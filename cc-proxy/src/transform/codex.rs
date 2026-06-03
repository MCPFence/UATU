use serde_json::{json, Value};
use uuid::Uuid;

/// Convert OpenAI Codex Responses API request to OpenAI Chat Completions request.
pub fn codex_to_openai_chat(body: &Value) -> Value {
    let mut messages: Vec<Value> = Vec::new();

    // instructions → system message
    if let Some(instr) = body.get("instructions").and_then(|v| v.as_str()) {
        if !instr.is_empty() {
            messages.push(json!({"role": "system", "content": instr}));
        }
    }

    // input[] → messages
    if let Some(input) = body.get("input").and_then(|v| v.as_array()) {
        for item in input {
            let role = item.get("role").and_then(|v| v.as_str()).unwrap_or("");
            let item_type = item.get("type").and_then(|v| v.as_str()).unwrap_or("");

            if !role.is_empty() {
                // Role-based items (user / assistant)
                let content = item.get("content").and_then(|v| v.as_array());
                match role {
                    "user" => {
                        let text = extract_text_from_content(content);
                        messages.push(json!({"role": "user", "content": text}));
                    }
                    "assistant" => {
                        let text = extract_text_from_content(content);
                        messages.push(json!({"role": "assistant", "content": text}));
                    }
                    _ => {}
                }
            } else {
                // Type-based top-level items
                match item_type {
                    "function_call" => {
                        let call_id = item.get("call_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                        let name = item.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
                        let arguments = item.get("arguments").and_then(|v| v.as_str()).unwrap_or("{}").to_string();
                        messages.push(json!({
                            "role": "assistant",
                            "content": null,
                            "tool_calls": [{
                                "id": call_id,
                                "type": "function",
                                "function": {
                                    "name": name,
                                    "arguments": arguments
                                }
                            }]
                        }));
                    }
                    "function_call_output" => {
                        let call_id = item.get("call_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                        let output = item.get("output").and_then(|v| v.as_str()).unwrap_or("").to_string();
                        messages.push(json!({
                            "role": "tool",
                            "tool_call_id": call_id,
                            "content": output
                        }));
                    }
                    _ => {}
                }
            }
        }
    }

    // tools: Codex tools format is already compatible with OpenAI Chat tools format
    let tools = body.get("tools").cloned().unwrap_or(Value::Null);

    let model = body.get("model").and_then(|v| v.as_str()).unwrap_or("gpt-4o").to_string();
    let stream = body.get("stream").and_then(|v| v.as_bool()).unwrap_or(false);

    let mut result = json!({
        "model": model,
        "messages": messages,
        "stream": stream,
    });

    if stream {
        result["stream_options"] = json!({"include_usage": true});
    }

    if !tools.is_null() {
        if let Some(arr) = tools.as_array() {
            if !arr.is_empty() {
                result["tools"] = tools;
            }
        }
    }

    // Passthrough optional fields
    for field in &["temperature", "top_p", "max_tokens", "stop", "frequency_penalty", "presence_penalty"] {
        if let Some(v) = body.get(*field) {
            result[*field] = v.clone();
        }
    }

    result
}

fn extract_text_from_content(content: Option<&Vec<Value>>) -> String {
    match content {
        None => String::new(),
        Some(parts) => {
            parts.iter()
                .filter_map(|p| {
                    let ptype = p.get("type").and_then(|v| v.as_str()).unwrap_or("");
                    match ptype {
                        "input_text" | "output_text" | "text" => {
                            p.get("text").and_then(|v| v.as_str()).map(|s| s.to_string())
                        }
                        _ => None,
                    }
                })
                .collect::<Vec<_>>()
                .join("\n")
        }
    }
}

/// Converts OpenAI Chat Completions SSE stream → Codex Responses API SSE stream.
pub struct CodexStreamConverter {
    response_id: String,
    item_id: String,
    output_index: u32,
    text_buf: String,
    // Tool call state
    in_tool: bool,
    tool_index: u32,
    tool_call_id: String,
    tool_name: String,
    args_buf: String,
    // Usage
    pub input_tokens: u64,
    pub output_tokens: u64,
    finished: bool,
}

impl CodexStreamConverter {
    pub fn new() -> Self {
        let response_id = format!("resp_{}", &Uuid::new_v4().to_string().replace('-', "")[..24]);
        let item_id = format!("msg_{}", &Uuid::new_v4().to_string().replace('-', "")[..24]);
        Self {
            response_id,
            item_id,
            output_index: 0,
            text_buf: String::new(),
            in_tool: false,
            tool_index: 0,
            tool_call_id: String::new(),
            tool_name: String::new(),
            args_buf: String::new(),
            input_tokens: 0,
            output_tokens: 0,
            finished: false,
        }
    }

    /// Process one OpenAI SSE chunk (parsed JSON), return zero or more Codex SSE event strings.
    pub fn process_chunk(&mut self, chunk: &Value) -> Vec<String> {
        if self.finished {
            return vec![];
        }
        let mut out: Vec<String> = Vec::new();

        // Extract usage if present (streamed with include_usage)
        if let Some(usage) = chunk.get("usage") {
            self.input_tokens = usage.get("prompt_tokens").and_then(|v| v.as_u64()).unwrap_or(self.input_tokens);
            self.output_tokens = usage.get("completion_tokens").and_then(|v| v.as_u64()).unwrap_or(self.output_tokens);
        }

        let choices = match chunk.get("choices").and_then(|v| v.as_array()) {
            Some(c) if !c.is_empty() => c,
            _ => return out,
        };
        let choice = &choices[0];
        let delta = match choice.get("delta") {
            Some(d) => d,
            None => return out,
        };

        // Text delta
        if let Some(content) = delta.get("content").and_then(|v| v.as_str()) {
            if !content.is_empty() {
                self.text_buf.push_str(content);
                out.push(self.make_event(
                    "response.output_text.delta",
                    &json!({
                        "type": "response.output_text.delta",
                        "item_id": self.item_id,
                        "output_index": self.output_index,
                        "content_index": 0,
                        "delta": content
                    }),
                ));
            }
        }

        // Tool calls
        if let Some(tool_calls) = delta.get("tool_calls").and_then(|v| v.as_array()) {
            for tc in tool_calls {
                let idx = tc.get("index").and_then(|v| v.as_u64()).unwrap_or(0) as u32;

                if !self.in_tool || idx != self.tool_index {
                    // Starting a new tool call
                    if self.in_tool {
                        // Close previous tool call item
                        out.extend(self.close_tool_item());
                        self.output_index += 1;
                    }
                    self.in_tool = true;
                    self.tool_index = idx;
                    self.args_buf.clear();

                    let call_id = tc.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    let name = tc.get("function")
                        .and_then(|f| f.get("name"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("").to_string();
                    if !call_id.is_empty() { self.tool_call_id = call_id; }
                    if !name.is_empty() { self.tool_name = name.clone(); }

                    let tc_item_id = format!("fc_{}", &Uuid::new_v4().to_string().replace('-', "")[..20]);
                    // reuse item_id slot for tool
                    self.item_id = tc_item_id.clone();

                    out.push(self.make_event(
                        "response.output_item.added",
                        &json!({
                            "type": "response.output_item.added",
                            "output_index": self.output_index,
                            "item": {
                                "id": tc_item_id,
                                "type": "function_call",
                                "status": "in_progress",
                                "call_id": self.tool_call_id,
                                "name": self.tool_name,
                                "arguments": ""
                            }
                        }),
                    ));
                }

                // Arguments delta
                if let Some(args_delta) = tc.get("function")
                    .and_then(|f| f.get("arguments"))
                    .and_then(|v| v.as_str())
                {
                    if !args_delta.is_empty() {
                        self.args_buf.push_str(args_delta);
                        out.push(self.make_event(
                            "response.function_call_arguments.delta",
                            &json!({
                                "type": "response.function_call_arguments.delta",
                                "item_id": self.item_id,
                                "output_index": self.output_index,
                                "delta": args_delta
                            }),
                        ));
                    }
                }
            }
        }

        // Finish reason
        if let Some(reason) = choice.get("finish_reason").and_then(|v| v.as_str()) {
            if !reason.is_empty() {
                if self.in_tool {
                    out.extend(self.close_tool_item());
                    self.output_index += 1;
                }
                out.extend(self.close_message_item(reason));
                self.finished = true;
            }
        }

        out
    }

    fn close_tool_item(&self) -> Vec<String> {
        vec![self.make_event(
            "response.output_item.done",
            &json!({
                "type": "response.output_item.done",
                "output_index": self.output_index,
                "item": {
                    "id": self.item_id,
                    "type": "function_call",
                    "status": "completed",
                    "call_id": self.tool_call_id,
                    "name": self.tool_name,
                    "arguments": self.args_buf
                }
            }),
        )]
    }

    fn close_message_item(&self, finish_reason: &str) -> Vec<String> {
        let mut events = vec![];
        let status = if finish_reason == "stop" || finish_reason == "tool_calls" {
            "completed"
        } else {
            "incomplete"
        };

        // If there was text output, emit the message item
        if !self.text_buf.is_empty() || finish_reason == "stop" {
            let msg_item_id = if self.in_tool {
                format!("msg_{}", &Uuid::new_v4().to_string().replace('-', "")[..24])
            } else {
                self.item_id.clone()
            };
            events.push(self.make_event(
                "response.output_item.done",
                &json!({
                    "type": "response.output_item.done",
                    "output_index": self.output_index,
                    "item": {
                        "id": msg_item_id,
                        "type": "message",
                        "status": status,
                        "role": "assistant",
                        "content": [{
                            "type": "output_text",
                            "text": self.text_buf,
                            "annotations": []
                        }]
                    }
                }),
            ));
        }

        // response.completed
        events.push(self.make_event(
            "response.completed",
            &json!({
                "type": "response.completed",
                "response": {
                    "id": self.response_id,
                    "object": "response",
                    "status": status,
                    "output": [],
                    "usage": {
                        "input_tokens": self.input_tokens,
                        "output_tokens": self.output_tokens,
                        "total_tokens": self.input_tokens + self.output_tokens
                    }
                }
            }),
        ));

        events
    }

    pub fn flush(&mut self) -> Vec<String> {
        if self.finished {
            return vec![];
        }
        self.finished = true;
        let mut out = vec![];
        if self.in_tool {
            out.extend(self.close_tool_item());
            self.output_index += 1;
        }
        out.extend(self.close_message_item("stop"));
        out
    }

    fn make_event(&self, event_type: &str, data: &Value) -> String {
        format!("event: {}\ndata: {}\n\n", event_type, data)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // ── codex_to_openai_chat ──────────────────────────────────────────────────

    #[test]
    fn test_instructions_become_system_message() {
        let body = json!({
            "model": "gpt-4o",
            "instructions": "You are a helpful assistant.",
            "input": [{"role": "user", "content": [{"type": "input_text", "text": "Hello"}]}]
        });
        let result = codex_to_openai_chat(&body);
        let msgs = result["messages"].as_array().unwrap();
        assert_eq!(msgs[0]["role"], "system");
        assert_eq!(msgs[0]["content"], "You are a helpful assistant.");
        assert_eq!(msgs[1]["role"], "user");
    }

    #[test]
    fn test_empty_instructions_not_added() {
        let body = json!({
            "model": "gpt-4o",
            "instructions": "",
            "input": [{"role": "user", "content": [{"type": "input_text", "text": "Hi"}]}]
        });
        let result = codex_to_openai_chat(&body);
        let msgs = result["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0]["role"], "user");
    }

    #[test]
    fn test_user_message_text_extracted() {
        let body = json!({
            "model": "gpt-4o",
            "input": [{"role": "user", "content": [{"type": "input_text", "text": "What is 2+2?"}]}]
        });
        let result = codex_to_openai_chat(&body);
        let msgs = result["messages"].as_array().unwrap();
        assert_eq!(msgs[0]["role"], "user");
        assert_eq!(msgs[0]["content"], "What is 2+2?");
    }

    #[test]
    fn test_assistant_message_output_text_extracted() {
        let body = json!({
            "model": "gpt-4o",
            "input": [
                {"role": "user", "content": [{"type": "input_text", "text": "Hi"}]},
                {"role": "assistant", "content": [{"type": "output_text", "text": "Hello!"}]}
            ]
        });
        let result = codex_to_openai_chat(&body);
        let msgs = result["messages"].as_array().unwrap();
        assert_eq!(msgs[1]["role"], "assistant");
        assert_eq!(msgs[1]["content"], "Hello!");
    }

    #[test]
    fn test_function_call_becomes_tool_call_message() {
        let body = json!({
            "model": "gpt-4o",
            "input": [{
                "type": "function_call",
                "call_id": "call_abc",
                "name": "bash",
                "arguments": "{\"cmd\":\"ls\"}"
            }]
        });
        let result = codex_to_openai_chat(&body);
        let msgs = result["messages"].as_array().unwrap();
        assert_eq!(msgs[0]["role"], "assistant");
        assert!(msgs[0]["content"].is_null());
        let tc = &msgs[0]["tool_calls"][0];
        assert_eq!(tc["id"], "call_abc");
        assert_eq!(tc["type"], "function");
        assert_eq!(tc["function"]["name"], "bash");
        assert_eq!(tc["function"]["arguments"], "{\"cmd\":\"ls\"}");
    }

    #[test]
    fn test_function_call_output_becomes_tool_message() {
        let body = json!({
            "model": "gpt-4o",
            "input": [{
                "type": "function_call_output",
                "call_id": "call_abc",
                "output": "file1.txt\nfile2.txt"
            }]
        });
        let result = codex_to_openai_chat(&body);
        let msgs = result["messages"].as_array().unwrap();
        assert_eq!(msgs[0]["role"], "tool");
        assert_eq!(msgs[0]["tool_call_id"], "call_abc");
        assert_eq!(msgs[0]["content"], "file1.txt\nfile2.txt");
    }

    #[test]
    fn test_tools_passthrough() {
        let body = json!({
            "model": "gpt-4o",
            "input": [{"role": "user", "content": [{"type": "input_text", "text": "run ls"}]}],
            "tools": [{"type": "function", "function": {"name": "bash", "parameters": {}}}]
        });
        let result = codex_to_openai_chat(&body);
        let tools = result["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0]["function"]["name"], "bash");
    }

    #[test]
    fn test_stream_adds_stream_options() {
        let body = json!({
            "model": "gpt-4o",
            "stream": true,
            "input": [{"role": "user", "content": [{"type": "input_text", "text": "hi"}]}]
        });
        let result = codex_to_openai_chat(&body);
        assert_eq!(result["stream"], true);
        assert_eq!(result["stream_options"]["include_usage"], true);
    }

    #[test]
    fn test_no_stream_no_stream_options() {
        let body = json!({
            "model": "gpt-4o",
            "stream": false,
            "input": [{"role": "user", "content": [{"type": "input_text", "text": "hi"}]}]
        });
        let result = codex_to_openai_chat(&body);
        assert!(result.get("stream_options").is_none() || result["stream_options"].is_null());
    }

    #[test]
    fn test_optional_fields_passthrough() {
        let body = json!({
            "model": "gpt-4o",
            "input": [{"role": "user", "content": [{"type": "input_text", "text": "hi"}]}],
            "temperature": 0.7,
            "max_tokens": 200
        });
        let result = codex_to_openai_chat(&body);
        assert_eq!(result["temperature"], 0.7);
        assert_eq!(result["max_tokens"], 200);
    }

    #[test]
    fn test_multi_turn_conversation() {
        let body = json!({
            "model": "gpt-4o",
            "instructions": "Be helpful.",
            "input": [
                {"role": "user", "content": [{"type": "input_text", "text": "What's 1+1?"}]},
                {"role": "assistant", "content": [{"type": "output_text", "text": "2"}]},
                {"role": "user", "content": [{"type": "input_text", "text": "And 2+2?"}]}
            ]
        });
        let result = codex_to_openai_chat(&body);
        let msgs = result["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), 4); // system + 3 turns
        assert_eq!(msgs[0]["role"], "system");
        assert_eq!(msgs[1]["role"], "user");
        assert_eq!(msgs[2]["role"], "assistant");
        assert_eq!(msgs[3]["role"], "user");
        assert_eq!(msgs[3]["content"], "And 2+2?");
    }

    #[test]
    fn test_model_defaults_to_gpt4o_if_missing() {
        let body = json!({
            "input": [{"role": "user", "content": [{"type": "input_text", "text": "hi"}]}]
        });
        let result = codex_to_openai_chat(&body);
        assert_eq!(result["model"], "gpt-4o");
    }

    // ── CodexStreamConverter ──────────────────────────────────────────────────

    fn parse_events(raw: &[String]) -> Vec<(String, Value)> {
        raw.iter().filter_map(|s| {
            let mut event_type = String::new();
            let mut data = String::new();
            for line in s.lines() {
                if let Some(et) = line.strip_prefix("event: ") { event_type = et.to_string(); }
                if let Some(d)  = line.strip_prefix("data: ")  { data = d.to_string(); }
            }
            if event_type.is_empty() { return None; }
            let v = serde_json::from_str::<Value>(&data).unwrap_or(Value::Null);
            Some((event_type, v))
        }).collect()
    }

    #[test]
    fn test_converter_text_delta_emitted() {
        let mut c = CodexStreamConverter::new();
        let chunk = json!({
            "choices": [{"delta": {"content": "Hello"}, "finish_reason": null}]
        });
        let events = c.process_chunk(&chunk);
        let parsed = parse_events(&events);
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].0, "response.output_text.delta");
        assert_eq!(parsed[0].1["delta"], "Hello");
    }

    #[test]
    fn test_converter_empty_content_not_emitted() {
        let mut c = CodexStreamConverter::new();
        let chunk = json!({
            "choices": [{"delta": {"content": ""}, "finish_reason": null}]
        });
        let events = c.process_chunk(&chunk);
        assert!(events.is_empty());
    }

    #[test]
    fn test_converter_finish_reason_stop_emits_done_and_completed() {
        let mut c = CodexStreamConverter::new();
        // First send some text
        c.process_chunk(&json!({"choices": [{"delta": {"content": "Hi"}, "finish_reason": null}]}));
        // Then finish
        let events = c.process_chunk(&json!({"choices": [{"delta": {}, "finish_reason": "stop"}]}));
        let parsed = parse_events(&events);
        let types: Vec<&str> = parsed.iter().map(|(t, _)| t.as_str()).collect();
        assert!(types.contains(&"response.output_item.done"), "expected output_item.done, got {:?}", types);
        assert!(types.contains(&"response.completed"), "expected response.completed, got {:?}", types);
    }

    #[test]
    fn test_converter_no_events_after_finished() {
        let mut c = CodexStreamConverter::new();
        c.process_chunk(&json!({"choices": [{"delta": {}, "finish_reason": "stop"}]}));
        // further chunks should be ignored
        let events = c.process_chunk(&json!({"choices": [{"delta": {"content": "extra"}, "finish_reason": null}]}));
        assert!(events.is_empty());
    }

    #[test]
    fn test_converter_usage_tracked() {
        let mut c = CodexStreamConverter::new();
        c.process_chunk(&json!({
            "choices": [{"delta": {"content": "hi"}, "finish_reason": null}],
            "usage": {"prompt_tokens": 10, "completion_tokens": 5}
        }));
        assert_eq!(c.input_tokens, 10);
        assert_eq!(c.output_tokens, 5);
    }

    #[test]
    fn test_converter_tool_call_emits_function_call_events() {
        let mut c = CodexStreamConverter::new();
        // Tool call start with id and name
        let events1 = c.process_chunk(&json!({
            "choices": [{"delta": {
                "tool_calls": [{"index": 0, "id": "call_x", "type": "function",
                    "function": {"name": "bash", "arguments": ""}}]
            }, "finish_reason": null}]
        }));
        let parsed1 = parse_events(&events1);
        let types1: Vec<&str> = parsed1.iter().map(|(t, _)| t.as_str()).collect();
        assert!(types1.contains(&"response.output_item.added"), "got {:?}", types1);

        // Arguments delta
        let events2 = c.process_chunk(&json!({
            "choices": [{"delta": {
                "tool_calls": [{"index": 0, "function": {"arguments": "{\"cmd\":"}}]
            }, "finish_reason": null}]
        }));
        let parsed2 = parse_events(&events2);
        assert!(parsed2.iter().any(|(t, _)| t == "response.function_call_arguments.delta"));

        // Finish
        let events3 = c.process_chunk(&json!({
            "choices": [{"delta": {
                "tool_calls": [{"index": 0, "function": {"arguments": "\"ls\"}"}}]
            }, "finish_reason": "tool_calls"}]
        }));
        let parsed3 = parse_events(&events3);
        let types3: Vec<&str> = parsed3.iter().map(|(t, _)| t.as_str()).collect();
        assert!(types3.contains(&"response.output_item.done"), "got {:?}", types3);
        assert!(types3.contains(&"response.completed"), "got {:?}", types3);
    }

    #[test]
    fn test_converter_flush_closes_open_stream() {
        let mut c = CodexStreamConverter::new();
        c.process_chunk(&json!({"choices": [{"delta": {"content": "partial"}, "finish_reason": null}]}));
        let events = c.flush();
        let parsed = parse_events(&events);
        let types: Vec<&str> = parsed.iter().map(|(t, _)| t.as_str()).collect();
        assert!(types.contains(&"response.output_item.done"));
        assert!(types.contains(&"response.completed"));
    }

    #[test]
    fn test_converter_flush_idempotent() {
        let mut c = CodexStreamConverter::new();
        c.process_chunk(&json!({"choices": [{"delta": {}, "finish_reason": "stop"}]}));
        let events = c.flush(); // already finished
        assert!(events.is_empty());
    }

    #[test]
    fn test_converter_completed_event_has_usage() {
        let mut c = CodexStreamConverter::new();
        c.process_chunk(&json!({
            "choices": [{"delta": {"content": "ok"}, "finish_reason": null}],
            "usage": {"prompt_tokens": 8, "completion_tokens": 3}
        }));
        let events = c.process_chunk(&json!({
            "choices": [{"delta": {}, "finish_reason": "stop"}]
        }));
        let parsed = parse_events(&events);
        let completed = parsed.iter().find(|(t, _)| t == "response.completed").unwrap();
        assert_eq!(completed.1["response"]["usage"]["input_tokens"], 8);
        assert_eq!(completed.1["response"]["usage"]["output_tokens"], 3);
        assert_eq!(completed.1["response"]["usage"]["total_tokens"], 11);
    }
}
