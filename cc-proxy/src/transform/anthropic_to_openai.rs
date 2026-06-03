use serde_json::{json, Value};

pub(crate) fn sanitize_tool_id(id: &str) -> String {
    id.chars()
        .map(|c| match c {
            '.' => '_',
            ':' => '-',
            c if c.is_ascii_alphanumeric() || c == '_' || c == '-' => c,
            _ => '_',
        })
        .collect()
}

pub fn transform_request(anthropic_req: &Value, target_model: &str) -> Result<Value, String> {
    let messages = anthropic_req
        .get("messages")
        .and_then(|m| m.as_array())
        .ok_or("Missing messages array")?;

    let mut openai_messages: Vec<Value> = Vec::new();

    if let Some(system) = anthropic_req.get("system") {
        let system_text = extract_system_text(system);
        if !system_text.is_empty() {
            openai_messages.push(json!({
                "role": "system",
                "content": system_text
            }));
        }
    }

    for msg in messages {
        let role = msg.get("role").and_then(|r| r.as_str()).unwrap_or("user");
        let content = msg.get("content");

        match role {
            "user" => {
                let converted = convert_user_message(content)?;
                openai_messages.extend(converted);
            }
            "assistant" => {
                let converted = convert_assistant_message(content)?;
                openai_messages.extend(converted);
            }
            _ => {
                openai_messages.push(json!({
                    "role": role,
                    "content": content
                }));
            }
        }
    }

    let mut openai_req = json!({
        "model": target_model,
        "messages": openai_messages,
        "stream": anthropic_req.get("stream").and_then(|s| s.as_bool()).unwrap_or(false),
    });

    if let Some(max_tokens) = anthropic_req.get("max_tokens") {
        openai_req["max_tokens"] = max_tokens.clone();
    }
    if let Some(temp) = anthropic_req.get("temperature") {
        openai_req["temperature"] = temp.clone();
    }
    if let Some(top_p) = anthropic_req.get("top_p") {
        openai_req["top_p"] = top_p.clone();
    }
    if let Some(stop) = anthropic_req.get("stop_sequences") {
        openai_req["stop"] = stop.clone();
    }

    if let Some(tools) = anthropic_req.get("tools").and_then(|t| t.as_array()) {
        let openai_tools: Vec<Value> = tools.iter().map(convert_tool_def).collect();
        openai_req["tools"] = json!(openai_tools);
    }

    if let Some(tool_choice) = anthropic_req.get("tool_choice") {
        openai_req["tool_choice"] = convert_tool_choice(tool_choice);
    }

    if anthropic_req.get("stream").and_then(|s| s.as_bool()).unwrap_or(false) {
        openai_req["stream_options"] = json!({"include_usage": true});
    }

    Ok(openai_req)
}

fn strip_billing_header(text: &str) -> String {
    text.lines()
        .filter(|line| !line.starts_with("x-anthropic-billing-header:"))
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

fn extract_system_text(system: &Value) -> String {
    let raw = match system {
        Value::String(s) => s.clone(),
        Value::Array(arr) => arr
            .iter()
            .filter_map(|block| {
                if block.get("type").and_then(|t| t.as_str()) == Some("text") {
                    block.get("text").and_then(|t| t.as_str()).map(String::from)
                } else {
                    None
                }
            })
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    };
    strip_billing_header(&raw)
}

fn convert_user_message(content: Option<&Value>) -> Result<Vec<Value>, String> {
    let content = content.ok_or("Missing content in user message")?;

    match content {
        Value::String(s) => Ok(vec![json!({"role": "user", "content": s})]),
        Value::Array(blocks) => {
            let mut text_parts: Vec<String> = Vec::new();
            let mut multimodal_parts: Vec<Value> = Vec::new();
            let mut tool_results: Vec<Value> = Vec::new();
            let mut has_non_text = false;

            for block in blocks {
                let block_type = block.get("type").and_then(|t| t.as_str()).unwrap_or("");
                match block_type {
                    "text" => {
                        let text = block.get("text").and_then(|t| t.as_str()).unwrap_or("");
                        text_parts.push(text.to_string());
                        multimodal_parts.push(json!({"type": "text", "text": text}));
                    }
                    "image" => {
                        has_non_text = true;
                        if let Some(source) = block.get("source") {
                            let media_type = source.get("media_type").and_then(|m| m.as_str()).unwrap_or("image/png");
                            let data = source.get("data").and_then(|d| d.as_str()).unwrap_or("");
                            multimodal_parts.push(json!({
                                "type": "image_url",
                                "image_url": {
                                    "url": format!("data:{media_type};base64,{data}")
                                }
                            }));
                        }
                    }
                    "tool_result" => {
                        let tool_use_id = block.get("tool_use_id").and_then(|id| id.as_str()).unwrap_or("");
                        let result_content = extract_tool_result_content(block);
                        tool_results.push(json!({
                            "role": "tool",
                            "tool_call_id": sanitize_tool_id(tool_use_id),
                            "content": result_content
                        }));
                    }
                    _ => {}
                }
            }

            let mut result: Vec<Value> = Vec::new();

            if !tool_results.is_empty() {
                result.extend(tool_results);
            }

            if has_non_text {
                if !multimodal_parts.is_empty() {
                    result.push(json!({"role": "user", "content": multimodal_parts}));
                }
            } else if !text_parts.is_empty() {
                result.push(json!({"role": "user", "content": text_parts.join("\n")}));
            }

            if result.is_empty() {
                Ok(vec![json!({"role": "user", "content": ""})])
            } else {
                Ok(result)
            }
        }
        _ => Ok(vec![json!({"role": "user", "content": content})]),
    }
}

fn convert_assistant_message(content: Option<&Value>) -> Result<Vec<Value>, String> {
    let content = content.ok_or("Missing content in assistant message")?;

    match content {
        Value::String(s) => Ok(vec![json!({"role": "assistant", "content": s})]),
        Value::Array(blocks) => {
            let mut text_parts: Vec<String> = Vec::new();
            let mut tool_calls: Vec<Value> = Vec::new();

            for block in blocks {
                let block_type = block.get("type").and_then(|t| t.as_str()).unwrap_or("");
                match block_type {
                    "text" => {
                        let text = block.get("text").and_then(|t| t.as_str()).unwrap_or("");
                        // Skip [Reasoning]-prefixed blocks: these are reasoning artifacts
                        // stored by finalize() and must not be forwarded to other providers
                        if !text.starts_with("[Reasoning]") {
                            text_parts.push(text.to_string());
                        }
                    }
                    "tool_use" => {
                        let id = block.get("id").and_then(|id| id.as_str()).unwrap_or("");
                        let name = block.get("name").and_then(|n| n.as_str()).unwrap_or("");
                        let empty = json!({});
                        let input = block.get("input").unwrap_or(&empty);
                        tool_calls.push(json!({
                            "id": sanitize_tool_id(id),
                            "type": "function",
                            "function": {
                                "name": name,
                                "arguments": serde_json::to_string(input).unwrap_or_default()
                            }
                        }));
                    }
                    "thinking" => {}
                    _ => {}
                }
            }

            let content_value = if text_parts.is_empty() {
                json!("")
            } else {
                json!(text_parts.join(""))
            };

            let mut msg = json!({
                "role": "assistant",
                "content": content_value
            });

            if !tool_calls.is_empty() {
                msg["tool_calls"] = json!(tool_calls);
            }

            Ok(vec![msg])
        }
        _ => Ok(vec![json!({"role": "assistant", "content": content})]),
    }
}

fn extract_tool_result_content(block: &Value) -> String {
    if let Some(content) = block.get("content") {
        match content {
            Value::String(s) => return s.clone(),
            Value::Array(arr) => {
                let parts: Vec<String> = arr
                    .iter()
                    .map(|b| {
                        let btype = b.get("type").and_then(|t| t.as_str()).unwrap_or("");
                        match btype {
                            "text" => b.get("text").and_then(|t| t.as_str())
                                .unwrap_or("").to_string(),
                            _ => serde_json::to_string(b).unwrap_or_default(),
                        }
                    })
                    .collect();
                return parts.join("\n");
            }
            _ => {}
        }
    }
    String::new()
}

fn convert_tool_def(tool: &Value) -> Value {
    let name = tool.get("name").and_then(|n| n.as_str()).unwrap_or("unknown");
    let description = tool.get("description").and_then(|d| d.as_str()).unwrap_or("");
    let input_schema = tool.get("input_schema").cloned().unwrap_or(json!({"type": "object", "properties": {}}));

    json!({
        "type": "function",
        "function": {
            "name": name,
            "description": description,
            "parameters": input_schema
        }
    })
}

fn convert_tool_choice(tool_choice: &Value) -> Value {
    match tool_choice {
        Value::Object(obj) => {
            let tc_type = obj.get("type").and_then(|t| t.as_str()).unwrap_or("auto");
            match tc_type {
                "auto" => json!("auto"),
                "any" => json!("required"),
                "tool" => {
                    let name = obj.get("name").and_then(|n| n.as_str()).unwrap_or("");
                    json!({"type": "function", "function": {"name": name}})
                }
                _ => json!("auto"),
            }
        }
        _ => json!("auto"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_simple_text_message() {
        let req = json!({
            "model": "claude-opus-4-20250514",
            "max_tokens": 1024,
            "messages": [{"role": "user", "content": "Hello"}]
        });
        let result = transform_request(&req, "gpt-4").unwrap();
        assert_eq!(result["model"], "gpt-4");
        assert_eq!(result["max_tokens"], 1024);
        assert_eq!(result["stream"], false);
        let msgs = result["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0]["role"], "user");
        assert_eq!(msgs[0]["content"], "Hello");
    }

    #[test]
    fn test_system_prompt_string() {
        let req = json!({
            "model": "claude",
            "system": "You are helpful.",
            "messages": [{"role": "user", "content": "Hi"}]
        });
        let result = transform_request(&req, "gpt-4").unwrap();
        let msgs = result["messages"].as_array().unwrap();
        assert_eq!(msgs[0]["role"], "system");
        assert_eq!(msgs[0]["content"], "You are helpful.");
        assert_eq!(msgs[1]["role"], "user");
    }

    #[test]
    fn test_system_prompt_array() {
        let req = json!({
            "model": "claude",
            "system": [
                {"type": "text", "text": "Line one."},
                {"type": "text", "text": "Line two."}
            ],
            "messages": [{"role": "user", "content": "Hi"}]
        });
        let result = transform_request(&req, "gpt-4").unwrap();
        let msgs = result["messages"].as_array().unwrap();
        assert_eq!(msgs[0]["content"], "Line one.\nLine two.");
    }

    #[test]
    fn test_user_message_with_content_blocks() {
        let req = json!({
            "model": "claude",
            "messages": [{
                "role": "user",
                "content": [
                    {"type": "text", "text": "Look at this image"},
                    {"type": "image", "source": {
                        "type": "base64",
                        "media_type": "image/png",
                        "data": "abc123"
                    }}
                ]
            }]
        });
        let result = transform_request(&req, "gpt-4").unwrap();
        let msgs = result["messages"].as_array().unwrap();
        let content = msgs[0]["content"].as_array().unwrap();
        assert_eq!(content.len(), 2);
        assert_eq!(content[0]["type"], "text");
        assert_eq!(content[1]["type"], "image_url");
        assert_eq!(content[1]["image_url"]["url"], "data:image/png;base64,abc123");
    }

    #[test]
    fn test_assistant_message_with_tool_use() {
        let req = json!({
            "model": "claude",
            "messages": [{
                "role": "assistant",
                "content": [
                    {"type": "text", "text": "Let me search."},
                    {"type": "tool_use", "id": "tc_1", "name": "search", "input": {"query": "rust"}}
                ]
            }]
        });
        let result = transform_request(&req, "gpt-4").unwrap();
        let msgs = result["messages"].as_array().unwrap();
        assert_eq!(msgs[0]["role"], "assistant");
        assert_eq!(msgs[0]["content"], "Let me search.");
        let tc = &msgs[0]["tool_calls"].as_array().unwrap()[0];
        assert_eq!(tc["id"], "tc_1");
        assert_eq!(tc["function"]["name"], "search");
        let args: Value = serde_json::from_str(tc["function"]["arguments"].as_str().unwrap()).unwrap();
        assert_eq!(args["query"], "rust");
    }

    #[test]
    fn test_tool_result_message() {
        let req = json!({
            "model": "claude",
            "messages": [{
                "role": "user",
                "content": [
                    {"type": "tool_result", "tool_use_id": "tc_1", "content": "search result here"}
                ]
            }]
        });
        let result = transform_request(&req, "gpt-4").unwrap();
        let msgs = result["messages"].as_array().unwrap();
        let tool_msg = msgs.iter().find(|m| m["role"] == "tool").unwrap();
        assert_eq!(tool_msg["tool_call_id"], "tc_1");
        assert_eq!(tool_msg["content"], "search result here");
    }

    #[test]
    fn test_tool_definitions() {
        let req = json!({
            "model": "claude",
            "messages": [{"role": "user", "content": "Hi"}],
            "tools": [{
                "name": "get_weather",
                "description": "Get weather info",
                "input_schema": {
                    "type": "object",
                    "properties": {
                        "location": {"type": "string"}
                    },
                    "required": ["location"]
                }
            }]
        });
        let result = transform_request(&req, "gpt-4").unwrap();
        let tools = result["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0]["type"], "function");
        assert_eq!(tools[0]["function"]["name"], "get_weather");
        assert_eq!(tools[0]["function"]["description"], "Get weather info");
        assert!(tools[0]["function"]["parameters"]["properties"]["location"].is_object());
    }

    #[test]
    fn test_tool_choice_auto() {
        let req = json!({
            "model": "claude",
            "messages": [{"role": "user", "content": "Hi"}],
            "tool_choice": {"type": "auto"}
        });
        let result = transform_request(&req, "gpt-4").unwrap();
        assert_eq!(result["tool_choice"], "auto");
    }

    #[test]
    fn test_tool_choice_any() {
        let req = json!({
            "model": "claude",
            "messages": [{"role": "user", "content": "Hi"}],
            "tool_choice": {"type": "any"}
        });
        let result = transform_request(&req, "gpt-4").unwrap();
        assert_eq!(result["tool_choice"], "required");
    }

    #[test]
    fn test_tool_choice_specific() {
        let req = json!({
            "model": "claude",
            "messages": [{"role": "user", "content": "Hi"}],
            "tool_choice": {"type": "tool", "name": "get_weather"}
        });
        let result = transform_request(&req, "gpt-4").unwrap();
        assert_eq!(result["tool_choice"]["function"]["name"], "get_weather");
    }

    #[test]
    fn test_stream_options() {
        let req = json!({
            "model": "claude",
            "stream": true,
            "messages": [{"role": "user", "content": "Hi"}]
        });
        let result = transform_request(&req, "gpt-4").unwrap();
        assert_eq!(result["stream"], true);
        assert_eq!(result["stream_options"]["include_usage"], true);
    }

    #[test]
    fn test_no_stream_options_when_not_streaming() {
        let req = json!({
            "model": "claude",
            "messages": [{"role": "user", "content": "Hi"}]
        });
        let result = transform_request(&req, "gpt-4").unwrap();
        assert!(result.get("stream_options").is_none());
    }

    #[test]
    fn test_params_passthrough() {
        let req = json!({
            "model": "claude",
            "messages": [{"role": "user", "content": "Hi"}],
            "temperature": 0.7,
            "top_p": 0.9,
            "stop_sequences": ["\n\n"]
        });
        let result = transform_request(&req, "gpt-4").unwrap();
        assert_eq!(result["temperature"], 0.7);
        assert_eq!(result["top_p"], 0.9);
        assert_eq!(result["stop"][0], "\n\n");
    }

    #[test]
    fn test_tool_result_with_non_text_blocks() {
        let req = json!({
            "model": "claude",
            "messages": [{
                "role": "user",
                "content": [
                    {"type": "tool_result", "tool_use_id": "tc_1", "content": [
                        {"type": "text", "text": "File contents:"},
                        {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "abc"}}
                    ]}
                ]
            }]
        });
        let result = transform_request(&req, "gpt-4").unwrap();
        let msgs = result["messages"].as_array().unwrap();
        let tool_msg = msgs.iter().find(|m| m["role"] == "tool").unwrap();
        let content = tool_msg["content"].as_str().unwrap();
        assert!(content.contains("File contents:"));
        assert!(content.contains("image"));
    }

    #[test]
    fn test_missing_messages() {
        let req = json!({"model": "claude"});
        assert!(transform_request(&req, "gpt-4").is_err());
    }

    #[test]
    fn test_multi_turn_conversation() {
        let req = json!({
            "model": "claude",
            "messages": [
                {"role": "user", "content": "Hello"},
                {"role": "assistant", "content": "Hi there!"},
                {"role": "user", "content": "How are you?"}
            ]
        });
        let result = transform_request(&req, "gpt-4").unwrap();
        let msgs = result["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), 3);
        assert_eq!(msgs[0]["role"], "user");
        assert_eq!(msgs[1]["role"], "assistant");
        assert_eq!(msgs[1]["content"], "Hi there!");
        assert_eq!(msgs[2]["role"], "user");
    }

    #[test]
    fn test_thinking_block_ignored() {
        let req = json!({
            "model": "claude",
            "messages": [{
                "role": "assistant",
                "content": [
                    {"type": "thinking", "thinking": "Let me think...", "signature": "real-anthropic-sig"},
                    {"type": "text", "text": "Here is my answer."}
                ]
            }]
        });
        let result = transform_request(&req, "gpt-4").unwrap();
        let msgs = result["messages"].as_array().unwrap();
        assert_eq!(msgs[0]["content"], "Here is my answer.");
        assert!(msgs[0].get("tool_calls").is_none());
    }

    #[test]
    fn test_tool_use_id_sanitized() {
        let req = json!({
            "model": "claude",
            "messages": [
                {
                    "role": "assistant",
                    "content": [
                        {"type": "tool_use", "id": "functions.Bash:45", "name": "bash", "input": {"cmd": "ls"}}
                    ]
                },
                {
                    "role": "user",
                    "content": [
                        {"type": "tool_result", "tool_use_id": "functions.Bash:45", "content": "output"}
                    ]
                }
            ]
        });
        let result = transform_request(&req, "gpt-4").unwrap();
        let msgs = result["messages"].as_array().unwrap();

        let assistant_msg = &msgs[0];
        let tool_call_id = assistant_msg["tool_calls"][0]["id"].as_str().unwrap();
        assert_eq!(tool_call_id, "functions_Bash-45");

        let tool_msg = &msgs[1];
        assert_eq!(tool_msg["tool_call_id"].as_str().unwrap(), "functions_Bash-45");
    }

    #[test]
    fn test_sanitize_tool_id_various_chars() {
        assert_eq!(sanitize_tool_id("simple_id-123"), "simple_id-123");
        assert_eq!(sanitize_tool_id("functions.Read:7"), "functions_Read-7");
        assert_eq!(sanitize_tool_id("a.b.c:d:e"), "a_b_c-d-e");
        assert_eq!(sanitize_tool_id("id with spaces!"), "id_with_spaces_");
    }

    #[test]
    fn test_billing_header_stripped_from_system_string() {
        let req = json!({
            "model": "claude",
            "system": "x-anthropic-billing-header: cc_version=2.1.132.936; cc_entrypoint=cli; cch=b5429;\nYou are helpful.",
            "messages": [{"role": "user", "content": "Hi"}]
        });
        let result = transform_request(&req, "gpt-4").unwrap();
        let msgs = result["messages"].as_array().unwrap();
        assert_eq!(msgs[0]["role"], "system");
        assert_eq!(msgs[0]["content"], "You are helpful.");
    }

    #[test]
    fn test_billing_header_stripped_from_system_array() {
        let req = json!({
            "model": "claude",
            "system": [
                {"type": "text", "text": "x-anthropic-billing-header: cc_version=2.1.132.936; cc_entrypoint=cli; cch=abc12;"},
                {"type": "text", "text": "You are helpful."}
            ],
            "messages": [{"role": "user", "content": "Hi"}]
        });
        let result = transform_request(&req, "gpt-4").unwrap();
        let msgs = result["messages"].as_array().unwrap();
        let sys_content = msgs[0]["content"].as_str().unwrap();
        assert!(!sys_content.contains("x-anthropic-billing-header"));
        assert!(sys_content.contains("You are helpful."));
    }

    #[test]
    fn test_reasoning_blocks_stripped_from_assistant_history() {
        // [Reasoning]-prefixed text blocks stored by finalize() must not be forwarded
        // to subsequent OpenAI-format providers as they pollute the context window
        let req = json!({
            "model": "claude",
            "messages": [
                {"role": "user", "content": "Hello"},
                {
                    "role": "assistant",
                    "content": [
                        {"type": "text", "text": "[Reasoning]\nLet me think step by step..."},
                        {"type": "text", "text": "The answer is 42."}
                    ]
                },
                {"role": "user", "content": "Follow up"}
            ]
        });
        let result = transform_request(&req, "gpt-4").unwrap();
        let msgs = result["messages"].as_array().unwrap();
        // Find the assistant message
        let asst = msgs.iter().find(|m| m["role"] == "assistant").unwrap();
        let content = asst["content"].as_str().unwrap();
        assert!(!content.contains("[Reasoning]"), "reasoning block should be stripped");
        assert!(content.contains("The answer is 42."), "actual response should be kept");
    }
}
