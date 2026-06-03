use serde_json::{json, Value};

/// Post-process an OpenAI-format request for maximum provider compatibility.
/// Applied after anthropic_to_openai transform, before sending.
pub fn normalize_openai_request(req: &mut Value) {
    if let Some(messages) = req.get_mut("messages").and_then(|m| m.as_array_mut()) {
        remove_empty_messages(messages);
        merge_consecutive_same_role(messages);
        ensure_tool_pairs(messages);
        content_as_string(messages);
        fix_first_message_role(messages);
    }
}

/// Remove messages with no useful content and no tool_calls.
fn remove_empty_messages(messages: &mut Vec<Value>) {
    messages.retain(|msg| {
        if msg.get("tool_calls").is_some() {
            return true;
        }
        let role = msg.get("role").and_then(|r| r.as_str()).unwrap_or("");
        if role == "tool" {
            return true;
        }
        match msg.get("content") {
            None => false,
            Some(Value::Null) => false,
            Some(Value::Array(a)) => !a.is_empty(),
            _ => true,
        }
    });
}

/// Merge consecutive messages with the same role (except tool messages).
fn merge_consecutive_same_role(messages: &mut Vec<Value>) {
    if messages.len() < 2 {
        return;
    }

    let mut merged: Vec<Value> = Vec::with_capacity(messages.len());

    for msg in messages.drain(..) {
        let role = msg.get("role").and_then(|r| r.as_str()).unwrap_or("");

        if role == "tool" || role == "system" {
            merged.push(msg);
            continue;
        }

        let should_merge = merged.last().map_or(false, |last| {
            let last_role = last.get("role").and_then(|r| r.as_str()).unwrap_or("");
            last_role == role
                && last.get("tool_calls").is_none()
                && msg.get("tool_calls").is_none()
        });

        if should_merge {
            let last = merged.last_mut().unwrap();
            let last_text = extract_string_content(last.get("content"));
            let cur_text = extract_string_content(msg.get("content"));
            if !cur_text.is_empty() {
                let combined = if last_text.is_empty() {
                    cur_text
                } else {
                    format!("{}\n{}", last_text, cur_text)
                };
                last["content"] = json!(combined);
            }
        } else {
            merged.push(msg);
        }
    }

    *messages = merged;
}

/// Ensure every assistant tool_call has a matching tool response anywhere in the conversation.
/// If a tool_call has no matching tool message, insert a placeholder right after the
/// last adjacent tool message (or right after the assistant message).
fn ensure_tool_pairs(messages: &mut Vec<Value>) {
    let all_tool_response_ids: std::collections::HashSet<String> = messages
        .iter()
        .filter(|m| m.get("role").and_then(|r| r.as_str()) == Some("tool"))
        .filter_map(|m| m.get("tool_call_id").and_then(|id| id.as_str()).map(String::from))
        .collect();

    let mut i = 0;
    while i < messages.len() {
        if let Some(tool_calls) = messages[i]
            .get("tool_calls")
            .and_then(|tc| tc.as_array())
        {
            let call_ids: Vec<String> = tool_calls
                .iter()
                .filter_map(|tc| tc.get("id").and_then(|id| id.as_str()).map(String::from))
                .collect();

            let mut j = i + 1;
            while j < messages.len() {
                if messages[j].get("role").and_then(|r| r.as_str()) == Some("tool") {
                    j += 1;
                } else {
                    break;
                }
            }

            let insert_pos = j;
            let mut inserts = Vec::new();
            for id in &call_ids {
                if !all_tool_response_ids.contains(id) {
                    inserts.push(json!({
                        "role": "tool",
                        "tool_call_id": id,
                        "content": ""
                    }));
                }
            }
            for (offset, val) in inserts.into_iter().enumerate() {
                messages.insert(insert_pos + offset, val);
            }
        }
        i += 1;
    }
}

/// Convert content arrays to plain strings when they only contain text parts.
/// Many OpenAI-compatible providers (JD Cloud, local models) require string content.
fn content_as_string(messages: &mut [Value]) {
    for msg in messages.iter_mut() {
        let role = msg.get("role").and_then(|r| r.as_str()).unwrap_or("");
        if role == "tool" {
            continue;
        }

        if let Some(content) = msg.get("content") {
            if let Some(arr) = content.as_array() {
                let all_text = arr.iter().all(|item| {
                    item.get("type").and_then(|t| t.as_str()) == Some("text")
                });
                if all_text && !arr.is_empty() {
                    let combined: String = arr
                        .iter()
                        .filter_map(|item| item.get("text").and_then(|t| t.as_str()))
                        .collect::<Vec<_>>()
                        .join("\n");
                    msg["content"] = json!(combined);
                }
            }
        }
    }
}

/// OpenAI API requires the first message to be system or user, not assistant.
fn fix_first_message_role(messages: &mut Vec<Value>) {
    if let Some(first) = messages.first() {
        let role = first.get("role").and_then(|r| r.as_str()).unwrap_or("");
        if role == "assistant" {
            messages.insert(0, json!({"role": "user", "content": ""}));
        }
    }
}

fn extract_string_content(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(arr)) => arr
            .iter()
            .filter_map(|item| {
                if item.get("type").and_then(|t| t.as_str()) == Some("text") {
                    item.get("text").and_then(|t| t.as_str()).map(String::from)
                } else {
                    None
                }
            })
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_remove_empty_messages() {
        let mut req = json!({
            "messages": [
                {"role": "user", "content": "hello"},
                {"role": "assistant"},
                {"role": "user", "content": "world"}
            ]
        });
        normalize_openai_request(&mut req);
        let msgs = req["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0]["content"], "hello\nworld");
    }

    #[test]
    fn test_keep_tool_calls_with_null_content() {
        let mut req = json!({
            "messages": [
                {"role": "user", "content": "ask"},
                {"role": "assistant", "content": "", "tool_calls": [
                    {"id": "tc_1", "type": "function", "function": {"name": "foo", "arguments": "{}"}}
                ]},
                {"role": "tool", "tool_call_id": "tc_1", "content": "result"}
            ]
        });
        normalize_openai_request(&mut req);
        let msgs = req["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), 3);
        assert!(msgs[1].get("tool_calls").is_some());
    }

    #[test]
    fn test_merge_consecutive_user() {
        let mut req = json!({
            "messages": [
                {"role": "user", "content": "line1"},
                {"role": "user", "content": "line2"},
                {"role": "assistant", "content": "reply"}
            ]
        });
        normalize_openai_request(&mut req);
        let msgs = req["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0]["content"], "line1\nline2");
    }

    #[test]
    fn test_no_merge_tool_messages() {
        let mut req = json!({
            "messages": [
                {"role": "user", "content": "ask"},
                {"role": "assistant", "content": "", "tool_calls": [
                    {"id": "tc_1", "type": "function", "function": {"name": "a", "arguments": "{}"}},
                    {"id": "tc_2", "type": "function", "function": {"name": "b", "arguments": "{}"}}
                ]},
                {"role": "tool", "tool_call_id": "tc_1", "content": "r1"},
                {"role": "tool", "tool_call_id": "tc_2", "content": "r2"}
            ]
        });
        normalize_openai_request(&mut req);
        let msgs = req["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), 4);
        assert_eq!(msgs[2]["role"], "tool");
        assert_eq!(msgs[3]["role"], "tool");
    }

    #[test]
    fn test_ensure_tool_pairs_missing() {
        let mut req = json!({
            "messages": [
                {"role": "assistant", "content": "", "tool_calls": [
                    {"id": "tc_1", "type": "function", "function": {"name": "a", "arguments": "{}"}},
                    {"id": "tc_2", "type": "function", "function": {"name": "b", "arguments": "{}"}}
                ]},
                {"role": "tool", "tool_call_id": "tc_1", "content": "r1"},
                {"role": "user", "content": "next"}
            ]
        });
        normalize_openai_request(&mut req);
        let msgs = req["messages"].as_array().unwrap();
        let tool_msgs: Vec<_> = msgs.iter().filter(|m| m["role"] == "tool").collect();
        assert_eq!(tool_msgs.len(), 2);
        assert_eq!(tool_msgs[1]["tool_call_id"], "tc_2");
    }

    #[test]
    fn test_ensure_tool_pairs_global_scan_finds_distant_response() {
        // tool response is far away from its assistant tool_call — global scan should find it
        let mut req = json!({
            "messages": [
                {"role": "assistant", "content": "", "tool_calls": [
                    {"id": "tc_far", "type": "function", "function": {"name": "a", "arguments": "{}"}}
                ]},
                {"role": "user", "content": "interrupt"},
                {"role": "tool", "tool_call_id": "tc_far", "content": "delayed"}
            ]
        });
        normalize_openai_request(&mut req);
        let msgs = req["messages"].as_array().unwrap();
        let placeholder_count = msgs.iter().filter(|m| {
            m["role"] == "tool" && m["content"] == ""
        }).count();
        assert_eq!(placeholder_count, 0, "should not insert placeholder when response exists later");
    }

    #[test]
    fn test_content_as_string_text_only() {
        let mut req = json!({
            "messages": [
                {"role": "user", "content": [
                    {"type": "text", "text": "hello"},
                    {"type": "text", "text": "world"}
                ]}
            ]
        });
        normalize_openai_request(&mut req);
        let msgs = req["messages"].as_array().unwrap();
        assert_eq!(msgs[0]["content"], "hello\nworld");
    }

    #[test]
    fn test_content_as_string_keeps_image_array() {
        let mut req = json!({
            "messages": [
                {"role": "user", "content": [
                    {"type": "text", "text": "look"},
                    {"type": "image_url", "image_url": {"url": "data:image/png;base64,abc"}}
                ]}
            ]
        });
        normalize_openai_request(&mut req);
        let msgs = req["messages"].as_array().unwrap();
        assert!(msgs[0]["content"].is_array());
    }

    #[test]
    fn test_fix_first_assistant() {
        let mut req = json!({
            "messages": [
                {"role": "assistant", "content": "I am assistant"}
            ]
        });
        normalize_openai_request(&mut req);
        let msgs = req["messages"].as_array().unwrap();
        assert_eq!(msgs[0]["role"], "user");
        assert_eq!(msgs[1]["role"], "assistant");
    }

    #[test]
    fn test_full_pipeline() {
        let mut req = json!({
            "messages": [
                {"role": "user", "content": [{"type": "text", "text": "hello"}]},
                {"role": "user", "content": "more"},
                {"role": "assistant", "content": "", "tool_calls": [
                    {"id": "t1", "type": "function", "function": {"name": "x", "arguments": "{}"}}
                ]},
                {"role": "user", "content": "after"}
            ]
        });
        normalize_openai_request(&mut req);
        let msgs = req["messages"].as_array().unwrap();
        // user merged, tool placeholder inserted
        assert_eq!(msgs[0]["content"], "hello\nmore");
        assert_eq!(msgs[0]["role"], "user");
        assert!(msgs[1].get("tool_calls").is_some());
        // tool placeholder should exist
        let has_tool = msgs.iter().any(|m| m["role"] == "tool" && m["tool_call_id"] == "t1");
        assert!(has_tool);
    }

    #[test]
    fn test_remove_null_content_message() {
        let mut req = json!({
            "messages": [
                {"role": "user", "content": "hi"},
                {"role": "assistant", "content": null},
                {"role": "user", "content": "there"}
            ]
        });
        normalize_openai_request(&mut req);
        let msgs = req["messages"].as_array().unwrap();
        // null-content assistant removed; two users merged
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0]["content"], "hi\nthere");
    }

    #[test]
    fn test_remove_no_content_field() {
        // message with no content key at all should be removed (unless it has tool_calls)
        let mut req = json!({
            "messages": [
                {"role": "user", "content": "start"},
                {"role": "assistant"},
                {"role": "user", "content": "end"}
            ]
        });
        normalize_openai_request(&mut req);
        let msgs = req["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0]["content"], "start\nend");
    }

    #[test]
    fn test_system_messages_not_merged_with_user() {
        // system and user should stay separate even if adjacent
        let mut req = json!({
            "messages": [
                {"role": "system", "content": "You are helpful."},
                {"role": "user", "content": "hello"}
            ]
        });
        normalize_openai_request(&mut req);
        let msgs = req["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0]["role"], "system");
        assert_eq!(msgs[1]["role"], "user");
    }

    #[test]
    fn test_consecutive_system_messages_not_merged() {
        // two system messages should stay separate (system is excluded from merge)
        let mut req = json!({
            "messages": [
                {"role": "system", "content": "rule1"},
                {"role": "system", "content": "rule2"},
                {"role": "user", "content": "hi"}
            ]
        });
        normalize_openai_request(&mut req);
        let msgs = req["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), 3);
        assert_eq!(msgs[0]["content"], "rule1");
        assert_eq!(msgs[1]["content"], "rule2");
    }

    #[test]
    fn test_merge_array_content_user_messages() {
        // array-content user messages should be merged by extracting text parts
        let mut req = json!({
            "messages": [
                {"role": "user", "content": [{"type": "text", "text": "part A"}]},
                {"role": "user", "content": [{"type": "text", "text": "part B"}]},
                {"role": "assistant", "content": "ok"}
            ]
        });
        normalize_openai_request(&mut req);
        let msgs = req["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0]["content"], "part A\npart B");
    }

    #[test]
    fn test_content_as_string_empty_array_stays() {
        // empty array content does not get collapsed to string (already filtered by remove_empty)
        // what matters: content_as_string only acts on non-empty all-text arrays
        let mut req = json!({
            "messages": [
                {"role": "user", "content": "keep"},
                {"role": "tool", "tool_call_id": "t1", "content": [{"type": "text", "text": "r"}]}
            ]
        });
        normalize_openai_request(&mut req);
        let msgs = req["messages"].as_array().unwrap();
        // tool message content should stay array (tool role skipped by content_as_string)
        assert!(msgs[1]["content"].is_array());
    }

    #[test]
    fn test_tool_message_kept_regardless_of_empty_content() {
        // tool messages are always retained (they complete a tool call pair)
        let mut req = json!({
            "messages": [
                {"role": "user", "content": "go"},
                {"role": "assistant", "content": null, "tool_calls": [
                    {"id": "tc1", "type": "function", "function": {"name": "f", "arguments": "{}"}}
                ]},
                {"role": "tool", "tool_call_id": "tc1", "content": ""}
            ]
        });
        normalize_openai_request(&mut req);
        let msgs = req["messages"].as_array().unwrap();
        let tool_count = msgs.iter().filter(|m| m["role"] == "tool").count();
        assert_eq!(tool_count, 1);
    }
}
