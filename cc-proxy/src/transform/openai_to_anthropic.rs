use serde_json::{json, Value};
use std::collections::HashMap;

pub fn transform_response(openai_resp: &Value) -> Result<Value, String> {
    let choice = openai_resp
        .get("choices")
        .and_then(|c| c.as_array())
        .and_then(|c| c.first())
        .ok_or("Missing choices in OpenAI response")?;

    let message = choice.get("message").ok_or("Missing message in choice")?;
    let finish_reason = choice
        .get("finish_reason")
        .and_then(|f| f.as_str())
        .unwrap_or("end_turn");

    let mut content_blocks: Vec<Value> = Vec::new();

    if let Some(reasoning) = message.get("reasoning_content").and_then(|c| c.as_str()) {
        if !reasoning.is_empty() {
            content_blocks.push(json!({
                "type": "text",
                "text": format!("[Reasoning]\n{reasoning}")
            }));
        }
    }

    if let Some(text) = message.get("content").and_then(|c| c.as_str()) {
        if !text.is_empty() {
            content_blocks.push(json!({"type": "text", "text": text}));
        }
    }

    if let Some(tool_calls) = message.get("tool_calls").and_then(|t| t.as_array()) {
        for (idx, tc) in tool_calls.iter().enumerate() {
            let id = tc.get("id").and_then(|id| id.as_str())
                .map(String::from)
                .unwrap_or_else(|| generate_tool_id(idx as u64));
            if let Some(func) = tc.get("function") {
                let name = func.get("name").and_then(|n| n.as_str()).unwrap_or("");
                let args_str = func.get("arguments").and_then(|a| a.as_str()).unwrap_or("{}");
                let input: Value = serde_json::from_str(args_str)
                    .or_else(|_| serde_json::from_str(&repair_json(args_str)))
                    .unwrap_or(json!({}));
                content_blocks.push(json!({
                    "type": "tool_use",
                    "id": id,
                    "name": name,
                    "input": input
                }));
            }
        }
    }

    if let Some(annotations) = message.get("annotations").and_then(|a| a.as_array()) {
        for ann in annotations {
            if let Some(ann_type) = ann.get("type").and_then(|t| t.as_str()) {
                if ann_type == "url_citation" {
                    let url = ann.get("url").and_then(|u| u.as_str()).unwrap_or("");
                    let title = ann.get("title").and_then(|t| t.as_str()).unwrap_or("");
                    content_blocks.push(json!({
                        "type": "text",
                        "text": format!("[{}]({})", title, url)
                    }));
                }
            }
        }
    }

    if content_blocks.is_empty() {
        content_blocks.push(json!({"type": "text", "text": ""}));
    }

    let stop_reason = map_finish_reason(finish_reason);

    let usage = openai_resp.get("usage");
    let input_tokens = usage
        .and_then(|u| u.get("prompt_tokens"))
        .and_then(|t| t.as_u64())
        .unwrap_or(0);
    let output_tokens = usage
        .and_then(|u| u.get("completion_tokens"))
        .and_then(|t| t.as_u64())
        .unwrap_or(0);

    Ok(json!({
        "id": openai_resp.get("id").and_then(|id| id.as_str()).unwrap_or("msg_proxy"),
        "type": "message",
        "role": "assistant",
        "content": content_blocks,
        "model": openai_resp.get("model").and_then(|m| m.as_str()).unwrap_or("unknown"),
        "stop_reason": stop_reason,
        "stop_sequence": null,
        "usage": {
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "cache_creation_input_tokens": 0,
            "cache_read_input_tokens": 0
        }
    }))
}

fn map_finish_reason(reason: &str) -> &str {
    match reason {
        "stop" => "end_turn",
        "length" => "max_tokens",
        "tool_calls" | "function_call" => "tool_use",
        "content_filter" => "end_turn",
        _ => "end_turn",
    }
}

fn generate_tool_id(index: u64) -> String {
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    format!("toolu_{:x}_{}", ts, index)
}

fn repair_json(s: &str) -> String {
    let trimmed = s.trim();
    if trimmed.is_empty() {
        return "{}".to_string();
    }

    let mut result = trimmed.to_string();

    if !result.starts_with('{') && !result.starts_with('[') {
        result = format!("{{{}}}", result);
    }

    let open_braces = result.chars().filter(|&c| c == '{').count();
    let close_braces = result.chars().filter(|&c| c == '}').count();
    for _ in 0..(open_braces.saturating_sub(close_braces)) {
        result.push('}');
    }

    let open_brackets = result.chars().filter(|&c| c == '[').count();
    let close_brackets = result.chars().filter(|&c| c == ']').count();
    for _ in 0..(open_brackets.saturating_sub(close_brackets)) {
        result.push(']');
    }

    if result.contains(",}") {
        result = result.replace(",}", "}");
    }
    if result.contains(",]") {
        result = result.replace(",]", "]");
    }

    result
}

struct ToolCallState {
    id: String,
    name: String,
    arguments: String,
    block_index: i64,
}

pub struct StreamState {
    pub model: String,
    pub message_id: String,
    content_block_index: i64,
    reasoning_block_index: i64,
    started: bool,
    finished: bool,
    has_text_block: bool,
    in_thinking: bool,
    reasoning_header_sent: bool,
    tool_calls: HashMap<u64, ToolCallState>,
    pub input_tokens: u64,
    pub output_tokens: u64,
    text_buf: String,
    thinking_buf: String,
    stop_reason: Option<String>,
}

impl StreamState {
    pub fn new(model: String) -> Self {
        Self {
            model,
            message_id: format!("msg_{}", uuid::Uuid::new_v4().to_string().replace('-', "")),
            content_block_index: -1,
            reasoning_block_index: -1,
            started: false,
            finished: false,
            has_text_block: false,
            in_thinking: false,
            reasoning_header_sent: false,
            tool_calls: HashMap::new(),
            input_tokens: 0,
            output_tokens: 0,
            text_buf: String::new(),
            thinking_buf: String::new(),
            stop_reason: None,
        }
    }

    pub fn process_chunk(&mut self, chunk: &Value) -> Vec<String> {
        let mut events: Vec<String> = Vec::new();

        if !self.started {
            self.started = true;
            events.push(format_sse("message_start", &json!({
                "type": "message_start",
                "message": {
                    "id": self.message_id,
                    "type": "message",
                    "role": "assistant",
                    "content": [],
                    "model": self.model,
                    "stop_reason": null,
                    "stop_sequence": null,
                    "usage": {"input_tokens": 0, "output_tokens": 0}
                }
            })));
        }

        if let Some(usage) = chunk.get("usage") {
            if let Some(pt) = usage.get("prompt_tokens").and_then(|t| t.as_u64()) {
                self.input_tokens = pt;
            }
            if let Some(ct) = usage.get("completion_tokens").and_then(|t| t.as_u64()) {
                self.output_tokens = ct;
            }
            // GLM sends usage in a separate chunk after finish_reason (choices=[]).
            // At that point self.finished is already true and the earlier message_delta
            // was emitted with output_tokens=0. Send a corrective message_delta so
            // Claude Code sees the real token counts for /context display.
            if self.finished && (self.input_tokens > 0 || self.output_tokens > 0) {
                events.push(format_sse("message_delta", &json!({
                    "type": "message_delta",
                    "delta": {"stop_reason": self.stop_reason.as_deref().unwrap_or("end_turn"), "stop_sequence": null},
                    "usage": {
                        "input_tokens": self.input_tokens,
                        "output_tokens": self.output_tokens
                    }
                })));
            }
        }

        let choices = chunk.get("choices").and_then(|c| c.as_array());
        let Some(choices) = choices else {
            return events;
        };

        for choice in choices {
            let delta = match choice.get("delta") {
                Some(d) => d,
                None => continue,
            };

            if let Some(reasoning) = delta.get("reasoning_content").and_then(|c| c.as_str()) {
                if !reasoning.is_empty() {
                    self.thinking_buf.push_str(reasoning);
                    if self.reasoning_block_index < 0 {
                        // First reasoning chunk: open a new block
                        self.close_current_block(&mut events);
                        self.content_block_index += 1;
                        self.reasoning_block_index = self.content_block_index;
                        self.in_thinking = true;
                        events.push(format_sse("content_block_start", &json!({
                            "type": "content_block_start",
                            "index": self.content_block_index,
                            "content_block": {"type": "text", "text": ""}
                        })));
                        // [Reasoning] header emitted exactly once when the block is opened
                        self.reasoning_header_sent = true;
                        events.push(format_sse("content_block_delta", &json!({
                            "type": "content_block_delta",
                            "index": self.content_block_index,
                            "delta": {"type": "text_delta", "text": "[Reasoning]\n"}
                        })));
                    } else {
                        // Subsequent reasoning chunk: reuse the existing reasoning block.
                        // If we are currently in a text block, close that text block first,
                        // then resume writing into the already-opened reasoning block.
                        // We must NOT send content_block_stop for the reasoning block itself —
                        // closing it prevents further deltas to that index (Claude Code UI
                        // would treat the next delta as a new block and re-emit [Reasoning]).
                        if !self.in_thinking {
                            self.close_current_block(&mut events);
                            self.in_thinking = true;
                            self.content_block_index = self.reasoning_block_index;
                        }
                    }
                    events.push(format_sse("content_block_delta", &json!({
                        "type": "content_block_delta",
                        "index": self.reasoning_block_index,
                        "delta": {"type": "text_delta", "text": reasoning}
                    })));
                }
            }

            if let Some(content) = delta.get("content").and_then(|c| c.as_str()) {
                if !content.is_empty() {
                    self.text_buf.push_str(content);
                    if self.in_thinking {
                        // Transitioning from reasoning → content.
                        // Do NOT close the reasoning block here: sending content_block_stop
                        // for index 0 would prevent further reasoning deltas from being
                        // written to that index later (GLM-5.1 can interleave them).
                        // Instead, just leave it open and open a new text block on the
                        // next available index.
                        self.in_thinking = false;
                        self.content_block_index += 1;
                        self.has_text_block = true;
                        events.push(format_sse("content_block_start", &json!({
                            "type": "content_block_start",
                            "index": self.content_block_index,
                            "content_block": {"type": "text", "text": ""}
                        })));
                    } else if !self.has_text_block || self.current_is_tool() {
                        self.close_current_block(&mut events);
                        self.content_block_index += 1;
                        self.has_text_block = true;
                        events.push(format_sse("content_block_start", &json!({
                            "type": "content_block_start",
                            "index": self.content_block_index,
                            "content_block": {"type": "text", "text": ""}
                        })));
                    }
                    events.push(format_sse("content_block_delta", &json!({
                        "type": "content_block_delta",
                        "index": self.content_block_index,
                        "delta": {"type": "text_delta", "text": content}
                    })));
                }
            }

            if let Some(tool_calls) = delta.get("tool_calls").and_then(|t| t.as_array()) {
                for tc in tool_calls {
                    let tc_index = tc.get("index").and_then(|i| i.as_u64()).unwrap_or(0);

                    if let Some(func) = tc.get("function") {
                        if let Some(name) = func.get("name").and_then(|n| n.as_str()) {
                            if self.in_thinking {
                                self.close_current_block(&mut events);
                                self.in_thinking = false;
                            }
                            self.close_current_block(&mut events);
                            self.has_text_block = false;
                            self.content_block_index += 1;

                            let tc_id = tc.get("id").and_then(|id| id.as_str())
                                .map(String::from)
                                .unwrap_or_else(|| generate_tool_id(tc_index));

                            self.tool_calls.insert(tc_index, ToolCallState {
                                id: tc_id.clone(),
                                name: name.to_string(),
                                arguments: String::new(),
                                block_index: self.content_block_index,
                            });

                            events.push(format_sse("content_block_start", &json!({
                                "type": "content_block_start",
                                "index": self.content_block_index,
                                "content_block": {
                                    "type": "tool_use",
                                    "id": tc_id,
                                    "name": name,
                                    "input": {}
                                }
                            })));
                        }

                        if let Some(args) = func.get("arguments").and_then(|a| a.as_str()) {
                            if !args.is_empty() {
                                if let Some(state) = self.tool_calls.get_mut(&tc_index) {
                                    state.arguments.push_str(args);
                                    events.push(format_sse("content_block_delta", &json!({
                                        "type": "content_block_delta",
                                        "index": state.block_index,
                                        "delta": {
                                            "type": "input_json_delta",
                                            "partial_json": args
                                        }
                                    })));
                                }
                            }
                        }
                    }
                }
            }

            if !self.finished {
                if let Some(finish_reason) = choice.get("finish_reason").and_then(|f| f.as_str()) {
                    self.close_current_block(&mut events);
                    // If we left the reasoning block open (interleaved GLM-5.1 stream),
                    // close it now too before ending the message.
                    if !self.in_thinking && self.reasoning_block_index >= 0
                        && self.reasoning_block_index != self.content_block_index
                    {
                        events.push(format_sse("content_block_stop", &json!({
                            "type": "content_block_stop",
                            "index": self.reasoning_block_index
                        })));
                    }
                    self.in_thinking = false;
                    self.finished = true;
                    let stop_reason = map_finish_reason(finish_reason);
                    self.stop_reason = Some(stop_reason.to_string());
                    events.push(format_sse("message_delta", &json!({
                        "type": "message_delta",
                        "delta": {"stop_reason": stop_reason, "stop_sequence": null},
                        "usage": {"output_tokens": self.output_tokens}
                    })));
                    events.push(format_sse("message_stop", &json!({"type": "message_stop"})));
                }
            }
        }

        events
    }

    pub fn flush(&mut self) -> Vec<String> {
        if self.finished {
            return Vec::new();
        }
        let mut events = Vec::new();
        if self.started && self.content_block_index >= 0 {
            self.close_current_block(&mut events);
            if !self.in_thinking && self.reasoning_block_index >= 0
                && self.reasoning_block_index != self.content_block_index
            {
                events.push(format_sse("content_block_stop", &json!({
                    "type": "content_block_stop",
                    "index": self.reasoning_block_index
                })));
            }
        }
        if self.started {
            self.finished = true;
            events.push(format_sse("message_delta", &json!({
                "type": "message_delta",
                "delta": {"stop_reason": "end_turn", "stop_sequence": null},
                "usage": {"output_tokens": self.output_tokens}
            })));
            events.push(format_sse("message_stop", &json!({"type": "message_stop"})));
        }
        events
    }

    pub fn ping_event() -> String {
        "event: ping\ndata: {\"type\": \"ping\"}\n\n".to_string()
    }

    /// Returns the text accumulated so far (for mid-stream failover/continuation).
    pub fn accumulated_text(&self) -> &str {
        &self.text_buf
    }

    pub fn finalize(&self) -> Value {
        let mut content_blocks: Vec<Value> = Vec::new();

        if !self.thinking_buf.is_empty() {
            content_blocks.push(json!({
                "type": "text",
                "text": format!("[Reasoning]\n{}", self.thinking_buf)
            }));
        }

        if !self.text_buf.is_empty() {
            content_blocks.push(json!({
                "type": "text",
                "text": self.text_buf
            }));
        }

        for (_idx, tc) in &self.tool_calls {
            let input: Value = serde_json::from_str(&tc.arguments)
                .unwrap_or(json!({}));
            content_blocks.push(json!({
                "type": "tool_use",
                "id": tc.id,
                "name": tc.name,
                "input": input
            }));
        }

        json!({
            "id": self.message_id,
            "type": "message",
            "role": "assistant",
            "model": self.model,
            "content": content_blocks,
            "stop_reason": self.stop_reason,
            "usage": {
                "input_tokens": self.input_tokens,
                "output_tokens": self.output_tokens,
            }
        })
    }

    fn close_current_block(&mut self, events: &mut Vec<String>) {
        if self.content_block_index >= 0 {
            events.push(format_sse("content_block_stop", &json!({
                "type": "content_block_stop",
                "index": self.content_block_index
            })));
        }
    }

    fn current_is_tool(&self) -> bool {
        self.tool_calls.values().any(|tc| tc.block_index == self.content_block_index)
    }
}

fn format_sse(event: &str, data: &Value) -> String {
    format!("event: {event}\ndata: {}\n\n", serde_json::to_string(data).unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_simple_text_response() {
        let openai = json!({
            "id": "chatcmpl-123",
            "model": "gpt-4",
            "choices": [{
                "index": 0,
                "message": {"role": "assistant", "content": "Hello!"},
                "finish_reason": "stop"
            }],
            "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}
        });
        let result = transform_response(&openai).unwrap();
        assert_eq!(result["type"], "message");
        assert_eq!(result["role"], "assistant");
        assert_eq!(result["stop_reason"], "end_turn");
        let content = result["content"].as_array().unwrap();
        assert_eq!(content.len(), 1);
        assert_eq!(content[0]["type"], "text");
        assert_eq!(content[0]["text"], "Hello!");
        assert_eq!(result["usage"]["input_tokens"], 10);
        assert_eq!(result["usage"]["output_tokens"], 5);
    }

    #[test]
    fn test_tool_call_response() {
        let openai = json!({
            "id": "chatcmpl-456",
            "model": "gpt-4",
            "choices": [{
                "index": 0,
                "message": {
                    "role": "assistant",
                    "content": null,
                    "tool_calls": [{
                        "id": "call_abc",
                        "type": "function",
                        "function": {
                            "name": "get_weather",
                            "arguments": "{\"location\":\"Tokyo\"}"
                        }
                    }]
                },
                "finish_reason": "tool_calls"
            }],
            "usage": {"prompt_tokens": 20, "completion_tokens": 10}
        });
        let result = transform_response(&openai).unwrap();
        assert_eq!(result["stop_reason"], "tool_use");
        let content = result["content"].as_array().unwrap();
        assert_eq!(content.len(), 1);
        assert_eq!(content[0]["type"], "tool_use");
        assert_eq!(content[0]["id"], "call_abc");
        assert_eq!(content[0]["name"], "get_weather");
        assert_eq!(content[0]["input"]["location"], "Tokyo");
    }

    #[test]
    fn test_tool_call_missing_id_gets_generated() {
        let openai = json!({
            "id": "chatcmpl-x",
            "model": "gpt-4",
            "choices": [{
                "index": 0,
                "message": {
                    "role": "assistant",
                    "content": null,
                    "tool_calls": [{
                        "type": "function",
                        "function": {"name": "search", "arguments": "{}"}
                    }]
                },
                "finish_reason": "tool_calls"
            }],
            "usage": {"prompt_tokens": 5, "completion_tokens": 3}
        });
        let result = transform_response(&openai).unwrap();
        let content = result["content"].as_array().unwrap();
        let id = content[0]["id"].as_str().unwrap();
        assert!(id.starts_with("toolu_"));
    }

    #[test]
    fn test_tool_call_malformed_arguments_repaired() {
        let openai = json!({
            "id": "chatcmpl-repair",
            "model": "gpt-4",
            "choices": [{
                "index": 0,
                "message": {
                    "role": "assistant",
                    "content": null,
                    "tool_calls": [{
                        "id": "call_1",
                        "type": "function",
                        "function": {"name": "foo", "arguments": "{\"a\": 1,}"}
                    }]
                },
                "finish_reason": "tool_calls"
            }],
            "usage": {"prompt_tokens": 5, "completion_tokens": 3}
        });
        let result = transform_response(&openai).unwrap();
        let content = result["content"].as_array().unwrap();
        assert_eq!(content[0]["input"]["a"], 1);
    }

    #[test]
    fn test_reasoning_content_response() {
        let openai = json!({
            "id": "chatcmpl-think",
            "model": "deepseek-r1",
            "choices": [{
                "index": 0,
                "message": {
                    "role": "assistant",
                    "reasoning_content": "Let me think...",
                    "content": "The answer is 42."
                },
                "finish_reason": "stop"
            }],
            "usage": {"prompt_tokens": 10, "completion_tokens": 20}
        });
        let result = transform_response(&openai).unwrap();
        let content = result["content"].as_array().unwrap();
        assert_eq!(content.len(), 2);
        assert_eq!(content[0]["type"], "text");
        assert_eq!(content[0]["text"], "[Reasoning]\nLet me think...");
        assert_eq!(content[1]["type"], "text");
        assert_eq!(content[1]["text"], "The answer is 42.");
    }

    #[test]
    fn test_text_and_tool_call_response() {
        let openai = json!({
            "id": "chatcmpl-789",
            "model": "gpt-4",
            "choices": [{
                "index": 0,
                "message": {
                    "role": "assistant",
                    "content": "Let me check the weather.",
                    "tool_calls": [{
                        "id": "call_xyz",
                        "type": "function",
                        "function": {
                            "name": "get_weather",
                            "arguments": "{\"city\":\"London\"}"
                        }
                    }]
                },
                "finish_reason": "tool_calls"
            }],
            "usage": {"prompt_tokens": 15, "completion_tokens": 8}
        });
        let result = transform_response(&openai).unwrap();
        let content = result["content"].as_array().unwrap();
        assert_eq!(content.len(), 2);
        assert_eq!(content[0]["type"], "text");
        assert_eq!(content[0]["text"], "Let me check the weather.");
        assert_eq!(content[1]["type"], "tool_use");
    }

    #[test]
    fn test_finish_reason_mapping() {
        assert_eq!(map_finish_reason("stop"), "end_turn");
        assert_eq!(map_finish_reason("length"), "max_tokens");
        assert_eq!(map_finish_reason("tool_calls"), "tool_use");
        assert_eq!(map_finish_reason("function_call"), "tool_use");
        assert_eq!(map_finish_reason("content_filter"), "end_turn");
        assert_eq!(map_finish_reason("unknown"), "end_turn");
    }

    #[test]
    fn test_empty_content_gets_placeholder() {
        let openai = json!({
            "id": "chatcmpl-empty",
            "model": "gpt-4",
            "choices": [{
                "index": 0,
                "message": {"role": "assistant", "content": ""},
                "finish_reason": "stop"
            }],
            "usage": {"prompt_tokens": 5, "completion_tokens": 0}
        });
        let result = transform_response(&openai).unwrap();
        let content = result["content"].as_array().unwrap();
        assert_eq!(content.len(), 1);
        assert_eq!(content[0]["type"], "text");
    }

    #[test]
    fn test_missing_usage() {
        let openai = json!({
            "id": "chatcmpl-nousage",
            "model": "gpt-4",
            "choices": [{
                "index": 0,
                "message": {"role": "assistant", "content": "Hi"},
                "finish_reason": "stop"
            }]
        });
        let result = transform_response(&openai).unwrap();
        assert_eq!(result["usage"]["input_tokens"], 0);
        assert_eq!(result["usage"]["output_tokens"], 0);
    }

    #[test]
    fn test_missing_choices() {
        let openai = json!({"id": "bad", "model": "gpt-4"});
        assert!(transform_response(&openai).is_err());
    }

    // ── Streaming tests ──

    #[test]
    fn test_stream_first_text_chunk() {
        let mut state = StreamState::new("gpt-4".to_string());
        let chunk = json!({
            "choices": [{
                "delta": {"role": "assistant", "content": "Hello"},
                "index": 0
            }]
        });
        let events = state.process_chunk(&chunk);
        assert!(state.started);
        let joined = events.join("");
        assert!(joined.contains("message_start"));
        assert!(joined.contains("content_block_start"));
        assert!(joined.contains("text_delta"));
        assert!(joined.contains("Hello"));
    }

    #[test]
    fn test_stream_reasoning_content_is_text_delta() {
        let mut state = StreamState::new("kimi".to_string());
        let events = state.process_chunk(&json!({
            "choices": [{
                "delta": {"reasoning_content": "thinking..."},
                "index": 0
            }]
        }));
        let joined = events.join("");
        assert!(joined.contains("content_block_start"));
        assert!(joined.contains("\"type\":\"text\""));
        assert!(joined.contains("text_delta"));
        assert!(joined.contains("[Reasoning]\\n"));
        assert!(joined.contains("thinking..."));
        assert!(!joined.contains("thinking_delta"));
        assert!(!joined.contains("\"type\":\"thinking\""));
    }

    #[test]
    fn test_stream_subsequent_text_chunks() {
        let mut state = StreamState::new("gpt-4".to_string());
        state.process_chunk(&json!({
            "choices": [{"delta": {"content": "Hello"}, "index": 0}]
        }));
        let events = state.process_chunk(&json!({
            "choices": [{"delta": {"content": " world"}, "index": 0}]
        }));
        let joined = events.join("");
        assert!(joined.contains("text_delta"));
        assert!(joined.contains(" world"));
        assert!(!joined.contains("message_start"));
    }

    #[test]
    fn test_stream_tool_call_with_index() {
        let mut state = StreamState::new("gpt-4".to_string());
        let chunk = json!({
            "choices": [{
                "delta": {
                    "tool_calls": [{
                        "index": 0,
                        "id": "call_1",
                        "type": "function",
                        "function": {"name": "search", "arguments": ""}
                    }]
                },
                "index": 0
            }]
        });
        let events = state.process_chunk(&chunk);
        let joined = events.join("");
        assert!(joined.contains("content_block_start"));
        assert!(joined.contains("tool_use"));
        assert!(joined.contains("search"));
        assert!(joined.contains("call_1"));
    }

    #[test]
    fn test_stream_parallel_tool_calls() {
        let mut state = StreamState::new("gpt-4".to_string());
        state.process_chunk(&json!({
            "choices": [{"delta": {
                "tool_calls": [{
                    "index": 0, "id": "call_a", "type": "function",
                    "function": {"name": "read", "arguments": ""}
                }]
            }, "index": 0}]
        }));
        state.process_chunk(&json!({
            "choices": [{"delta": {
                "tool_calls": [{
                    "index": 1, "id": "call_b", "type": "function",
                    "function": {"name": "write", "arguments": ""}
                }]
            }, "index": 0}]
        }));

        assert_eq!(state.tool_calls.len(), 2);
        assert_eq!(state.tool_calls[&0].name, "read");
        assert_eq!(state.tool_calls[&1].name, "write");
        assert_eq!(state.content_block_index, 1);
    }

    #[test]
    fn test_stream_tool_call_arguments_accumulated() {
        let mut state = StreamState::new("gpt-4".to_string());
        state.process_chunk(&json!({
            "choices": [{"delta": {
                "tool_calls": [{
                    "index": 0, "id": "call_1", "type": "function",
                    "function": {"name": "search", "arguments": ""}
                }]
            }, "index": 0}]
        }));
        state.process_chunk(&json!({
            "choices": [{"delta": {
                "tool_calls": [{"index": 0, "function": {"arguments": "{\"q\":"}}]
            }, "index": 0}]
        }));
        state.process_chunk(&json!({
            "choices": [{"delta": {
                "tool_calls": [{"index": 0, "function": {"arguments": "\"rust\"}"}}]
            }, "index": 0}]
        }));

        assert_eq!(state.tool_calls[&0].arguments, "{\"q\":\"rust\"}");
    }

    #[test]
    fn test_stream_tool_call_missing_id_generated() {
        let mut state = StreamState::new("gpt-4".to_string());
        let events = state.process_chunk(&json!({
            "choices": [{"delta": {
                "tool_calls": [{
                    "index": 0,
                    "type": "function",
                    "function": {"name": "foo", "arguments": ""}
                }]
            }, "index": 0}]
        }));
        let joined = events.join("");
        assert!(joined.contains("toolu_"));
    }

    #[test]
    fn test_stream_reasoning_content() {
        let mut state = StreamState::new("deepseek".to_string());
        let events = state.process_chunk(&json!({
            "choices": [{"delta": {"reasoning_content": "Let me think..."}, "index": 0}]
        }));
        let joined = events.join("");
        assert!(joined.contains("\"type\":\"text\""));
        assert!(joined.contains("text_delta"));
        assert!(joined.contains("[Reasoning]\\n"));
        assert!(joined.contains("Let me think..."));
        assert!(!joined.contains("thinking_delta"));

        let events2 = state.process_chunk(&json!({
            "choices": [{"delta": {"content": "Answer"}, "index": 0}]
        }));
        let joined2 = events2.join("");
        // reasoning block stays open (no content_block_stop yet — it's closed at finish_reason)
        assert!(joined2.contains("content_block_start"), "new text block opened");
        assert!(joined2.contains("text_delta"));
        assert!(joined2.contains("Answer"));
    }

    #[test]
    fn test_stream_finish() {
        let mut state = StreamState::new("gpt-4".to_string());
        state.process_chunk(&json!({
            "choices": [{"delta": {"content": "Hi"}, "index": 0}]
        }));
        let events = state.process_chunk(&json!({
            "choices": [{"delta": {}, "finish_reason": "stop", "index": 0}]
        }));
        let joined = events.join("");
        assert!(joined.contains("content_block_stop"));
        assert!(joined.contains("message_delta"));
        assert!(joined.contains("end_turn"));
        assert!(joined.contains("message_stop"));
    }

    #[test]
    fn test_stream_usage_tracking() {
        let mut state = StreamState::new("gpt-4".to_string());
        state.process_chunk(&json!({
            "choices": [{"delta": {"content": "Hi"}, "index": 0}],
            "usage": {"prompt_tokens": 42, "completion_tokens": 7}
        }));
        assert_eq!(state.input_tokens, 42);
        assert_eq!(state.output_tokens, 7);
    }

    #[test]
    fn test_stream_no_choices() {
        let mut state = StreamState::new("gpt-4".to_string());
        state.started = true;
        // Not finished yet — no corrective delta emitted
        let events = state.process_chunk(&json!({"usage": {"prompt_tokens": 10}}));
        assert!(events.is_empty());
    }

    #[test]
    fn test_stream_glm_split_usage_chunk() {
        // GLM sends finish_reason and usage in separate chunks.
        // Chunk 1: finish_reason arrives, no usage → message_delta emitted with output_tokens=0
        // Chunk 2: usage-only chunk (choices=[]) → corrective message_delta must update token counts
        let mut state = StreamState::new("glm-4.5".to_string());
        state.process_chunk(&json!({
            "choices": [{"delta": {"content": "Hello"}, "index": 0}]
        }));
        // Chunk with finish_reason but no usage
        let finish_events = state.process_chunk(&json!({
            "choices": [{"delta": {}, "finish_reason": "stop", "index": 0}]
        }));
        let finish_joined = finish_events.join("");
        assert!(finish_joined.contains("message_delta"));
        // At this point output_tokens is still 0
        assert_eq!(state.output_tokens, 0);
        assert!(state.finished);

        // Separate usage-only chunk (GLM style: choices=[])
        let usage_events = state.process_chunk(&json!({
            "choices": [],
            "usage": {"prompt_tokens": 191571, "completion_tokens": 500}
        }));
        // Must emit a corrective message_delta with real token counts
        assert_eq!(state.input_tokens, 191571);
        assert_eq!(state.output_tokens, 500);
        let usage_joined = usage_events.join("");
        assert!(usage_joined.contains("message_delta"), "corrective delta must be emitted");
        assert!(usage_joined.contains("191571"), "input_tokens must appear in corrective delta");
        assert!(usage_joined.contains("500"), "output_tokens must appear in corrective delta");
    }

    #[test]
    fn test_stream_flush() {
        let mut state = StreamState::new("gpt-4".to_string());
        state.process_chunk(&json!({
            "choices": [{"delta": {"content": "Hi"}, "index": 0}]
        }));
        let events = state.flush();
        let joined = events.join("");
        assert!(joined.contains("content_block_stop"));
        assert!(joined.contains("message_delta"));
        assert!(joined.contains("message_stop"));
    }

    #[test]
    fn test_stream_flush_idempotent() {
        // flush() after already finished should return nothing
        let mut state = StreamState::new("gpt-4".to_string());
        state.process_chunk(&json!({
            "choices": [{"delta": {"content": "x"}, "index": 0}]
        }));
        state.process_chunk(&json!({
            "choices": [{"delta": {}, "finish_reason": "stop", "index": 0}]
        }));
        assert!(state.finished);
        let events = state.flush();
        assert!(events.is_empty(), "flush after finish should emit nothing");
    }

    #[test]
    fn test_glm_corrective_delta_contains_input_tokens() {
        // After GLM split-usage fix: the corrective message_delta must include both
        // input_tokens and output_tokens so /context shows real usage
        let mut state = StreamState::new("glm-5.1".to_string());
        state.process_chunk(&json!({
            "choices": [{"delta": {}, "finish_reason": "stop", "index": 0}]
        }));
        let events = state.process_chunk(&json!({
            "choices": [],
            "usage": {"prompt_tokens": 50000, "completion_tokens": 1000}
        }));
        let joined = events.join("");
        // Both counts must be present in the corrective delta
        let delta_data: serde_json::Value = events.iter()
            .filter(|e| e.contains("message_delta"))
            .filter_map(|e| e.lines().find(|l| l.starts_with("data:"))
                .and_then(|l| serde_json::from_str(&l[5..]).ok()))
            .last()
            .expect("corrective message_delta must be emitted");
        assert_eq!(delta_data["usage"]["input_tokens"], 50000);
        assert_eq!(delta_data["usage"]["output_tokens"], 1000);
    }

    #[test]
    fn test_format_sse() {
        let data = json!({"type": "message_stop"});
        let result = format_sse("message_stop", &data);
        assert!(result.starts_with("event: message_stop\n"));
        assert!(result.contains("data: "));
        assert!(result.ends_with("\n\n"));
    }

    #[test]
    fn test_repair_json_trailing_comma() {
        let repaired = repair_json("{\"a\": 1,}");
        let parsed: Value = serde_json::from_str(&repaired).unwrap();
        assert_eq!(parsed["a"], 1);
    }

    #[test]
    fn test_repair_json_unclosed_brace() {
        let repaired = repair_json("{\"a\": 1");
        let parsed: Value = serde_json::from_str(&repaired).unwrap();
        assert_eq!(parsed["a"], 1);
    }

    #[test]
    fn test_repair_json_empty() {
        assert_eq!(repair_json(""), "{}");
    }

    #[test]
    fn test_ping_event() {
        let ping = StreamState::ping_event();
        assert!(ping.contains("event: ping"));
        assert!(ping.contains("\"type\": \"ping\""));
    }

    // ── Duplicate-response tests ──

    #[test]
    fn test_stream_duplicate_text_delta_all_emitted() {
        let mut state = StreamState::new("gpt-4".to_string());
        state.process_chunk(&json!({
            "choices": [{"delta": {"content": "hello"}, "index": 0}]
        }));
        let e2 = state.process_chunk(&json!({
            "choices": [{"delta": {"content": "hello"}, "index": 0}]
        }));
        let e3 = state.process_chunk(&json!({
            "choices": [{"delta": {"content": "hello"}, "index": 0}]
        }));
        let joined2 = e2.join("");
        let joined3 = e3.join("");
        assert!(joined2.contains("text_delta"));
        assert!(joined3.contains("text_delta"));
        assert!(joined2.contains("hello"));
        assert!(joined3.contains("hello"));
        assert!(!joined2.contains("content_block_start"), "no new block for same-type delta");
        assert!(!joined3.contains("content_block_start"));
    }

    #[test]
    fn test_stream_duplicate_sse_message_start_idempotent() {
        let mut state = StreamState::new("gpt-4".to_string());
        let e1 = state.process_chunk(&json!({
            "choices": [{"delta": {"content": "A"}, "index": 0}]
        }));
        let e2 = state.process_chunk(&json!({
            "choices": [{"delta": {"content": "B"}, "index": 0}]
        }));
        let msg_start_count = e1.iter().chain(e2.iter())
            .filter(|e| e.contains("message_start"))
            .count();
        assert_eq!(msg_start_count, 1, "message_start must appear exactly once");
    }

    #[test]
    fn test_stream_duplicate_tool_call_same_index() {
        let mut state = StreamState::new("gpt-4".to_string());
        state.process_chunk(&json!({
            "choices": [{"delta": {
                "tool_calls": [{
                    "index": 0, "id": "call_dup", "type": "function",
                    "function": {"name": "read_file", "arguments": ""}
                }]
            }, "index": 0}]
        }));
        state.process_chunk(&json!({
            "choices": [{"delta": {
                "tool_calls": [{"index": 0, "function": {"arguments": "{\"path\":"}}]
            }, "index": 0}]
        }));
        let events = state.process_chunk(&json!({
            "choices": [{"delta": {
                "tool_calls": [{
                    "index": 0, "id": "call_dup", "type": "function",
                    "function": {"name": "read_file", "arguments": ""}
                }]
            }, "index": 0}]
        }));
        let all_events = events.join("");
        assert!(all_events.contains("content_block_start"), "re-sent tool name creates a new block");
        assert_eq!(state.tool_calls.len(), 1, "same index should stay as one entry");
        assert_eq!(state.tool_calls[&0].name, "read_file");
    }

    #[test]
    fn test_stream_duplicate_tool_call_different_index() {
        let mut state = StreamState::new("gpt-4".to_string());
        state.process_chunk(&json!({
            "choices": [{"delta": {
                "tool_calls": [{
                    "index": 0, "id": "call_a", "type": "function",
                    "function": {"name": "read_file", "arguments": "{\"p\":\"a\"}"}
                }]
            }, "index": 0}]
        }));
        state.process_chunk(&json!({
            "choices": [{"delta": {
                "tool_calls": [{
                    "index": 1, "id": "call_b", "type": "function",
                    "function": {"name": "read_file", "arguments": "{\"p\":\"b\"}"}
                }]
            }, "index": 0}]
        }));
        assert_eq!(state.tool_calls.len(), 2);
        assert_eq!(state.tool_calls[&0].id, "call_a");
        assert_eq!(state.tool_calls[&1].id, "call_b");
    }

    #[test]
    fn test_stream_content_block_stop_not_duplicated() {
        let mut state = StreamState::new("gpt-4".to_string());
        state.process_chunk(&json!({
            "choices": [{"delta": {"content": "text"}, "index": 0}]
        }));
        let finish = state.process_chunk(&json!({
            "choices": [{"delta": {}, "finish_reason": "stop", "index": 0}]
        }));
        let stop_count = finish.iter()
            .filter(|e| e.contains("content_block_stop"))
            .count();
        assert_eq!(stop_count, 1, "one content_block_stop per finish");

        let flush = state.flush();
        assert!(flush.is_empty(), "flush after finish should produce nothing");
    }

    #[test]
    fn test_stream_double_finish_reason_no_duplicate_message_stop() {
        let mut state = StreamState::new("gpt-4".to_string());
        state.process_chunk(&json!({
            "choices": [{"delta": {"content": "hi"}, "index": 0}]
        }));
        let e1 = state.process_chunk(&json!({
            "choices": [{"delta": {}, "finish_reason": "stop", "index": 0}]
        }));
        let e2 = state.process_chunk(&json!({
            "choices": [{"delta": {}, "finish_reason": "stop", "index": 0}]
        }));
        let all: Vec<&String> = e1.iter().chain(e2.iter()).collect();
        let stop_count = all.iter().filter(|e| e.contains("message_stop")).count();
        assert_eq!(stop_count, 1, "message_stop must appear exactly once even with duplicate finish");
    }

    #[test]
    fn test_stream_thinking_then_duplicate_text_blocks() {
        let mut state = StreamState::new("deepseek".to_string());
        state.process_chunk(&json!({
            "choices": [{"delta": {"reasoning_content": "thinking..."}, "index": 0}]
        }));
        state.process_chunk(&json!({
            "choices": [{"delta": {"content": "answer"}, "index": 0}]
        }));
        let e3 = state.process_chunk(&json!({
            "choices": [{"delta": {"content": "answer"}, "index": 0}]
        }));
        let joined = e3.join("");
        assert!(joined.contains("text_delta"), "duplicate text delta should still be emitted");
        assert!(!joined.contains("content_block_start"), "no new text block for repeated delta");
        assert_eq!(state.content_block_index, 1, "should have thinking(0) + text(1)");
    }

    #[test]
    fn test_stream_reasoning_block_not_duplicated_when_interleaved() {
        // GLM-5.1 pattern: reasoning → content → reasoning again.
        // The second reasoning chunk must NOT open a new content block;
        // it must write into the original reasoning block (index 0).
        let mut state = StreamState::new("GLM-5.1".to_string());

        // First reasoning chunk → opens block 0, emits [Reasoning]\n header
        state.process_chunk(&json!({
            "choices": [{"delta": {"reasoning_content": "first part"}, "index": 0}]
        }));
        assert_eq!(state.reasoning_block_index, 0);
        assert_eq!(state.content_block_index, 0);

        // Content chunk → closes block 0, opens block 1 for text
        state.process_chunk(&json!({
            "choices": [{"delta": {"content": "interleaved text"}, "index": 0}]
        }));
        assert_eq!(state.content_block_index, 1);
        assert!(!state.in_thinking);

        // Second reasoning chunk → must NOT open block 2; instead reuse block 0
        let events = state.process_chunk(&json!({
            "choices": [{"delta": {"reasoning_content": "second part"}, "index": 0}]
        }));
        let joined = events.join("");
        // Should NOT open a new content_block_start for reasoning
        assert!(!joined.contains("content_block_start"),
            "second reasoning chunk must not open a new block, got: {}", joined);
        // Must emit a delta to the original reasoning block (index 0)
        assert!(joined.contains("\"index\":0"), "delta must target original reasoning block");
        assert!(joined.contains("second part"));
        // [Reasoning] header must NOT appear again
        assert!(!joined.contains("[Reasoning]"), "header must not be re-emitted");
    }

    #[test]
    fn test_stream_reasoning_header_emitted_only_once() {
        // GLM-5.1 sometimes sends reasoning_content, then content, then reasoning_content again.
        // The [Reasoning] header must appear exactly once.
        let mut state = StreamState::new("GLM-5.1".to_string());
        state.process_chunk(&json!({
            "choices": [{"delta": {"reasoning_content": "first part"}, "index": 0}]
        }));
        // A content chunk resets in_thinking to false
        state.process_chunk(&json!({
            "choices": [{"delta": {"content": "interleaved text"}, "index": 0}]
        }));
        // Another reasoning_content chunk arrives — should NOT re-emit [Reasoning]\n
        let events = state.process_chunk(&json!({
            "choices": [{"delta": {"reasoning_content": "second part"}, "index": 0}]
        }));
        let joined = events.join("");
        assert!(!joined.contains("[Reasoning]"), "second reasoning chunk must not re-emit [Reasoning] header");
        assert!(joined.contains("second part"), "reasoning text itself should still be emitted");
    }

    #[test]
    fn test_non_stream_duplicate_tool_calls_preserved() {
        let openai = json!({
            "id": "chatcmpl-dup",
            "model": "gpt-4",
            "choices": [{
                "index": 0,
                "message": {
                    "role": "assistant",
                    "content": null,
                    "tool_calls": [
                        {
                            "id": "call_1", "type": "function",
                            "function": {"name": "read_file", "arguments": "{\"path\":\"a.rs\"}"}
                        },
                        {
                            "id": "call_2", "type": "function",
                            "function": {"name": "read_file", "arguments": "{\"path\":\"b.rs\"}"}
                        }
                    ]
                },
                "finish_reason": "tool_calls"
            }],
            "usage": {"prompt_tokens": 10, "completion_tokens": 5}
        });
        let result = transform_response(&openai).unwrap();
        let content = result["content"].as_array().unwrap();
        assert_eq!(content.len(), 2);
        assert_eq!(content[0]["id"], "call_1");
        assert_eq!(content[1]["id"], "call_2");
        assert_eq!(content[0]["name"], "read_file");
        assert_eq!(content[1]["name"], "read_file");
        assert_ne!(content[0]["input"]["path"], content[1]["input"]["path"]);
    }
}
