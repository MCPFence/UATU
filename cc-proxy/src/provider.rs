use crate::config::{ProviderConfig, ProviderType};
use crate::transform::anthropic_to_openai::sanitize_tool_id;
use crate::transform::{anthropic_to_openai, normalize, openai_to_anthropic};
use bytes::Bytes;
use reqwest::Client;
use serde_json::Value;
use std::time::Duration;
use tokio_stream::Stream;

pub struct ProviderResult {
    pub status: u16,
    pub provider_type: ProviderType,
    pub provider_name: String,
    pub model: String,
    pub body: ProviderBody,
}

pub enum ProviderBody {
    Json(Value),
    Stream(Box<dyn Stream<Item = Result<Bytes, reqwest::Error>> + Send + Unpin>),
}

pub async fn send_request(
    client: &Client,
    provider: &ProviderConfig,
    model: &str,
    body: &Value,
    timeout: Duration,
) -> Result<ProviderResult, String> {
    let is_stream = body.get("stream").and_then(|s| s.as_bool()).unwrap_or(false);
    let ptype = provider.provider_type.clone();
    let pname = provider.name.clone();
    let model_str = model.to_string();

    let mut result = match provider.provider_type {
        ProviderType::Anthropic => send_anthropic(client, provider, model, body, timeout, is_stream).await?,
        ProviderType::OpenAI | ProviderType::OpenAIResponses => send_openai(client, provider, model, body, timeout, is_stream).await?,
    };
    result.provider_type = ptype;
    result.provider_name = pname;
    result.model = model_str;
    Ok(result)
}

async fn send_anthropic(
    client: &Client,
    provider: &ProviderConfig,
    model: &str,
    body: &Value,
    timeout: Duration,
    is_stream: bool,
) -> Result<ProviderResult, String> {
    let url = format!("{}/v1/messages", provider.base_url.trim_end_matches('/'));

    let mut body = body.clone();
    body["model"] = Value::String(model.to_string());
    sanitize_anthropic_request(&mut body);

    let resp = client
        .post(&url)
        .header("x-api-key", &provider.api_key)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .timeout(timeout)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Anthropic request failed: {e}"))?;

    let status = resp.status().as_u16();

    if status >= 400 {
        let error_text = resp.text().await.unwrap_or_default();
        if status == 400 {
            if let Ok(err_json) = serde_json::from_str::<Value>(&error_text) {
                let err_type = err_json.pointer("/error/type")
                    .and_then(|v| v.as_str()).unwrap_or("");
                let err_msg = err_json.pointer("/error/message")
                    .and_then(|v| v.as_str()).unwrap_or("");
                if err_type == "invalid_request_error" && err_msg.contains("Usage Policy") {
                    return Err(format!("status=400 policy_refusal=true body={error_text}"));
                }
            }
        }
        return Err(format!("status={status} body={error_text}"));
    }

    if is_stream {
        Ok(ProviderResult {
            status,
            provider_type: ProviderType::Anthropic,
            provider_name: String::new(),
            model: String::new(),
            body: ProviderBody::Stream(Box::new(resp.bytes_stream())),
        })
    } else {
        let json_body: Value = resp.json().await.map_err(|e| format!("Failed to parse Anthropic response: {e}"))?;
        Ok(ProviderResult {
            status,
            provider_type: ProviderType::Anthropic,
            provider_name: String::new(),
            model: String::new(),
            body: ProviderBody::Json(json_body),
        })
    }
}

fn sanitize_anthropic_request(body: &mut Value) {
    let Some(messages) = body.get_mut("messages").and_then(|m| m.as_array_mut()) else {
        return;
    };

    for msg in messages.iter_mut() {
        let role = msg.get("role").and_then(|r| r.as_str()).unwrap_or("").to_string();
        let Some(content) = msg.get_mut("content").and_then(|c| c.as_array_mut()) else {
            continue;
        };

        match role.as_str() {
            "assistant" => {
                let mut sanitized = Vec::with_capacity(content.len());
                for mut block in content.drain(..) {
                    match block.get("type").and_then(|t| t.as_str()) {
                        Some("thinking") => {
                            let signature = block.get("signature").and_then(|s| s.as_str()).unwrap_or("");
                            if !signature.is_empty() {
                                sanitized.push(block);
                            } else if let Some(thinking) = block.get("thinking").and_then(|t| t.as_str()) {
                                if !thinking.trim().is_empty() {
                                    sanitized.push(serde_json::json!({
                                        "type": "text",
                                        "text": format!("[Reasoning from previous non-Anthropic response]\n{thinking}")
                                    }));
                                }
                            }
                        }
                        Some("redacted_thinking") => {}
                        Some("tool_use") => {
                            if let Some(id) = block.get("id").and_then(|v| v.as_str()).map(|s| s.to_string()) {
                                block["id"] = Value::String(sanitize_tool_id(&id));
                            }
                            sanitized.push(block);
                        }
                        _ => sanitized.push(block),
                    }
                }
                *content = sanitized;
            }
            "user" => {
                for block in content.iter_mut() {
                    if block.get("type").and_then(|t| t.as_str()) == Some("tool_result") {
                        if let Some(id) = block.get("tool_use_id").and_then(|v| v.as_str()).map(|s| s.to_string()) {
                            block["tool_use_id"] = Value::String(sanitize_tool_id(&id));
                        }
                    }
                }
            }
            _ => {}
        }
    }

    messages.retain(|msg| {
        if msg.get("role").and_then(|r| r.as_str()) != Some("assistant") {
            return true;
        }
        match msg.get("content") {
            Some(Value::Array(a)) => !a.is_empty(),
            Some(Value::String(s)) => !s.is_empty(),
            _ => true,
        }
    });
}

async fn send_openai(
    client: &Client,
    provider: &ProviderConfig,
    model: &str,
    body: &Value,
    timeout: Duration,
    is_stream: bool,
) -> Result<ProviderResult, String> {
    let mut openai_body = anthropic_to_openai::transform_request(body, model)
        .map_err(|e| format!("Transform error: {e}"))?;
    normalize::normalize_openai_request(&mut openai_body);

    let base = provider.base_url.trim_end_matches('/');
    let url = if base.ends_with("/chat/completions") {
        base.to_string()
    } else if base.ends_with("/v1") {
        format!("{base}/chat/completions")
    } else {
        format!("{base}/v1/chat/completions")
    };

    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", provider.api_key))
        .header("content-type", "application/json")
        .timeout(timeout)
        .json(&openai_body)
        .send()
        .await
        .map_err(|e| format!("OpenAI request failed: {e}"))?;

    let status = resp.status().as_u16();

    if status >= 400 {
        let error_text = resp.text().await.unwrap_or_default();
        return Err(format!("status={status} body={error_text}"));
    }

    if is_stream {
        Ok(ProviderResult {
            status,
            provider_type: ProviderType::OpenAI,
            provider_name: String::new(),
            model: String::new(),
            body: ProviderBody::Stream(Box::new(resp.bytes_stream())),
        })
    } else {
        let json_body: Value = resp.json().await.map_err(|e| format!("Failed to parse OpenAI response: {e}"))?;
        let anthropic_resp = openai_to_anthropic::transform_response(&json_body)
            .map_err(|e| format!("Response transform error: {e}"))?;
        Ok(ProviderResult {
            status,
            provider_type: ProviderType::OpenAI,
            provider_name: String::new(),
            model: String::new(),
            body: ProviderBody::Json(anthropic_resp),
        })
    }
}

pub fn create_openai_stream_converter(model: String) -> openai_to_anthropic::StreamState {
    openai_to_anthropic::StreamState::new(model)
}

/// Send a Codex Responses API body directly to a provider's /responses endpoint (pass-through).
pub async fn send_responses_raw(
    client: &Client,
    provider: &ProviderConfig,
    model: &str,
    body: &Value,
    timeout: Duration,
) -> Result<ProviderResult, String> {
    let is_stream = body.get("stream").and_then(|s| s.as_bool()).unwrap_or(false);

    let mut req_body = body.clone();
    req_body["model"] = Value::String(model.to_string());

    let base = provider.base_url.trim_end_matches('/');
    // Remove /chat/completions suffix if present, then append /responses
    let base_v1 = if base.ends_with("/chat/completions") {
        base.trim_end_matches("/chat/completions")
    } else {
        base
    };
    let url = if base_v1.ends_with("/responses") {
        base_v1.to_string()
    } else if base_v1.ends_with("/v1") {
        format!("{base_v1}/responses")
    } else {
        format!("{base_v1}/v1/responses")
    };

    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", provider.api_key))
        .header("content-type", "application/json")
        .timeout(timeout)
        .json(&req_body)
        .send()
        .await
        .map_err(|e| format!("OpenAI Responses request failed: {e}"))?;

    let status = resp.status().as_u16();
    if status >= 400 {
        let error_text = resp.text().await.unwrap_or_default();
        return Err(format!("status={status} body={error_text}"));
    }

    if is_stream {
        Ok(ProviderResult {
            status,
            provider_type: ProviderType::OpenAIResponses,
            provider_name: String::new(),
            model: String::new(),
            body: ProviderBody::Stream(Box::new(resp.bytes_stream())),
        })
    } else {
        let json_body: Value = resp.json().await.map_err(|e| format!("Failed to parse Responses API response: {e}"))?;
        Ok(ProviderResult {
            status,
            provider_type: ProviderType::OpenAIResponses,
            provider_name: String::new(),
            model: String::new(),
            body: ProviderBody::Json(json_body),
        })
    }
}
pub async fn send_openai_raw(
    client: &Client,
    provider: &ProviderConfig,
    model: &str,
    body: &Value,
    timeout: Duration,
) -> Result<ProviderResult, String> {
    let is_stream = body.get("stream").and_then(|s| s.as_bool()).unwrap_or(false);

    let mut openai_body = body.clone();
    // Always override model with the configured provider model
    openai_body["model"] = Value::String(model.to_string());
    normalize::normalize_openai_request(&mut openai_body);

    let base = provider.base_url.trim_end_matches('/');
    let url = if base.ends_with("/chat/completions") {
        base.to_string()
    } else if base.ends_with("/v1") {
        format!("{base}/chat/completions")
    } else {
        format!("{base}/v1/chat/completions")
    };

    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", provider.api_key))
        .header("content-type", "application/json")
        .timeout(timeout)
        .json(&openai_body)
        .send()
        .await
        .map_err(|e| format!("OpenAI request failed: {e}"))?;

    let status = resp.status().as_u16();
    if status >= 400 {
        let error_text = resp.text().await.unwrap_or_default();
        return Err(format!("status={status} body={error_text}"));
    }

    if is_stream {
        Ok(ProviderResult {
            status,
            provider_type: ProviderType::OpenAI,
            provider_name: String::new(),
            model: String::new(),
            body: ProviderBody::Stream(Box::new(resp.bytes_stream())),
        })
    } else {
        let json_body: Value = resp.json().await.map_err(|e| format!("Failed to parse OpenAI response: {e}"))?;
        Ok(ProviderResult {
            status,
            provider_type: ProviderType::OpenAI,
            provider_name: String::new(),
            model: String::new(),
            body: ProviderBody::Json(json_body),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn sanitize_converts_empty_signature_thinking_to_text() {
        let mut body = json!({
            "messages": [{
                "role": "assistant",
                "content": [
                    {"type": "thinking", "thinking": "internal chain", "signature": ""},
                    {"type": "text", "text": "answer"}
                ]
            }]
        });

        sanitize_anthropic_request(&mut body);

        let content = body["messages"][0]["content"].as_array().unwrap();
        assert_eq!(content[0]["type"], "text");
        assert!(content[0]["text"].as_str().unwrap().contains("internal chain"));
        assert_eq!(content[1]["type"], "text");
    }

    #[test]
    fn sanitize_keeps_signed_anthropic_thinking() {
        let mut body = json!({
            "messages": [{
                "role": "assistant",
                "content": [
                    {"type": "thinking", "thinking": "signed", "signature": "sig_abc"}
                ]
            }]
        });

        sanitize_anthropic_request(&mut body);

        let content = body["messages"][0]["content"].as_array().unwrap();
        assert_eq!(content.len(), 1);
        assert_eq!(content[0]["type"], "thinking");
        assert_eq!(content[0]["signature"], "sig_abc");
    }

    #[test]
    fn sanitize_removes_redacted_thinking_and_empty_assistant() {
        let mut body = json!({
            "messages": [
                {"role": "user", "content": "hello"},
                {"role": "assistant", "content": [{"type": "redacted_thinking", "data": "x"}]}
            ]
        });

        sanitize_anthropic_request(&mut body);

        let messages = body["messages"].as_array().unwrap();
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0]["role"], "user");
    }

    #[test]
    fn sanitize_tool_use_ids_in_anthropic_request() {
        let mut body = json!({
            "messages": [
                {
                    "role": "assistant",
                    "content": [
                        {"type": "tool_use", "id": "functions.Bash:45", "name": "bash", "input": {"cmd": "ls"}},
                        {"type": "text", "text": "done"}
                    ]
                },
                {
                    "role": "user",
                    "content": [
                        {"type": "tool_result", "tool_use_id": "functions.Bash:45", "content": "output"},
                        {"type": "text", "text": "thanks"}
                    ]
                }
            ]
        });

        sanitize_anthropic_request(&mut body);

        let msgs = body["messages"].as_array().unwrap();
        let assistant_content = msgs[0]["content"].as_array().unwrap();
        assert_eq!(assistant_content[0]["id"], "functions_Bash-45");
        assert_eq!(assistant_content[1]["text"], "done");

        let user_content = msgs[1]["content"].as_array().unwrap();
        assert_eq!(user_content[0]["tool_use_id"], "functions_Bash-45");
        assert_eq!(user_content[1]["text"], "thanks");
    }

    #[test]
    fn sanitize_thinking_empty_text_dropped() {
        // thinking block with blank text (after trim) should not be converted to text block
        let mut body = json!({
            "messages": [{
                "role": "assistant",
                "content": [
                    {"type": "thinking", "thinking": "   ", "signature": ""},
                    {"type": "text", "text": "answer"}
                ]
            }]
        });
        sanitize_anthropic_request(&mut body);
        let content = body["messages"][0]["content"].as_array().unwrap();
        assert_eq!(content.len(), 1);
        assert_eq!(content[0]["type"], "text");
        assert_eq!(content[0]["text"], "answer");
    }

    #[test]
    fn sanitize_user_non_tool_result_blocks_unchanged() {
        // regular text blocks in user messages should pass through untouched
        let mut body = json!({
            "messages": [{
                "role": "user",
                "content": [
                    {"type": "text", "text": "hello"},
                    {"type": "image_url", "image_url": {"url": "http://example.com/img.png"}}
                ]
            }]
        });
        sanitize_anthropic_request(&mut body);
        let content = body["messages"][0]["content"].as_array().unwrap();
        assert_eq!(content.len(), 2);
        assert_eq!(content[0]["type"], "text");
        assert_eq!(content[1]["type"], "image_url");
    }

    #[test]
    fn sanitize_retains_assistant_with_string_content() {
        // assistant messages with non-empty string content should be kept
        let mut body = json!({
            "messages": [
                {"role": "user", "content": "hi"},
                {"role": "assistant", "content": "I am Claude"}
            ]
        });
        sanitize_anthropic_request(&mut body);
        let msgs = body["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[1]["content"], "I am Claude");
    }

    #[test]
    fn sanitize_drops_assistant_with_empty_string_content() {
        // assistant messages with empty string content should be removed
        let mut body = json!({
            "messages": [
                {"role": "user", "content": "hi"},
                {"role": "assistant", "content": ""}
            ]
        });
        sanitize_anthropic_request(&mut body);
        let msgs = body["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0]["role"], "user");
    }

    #[test]
    fn sanitize_no_messages_field_is_noop() {
        // request without messages should not panic
        let mut body = json!({"model": "claude-opus-4"});
        sanitize_anthropic_request(&mut body);
        assert_eq!(body["model"], "claude-opus-4");
    }

    #[test]
    fn sanitize_mixed_assistant_content_keeps_text_drops_redacted() {
        // redacted_thinking dropped, regular text block kept
        let mut body = json!({
            "messages": [{
                "role": "assistant",
                "content": [
                    {"type": "redacted_thinking", "data": "secret"},
                    {"type": "text", "text": "visible answer"}
                ]
            }]
        });
        sanitize_anthropic_request(&mut body);
        let content = body["messages"][0]["content"].as_array().unwrap();
        assert_eq!(content.len(), 1);
        assert_eq!(content[0]["type"], "text");
        assert_eq!(content[0]["text"], "visible answer");
    }
}