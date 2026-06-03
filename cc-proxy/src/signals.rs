use crate::agent_role::{self, AgentRole};
use crate::cluster;
use crate::retrial::RetrialDetector;
use serde_json::Value;
use std::collections::HashMap;

pub struct RequestSignals {
    pub model: String,
    pub session_id: String,
    pub agent_role: AgentRole,
    pub agent_role_str: String,
    pub agent_role_family: String,
    pub tool_category: Option<String>,
    pub cc_version_suffix: Option<String>,
    pub cc_entrypoint: Option<String>,
    pub cluster_id: u32,

    pub msg_count: u64,
    pub tool_call_count: u64,
    pub has_code: bool,
    pub has_tools: bool,
    pub user_msg_length: u64,
    pub user_word_count: u64,
    pub is_stream: bool,

    pub is_retrial: bool,
    pub is_main: bool,
    pub is_subagent: bool,
    pub is_sidequery: bool,
    pub is_independently_routable: bool,
}

impl RequestSignals {
    pub fn extract(body: &Value, session_id: &str, retrial: Option<&RetrialDetector>) -> Self {
        let model = body
            .get("model")
            .and_then(|m| m.as_str())
            .unwrap_or("unknown")
            .to_string();

        let agent = agent_role::detect(body);
        let cc_suffix = agent_role::extract_cc_version_suffix(body);
        let cc_entrypoint = agent_role::extract_cc_entrypoint(body);
        let cluster_id = cluster::compute_cluster_id(body);

        let messages = body.get("messages").and_then(|m| m.as_array());
        let msg_count = messages.map(|a| a.len() as u64).unwrap_or(0);

        let tools = body.get("tools").and_then(|t| t.as_array());
        let tool_call_count = tools.map(|a| a.len() as u64).unwrap_or(0);
        let has_tools = tool_call_count > 0;

        let is_stream = body
            .get("stream")
            .and_then(|s| s.as_bool())
            .unwrap_or(false);

        let last_user_text = extract_last_user_text(messages);
        let user_msg_length = last_user_text.len() as u64;
        let user_word_count = count_words(&last_user_text);
        let has_code = detect_code(&last_user_text);

        let is_retrial = retrial
            .map(|r| r.check_and_record(body))
            .unwrap_or(false);

        let agent_role_str = agent.to_string();
        let agent_role_family = agent.family().to_string();
        let tool_category = agent.tool_category().map(String::from);
        let is_main = agent.is_main();
        let is_subagent = agent.is_subagent();
        let is_sidequery = agent.is_sidequery();
        let is_independently_routable = agent.is_independently_routable();

        Self {
            model,
            session_id: session_id.to_string(),
            agent_role: agent,
            agent_role_str,
            agent_role_family,
            tool_category,
            cc_version_suffix: cc_suffix,
            cc_entrypoint,
            cluster_id,
            msg_count,
            tool_call_count,
            has_code,
            has_tools,
            user_msg_length,
            user_word_count,
            is_stream,
            is_retrial,
            is_main,
            is_subagent,
            is_sidequery,
            is_independently_routable,
        }
    }

    pub fn to_cel_context(&self) -> HashMap<String, cel_interpreter::Value> {
        let mut ctx = HashMap::new();
        ctx.insert("model".into(), cel_interpreter::Value::String(self.model.clone().into()));
        ctx.insert("session_id".into(), cel_interpreter::Value::String(self.session_id.clone().into()));
        ctx.insert("agent_role".into(), cel_interpreter::Value::String(self.agent_role_str.clone().into()));
        ctx.insert("agent_role_family".into(), cel_interpreter::Value::String(self.agent_role_family.clone().into()));
        if let Some(ref tc) = self.tool_category {
            ctx.insert("tool_category".into(), cel_interpreter::Value::String(tc.clone().into()));
        } else {
            ctx.insert("tool_category".into(), cel_interpreter::Value::String(String::new().into()));
        }
        if let Some(ref ep) = self.cc_entrypoint {
            ctx.insert("cc_entrypoint".into(), cel_interpreter::Value::String(ep.clone().into()));
        } else {
            ctx.insert("cc_entrypoint".into(), cel_interpreter::Value::String(String::new().into()));
        }
        ctx.insert("cluster_id".into(), cel_interpreter::Value::UInt(self.cluster_id as u64));
        ctx.insert("msg_count".into(), cel_interpreter::Value::UInt(self.msg_count));
        ctx.insert("tool_call_count".into(), cel_interpreter::Value::UInt(self.tool_call_count));
        ctx.insert("has_code".into(), cel_interpreter::Value::Bool(self.has_code));
        ctx.insert("has_tools".into(), cel_interpreter::Value::Bool(self.has_tools));
        ctx.insert("user_msg_length".into(), cel_interpreter::Value::UInt(self.user_msg_length));
        ctx.insert("user_word_count".into(), cel_interpreter::Value::UInt(self.user_word_count));
        ctx.insert("is_stream".into(), cel_interpreter::Value::Bool(self.is_stream));
        ctx.insert("is_retrial".into(), cel_interpreter::Value::Bool(self.is_retrial));
        ctx.insert("is_main".into(), cel_interpreter::Value::Bool(self.is_main));
        ctx.insert("is_subagent".into(), cel_interpreter::Value::Bool(self.is_subagent));
        ctx.insert("is_sidequery".into(), cel_interpreter::Value::Bool(self.is_sidequery));
        ctx.insert("is_independently_routable".into(), cel_interpreter::Value::Bool(self.is_independently_routable));
        ctx
    }
}

fn extract_last_user_text(messages: Option<&Vec<Value>>) -> String {
    let Some(msgs) = messages else {
        return String::new();
    };
    for msg in msgs.iter().rev() {
        if msg.get("role").and_then(|r| r.as_str()) != Some("user") {
            continue;
        }
        let content = msg.get("content");
        match content {
            Some(Value::String(s)) => return s.clone(),
            Some(Value::Array(arr)) => {
                for block in arr {
                    if block.get("type").and_then(|t| t.as_str()) == Some("text") {
                        if let Some(t) = block.get("text").and_then(|t| t.as_str()) {
                            return t.to_string();
                        }
                    }
                }
            }
            _ => {}
        }
    }
    String::new()
}

fn count_words(text: &str) -> u64 {
    if text.is_empty() {
        return 0;
    }
    let has_cjk = text.chars().any(|c| {
        matches!(c,
            '\u{4E00}'..='\u{9FFF}' |
            '\u{3400}'..='\u{4DBF}' |
            '\u{F900}'..='\u{FAFF}'
        )
    });
    if has_cjk {
        (text.chars().count() / 3) as u64
    } else {
        text.split_whitespace().count() as u64
    }
}

fn detect_code(text: &str) -> bool {
    if text.contains("```") {
        return true;
    }
    for line in text.lines() {
        if line.starts_with("    ") && !line.trim().is_empty() {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_extract_basic() {
        let body = json!({
            "model": "claude-opus-4-20250514",
            "messages": [
                {"role": "user", "content": "Hello world"}
            ],
            "stream": true
        });
        let sig = RequestSignals::extract(&body, "sess-1", None);
        assert_eq!(sig.model, "claude-opus-4-20250514");
        assert_eq!(sig.msg_count, 1);
        assert_eq!(sig.tool_call_count, 0);
        assert!(!sig.has_tools);
        assert!(!sig.has_code);
        assert!(sig.is_stream);
        assert_eq!(sig.user_msg_length, 11);
    }

    #[test]
    fn test_extract_with_tools() {
        let body = json!({
            "model": "test",
            "messages": [{"role": "user", "content": "Hi"}],
            "tools": [
                {"name": "read", "description": "read file"},
                {"name": "write", "description": "write file"}
            ]
        });
        let sig = RequestSignals::extract(&body, "s1", None);
        assert_eq!(sig.tool_call_count, 2);
        assert!(sig.has_tools);
    }

    #[test]
    fn test_extract_code_detection_backtick() {
        let body = json!({
            "model": "test",
            "messages": [{"role": "user", "content": "Fix this:\n```rust\nfn main() {}\n```"}]
        });
        let sig = RequestSignals::extract(&body, "s1", None);
        assert!(sig.has_code);
    }

    #[test]
    fn test_extract_code_detection_indent() {
        let body = json!({
            "model": "test",
            "messages": [{"role": "user", "content": "Look at this:\n    def foo():\n        pass"}]
        });
        let sig = RequestSignals::extract(&body, "s1", None);
        assert!(sig.has_code);
    }

    #[test]
    fn test_extract_no_code() {
        let body = json!({
            "model": "test",
            "messages": [{"role": "user", "content": "Just a normal question about life"}]
        });
        let sig = RequestSignals::extract(&body, "s1", None);
        assert!(!sig.has_code);
    }

    #[test]
    fn test_word_count_english() {
        assert_eq!(count_words("hello world foo bar"), 4);
    }

    #[test]
    fn test_word_count_cjk() {
        assert_eq!(count_words("你好世界这是测试"), 2); // 8 chars / 3
    }

    #[test]
    fn test_word_count_empty() {
        assert_eq!(count_words(""), 0);
    }

    #[test]
    fn test_last_user_text_array_content() {
        let body = json!({
            "model": "test",
            "messages": [
                {"role": "user", "content": [
                    {"type": "text", "text": "block content"}
                ]}
            ]
        });
        let sig = RequestSignals::extract(&body, "s1", None);
        assert_eq!(sig.user_msg_length, 13);
    }

    #[test]
    fn test_last_user_text_skips_assistant() {
        let body = json!({
            "model": "test",
            "messages": [
                {"role": "user", "content": "first question"},
                {"role": "assistant", "content": "answer"},
                {"role": "user", "content": "second question"}
            ]
        });
        let sig = RequestSignals::extract(&body, "s1", None);
        assert_eq!(sig.user_msg_length, 15); // "second question"
    }

    #[test]
    fn test_cel_context() {
        let body = json!({
            "model": "opus",
            "messages": [{"role": "user", "content": "hi"}],
            "tools": [{"name": "t1"}]
        });
        let sig = RequestSignals::extract(&body, "s1", None);
        let ctx = sig.to_cel_context();
        assert_eq!(ctx.get("msg_count"), Some(&cel_interpreter::Value::UInt(1)));
        assert_eq!(ctx.get("has_tools"), Some(&cel_interpreter::Value::Bool(true)));
    }
}
