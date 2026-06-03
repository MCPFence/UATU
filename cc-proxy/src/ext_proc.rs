use crate::config::ExtProcConfig;
use crate::signals::RequestSignals;
use serde_json::Value;

pub enum ExtProcResult {
    /// value: modified body/response; subs: token→real substitutions (non-empty for post_response)
    Modified(Value, std::collections::HashMap<String, String>),
    Passthrough,
    Block(String),
}

#[cfg(unix)]
mod unix_impl {
    use super::*;
    use serde_json::json;
    use std::time::Duration;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::net::UnixStream;
    use tokio::sync::Mutex;
    use tokio::time::timeout;

    pub struct ExtProcClient {
        pub socket_path: String,
        pub timeout: Duration,
        pub on_timeout_block: bool,
        pub conn: Mutex<
            Option<(
                tokio::io::WriteHalf<UnixStream>,
                BufReader<tokio::io::ReadHalf<UnixStream>>,
            )>,
        >,
    }

    impl ExtProcClient {
        pub fn new(cfg: &ExtProcConfig) -> Self {
            Self {
                socket_path: cfg.socket_path.clone(),
                timeout: Duration::from_millis(cfg.timeout_ms),
                on_timeout_block: cfg.on_timeout == "block",
                conn: Mutex::new(None),
            }
        }

        pub fn should_call_pre(&self, cfg: &ExtProcConfig, signals: &RequestSignals) -> bool {
            let h = &cfg.hooks.pre_request;
            if !h.enabled {
                return false;
            }
            if !h.roles.is_empty() {
                let role = &signals.agent_role_str;
                let family = &signals.agent_role_family;
                if !h.roles.iter().any(|r| r == role || r == family) {
                    return false;
                }
            }
            if let Some(ref expr) = h.cel_condition {
                if !eval_cel(expr, signals) {
                    return false;
                }
            }
            true
        }

        pub fn should_call_post(&self, cfg: &ExtProcConfig, signals: &RequestSignals) -> bool {
            let h = &cfg.hooks.post_response;
            if !h.enabled {
                return false;
            }
            if !h.roles.is_empty() {
                let role = &signals.agent_role_str;
                let family = &signals.agent_role_family;
                if !h.roles.iter().any(|r| r == role || r == family) {
                    return false;
                }
            }
            if let Some(ref expr) = h.cel_condition {
                if !eval_cel(expr, signals) {
                    return false;
                }
            }
            true
        }

        pub async fn call_pre_request(
            &self,
            session_id: &str,
            seq: u64,
            signals: &RequestSignals,
            body: &Value,
            attempt_model: Option<&str>,
        ) -> ExtProcResult {
            let payload = json!({
                "type": "pre_request",
                "session_id": session_id,
                "seq": seq,
                "agent_role": signals.agent_role_str,
                "agent_role_family": signals.agent_role_family,
                "msg_count": signals.msg_count,
                "tool_call_count": signals.tool_call_count,
                "is_main": signals.is_main,
                "is_subagent": signals.is_subagent,
                "attempt_model": attempt_model,
                "body": body,
            });
            match timeout(self.timeout, self.send_recv(payload)).await {
                Ok(result) => result,
                Err(_) => {
                    tracing::warn!(
                        "ext_proc pre_request timeout ({}ms)",
                        self.timeout.as_millis()
                    );
                    if self.on_timeout_block {
                        ExtProcResult::Block("ext_proc timeout".to_string())
                    } else {
                        ExtProcResult::Passthrough
                    }
                }
            }
        }

        pub async fn call_post_response(
            &self,
            session_id: &str,
            seq: u64,
            signals: &RequestSignals,
            request_body: &Value,
            response: &Value,
        ) -> ExtProcResult {
            let payload = json!({
                "type": "post_response",
                "session_id": session_id,
                "seq": seq,
                "agent_role": signals.agent_role_str,
                "stop_reason": response.get("stop_reason"),
                "request_body": request_body,
                "response": response,
            });
            match timeout(self.timeout, self.send_recv(payload)).await {
                Ok(result) => result,
                Err(_) => {
                    tracing::warn!("ext_proc post_response timeout ({}ms)", self.timeout.as_millis());
                    ExtProcResult::Passthrough
                }
            }
        }

        async fn send_recv(&self, payload: Value) -> ExtProcResult {
            let mut guard = self.conn.lock().await;

            loop {
                if guard.is_none() {
                    match UnixStream::connect(&self.socket_path).await {
                        Ok(stream) => {
                            let (read_half, write_half) = tokio::io::split(stream);
                            *guard = Some((write_half, BufReader::new(read_half)));
                        }
                        Err(e) => {
                            tracing::warn!("ext_proc connect failed: {e}");
                            return ExtProcResult::Passthrough;
                        }
                    }
                }

                let (writer, reader) = guard.as_mut().unwrap();
                let mut line_json = serde_json::to_string(&payload).unwrap_or_default();
                line_json.push('\n');

                if writer.write_all(line_json.as_bytes()).await.is_err() {
                    *guard = None;
                    continue;
                }

                let mut response_line = String::new();
                match reader.read_line(&mut response_line).await {
                    Ok(0) => {
                        *guard = None;
                        continue;
                    }
                    Ok(_) => {
                        return parse_response(&response_line);
                    }
                    Err(e) => {
                        tracing::warn!("ext_proc read error: {e}");
                        *guard = None;
                        return ExtProcResult::Passthrough;
                    }
                }
            }
        }
    }

    fn parse_response(line: &str) -> ExtProcResult {
        let Ok(v) = serde_json::from_str::<Value>(line.trim()) else {
            tracing::warn!("ext_proc invalid JSON response: {line}");
            return ExtProcResult::Passthrough;
        };

        let subs: std::collections::HashMap<String, String> = v
            .get("subs")
            .and_then(|s| serde_json::from_value(s.clone()).ok())
            .unwrap_or_default();

        match v.get("action").and_then(|a| a.as_str()).unwrap_or("passthrough") {
            "modified" => {
                if let Some(body) = v.get("body").cloned() {
                    ExtProcResult::Modified(body, subs)
                } else if let Some(resp) = v.get("response").cloned() {
                    ExtProcResult::Modified(resp, subs)
                } else {
                    ExtProcResult::Passthrough
                }
            }
            "block" => {
                let reason = v
                    .get("reason")
                    .and_then(|r| r.as_str())
                    .unwrap_or("blocked by ext_proc");
                ExtProcResult::Block(reason.to_string())
            }
            _ => ExtProcResult::Passthrough,
        }
    }

    fn eval_cel(expr: &str, signals: &RequestSignals) -> bool {
        let Ok(program) = cel_interpreter::Program::compile(expr) else {
            return true;
        };
        let mut context = cel_interpreter::Context::default();
        let cel_ctx = signals.to_cel_context();
        for (k, v) in &cel_ctx {
            context.add_variable_from_value(k, v.clone());
        }
        matches!(
            program.execute(&context),
            Ok(cel_interpreter::Value::Bool(true))
        )
    }
}

#[cfg(unix)]
pub use unix_impl::ExtProcClient;
