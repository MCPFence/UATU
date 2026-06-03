//! pii — PII 透明 mask/unmask（detector + 会话级 vault + masker + 审计日志）

use chrono::Local;
use rand::RngCore;
use regex::Regex;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;
use std::sync::{LazyLock, Mutex};

// ── Token 格式 ────────────────────────────────────────────────────────────────

pub const TOKEN_MAX_LEN: usize = 22; // "⟦BANKCARD_XXXXXXXX⟧" UTF-8 字节最长 22

static TOKEN_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"⟦(EMAIL|PHONE|IDCARD|BANKCARD|MAC)_([0-9A-F]{8})⟧").unwrap());

// ── 正则 ──────────────────────────────────────────────────────────────────────

static EMAIL_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}").unwrap());
static PHONE_RE: LazyLock<Regex> = LazyLock::new(|| {
    // 不能使用 lookaround，外层手动检查左右是否为数字
    Regex::new(r"(?:(?:\+86|0086)?[\s\-]?)?1[3-9]\d{9}").unwrap()
});
static PHONE_INNER_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"1[3-9]\d{9}").unwrap());
static IDCARD_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\d{17}[\dXx]").unwrap());
static BANKCARD_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?:4\d{12}(?:\d{3})?|5[1-5]\d{14}|62\d{14,17}|\d{16,19})").unwrap()
});
static MAC_RE: LazyLock<Regex> = LazyLock::new(|| {
    // 匹配常见 MAC 地址格式：AA:BB:CC:DD:EE:FF / AA-BB-CC-DD-EE-FF / AABB.CCDD.EEFF
    Regex::new(r"(?i)(?:[0-9a-f]{2}[:\-]){5}[0-9a-f]{2}|(?:[0-9a-f]{4}\.){2}[0-9a-f]{4}").unwrap()
});

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PiiType {
    Email,
    Phone,
    IdCard,
    BankCard,
    Mac,
}

impl PiiType {
    pub fn as_str(self) -> &'static str {
        match self {
            PiiType::Email => "EMAIL",
            PiiType::Phone => "PHONE",
            PiiType::IdCard => "IDCARD",
            PiiType::BankCard => "BANKCARD",
            PiiType::Mac => "MAC",
        }
    }
}

// ── 校验函数 ──────────────────────────────────────────────────────────────────

fn luhn_ok(number: &str) -> bool {
    let digits: Vec<u32> = number.chars().filter_map(|c| c.to_digit(10)).collect();
    if digits.len() != number.len() || digits.is_empty() {
        return false;
    }
    let mut total: u32 = 0;
    let n = digits.len();
    for (i, d) in digits.iter().rev().enumerate() {
        if i % 2 == 0 {
            total += d;
        } else {
            let doubled = d * 2;
            total += doubled / 10 + doubled % 10;
        }
    }
    let _ = n;
    total % 10 == 0
}

fn idcard_ok(s: &str) -> bool {
    if s.len() != 18 {
        return false;
    }
    let upper = s.to_ascii_uppercase();
    let weights = [7u32, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
    let check_chars = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2'];
    let bytes = upper.as_bytes();
    let mut total: u32 = 0;
    for i in 0..17 {
        let d = (bytes[i] as char).to_digit(10);
        match d {
            Some(v) => total += v * weights[i],
            None => return false,
        }
    }
    bytes[17] as char == check_chars[(total % 11) as usize]
}

// ── 检测 ──────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct PiiHit {
    pub pii_type: PiiType,
    pub raw: String,
    pub start: usize,
    pub end: usize,
}

/// 返回按 start 升序去重后的 hits（再由调用方按 start 倒序替换以避免位置偏移）。
pub fn detect_pii(text: &str) -> Vec<PiiHit> {
    let bytes = text.as_bytes();
    let is_digit = |b: u8| b.is_ascii_digit();
    let mut hits: Vec<PiiHit> = Vec::new();

    for m in EMAIL_RE.find_iter(text) {
        hits.push(PiiHit {
            pii_type: PiiType::Email,
            raw: m.as_str().to_string(),
            start: m.start(),
            end: m.end(),
        });
    }

    for m in PHONE_RE.find_iter(text) {
        // 左右不得为数字（替代 lookaround）
        if let Some(inner) = PHONE_INNER_RE.find(m.as_str()) {
            let abs_start = m.start() + inner.start();
            let abs_end = m.start() + inner.end();
            let left_ok = abs_start == 0 || !is_digit(bytes[abs_start - 1]);
            let right_ok = abs_end == bytes.len() || !is_digit(bytes[abs_end]);
            if left_ok && right_ok {
                hits.push(PiiHit {
                    pii_type: PiiType::Phone,
                    raw: inner.as_str().to_string(),
                    start: abs_start,
                    end: abs_end,
                });
            }
        }
    }

    for m in IDCARD_RE.find_iter(text) {
        let left_ok = m.start() == 0 || !is_digit(bytes[m.start() - 1]);
        let right_ok = m.end() == bytes.len() || !is_digit(bytes[m.end()]);
        if left_ok && right_ok && idcard_ok(m.as_str()) {
            hits.push(PiiHit {
                pii_type: PiiType::IdCard,
                raw: m.as_str().to_ascii_uppercase(),
                start: m.start(),
                end: m.end(),
            });
        }
    }

    for m in BANKCARD_RE.find_iter(text) {
        let left_ok = m.start() == 0 || !is_digit(bytes[m.start() - 1]);
        let right_ok = m.end() == bytes.len() || !is_digit(bytes[m.end()]);
        let val = m.as_str();
        if left_ok && right_ok && val.len() >= 16 && luhn_ok(val) {
            hits.push(PiiHit {
                pii_type: PiiType::BankCard,
                raw: val.to_string(),
                start: m.start(),
                end: m.end(),
            });
        }
    }

    for m in MAC_RE.find_iter(text) {
        let raw = m.as_str();
        // 排除全零 MAC 和广播地址 FF:FF:FF:FF:FF:FF
        let normalized: String = raw.chars().filter(|c| c.is_ascii_hexdigit()).collect();
        if normalized.len() == 12
            && normalized != "000000000000"
            && normalized.to_ascii_uppercase() != "FFFFFFFFFFFF"
        {
            hits.push(PiiHit {
                pii_type: PiiType::Mac,
                raw: raw.to_string(),
                start: m.start(),
                end: m.end(),
            });
        }
    }

    // 按 start 升序、去重重叠
    hits.sort_by_key(|h| h.start);
    let mut deduped: Vec<PiiHit> = Vec::with_capacity(hits.len());
    let mut last_end: usize = 0;
    let mut first = true;
    for h in hits {
        if first || h.start >= last_end {
            last_end = h.end;
            deduped.push(h);
            first = false;
        }
    }
    deduped
}

// ── Vault ────────────────────────────────────────────────────────────────────

#[derive(Default)]
pub struct PiiVault {
    salt: [u8; 16],
    forward: HashMap<String, String>, // "TYPE:raw" → token
    reverse: HashMap<String, String>, // token → raw
}

impl PiiVault {
    pub fn new() -> Self {
        let mut salt = [0u8; 16];
        rand::thread_rng().fill_bytes(&mut salt);
        Self {
            salt,
            forward: HashMap::new(),
            reverse: HashMap::new(),
        }
    }

    fn make_token(&self, pii_type: PiiType, raw: &str) -> String {
        let mut ctx = md5::Context::new();
        ctx.consume(self.salt);
        ctx.consume(pii_type.as_str().as_bytes());
        ctx.consume(b":");
        ctx.consume(raw.as_bytes());
        let digest = ctx.compute();
        let hex8: String = digest.0.iter().take(4).map(|b| format!("{:02X}", b)).collect();
        format!("⟦{}_{}⟧", pii_type.as_str(), hex8)
    }

    pub fn mask(&mut self, text: &str, session_id: &str, seq: u64) -> String {
        let hits = detect_pii(text);
        if hits.is_empty() {
            return text.to_string();
        }
        // 从后向前替换，避免位置偏移
        let mut buf = text.to_string();
        for h in hits.into_iter().rev() {
            let fwd_key = format!("{}:{}", h.pii_type.as_str(), h.raw);
            let token = if let Some(t) = self.forward.get(&fwd_key) {
                t.clone()
            } else {
                let t = self.make_token(h.pii_type, &h.raw);
                self.forward.insert(fwd_key, t.clone());
                self.reverse.insert(t.clone(), h.raw.clone());
                t
            };
            log_mask(session_id, seq, h.pii_type, &h.raw, &token);
            buf.replace_range(h.start..h.end, &token);
        }
        buf
    }

    /// 返回 (还原后文本, 未知 token 列表)
    pub fn unmask(&self, text: &str, session_id: &str, seq: u64) -> (String, Vec<String>) {
        if !text.contains('⟦') {
            return (text.to_string(), Vec::new());
        }
        let mut unknown: Vec<String> = Vec::new();
        let result = TOKEN_RE
            .replace_all(text, |caps: &regex::Captures<'_>| {
                let token = caps.get(0).unwrap().as_str();
                let pii_type = caps.get(1).unwrap().as_str();
                if let Some(raw) = self.reverse.get(token) {
                    log_unmask(session_id, seq, pii_type, token, raw);
                    raw.clone()
                } else {
                    log_unknown_token(session_id, seq, token);
                    unknown.push(token.to_string());
                    token.to_string()
                }
            })
            .into_owned();
        (result, unknown)
    }

    pub fn reverse_map(&self) -> HashMap<String, String> {
        self.reverse.clone()
    }
}

// ── Manager ──────────────────────────────────────────────────────────────────

pub struct VaultManager {
    vaults: Mutex<HashMap<String, std::sync::Arc<Mutex<PiiVault>>>>,
}

impl VaultManager {
    pub fn new() -> Self {
        Self {
            vaults: Mutex::new(HashMap::new()),
        }
    }

    pub fn get(&self, session_id: &str) -> std::sync::Arc<Mutex<PiiVault>> {
        let mut guard = self.vaults.lock().unwrap();
        guard
            .entry(session_id.to_string())
            .or_insert_with(|| std::sync::Arc::new(Mutex::new(PiiVault::new())))
            .clone()
    }

    pub fn clear(&self, session_id: &str) {
        let mut guard = self.vaults.lock().unwrap();
        guard.remove(session_id);
    }

    pub fn size(&self) -> usize {
        self.vaults.lock().unwrap().len()
    }
}

impl Default for VaultManager {
    fn default() -> Self {
        Self::new()
    }
}

// ── 消息遍历（mask） ────────────────────────────────────────────────────────

/// 对 body.messages 中 user / tool_result 文本做 mask（in-place）。
pub fn mask_messages(body: &mut Value, vault: &mut PiiVault, session_id: &str, seq: u64) {
    let Some(messages) = body.get_mut("messages").and_then(|m| m.as_array_mut()) else {
        return;
    };
    for msg in messages.iter_mut() {
        if msg.get("role").and_then(|r| r.as_str()) != Some("user") {
            continue;
        }
        let Some(content) = msg.get_mut("content") else {
            continue;
        };
        if let Some(s) = content.as_str() {
            *content = Value::String(vault.mask(s, session_id, seq));
        } else if let Some(blocks) = content.as_array_mut() {
            for block in blocks.iter_mut() {
                let btype = block
                    .get("type")
                    .and_then(|t| t.as_str())
                    .unwrap_or("")
                    .to_string();
                if btype == "text" {
                    if let Some(t) = block.get_mut("text").and_then(|v| v.as_str()).map(|s| s.to_string()) {
                        let masked = vault.mask(&t, session_id, seq);
                        if let Some(text_field) = block.get_mut("text") {
                            *text_field = Value::String(masked);
                        }
                    }
                } else if btype == "tool_result" {
                    if let Some(c) = block.get_mut("content") {
                        if let Some(s) = c.as_str() {
                            *c = Value::String(vault.mask(s, session_id, seq));
                        } else if let Some(items) = c.as_array_mut() {
                            for cb in items.iter_mut() {
                                if cb.get("type").and_then(|t| t.as_str()) == Some("text") {
                                    if let Some(t) = cb
                                        .get_mut("text")
                                        .and_then(|v| v.as_str())
                                        .map(|s| s.to_string())
                                    {
                                        let masked = vault.mask(&t, session_id, seq);
                                        if let Some(f) = cb.get_mut("text") {
                                            *f = Value::String(masked);
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

// ── 响应遍历（unmask） ──────────────────────────────────────────────────────

/// 对 response.content 做 unmask。text block 还原 text；tool_use 递归还原 input。
pub fn unmask_response(
    response: &mut Value,
    vault: &PiiVault,
    session_id: &str,
    seq: u64,
) -> Vec<String> {
    let mut unknown_all: Vec<String> = Vec::new();
    let Some(content) = response.get_mut("content").and_then(|c| c.as_array_mut()) else {
        return unknown_all;
    };
    for block in content.iter_mut() {
        let btype = block.get("type").and_then(|t| t.as_str()).unwrap_or("").to_string();
        if btype == "text" {
            if let Some(t) = block.get_mut("text").and_then(|v| v.as_str()).map(|s| s.to_string()) {
                let (clean, unk) = vault.unmask(&t, session_id, seq);
                unknown_all.extend(unk);
                if let Some(f) = block.get_mut("text") {
                    *f = Value::String(clean);
                }
            }
        } else if btype == "tool_use" {
            if let Some(input) = block.get_mut("input") {
                unmask_value_in_place(input, vault, session_id, seq, &mut unknown_all);
            }
        }
    }
    unknown_all
}

fn unmask_value_in_place(
    v: &mut Value,
    vault: &PiiVault,
    session_id: &str,
    seq: u64,
    unknown: &mut Vec<String>,
) {
    match v {
        Value::String(s) => {
            let (clean, unk) = vault.unmask(s, session_id, seq);
            unknown.extend(unk);
            *s = clean;
        }
        Value::Array(arr) => {
            for item in arr.iter_mut() {
                unmask_value_in_place(item, vault, session_id, seq, unknown);
            }
        }
        Value::Object(obj) => {
            for (_, val) in obj.iter_mut() {
                unmask_value_in_place(val, vault, session_id, seq, unknown);
            }
        }
        _ => {}
    }
}

// ── 系统提示注入（首轮） ────────────────────────────────────────────────────

const PII_RULES_SECTION: &str = "# 敏感信息占位符\n\
文本中形如 ⟦EMAIL_xxxx⟧、⟦PHONE_xxxx⟧、⟦IDCARD_xxxx⟧、⟦BANKCARD_xxxx⟧、⟦MAC_xxxx⟧ 的内容是用户敏感信息的占位符。\n\
你必须把它们当作真实信息的引用来处理，但不得推测、展开、改写或还原其原始值。\n\
回复内容、工具调用参数中如需引用这些信息，必须原样输出完整 token，包含 ⟦ 与 ⟧。";

const PII_MARKER: &str = "⟦EMAIL_xxxx⟧";

pub fn inject_pii_system_rules(body: &mut Value) {
    let system = body.get_mut("system");
    match system {
        None => {
            body["system"] = json!([{"type": "text", "text": PII_RULES_SECTION}]);
        }
        Some(Value::Array(arr)) => {
            let already = arr.iter().any(|b| {
                b.get("type").and_then(|t| t.as_str()) == Some("text")
                    && b.get("text")
                        .and_then(|t| t.as_str())
                        .map(|s| s.contains(PII_MARKER))
                        .unwrap_or(false)
            });
            if !already {
                arr.push(json!({"type": "text", "text": PII_RULES_SECTION}));
            }
        }
        Some(Value::String(s)) => {
            if !s.contains(PII_MARKER) {
                let merged = format!("{}\n\n{}", s, PII_RULES_SECTION);
                *s = merged;
            }
        }
        Some(_) => {}
    }
}

// ── 流式 token 替换（带边界缓冲） ───────────────────────────────────────────

/// 用 reverse map 替换字符串中已知 token；保留未知 token。
pub fn unmask_text_with_map(text: &str, reverse: &HashMap<String, String>) -> String {
    if !text.contains('⟦') {
        return text.to_string();
    }
    TOKEN_RE
        .replace_all(text, |caps: &regex::Captures<'_>| {
            let token = caps.get(0).unwrap().as_str();
            if let Some(raw) = reverse.get(token) {
                raw.clone()
            } else {
                token.to_string()
            }
        })
        .into_owned()
}

/// 跨 chunk 文本缓冲：保留可能跨边界的 token 尾巴。
pub struct StreamTextReplacer {
    pending: String,
}

impl StreamTextReplacer {
    pub fn new() -> Self {
        Self { pending: String::new() }
    }

    /// 喂入新 chunk，返回可安全输出的字符串。
    pub fn feed(&mut self, chunk: &str, reverse: &HashMap<String, String>) -> String {
        self.pending.push_str(chunk);
        // 找最后一个未闭合的 ⟦：若其后无 ⟧ 且距末尾在 TOKEN_MAX_LEN 内，保留作为 pending
        if let Some(last_open) = self.pending.rfind('⟦') {
            let tail = &self.pending[last_open..];
            if !tail.contains('⟧') && tail.len() < TOKEN_MAX_LEN {
                let safe = unmask_text_with_map(&self.pending[..last_open], reverse);
                let retained = self.pending[last_open..].to_string();
                self.pending = retained;
                return safe;
            }
        }
        let out = unmask_text_with_map(&self.pending, reverse);
        self.pending.clear();
        out
    }

    /// 流结束时冲刷剩余内容。
    pub fn flush(&mut self, reverse: &HashMap<String, String>) -> String {
        if self.pending.is_empty() {
            return String::new();
        }
        let out = unmask_text_with_map(&self.pending, reverse);
        self.pending.clear();
        out
    }
}

impl Default for StreamTextReplacer {
    fn default() -> Self {
        Self::new()
    }
}

// ── JSONL 审计日志 ──────────────────────────────────────────────────────────

static LOG_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

fn log_path() -> PathBuf {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    let dir = home.join(".cc-proxy").join("logs");
    let _ = std::fs::create_dir_all(&dir);
    dir.join("pii.jsonl")
}

#[derive(Serialize)]
struct LogRecord<'a> {
    ts: String,
    direction: &'a str,
    session_id: &'a str,
    seq: u64,
    pii_type: &'a str,
    token: &'a str,
    raw_hint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<&'a str>,
}

fn raw_hint(pii_type: &str, raw: &str) -> String {
    match pii_type {
        "EMAIL" => raw
            .split_once('@')
            .map(|(_, dom)| format!("***@{}", dom))
            .unwrap_or_else(|| "***".to_string()),
        "PHONE" | "IDCARD" | "BANKCARD" if raw.len() >= 4 => {
            format!("***{}", &raw[raw.len() - 4..])
        }
        "MAC" => {
            // 只显示前缀（厂商OUI部分）
            let hex: String = raw.chars().filter(|c| c.is_ascii_hexdigit()).collect();
            if hex.len() >= 6 {
                format!("{}:***", &hex[..6])
            } else {
                "***".to_string()
            }
        }
        _ => "***".to_string(),
    }
}

fn short_sid(session_id: &str) -> &str {
    if session_id.len() >= 16 {
        &session_id[..16]
    } else {
        session_id
    }
}

fn write_record(rec: &LogRecord<'_>) {
    let line = match serde_json::to_string(rec) {
        Ok(s) => s,
        Err(_) => return,
    };
    let path = log_path();
    let _guard = LOG_LOCK.lock().unwrap();
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(f, "{}", line);
    }
}

pub fn log_mask(session_id: &str, seq: u64, pii_type: PiiType, raw: &str, token: &str) {
    let ts = Local::now().to_rfc3339();
    let hint = raw_hint(pii_type.as_str(), raw);
    let rec = LogRecord {
        ts,
        direction: "mask",
        session_id: short_sid(session_id),
        seq,
        pii_type: pii_type.as_str(),
        token,
        raw_hint: Some(hint),
        error: None,
    };
    write_record(&rec);
}

pub fn log_unmask(session_id: &str, seq: u64, pii_type: &str, token: &str, raw: &str) {
    let ts = Local::now().to_rfc3339();
    let hint = raw_hint(pii_type, raw);
    let rec = LogRecord {
        ts,
        direction: "unmask",
        session_id: short_sid(session_id),
        seq,
        pii_type,
        token,
        raw_hint: Some(hint),
        error: None,
    };
    write_record(&rec);
}

pub fn log_unknown_token(session_id: &str, seq: u64, token: &str) {
    let ts = Local::now().to_rfc3339();
    let rec = LogRecord {
        ts,
        direction: "unmask",
        session_id: short_sid(session_id),
        seq,
        pii_type: "UNKNOWN",
        token,
        raw_hint: None,
        error: Some("unknown_token"),
    };
    write_record(&rec);
}

// ── 测试 ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detect_email() {
        let hits = detect_pii("联系 alice@example.com 谢谢");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].pii_type, PiiType::Email);
        assert_eq!(hits[0].raw, "alice@example.com");
    }

    #[test]
    fn detect_phone() {
        let hits = detect_pii("电话 13812345678 备注");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].pii_type, PiiType::Phone);
    }

    #[test]
    fn phone_rejects_surrounding_digit() {
        let hits = detect_pii("代码 a13812345678b");
        assert_eq!(hits[0].pii_type, PiiType::Phone);
        let hits = detect_pii("代码 12313812345678");
        assert!(hits.iter().all(|h| h.pii_type != PiiType::Phone));
    }

    #[test]
    fn mask_unmask_roundtrip() {
        let mut vault = PiiVault::new();
        let masked = vault.mask("ping alice@x.com from 13812345678", "sid", 1);
        assert!(masked.contains("⟦EMAIL_"));
        assert!(masked.contains("⟦PHONE_"));
        let (clean, unk) = vault.unmask(&masked, "sid", 1);
        assert_eq!(clean, "ping alice@x.com from 13812345678");
        assert!(unk.is_empty());
    }

    #[test]
    fn mask_idempotent_token() {
        let mut vault = PiiVault::new();
        let a = vault.mask("alice@x.com", "sid", 1);
        let b = vault.mask("alice@x.com", "sid", 2);
        assert_eq!(a, b);
    }

    #[test]
    fn unmask_unknown_token_preserved() {
        let vault = PiiVault::new();
        let (clean, unk) = vault.unmask("hello ⟦EMAIL_DEADBEEF⟧!", "sid", 1);
        assert_eq!(clean, "hello ⟦EMAIL_DEADBEEF⟧!");
        assert_eq!(unk, vec!["⟦EMAIL_DEADBEEF⟧".to_string()]);
    }

    #[test]
    fn mask_messages_walks_user_only() {
        let mut body = json!({
            "messages": [
                {"role": "user", "content": "find alice@x.com"},
                {"role": "assistant", "content": [{"type": "text", "text": "user is alice@x.com"}]},
                {"role": "user", "content": [
                    {"type": "tool_result", "content": "result: bob@y.com"}
                ]},
            ]
        });
        let mut vault = PiiVault::new();
        mask_messages(&mut body, &mut vault, "sid", 1);
        let msgs = body["messages"].as_array().unwrap();
        assert!(msgs[0]["content"].as_str().unwrap().contains("⟦EMAIL_"));
        // assistant 不 mask
        assert_eq!(
            msgs[1]["content"][0]["text"].as_str().unwrap(),
            "user is alice@x.com"
        );
        assert!(msgs[2]["content"][0]["content"]
            .as_str()
            .unwrap()
            .contains("⟦EMAIL_"));
    }

    #[test]
    fn unmask_response_walks_text_and_tool_use() {
        let mut vault = PiiVault::new();
        let token_email = vault.mask("alice@x.com", "sid", 1);
        let mut resp = json!({
            "content": [
                {"type": "text", "text": format!("user {}", token_email)},
                {"type": "tool_use", "input": {"to": token_email.clone(), "nested": {"cc": [token_email.clone()]}}},
            ]
        });
        let unk = unmask_response(&mut resp, &vault, "sid", 1);
        assert!(unk.is_empty());
        assert_eq!(resp["content"][0]["text"], "user alice@x.com");
        assert_eq!(resp["content"][1]["input"]["to"], "alice@x.com");
        assert_eq!(resp["content"][1]["input"]["nested"]["cc"][0], "alice@x.com");
    }

    #[test]
    fn stream_replacer_handles_cross_boundary() {
        let mut vault = PiiVault::new();
        let token = vault.mask("alice@x.com", "sid", 1);
        let rev = vault.reverse_map();

        // 把 token 拆成两半投喂
        let (left, right) = token.split_at(token.len() / 2);
        let mut r = StreamTextReplacer::new();
        let out1 = r.feed(&format!("hello {}", left), &rev);
        let out2 = r.feed(right, &rev);
        let out3 = r.feed(" world", &rev);
        let flushed = r.flush(&rev);
        let total = format!("{}{}{}{}", out1, out2, out3, flushed);
        assert_eq!(total, "hello alice@x.com world");
    }

    #[test]
    fn inject_pii_rules_idempotent() {
        let mut body = json!({"system": "you are helpful"});
        inject_pii_system_rules(&mut body);
        inject_pii_system_rules(&mut body);
        let s = body["system"].as_str().unwrap();
        assert_eq!(s.matches("敏感信息占位符").count(), 1);
    }

    #[test]
    fn detect_mac_colon() {
        let hits = detect_pii("MAC地址 aa:bb:cc:dd:ee:ff 结束");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].pii_type, PiiType::Mac);
        assert_eq!(hits[0].raw, "aa:bb:cc:dd:ee:ff");
    }

    #[test]
    fn detect_mac_dash() {
        let hits = detect_pii("设备 01-23-45-67-89-AB ok");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].pii_type, PiiType::Mac);
    }

    #[test]
    fn detect_mac_dot() {
        let hits = detect_pii("cisco格式 0123.4567.89ab 完毕");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].pii_type, PiiType::Mac);
    }

    #[test]
    fn detect_mac_rejects_all_zero() {
        let hits = detect_pii("空MAC 00:00:00:00:00:00 不算");
        let macs: Vec<_> = hits.iter().filter(|h| h.pii_type == PiiType::Mac).collect();
        assert!(macs.is_empty());
    }

    #[test]
    fn detect_mac_rejects_broadcast() {
        let hits = detect_pii("广播 FF:FF:FF:FF:FF:FF 不算");
        let macs: Vec<_> = hits.iter().filter(|h| h.pii_type == PiiType::Mac).collect();
        assert!(macs.is_empty());
    }

    #[test]
    fn mask_unmask_mac_roundtrip() {
        let mut vault = PiiVault::new();
        let original = "设备MAC aa:bb:cc:11:22:33 记录";
        let masked = vault.mask(original, "sid", 1);
        assert!(!masked.contains("aa:bb:cc:11:22:33"));
        assert!(masked.contains("⟦MAC_"));
        let (clean, unk) = vault.unmask(&masked, "sid", 1);
        assert_eq!(clean, original);
        assert!(unk.is_empty());
    }
}
