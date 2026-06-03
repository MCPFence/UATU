use serde_json::Value;
use std::collections::VecDeque;
use std::sync::Mutex;

pub struct RetrialDetector {
    recent: Mutex<VecDeque<(u64, String)>>,
    window_ms: u64,
}

impl RetrialDetector {
    pub fn new(window_secs: u64) -> Self {
        Self {
            recent: Mutex::new(VecDeque::new()),
            window_ms: window_secs * 1000,
        }
    }

    pub fn check_and_record(&self, body: &Value) -> bool {
        let hash = compute_fuzzy_hash(body);
        let now = current_timestamp_ms();
        let mut recent = self.recent.lock().unwrap();

        while recent.front().map_or(false, |(t, _)| now - t > self.window_ms) {
            recent.pop_front();
        }

        let is_retrial = recent.iter().any(|(_, h)| h == &hash);
        recent.push_back((now, hash));
        is_retrial
    }
}

fn current_timestamp_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn compute_fuzzy_hash(body: &Value) -> String {
    let last_user_text = extract_last_user_prefix(body);
    let msg_count = body
        .get("messages")
        .and_then(|m| m.as_array())
        .map(|a| a.len())
        .unwrap_or(0);

    let input = format!("{}|{}", msg_count, last_user_text);
    let digest = md5::compute(input.as_bytes());
    format!("{:x}", digest)
}

fn extract_last_user_prefix(body: &Value) -> String {
    let messages = body.get("messages").and_then(|m| m.as_array());
    let Some(msgs) = messages else {
        return String::new();
    };
    for msg in msgs.iter().rev() {
        if msg.get("role").and_then(|r| r.as_str()) != Some("user") {
            continue;
        }
        let text = match msg.get("content") {
            Some(Value::String(s)) => s.as_str(),
            Some(Value::Array(arr)) => {
                for block in arr {
                    if block.get("type").and_then(|t| t.as_str()) == Some("text") {
                        if let Some(t) = block.get("text").and_then(|t| t.as_str()) {
                            return t.chars().take(200).collect();
                        }
                    }
                }
                return String::new();
            }
            _ => return String::new(),
        };
        return text.chars().take(200).collect();
    }
    String::new()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_no_retrial_first_request() {
        let det = RetrialDetector::new(120);
        let body = json!({
            "messages": [{"role": "user", "content": "Hello"}]
        });
        assert!(!det.check_and_record(&body));
    }

    #[test]
    fn test_retrial_same_request() {
        let det = RetrialDetector::new(120);
        let body = json!({
            "messages": [{"role": "user", "content": "Hello"}]
        });
        assert!(!det.check_and_record(&body));
        assert!(det.check_and_record(&body));
    }

    #[test]
    fn test_no_retrial_different_request() {
        let det = RetrialDetector::new(120);
        let body1 = json!({
            "messages": [{"role": "user", "content": "Hello"}]
        });
        let body2 = json!({
            "messages": [{"role": "user", "content": "Goodbye"}]
        });
        assert!(!det.check_and_record(&body1));
        assert!(!det.check_and_record(&body2));
    }

    #[test]
    fn test_retrial_after_different() {
        let det = RetrialDetector::new(120);
        let body1 = json!({
            "messages": [{"role": "user", "content": "Hello"}]
        });
        let body2 = json!({
            "messages": [{"role": "user", "content": "World"}]
        });
        assert!(!det.check_and_record(&body1));
        assert!(!det.check_and_record(&body2));
        assert!(det.check_and_record(&body1));
    }

    #[test]
    fn test_fuzzy_hash_deterministic() {
        let body = json!({
            "messages": [{"role": "user", "content": "Test message"}]
        });
        let h1 = compute_fuzzy_hash(&body);
        let h2 = compute_fuzzy_hash(&body);
        assert_eq!(h1, h2);
    }

    #[test]
    fn test_fuzzy_hash_differs_by_content() {
        let body1 = json!({"messages": [{"role": "user", "content": "A"}]});
        let body2 = json!({"messages": [{"role": "user", "content": "B"}]});
        assert_ne!(compute_fuzzy_hash(&body1), compute_fuzzy_hash(&body2));
    }

    #[test]
    fn test_fuzzy_hash_includes_msg_count() {
        let body1 = json!({"messages": [{"role": "user", "content": "X"}]});
        let body2 = json!({"messages": [
            {"role": "assistant", "content": "Y"},
            {"role": "user", "content": "X"}
        ]});
        assert_ne!(compute_fuzzy_hash(&body1), compute_fuzzy_hash(&body2));
    }
}
