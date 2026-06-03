use colored::Colorize;
use md5;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::RwLock;

const BLOB_MIN_SIZE: usize = 512;

struct BlobStore {
    dir: PathBuf,
    known: HashSet<String>,
}

impl BlobStore {
    fn new(session_dir: &Path) -> Self {
        let dir = session_dir.join("_blobs");
        let mut known = HashSet::new();
        if dir.exists() {
            if let Ok(entries) = fs::read_dir(&dir) {
                for entry in entries.flatten() {
                    let name = entry.file_name();
                    let name_str = name.to_string_lossy();
                    if let Some(hash) = name_str.strip_suffix(".json") {
                        known.insert(hash.to_string());
                    }
                }
            }
        }
        Self { dir, known }
    }

    fn store(&mut self, value: &Value) -> Option<String> {
        let content = serde_json::to_string(value).unwrap_or_default();
        if content.len() < BLOB_MIN_SIZE {
            return None;
        }

        let digest = md5::compute(content.as_bytes());
        let hash8 = format!("{:x}", digest)[..8].to_string();

        if self.known.contains(&hash8) {
            return Some(hash8);
        }

        ensure_dir(&self.dir);
        let path = self.dir.join(format!("{}.json", hash8));
        if path.exists() {
            let existing = fs::read_to_string(&path).unwrap_or_default();
            if existing.trim() != content.trim() {
                let full_hash = format!("{:x}", digest);
                let full_path = self.dir.join(format!("{}.json", full_hash));
                let _ = fs::write(&full_path, content.as_bytes());
                self.known.insert(full_hash.clone());
                return Some(full_hash);
            }
        } else {
            let _ = fs::write(&path, content.as_bytes());
        }
        self.known.insert(hash8.clone());
        Some(hash8)
    }

    fn dedup_request(&mut self, record: &mut Value) {
        if let Some(messages) = record.get_mut("messages").and_then(|m| m.as_array_mut()) {
            for msg in messages.iter_mut() {
                if let Some(hash) = self.store(msg) {
                    *msg = json!({"$blob": hash});
                }
            }
        }

        if let Some(tools) = record.get("tools").cloned() {
            if tools.is_array() {
                if let Some(hash) = self.store(&tools) {
                    record["tools"] = json!({"$blob": hash});
                }
            }
        }
    }
}

pub struct AnthropicStreamAccumulator {
    message_id: String,
    model: String,
    role: String,
    blocks: HashMap<i64, AccBlock>,
    block_order: Vec<i64>,
    stop_reason: Option<String>,
    input_tokens: u64,
    output_tokens: u64,
    cache_read_input_tokens: u64,
    cache_creation_input_tokens: u64,
    finalized: bool,
}

struct AccBlock {
    block_type: String,
    text: String,
    tool_id: String,
    tool_name: String,
    tool_input_buf: String,
    thinking: String,
}

impl Default for AccBlock {
    fn default() -> Self {
        Self {
            block_type: "text".to_string(),
            text: String::new(),
            tool_id: String::new(),
            tool_name: String::new(),
            tool_input_buf: String::new(),
            thinking: String::new(),
        }
    }
}

impl AnthropicStreamAccumulator {
    pub fn new() -> Self {
        Self {
            message_id: String::new(),
            model: String::new(),
            role: "assistant".to_string(),
            blocks: HashMap::new(),
            block_order: Vec::new(),
            stop_reason: None,
            input_tokens: 0,
            output_tokens: 0,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
            finalized: false,
        }
    }

    pub fn process_event(&mut self, event_type: &str, data: &Value) {
        match event_type {
            "message_start" => {
                if let Some(msg) = data.get("message") {
                    if let Some(id) = msg.get("id").and_then(|v| v.as_str()) {
                        self.message_id = id.to_string();
                    }
                    if let Some(m) = msg.get("model").and_then(|v| v.as_str()) {
                        self.model = m.to_string();
                    }
                    if let Some(role) = msg.get("role").and_then(|v| v.as_str()) {
                        self.role = role.to_string();
                    }
                    if let Some(usage) = msg.get("usage") {
                        if let Some(it) = usage.get("input_tokens").and_then(|v| v.as_u64()) {
                            self.input_tokens = it;
                        }
                        if let Some(ot) = usage.get("output_tokens").and_then(|v| v.as_u64()) {
                            self.output_tokens = ot;
                        }
                        if let Some(cr) = usage.get("cache_read_input_tokens").and_then(|v| v.as_u64()) {
                            self.cache_read_input_tokens = cr;
                        }
                        if let Some(cw) = usage.get("cache_creation_input_tokens").and_then(|v| v.as_u64()) {
                            self.cache_creation_input_tokens = cw;
                        }
                    }
                }
            }
            "content_block_start" => {
                let idx = data.get("index").and_then(|v| v.as_i64()).unwrap_or(0);
                let mut block = AccBlock::default();
                if let Some(cb) = data.get("content_block") {
                    let btype = cb.get("type").and_then(|v| v.as_str()).unwrap_or("text");
                    block.block_type = btype.to_string();
                    if btype == "tool_use" {
                        block.tool_id = cb.get("id").and_then(|v| v.as_str())
                            .unwrap_or("").to_string();
                        block.tool_name = cb.get("name").and_then(|v| v.as_str())
                            .unwrap_or("").to_string();
                    }
                }
                if !self.blocks.contains_key(&idx) {
                    self.block_order.push(idx);
                }
                self.blocks.insert(idx, block);
            }
            "content_block_delta" => {
                let idx = data.get("index").and_then(|v| v.as_i64()).unwrap_or(0);
                let block = self.blocks.entry(idx).or_insert_with(|| {
                    self.block_order.push(idx);
                    AccBlock::default()
                });
                if let Some(delta) = data.get("delta") {
                    let dtype = delta.get("type").and_then(|v| v.as_str()).unwrap_or("");
                    match dtype {
                        "text_delta" => {
                            if let Some(t) = delta.get("text").and_then(|v| v.as_str()) {
                                block.text.push_str(t);
                            }
                        }
                        "input_json_delta" => {
                            if let Some(pj) = delta.get("partial_json").and_then(|v| v.as_str()) {
                                block.tool_input_buf.push_str(pj);
                            }
                        }
                        "thinking_delta" => {
                            if let Some(t) = delta.get("thinking").and_then(|v| v.as_str()) {
                                block.thinking.push_str(t);
                            }
                        }
                        _ => {}
                    }
                }
            }
            "message_delta" => {
                if let Some(delta) = data.get("delta") {
                    if let Some(sr) = delta.get("stop_reason").and_then(|v| v.as_str()) {
                        self.stop_reason = Some(sr.to_string());
                    }
                }
                if let Some(usage) = data.get("usage") {
                    if let Some(ot) = usage.get("output_tokens").and_then(|v| v.as_u64()) {
                        self.output_tokens = ot;
                    }
                    if let Some(cr) = usage.get("cache_read_input_tokens").and_then(|v| v.as_u64()) {
                        self.cache_read_input_tokens = cr;
                    }
                    if let Some(cw) = usage.get("cache_creation_input_tokens").and_then(|v| v.as_u64()) {
                        self.cache_creation_input_tokens = cw;
                    }
                }
            }
            "message_stop" => {
                self.finalized = true;
            }
            _ => {}
        }
    }

    pub fn finalize(&self) -> Value {
        let mut content_blocks: Vec<Value> = Vec::new();
        let mut seen: HashSet<i64> = HashSet::new();
        for idx in &self.block_order {
            if !seen.insert(*idx) {
                continue;
            }
            let Some(block) = self.blocks.get(idx) else { continue };
            match block.block_type.as_str() {
                "text" => {
                    content_blocks.push(json!({
                        "type": "text",
                        "text": block.text
                    }));
                }
                "tool_use" => {
                    let input: Value = serde_json::from_str(&block.tool_input_buf)
                        .unwrap_or(json!({}));
                    content_blocks.push(json!({
                        "type": "tool_use",
                        "id": block.tool_id,
                        "name": block.tool_name,
                        "input": input
                    }));
                }
                "thinking" => {
                    content_blocks.push(json!({
                        "type": "thinking",
                        "thinking": block.thinking
                    }));
                }
                _ => {}
            }
        }

        json!({
            "id": self.message_id,
            "type": "message",
            "role": self.role,
            "model": self.model,
            "content": content_blocks,
            "stop_reason": self.stop_reason,
            "usage": {
                "input_tokens": self.input_tokens,
                "output_tokens": self.output_tokens,
                "cache_read_input_tokens": self.cache_read_input_tokens,
                "cache_creation_input_tokens": self.cache_creation_input_tokens,
            }
        })
    }
}

pub struct SessionManager {
    log_dir: String,
    sessions: RwLock<HashMap<String, SessionState>>,
    global_seq: AtomicU64,
}

struct SessionState {
    session_id: String,
    short_id: String,
    device_id: String,
    first_seen: String,
    last_seen: String,
    seq: AtomicU64,
    models: HashSet<String>,
    request_count: u64,
    blob_store: Option<BlobStore>,
}

#[derive(Clone)]
pub struct RequestContext {
    pub session_id: String,
    pub session_short: String,
    pub dir_name: String,
    pub seq: u64,
    pub request_id: String,
    pub base_name: String,
    pub dir_path: PathBuf,
}

impl SessionManager {
    pub fn new(log_dir: String) -> Self {
        Self {
            log_dir,
            sessions: RwLock::new(HashMap::new()),
            global_seq: AtomicU64::new(0),
        }
    }

    pub fn begin_request(&self, body: &Value) -> RequestContext {
        let (session_id, device_id) = extract_session_info(body);
        let short_id = if session_id == "unknown" {
            "unknown".to_string()
        } else {
            session_id.chars().take(8).collect()
        };
        let dir_name = if session_id == "unknown" {
            "unknown".to_string()
        } else {
            session_id.chars().take(14).collect()
        };

        let date = chrono::Local::now().format("%Y-%m-%d").to_string();
        let dir_path = Path::new(&self.log_dir).join(&date).join(&dir_name);

        let seq = {
            let mut sessions = self.sessions.write().unwrap();
            let state = sessions.entry(session_id.clone()).or_insert_with(|| {
                let initial_seq = scan_max_seq(&dir_path);
                SessionState {
                    session_id: session_id.clone(),
                    short_id: short_id.clone(),
                    device_id: device_id.clone(),
                    first_seen: chrono::Local::now().to_rfc3339(),
                    last_seen: chrono::Local::now().to_rfc3339(),
                    seq: AtomicU64::new(initial_seq),
                    models: HashSet::new(),
                    request_count: 0,
                    blob_store: None,
                }
            });
            state.last_seen = chrono::Local::now().to_rfc3339();
            state.request_count += 1;
            state.seq.fetch_add(1, Ordering::SeqCst) + 1
        };

        self.global_seq.fetch_add(1, Ordering::SeqCst);

        let request_id = uuid::Uuid::new_v4().to_string();
        let ts = chrono::Local::now().format("%H%M%S").to_string();
        let rand4 = &request_id[..4];
        let base_name = format!("{:03}-{}-{}", seq, ts, rand4);

        RequestContext {
            session_id,
            session_short: short_id,
            dir_name,
            seq,
            request_id,
            base_name,
            dir_path,
        }
    }

    pub fn log_request_post(&self, ctx: &RequestContext, body: &Value, attempt_model: &str) {
        ensure_dir(&ctx.dir_path);
        let safe_model = attempt_model
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '.' { c } else { '_' })
            .collect::<String>();
        let filename = format!("{}.{}.post.json", ctx.base_name, safe_model);
        let path = ctx.dir_path.join(&filename);

        let mut record = json!({
            "type": "request_post_ext_proc",
            "session_id": ctx.session_id,
            "seq": ctx.seq,
            "request_id": ctx.request_id,
            "attempt_model": attempt_model,
            "timestamp": chrono::Local::now().to_rfc3339(),
            "model": body.get("model"),
            "system": body.get("system"),
            "instructions": body.get("instructions"),
            "messages": body.get("messages"),
            "input": body.get("input"),
            "tools": body.get("tools"),
            "tool_choice": body.get("tool_choice"),
            "metadata": body.get("metadata"),
        });

        {
            let mut sessions = self.sessions.write().unwrap();
            if let Some(state) = sessions.get_mut(&ctx.session_id) {
                let blob_store = state.blob_store.get_or_insert_with(|| {
                    BlobStore::new(&ctx.dir_path)
                });
                blob_store.dedup_request(&mut record);
            }
        }

        write_json_file(&path, &record);
    }

    pub fn log_request(&self, ctx: &RequestContext, body: &Value) {
        ensure_dir(&ctx.dir_path);
        let filename = format!("{}.req.json", ctx.base_name);
        let path = ctx.dir_path.join(&filename);

        let mut record = json!({
            "type": "request",
            "session_id": ctx.session_id,
            "seq": ctx.seq,
            "request_id": ctx.request_id,
            "timestamp": chrono::Local::now().to_rfc3339(),
            "model": body.get("model"),
            "stream": body.get("stream"),
            "system": body.get("system"),
            "instructions": body.get("instructions"),
            "messages": body.get("messages"),
            "input": body.get("input"),
            "tools": body.get("tools"),
            "tool_choice": body.get("tool_choice"),
            "max_tokens": body.get("max_tokens"),
            "temperature": body.get("temperature"),
            "top_p": body.get("top_p"),
            "top_k": body.get("top_k"),
            "metadata": body.get("metadata"),
            "prompt_cache_key": body.get("prompt_cache_key"),
            "reasoning": body.get("reasoning"),
        });

        {
            let mut sessions = self.sessions.write().unwrap();
            if let Some(state) = sessions.get_mut(&ctx.session_id) {
                let blob_store = state.blob_store.get_or_insert_with(|| {
                    BlobStore::new(&ctx.dir_path)
                });
                blob_store.dedup_request(&mut record);
            }
        }

        write_json_file(&path, &record);
    }

    pub fn log_response(
        &self,
        ctx: &RequestContext,
        provider: &str,
        model: &str,
        response_body: &Value,
        elapsed_ms: u128,
    ) {
        ensure_dir(&ctx.dir_path);
        let filename = format!("{}.resp.json", ctx.base_name);
        let path = ctx.dir_path.join(&filename);

        let record = json!({
            "type": "response",
            "session_id": ctx.session_id,
            "seq": ctx.seq,
            "request_id": ctx.request_id,
            "timestamp": chrono::Local::now().to_rfc3339(),
            "provider": provider,
            "model": model,
            "elapsed_ms": elapsed_ms,
            "usage": response_body.get("usage"),
            "stop_reason": response_body.get("stop_reason"),
            "content": response_body.get("content"),
        });

        write_json_file(&path, &record);
        self.update_meta(ctx, model);
        self.append_index(ctx, provider, model, "response", elapsed_ms, None);
    }

    pub fn log_error(&self, ctx: &RequestContext, error: &str) {
        ensure_dir(&ctx.dir_path);
        let filename = format!("{}.error.json", ctx.base_name);
        let path = ctx.dir_path.join(&filename);

        let record = json!({
            "type": "error",
            "session_id": ctx.session_id,
            "seq": ctx.seq,
            "request_id": ctx.request_id,
            "timestamp": chrono::Local::now().to_rfc3339(),
            "error": error,
        });

        write_json_file(&path, &record);
        self.append_index(ctx, "", "", "error", 0, Some(error));
    }

    pub fn log_guard(&self, ctx: &RequestContext, requested: u64, maximum: u64, model: &str) {
        ensure_dir(&ctx.dir_path);
        let filename = format!("{}.guard.json", ctx.base_name);
        let path = ctx.dir_path.join(&filename);

        let record = json!({
            "type": "context_guard",
            "session_id": ctx.session_id,
            "seq": ctx.seq,
            "timestamp": chrono::Local::now().to_rfc3339(),
            "requested_tokens": requested,
            "maximum_tokens": maximum,
            "model": model,
        });

        write_json_file(&path, &record);
    }

    pub fn log_provider_error(
        &self,
        ctx: &RequestContext,
        provider_model: &str,
        error_class: &str,
        error: &str,
        latency_ms: u128,
    ) {
        ensure_dir(&ctx.dir_path);
        let ts = chrono::Local::now().format("%Y%m%d_%H%M%S_%3f");
        let filename = format!("{}.provider_error.{}.json", ctx.base_name, ts);
        let path = ctx.dir_path.join(&filename);

        let record = json!({
            "type": "provider_error",
            "session_id": ctx.session_id,
            "seq": ctx.seq,
            "request_id": ctx.request_id,
            "timestamp": chrono::Local::now().to_rfc3339(),
            "provider_model": provider_model,
            "error_class": error_class,
            "error": error,
            "latency_ms": latency_ms,
        });

        write_json_file(&path, &record);
    }

    pub fn log_stream_start(&self, ctx: &RequestContext, provider: &str, model: &str) {
        self.update_meta(ctx, model);
        self.append_index(ctx, provider, model, "stream_start", 0, None);
    }

    pub fn log_stream_complete(
        &self,
        ctx: &RequestContext,
        provider: &str,
        model: &str,
        accumulated: &Value,
        elapsed_ms: u128,
    ) {
        ensure_dir(&ctx.dir_path);
        let filename = format!("{}.resp.json", ctx.base_name);
        let path = ctx.dir_path.join(&filename);

        let record = json!({
            "type": "stream_response",
            "session_id": ctx.session_id,
            "seq": ctx.seq,
            "request_id": ctx.request_id,
            "timestamp": chrono::Local::now().to_rfc3339(),
            "provider": provider,
            "model": model,
            "elapsed_ms": elapsed_ms,
            "response": accumulated,
        });

        write_json_file(&path, &record);
        self.append_index(ctx, provider, model, "stream_complete", elapsed_ms, None);
    }

    fn update_meta(&self, ctx: &RequestContext, model: &str) {
        let mut sessions = self.sessions.write().unwrap();
        if let Some(state) = sessions.get_mut(&ctx.session_id) {
            state.models.insert(model.to_string());
            state.last_seen = chrono::Local::now().to_rfc3339();

            let meta = json!({
                "session_id": state.session_id,
                "short_id": state.short_id,
                "device_id": state.device_id,
                "first_seen": state.first_seen,
                "last_seen": state.last_seen,
                "request_count": state.request_count,
                "models": state.models.iter().collect::<Vec<_>>(),
            });

            ensure_dir(&ctx.dir_path);
            let meta_path = ctx.dir_path.join("_meta.json");
            write_json_file(&meta_path, &meta);
        }
    }

    fn append_index(
        &self,
        ctx: &RequestContext,
        provider: &str,
        model: &str,
        event_type: &str,
        elapsed_ms: u128,
        error: Option<&str>,
    ) {
        let date = chrono::Local::now().format("%Y-%m-%d").to_string();
        let index_dir = Path::new(&self.log_dir).join(&date);
        ensure_dir(&index_dir);
        let index_path = index_dir.join("index.jsonl");

        let mut entry = json!({
            "timestamp": chrono::Local::now().to_rfc3339(),
            "session": ctx.session_short,
            "session_id": ctx.session_id,
            "seq": ctx.seq,
            "request_id": ctx.request_id,
            "type": event_type,
            "provider": provider,
            "model": model,
        });
        if elapsed_ms > 0 {
            entry["elapsed_ms"] = json!(elapsed_ms);
        }
        if let Some(err) = error {
            entry["error"] = json!(err);
        }

        if let Ok(mut f) = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&index_path)
        {
            let line = serde_json::to_string(&entry).unwrap_or_default();
            let _ = writeln!(f, "{}", line);
        }
    }
}

fn extract_session_info(body: &Value) -> (String, String) {
    // Anthropic format: metadata.user_id is a JSON string with session_id and device_id
    if let Some(user_id) = body
        .get("metadata")
        .and_then(|m| m.get("user_id"))
        .and_then(|u| u.as_str())
    {
        if let Ok(parsed) = serde_json::from_str::<Value>(user_id) {
            let session_id = parsed
                .get("session_id")
                .and_then(|s| s.as_str())
                .unwrap_or("")
                .to_string();
            let device_id = parsed
                .get("device_id")
                .and_then(|d| d.as_str())
                .unwrap_or("")
                .to_string();
            if !session_id.is_empty() {
                return (session_id, device_id);
            }
        }
    }

    // Codex Responses API format: prompt_cache_key as session_id, client_metadata for device_id
    if let Some(cache_key) = body.get("prompt_cache_key").and_then(|v| v.as_str()) {
        if !cache_key.is_empty() {
            let device_id = body
                .get("client_metadata")
                .and_then(|m| m.get("x-codex-installation-id"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            return (cache_key.to_string(), device_id);
        }
    }

    ("unknown".to_string(), String::new())
}

fn ensure_dir(dir: &Path) {
    if !dir.exists() {
        let _ = fs::create_dir_all(dir);
    }
}

fn scan_max_seq(dir: &Path) -> u64 {
    if !dir.exists() {
        return 0;
    }
    let Ok(entries) = fs::read_dir(dir) else { return 0 };
    let mut max_seq: u64 = 0;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if let Some(seq_str) = name_str.split('-').next() {
            if let Ok(n) = seq_str.parse::<u64>() {
                if n > max_seq {
                    max_seq = n;
                }
            }
        }
    }
    max_seq
}

fn write_json_file(path: &Path, data: &Value) {
    match fs::File::create(path) {
        Ok(mut f) => {
            let content = serde_json::to_string_pretty(data).unwrap_or_default();
            let _ = f.write_all(content.as_bytes());
        }
        Err(e) => {
            eprintln!(
                "  {} failed to write log: {}",
                "LOG ERROR:".red(),
                e
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_body(session_id: &str, model: &str) -> Value {
        json!({
            "model": model,
            "messages": [{"role": "user", "content": "hello"}],
            "metadata": {
                "user_id": serde_json::to_string(&json!({
                    "session_id": session_id,
                    "device_id": "dev1"
                })).unwrap()
            }
        })
    }

    #[test]
    fn test_extract_session_info() {
        let body = make_body("abc-123-def", "m1");
        let (sid, did) = extract_session_info(&body);
        assert_eq!(sid, "abc-123-def");
        assert_eq!(did, "dev1");
    }

    #[test]
    fn test_extract_session_info_missing() {
        let body = json!({"model": "m1", "messages": []});
        let (sid, _) = extract_session_info(&body);
        assert_eq!(sid, "unknown");
    }

    #[test]
    fn test_extract_session_info_bad_json() {
        let body = json!({
            "model": "m1",
            "metadata": {"user_id": "not-json"}
        });
        let (sid, _) = extract_session_info(&body);
        assert_eq!(sid, "unknown");
    }

    #[test]
    fn test_begin_request_assigns_seq() {
        let mgr = SessionManager::new("/tmp/cc-proxy-test".into());
        let body = make_body("sess-1", "m1");
        let ctx1 = mgr.begin_request(&body);
        let ctx2 = mgr.begin_request(&body);
        assert_eq!(ctx1.seq, 1);
        assert_eq!(ctx2.seq, 2);
        assert_eq!(ctx1.session_short, "sess-1");
    }

    #[test]
    fn test_begin_request_different_sessions() {
        let mgr = SessionManager::new("/tmp/cc-proxy-test".into());
        let body1 = make_body("sess-aaa", "m1");
        let body2 = make_body("sess-bbb", "m1");
        let ctx1 = mgr.begin_request(&body1);
        let ctx2 = mgr.begin_request(&body2);
        assert_eq!(ctx1.seq, 1);
        assert_eq!(ctx2.seq, 1);
        assert_ne!(ctx1.dir_name, ctx2.dir_name);
    }

    #[test]
    fn test_begin_request_unknown_session() {
        let mgr = SessionManager::new("/tmp/cc-proxy-test".into());
        let body = json!({"model": "m1", "messages": []});
        let ctx = mgr.begin_request(&body);
        assert_eq!(ctx.session_short, "unknown");
        assert_eq!(ctx.dir_name, "unknown");
    }

    #[test]
    fn test_log_request_creates_file() {
        let dir = tempfile::tempdir().unwrap();
        let mgr = SessionManager::new(dir.path().to_string_lossy().to_string());
        let body = make_body("file-test-session", "m1");
        let ctx = mgr.begin_request(&body);
        mgr.log_request(&ctx, &body);

        let req_file = ctx.dir_path.join(format!("{}.req.json", ctx.base_name));
        assert!(req_file.exists());

        let content: Value = serde_json::from_str(&fs::read_to_string(&req_file).unwrap()).unwrap();
        assert_eq!(content["type"], "request");
        assert_eq!(content["session_id"], "file-test-session");
    }

    #[test]
    fn test_log_response_creates_file_and_index() {
        let dir = tempfile::tempdir().unwrap();
        let mgr = SessionManager::new(dir.path().to_string_lossy().to_string());
        let body = make_body("resp-test", "m1");
        let ctx = mgr.begin_request(&body);
        mgr.log_request(&ctx, &body);

        let resp = json!({"usage": {"input_tokens": 10, "output_tokens": 5}, "stop_reason": "end_turn", "content": []});
        mgr.log_response(&ctx, "anthropic", "claude", &resp, 1234);

        let resp_file = ctx.dir_path.join(format!("{}.resp.json", ctx.base_name));
        assert!(resp_file.exists());

        let meta_file = ctx.dir_path.join("_meta.json");
        assert!(meta_file.exists());

        let date = chrono::Local::now().format("%Y-%m-%d").to_string();
        let index_file = dir.path().join(&date).join("index.jsonl");
        assert!(index_file.exists());
    }

    #[test]
    fn test_log_error_creates_file() {
        let dir = tempfile::tempdir().unwrap();
        let mgr = SessionManager::new(dir.path().to_string_lossy().to_string());
        let body = make_body("err-test", "m1");
        let ctx = mgr.begin_request(&body);
        mgr.log_error(&ctx, "connection refused");

        let err_file = ctx.dir_path.join(format!("{}.error.json", ctx.base_name));
        assert!(err_file.exists());

        let content: Value = serde_json::from_str(&fs::read_to_string(&err_file).unwrap()).unwrap();
        assert_eq!(content["error"], "connection refused");
    }

    #[test]
    fn test_multiple_sessions_separate_dirs() {
        let dir = tempfile::tempdir().unwrap();
        let mgr = SessionManager::new(dir.path().to_string_lossy().to_string());
        let body1 = make_body("aaaa-bbbb-cccc-dddd", "m1");
        let body2 = make_body("xxxx-yyyy-zzzz-wwww", "m2");
        let ctx1 = mgr.begin_request(&body1);
        let ctx2 = mgr.begin_request(&body2);
        mgr.log_request(&ctx1, &body1);
        mgr.log_request(&ctx2, &body2);

        assert_ne!(ctx1.dir_path, ctx2.dir_path);
        assert!(ctx1.dir_path.exists());
        assert!(ctx2.dir_path.exists());
    }

    #[test]
    fn test_seq_resumes_from_existing_files() {
        let dir = tempfile::tempdir().unwrap();
        let mgr = SessionManager::new(dir.path().to_string_lossy().to_string());
        let body = make_body("resume-test-session", "m1");

        let ctx1 = mgr.begin_request(&body);
        mgr.log_request(&ctx1, &body);
        assert_eq!(ctx1.seq, 1);

        let ctx2 = mgr.begin_request(&body);
        mgr.log_request(&ctx2, &body);
        assert_eq!(ctx2.seq, 2);

        drop(mgr);

        let mgr2 = SessionManager::new(dir.path().to_string_lossy().to_string());
        let ctx3 = mgr2.begin_request(&body);
        assert!(ctx3.seq > 2, "seq should resume past existing files, got {}", ctx3.seq);
    }

    #[test]
    fn test_scan_max_seq_empty_dir() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(scan_max_seq(dir.path()), 0);
    }

    #[test]
    fn test_scan_max_seq_with_files() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("003-120000-abcd.req.json"), "{}").unwrap();
        fs::write(dir.path().join("007-130000-efgh.req.json"), "{}").unwrap();
        fs::write(dir.path().join("_meta.json"), "{}").unwrap();
        assert_eq!(scan_max_seq(dir.path()), 7);
    }

    #[test]
    fn test_anthropic_accumulator_text() {
        let mut acc = AnthropicStreamAccumulator::new();
        acc.process_event("message_start", &json!({
            "message": {"id": "msg_1", "model": "claude", "role": "assistant",
                       "usage": {"input_tokens": 10, "output_tokens": 0}}
        }));
        acc.process_event("content_block_start", &json!({
            "index": 0, "content_block": {"type": "text", "text": ""}
        }));
        acc.process_event("content_block_delta", &json!({
            "index": 0, "delta": {"type": "text_delta", "text": "Hello "}
        }));
        acc.process_event("content_block_delta", &json!({
            "index": 0, "delta": {"type": "text_delta", "text": "world!"}
        }));
        acc.process_event("content_block_stop", &json!({"index": 0}));
        acc.process_event("message_delta", &json!({
            "delta": {"stop_reason": "end_turn"},
            "usage": {"output_tokens": 5}
        }));
        acc.process_event("message_stop", &json!({}));

        let result = acc.finalize();
        assert_eq!(result["id"], "msg_1");
        assert_eq!(result["model"], "claude");
        let content = result["content"].as_array().unwrap();
        assert_eq!(content.len(), 1);
        assert_eq!(content[0]["text"], "Hello world!");
        assert_eq!(result["stop_reason"], "end_turn");
        assert_eq!(result["usage"]["input_tokens"], 10);
        assert_eq!(result["usage"]["output_tokens"], 5);
    }

    #[test]
    fn test_anthropic_accumulator_tool_use() {
        let mut acc = AnthropicStreamAccumulator::new();
        acc.process_event("message_start", &json!({
            "message": {"id": "msg_2", "model": "claude", "role": "assistant",
                       "usage": {"input_tokens": 20}}
        }));
        acc.process_event("content_block_start", &json!({
            "index": 0, "content_block": {"type": "text", "text": ""}
        }));
        acc.process_event("content_block_delta", &json!({
            "index": 0, "delta": {"type": "text_delta", "text": "Let me search."}
        }));
        acc.process_event("content_block_stop", &json!({"index": 0}));
        acc.process_event("content_block_start", &json!({
            "index": 1, "content_block": {"type": "tool_use", "id": "toolu_1", "name": "search", "input": {}}
        }));
        acc.process_event("content_block_delta", &json!({
            "index": 1, "delta": {"type": "input_json_delta", "partial_json": "{\"q\":"}
        }));
        acc.process_event("content_block_delta", &json!({
            "index": 1, "delta": {"type": "input_json_delta", "partial_json": "\"rust\"}"}
        }));
        acc.process_event("content_block_stop", &json!({"index": 1}));
        acc.process_event("message_delta", &json!({
            "delta": {"stop_reason": "tool_use"},
            "usage": {"output_tokens": 15}
        }));
        acc.process_event("message_stop", &json!({}));

        let result = acc.finalize();
        let content = result["content"].as_array().unwrap();
        assert_eq!(content.len(), 2);
        assert_eq!(content[0]["type"], "text");
        assert_eq!(content[1]["type"], "tool_use");
        assert_eq!(content[1]["name"], "search");
        assert_eq!(content[1]["input"]["q"], "rust");
        assert_eq!(result["stop_reason"], "tool_use");
    }

    #[test]
    fn test_anthropic_accumulator_thinking() {
        let mut acc = AnthropicStreamAccumulator::new();
        acc.process_event("message_start", &json!({
            "message": {"id": "msg_3", "model": "claude", "role": "assistant", "usage": {}}
        }));
        acc.process_event("content_block_start", &json!({
            "index": 0, "content_block": {"type": "thinking", "thinking": ""}
        }));
        acc.process_event("content_block_delta", &json!({
            "index": 0, "delta": {"type": "thinking_delta", "thinking": "Let me think..."}
        }));
        acc.process_event("content_block_stop", &json!({"index": 0}));
        acc.process_event("content_block_start", &json!({
            "index": 1, "content_block": {"type": "text", "text": ""}
        }));
        acc.process_event("content_block_delta", &json!({
            "index": 1, "delta": {"type": "text_delta", "text": "Answer"}
        }));
        acc.process_event("content_block_stop", &json!({"index": 1}));
        acc.process_event("message_stop", &json!({}));

        let result = acc.finalize();
        let content = result["content"].as_array().unwrap();
        assert_eq!(content.len(), 2);
        assert_eq!(content[0]["type"], "thinking");
        assert_eq!(content[0]["thinking"], "Let me think...");
        assert_eq!(content[1]["type"], "text");
        assert_eq!(content[1]["text"], "Answer");
    }

    // ── Duplicate-response accumulator tests ──

    #[test]
    fn test_accumulator_duplicate_text_delta_concatenated() {
        let mut acc = AnthropicStreamAccumulator::new();
        acc.process_event("message_start", &json!({
            "message": {"id": "msg_dup", "model": "claude", "role": "assistant", "usage": {}}
        }));
        acc.process_event("content_block_start", &json!({
            "index": 0, "content_block": {"type": "text", "text": ""}
        }));
        acc.process_event("content_block_delta", &json!({
            "index": 0, "delta": {"type": "text_delta", "text": "hello "}
        }));
        acc.process_event("content_block_delta", &json!({
            "index": 0, "delta": {"type": "text_delta", "text": "hello "}
        }));
        acc.process_event("content_block_delta", &json!({
            "index": 0, "delta": {"type": "text_delta", "text": "hello "}
        }));
        acc.process_event("content_block_stop", &json!({"index": 0}));
        acc.process_event("message_stop", &json!({}));

        let result = acc.finalize();
        let content = result["content"].as_array().unwrap();
        assert_eq!(content.len(), 1);
        assert_eq!(content[0]["text"], "hello hello hello ");
    }

    #[test]
    fn test_accumulator_duplicate_content_block_start_same_index() {
        let mut acc = AnthropicStreamAccumulator::new();
        acc.process_event("message_start", &json!({
            "message": {"id": "msg_dup2", "model": "claude", "role": "assistant", "usage": {}}
        }));
        acc.process_event("content_block_start", &json!({
            "index": 0, "content_block": {"type": "text", "text": ""}
        }));
        acc.process_event("content_block_delta", &json!({
            "index": 0, "delta": {"type": "text_delta", "text": "first"}
        }));
        acc.process_event("content_block_start", &json!({
            "index": 0, "content_block": {"type": "text", "text": ""}
        }));
        acc.process_event("content_block_delta", &json!({
            "index": 0, "delta": {"type": "text_delta", "text": "second"}
        }));
        acc.process_event("content_block_stop", &json!({"index": 0}));
        acc.process_event("message_stop", &json!({}));

        let result = acc.finalize();
        let content = result["content"].as_array().unwrap();
        assert_eq!(content.len(), 1, "duplicate block_start at same index should not create extra blocks");
    }

    #[test]
    fn test_accumulator_duplicate_message_start_keeps_last() {
        let mut acc = AnthropicStreamAccumulator::new();
        acc.process_event("message_start", &json!({
            "message": {"id": "msg_v1", "model": "claude", "role": "assistant",
                        "usage": {"input_tokens": 10}}
        }));
        acc.process_event("message_start", &json!({
            "message": {"id": "msg_v2", "model": "claude", "role": "assistant",
                        "usage": {"input_tokens": 20}}
        }));
        acc.process_event("content_block_start", &json!({
            "index": 0, "content_block": {"type": "text", "text": ""}
        }));
        acc.process_event("content_block_delta", &json!({
            "index": 0, "delta": {"type": "text_delta", "text": "ok"}
        }));
        acc.process_event("message_stop", &json!({}));

        let result = acc.finalize();
        assert_eq!(result["id"], "msg_v2");
        assert_eq!(result["usage"]["input_tokens"], 20);
    }

    #[test]
    fn test_accumulator_duplicate_tool_use_same_index() {
        let mut acc = AnthropicStreamAccumulator::new();
        acc.process_event("message_start", &json!({
            "message": {"id": "msg_t", "model": "claude", "role": "assistant", "usage": {}}
        }));
        acc.process_event("content_block_start", &json!({
            "index": 0, "content_block": {"type": "tool_use", "id": "toolu_1", "name": "read", "input": {}}
        }));
        acc.process_event("content_block_delta", &json!({
            "index": 0, "delta": {"type": "input_json_delta", "partial_json": "{\"path\":"}
        }));
        acc.process_event("content_block_delta", &json!({
            "index": 0, "delta": {"type": "input_json_delta", "partial_json": "\"a.rs\"}"}
        }));
        acc.process_event("content_block_stop", &json!({"index": 0}));
        acc.process_event("content_block_start", &json!({
            "index": 0, "content_block": {"type": "tool_use", "id": "toolu_1", "name": "read", "input": {}}
        }));
        acc.process_event("content_block_delta", &json!({
            "index": 0, "delta": {"type": "input_json_delta", "partial_json": "{\"path\":\"b.rs\"}"}
        }));
        acc.process_event("content_block_stop", &json!({"index": 0}));
        acc.process_event("message_stop", &json!({}));

        let result = acc.finalize();
        let content = result["content"].as_array().unwrap();
        assert_eq!(content.len(), 1, "same-index tool_use should not produce duplicate blocks");
        assert_eq!(content[0]["type"], "tool_use");
        assert_eq!(content[0]["id"], "toolu_1");
    }

    #[test]
    fn test_accumulator_duplicate_message_delta_last_wins() {
        let mut acc = AnthropicStreamAccumulator::new();
        acc.process_event("message_start", &json!({
            "message": {"id": "msg_md", "model": "claude", "role": "assistant", "usage": {}}
        }));
        acc.process_event("content_block_start", &json!({
            "index": 0, "content_block": {"type": "text", "text": ""}
        }));
        acc.process_event("content_block_delta", &json!({
            "index": 0, "delta": {"type": "text_delta", "text": "ok"}
        }));
        acc.process_event("content_block_stop", &json!({"index": 0}));
        acc.process_event("message_delta", &json!({
            "delta": {"stop_reason": "end_turn"},
            "usage": {"output_tokens": 5}
        }));
        acc.process_event("message_delta", &json!({
            "delta": {"stop_reason": "max_tokens"},
            "usage": {"output_tokens": 10}
        }));
        acc.process_event("message_stop", &json!({}));

        let result = acc.finalize();
        assert_eq!(result["stop_reason"], "max_tokens", "last message_delta should win");
        assert_eq!(result["usage"]["output_tokens"], 10);
    }

    #[test]
    fn test_blob_store_basic() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = BlobStore::new(dir.path());
        let val = json!({"role": "user", "content": "a long message that exceeds the minimum blob size threshold of 512 bytes. ".repeat(10)});
        let hash1 = store.store(&val).unwrap();
        let hash2 = store.store(&val).unwrap();
        assert_eq!(hash1, hash2);

        let blob_path = dir.path().join("_blobs").join(format!("{}.json", hash1));
        assert!(blob_path.exists());

        let stored: Value = serde_json::from_str(&fs::read_to_string(&blob_path).unwrap()).unwrap();
        assert_eq!(stored, val);
    }

    #[test]
    fn test_blob_store_small_content_inline() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = BlobStore::new(dir.path());
        let val = json!({"role": "user", "content": "hi"});
        assert!(store.store(&val).is_none());
        assert!(!dir.path().join("_blobs").exists());
    }

    #[test]
    fn test_dedup_request_messages() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = BlobStore::new(dir.path());

        let big_msg = json!({"role": "user", "content": "x".repeat(600)});
        let small_msg = json!({"role": "user", "content": "hi"});

        let mut record = json!({
            "messages": [big_msg.clone(), small_msg.clone(), big_msg.clone()],
            "tools": null
        });

        store.dedup_request(&mut record);

        let msgs = record["messages"].as_array().unwrap();
        assert!(msgs[0].get("$blob").is_some());
        assert!(msgs[1].get("$blob").is_none());
        assert_eq!(msgs[1], small_msg);
        assert!(msgs[2].get("$blob").is_some());
        assert_eq!(msgs[0]["$blob"], msgs[2]["$blob"]);
    }

    #[test]
    fn test_dedup_request_tools() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = BlobStore::new(dir.path());

        let tools = json!([{"name": "tool1", "description": "x".repeat(600)}]);
        let mut record = json!({
            "messages": [],
            "tools": tools
        });

        store.dedup_request(&mut record);
        assert!(record["tools"].get("$blob").is_some());
    }

    #[test]
    fn test_dedup_across_requests() {
        let dir = tempfile::tempdir().unwrap();
        let mgr = SessionManager::new(dir.path().to_string_lossy().to_string());

        let big_content = "x".repeat(600);
        let body = json!({
            "model": "m1",
            "messages": [
                {"role": "user", "content": big_content},
                {"role": "assistant", "content": big_content}
            ],
            "tools": [{"name": "t1", "description": big_content}],
            "metadata": {
                "user_id": serde_json::to_string(&json!({
                    "session_id": "dedup-test-session",
                    "device_id": "dev1"
                })).unwrap()
            }
        });

        let ctx1 = mgr.begin_request(&body);
        mgr.log_request(&ctx1, &body);

        let ctx2 = mgr.begin_request(&body);
        mgr.log_request(&ctx2, &body);

        let req1_path = ctx1.dir_path.join(format!("{}.req.json", ctx1.base_name));
        let req2_path = ctx2.dir_path.join(format!("{}.req.json", ctx2.base_name));

        let req1_size = fs::metadata(&req1_path).unwrap().len();
        let req2_size = fs::metadata(&req2_path).unwrap().len();

        assert!(req2_size <= req1_size, "Second request ({req2_size}B) should be <= first ({req1_size}B) due to blob dedup");

        let req2: Value = serde_json::from_str(&fs::read_to_string(&req2_path).unwrap()).unwrap();
        let msgs = req2["messages"].as_array().unwrap();
        assert!(msgs[0].get("$blob").is_some());
        assert!(msgs[1].get("$blob").is_some());
        assert!(req2["tools"].get("$blob").is_some());

        let blobs_dir = ctx1.dir_path.join("_blobs");
        assert!(blobs_dir.exists());
        let blob_count = fs::read_dir(&blobs_dir).unwrap().count();
        assert!(blob_count >= 2, "Should have at least 2 blobs (msgs + tools), got {blob_count}");
    }
}
