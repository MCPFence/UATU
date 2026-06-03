use serde_json::Value;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

pub fn compute_cluster_id(body: &Value) -> u32 {
    let mut h = DefaultHasher::new();

    hash_system_prompt(body, &mut h);
    hash_tool_names(body, &mut h);
    hash_size_bucket(body, &mut h);
    hash_depth_bucket(body, &mut h);

    (h.finish() & 0xFFFFFFFF) as u32
}

fn hash_system_prompt(body: &Value, h: &mut DefaultHasher) {
    let text = match body.get("system") {
        Some(Value::String(s)) => s.as_str(),
        Some(Value::Array(arr)) => {
            if let Some(first_text) = arr.iter().find_map(|b| {
                if b.get("type").and_then(|t| t.as_str()) == Some("text") {
                    b.get("text").and_then(|t| t.as_str())
                } else {
                    None
                }
            }) {
                first_text
            } else {
                ""
            }
        }
        _ => "",
    };
    let prefix: String = text.chars().take(512).collect();
    prefix.hash(h);
}

fn hash_tool_names(body: &Value, h: &mut DefaultHasher) {
    if let Some(tools) = body.get("tools").and_then(|t| t.as_array()) {
        let mut names: Vec<&str> = tools
            .iter()
            .filter_map(|t| t.get("name").and_then(|n| n.as_str()))
            .collect();
        names.sort_unstable();
        for name in &names {
            name.hash(h);
        }
        names.len().hash(h);
    } else {
        0u8.hash(h);
    }
}

fn hash_size_bucket(body: &Value, h: &mut DefaultHasher) {
    let total_len: usize = body
        .get("messages")
        .and_then(|m| m.as_array())
        .map(|msgs| {
            msgs.iter()
                .map(|m| {
                    m.get("content")
                        .map(|c| match c {
                            Value::String(s) => s.len(),
                            Value::Array(arr) => arr
                                .iter()
                                .map(|b| {
                                    b.get("text")
                                        .and_then(|t| t.as_str())
                                        .map(|s| s.len())
                                        .unwrap_or(100)
                                })
                                .sum(),
                            _ => 0,
                        })
                        .unwrap_or(0)
                })
                .sum()
        })
        .unwrap_or(0);

    let bucket: u8 = match total_len {
        0..=500 => 0,
        501..=2000 => 1,
        2001..=10000 => 2,
        10001..=50000 => 3,
        _ => 4,
    };
    bucket.hash(h);
}

fn hash_depth_bucket(body: &Value, h: &mut DefaultHasher) {
    let count = body
        .get("messages")
        .and_then(|m| m.as_array())
        .map(|a| a.len())
        .unwrap_or(0);

    let bucket: u8 = match count {
        0..=1 => 0,
        2..=5 => 1,
        6..=20 => 2,
        _ => 3,
    };
    bucket.hash(h);
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_same_request_same_cluster() {
        let body = json!({
            "system": "You are helpful.",
            "messages": [{"role": "user", "content": "Hello"}],
            "tools": [{"name": "read"}, {"name": "write"}]
        });
        let a = compute_cluster_id(&body);
        let b = compute_cluster_id(&body);
        assert_eq!(a, b);
    }

    #[test]
    fn test_different_system_different_cluster() {
        let a = compute_cluster_id(&json!({
            "system": "You are a coder.",
            "messages": [{"role": "user", "content": "Hi"}]
        }));
        let b = compute_cluster_id(&json!({
            "system": "You are a writer.",
            "messages": [{"role": "user", "content": "Hi"}]
        }));
        assert_ne!(a, b);
    }

    #[test]
    fn test_different_tools_different_cluster() {
        let a = compute_cluster_id(&json!({
            "messages": [{"role": "user", "content": "Hi"}],
            "tools": [{"name": "read"}]
        }));
        let b = compute_cluster_id(&json!({
            "messages": [{"role": "user", "content": "Hi"}],
            "tools": [{"name": "search"}]
        }));
        assert_ne!(a, b);
    }

    #[test]
    fn test_tool_order_independent() {
        let a = compute_cluster_id(&json!({
            "messages": [{"role": "user", "content": "Hi"}],
            "tools": [{"name": "a"}, {"name": "b"}]
        }));
        let b = compute_cluster_id(&json!({
            "messages": [{"role": "user", "content": "Hi"}],
            "tools": [{"name": "b"}, {"name": "a"}]
        }));
        assert_eq!(a, b);
    }

    #[test]
    fn test_no_tools_no_system() {
        let id = compute_cluster_id(&json!({
            "messages": [{"role": "user", "content": "Hello world"}]
        }));
        assert!(id > 0 || id == 0); // just ensure no panic
    }

    #[test]
    fn test_size_buckets_differ() {
        let small = compute_cluster_id(&json!({
            "messages": [{"role": "user", "content": "Hi"}]
        }));
        let large = compute_cluster_id(&json!({
            "messages": [{"role": "user", "content": "x".repeat(60000)}]
        }));
        assert_ne!(small, large);
    }

    #[test]
    fn test_depth_buckets_differ() {
        let shallow = compute_cluster_id(&json!({
            "messages": [{"role": "user", "content": "Hi"}]
        }));
        let msgs: Vec<_> = (0..25).map(|i| json!({"role": "user", "content": format!("msg {i}")})).collect();
        let deep = compute_cluster_id(&json!({ "messages": msgs }));
        assert_ne!(shallow, deep);
    }
}
