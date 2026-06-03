use crate::config::{Config, ExtProcConfig, PriorityEntry, ProviderType};
use crate::ext_proc::{ExtProcClient, ExtProcResult};
use crate::jsonlog::{RequestContext, SessionManager};
use crate::provider::{self, ProviderResult};
use crate::signals::RequestSignals;
use colored::Colorize;
use regex::Regex;
use reqwest::Client;
use serde_json::Value;
use std::sync::Arc;
use std::time::{Duration, Instant};

/// Bundle of ext_proc-related references threaded into failover functions.
/// All-None disables the per-attempt hook (used by code paths that don't need it).
#[derive(Clone, Copy)]
pub struct ExtProcCtx<'a> {
    pub client: Option<&'a Arc<ExtProcClient>>,
    pub config: Option<&'a ExtProcConfig>,
    pub signals: Option<&'a RequestSignals>,
    pub session_id: &'a str,
}

impl<'a> ExtProcCtx<'a> {
    pub fn none() -> Self {
        Self { client: None, config: None, signals: None, session_id: "" }
    }
}

/// Apply per-attempt ext_proc pre_request hook. Returns the (possibly modified)
/// body to send and an Option<Err> when the hook signals block.
async fn maybe_apply_ext_proc(
    ext_proc: &ExtProcCtx<'_>,
    seq: u64,
    body: &Value,
    attempt_model: &str,
    session_mgr: Option<&Arc<SessionManager>>,
    ctx: Option<&RequestContext>,
) -> Result<Value, String> {
    let (Some(client), Some(cfg), Some(sig)) = (ext_proc.client, ext_proc.config, ext_proc.signals)
    else {
        return Ok(body.clone());
    };
    if !client.should_call_pre(cfg, sig) {
        return Ok(body.clone());
    }
    match client
        .call_pre_request(ext_proc.session_id, seq, sig, body, Some(attempt_model))
        .await
    {
        ExtProcResult::Modified(new_body, _subs) => {
            if let (Some(mgr), Some(c)) = (session_mgr, ctx) {
                mgr.log_request_post(c, &new_body, attempt_model);
            }
            Ok(new_body)
        }
        ExtProcResult::Passthrough => Ok(body.clone()),
        ExtProcResult::Block(reason) => Err(format!("blocked_by_ext_proc={reason}")),
    }
}

const MAX_RETRIES_PER_PROVIDER: usize = 1;
const RETRY_BACKOFF_MS: u64 = 1000;

/// Execute with failover using pre-converted OpenAI Chat Completions body.
/// Skips Anthropic and OpenAIResponses providers (only routes to OpenAI Chat providers).
pub async fn execute_openai_with_failover(
    client: &Client,
    config: &Config,
    body: &Value,
    chain: &[PriorityEntry],
    profile_name: &str,
    session_short: &str,
    seq: u64,
    session_mgr: Option<&Arc<SessionManager>>,
    ctx: Option<&RequestContext>,
    ext_proc: ExtProcCtx<'_>,
) -> Result<(ProviderResult, usize), String> {
    let timeout = Duration::from_secs(config.timeout_secs);
    let mut last_error = String::from("No OpenAI-compatible providers found in chain");
    let profile_tag = format!("[profile={}]", profile_name);
    let session_tag = format!("[{}/{}]", session_short, seq);

    for (i, entry) in chain.iter().enumerate() {
        let provider = config.find_provider(&entry.provider).ok_or_else(|| {
            format!("Provider '{}' not found in config", entry.provider)
        })?;

        // Skip non-OpenAI-Chat providers
        if provider.provider_type != ProviderType::OpenAI {
            let ts = chrono::Local::now().format("%H:%M:%S");
            eprintln!(
                "{} {} {} skip {}/{} (type={:?}, not openai)",
                ts.to_string().dimmed(), session_tag.cyan().bold(),
                profile_tag.dimmed(),
                entry.provider.dimmed(), entry.model.dimmed(),
                provider.provider_type
            );
            continue;
        }

        let provider_model = format!("{}/{}", entry.provider, entry.model);
        let mut retries = 0;
        loop {
            let start = Instant::now();
            let body_for_attempt = match maybe_apply_ext_proc(&ext_proc, seq, body, &entry.model, session_mgr, ctx).await {
                Ok(b) => b,
                Err(block) => {
                    log_provider_error(session_mgr, ctx, &provider_model, &ErrorClass::PolicyRefusal, &block, start.elapsed());
                    return Err(block);
                }
            };
            match provider::send_openai_raw(client, provider, &entry.model, &body_for_attempt, timeout).await {
                Ok(mut result) => {
                    result.provider_name = entry.provider.clone();
                    result.model = entry.model.clone();
                    return Ok((result, i));
                }
                Err(e) => {
                    let elapsed = start.elapsed();
                    let err_class = classify_error(&e, &config.retry_codes);

                    match err_class {
                        ErrorClass::ServerRetryable if retries < MAX_RETRIES_PER_PROVIDER => {
                            let ts = chrono::Local::now().format("%H:%M:%S");
                            eprintln!(
                                "{} {} {} WARN {} {}: {} -> retry {}/{}",
                                ts.to_string().dimmed(),
                                session_tag.cyan().bold(),
                                profile_tag.dimmed(),
                                "x".yellow(),
                                provider_model.yellow(),
                                e.dimmed(),
                                retries + 1,
                                MAX_RETRIES_PER_PROVIDER
                            );
                            log_provider_error(session_mgr, ctx, &provider_model, &err_class, &e, elapsed);
                            last_error = e;
                            retries += 1;
                            tokio::time::sleep(Duration::from_millis(RETRY_BACKOFF_MS)).await;
                            continue;
                        }
                        ErrorClass::ServerRetryable | ErrorClass::NetworkError | ErrorClass::ClientError => {
                            if i + 1 < chain.len() {
                                let next = &chain[i + 1];
                                let ts = chrono::Local::now().format("%H:%M:%S");
                                eprintln!(
                                    "{} {} {} WARN {} {}: {} {} -> {}/{}",
                                    ts.to_string().dimmed(),
                                    session_tag.cyan().bold(),
                                    profile_tag.dimmed(),
                                    "x".red(),
                                    provider_model.red(),
                                    e.dimmed(),
                                    format!("({:.1}s)", elapsed.as_secs_f64()).dimmed(),
                                    next.provider.yellow(),
                                    next.model.yellow()
                                );
                                log_provider_error(session_mgr, ctx, &provider_model, &err_class, &e, elapsed);
                                last_error = e;
                                break;
                            }
                            let ts = chrono::Local::now().format("%H:%M:%S");
                            eprintln!(
                                "{} {} {} ERROR {} {}: {} (no fallback)",
                                ts.to_string().dimmed(),
                                session_tag.cyan().bold(),
                                profile_tag.dimmed(),
                                "x".red(),
                                provider_model.red(),
                                e.dimmed()
                            );
                            log_provider_error(session_mgr, ctx, &provider_model, &err_class, &e, elapsed);
                            return Err(e);
                        }
                        ErrorClass::Fatal | ErrorClass::PolicyRefusal | ErrorClass::ContextOverflow => {
                            let ts = chrono::Local::now().format("%H:%M:%S");
                            eprintln!(
                                "{} {} {} ERROR {} {}: {}",
                                ts.to_string().dimmed(),
                                session_tag.cyan().bold(),
                                profile_tag.dimmed(),
                                "x".red().bold(),
                                provider_model.red(),
                                e.dimmed()
                            );
                            log_provider_error(session_mgr, ctx, &provider_model, &err_class, &e, elapsed);
                            return Err(e);
                        }
                    }
                }
            }
        }
    }

    let ts = chrono::Local::now().format("%H:%M:%S");
    eprintln!(
        "{} {} ERROR {} {}",
        ts.to_string().dimmed(),
        session_tag.cyan().bold(),
        "ALL FAILED".red().bold(),
        truncate_error(&last_error, 100).red()
    );
    Err(format!("All providers failed. Last error: {last_error}"))
}

/// Execute Codex Responses API request with failover.
/// - Anthropic providers: skipped
/// - OpenAI providers: codex_to_openai_chat conversion → send_openai_raw
/// - OpenAIResponses providers: send_responses_raw (pass-through)
pub async fn execute_responses_with_failover(
    client: &Client,
    config: &Config,
    codex_body: &Value,
    chain: &[PriorityEntry],
    profile_name: &str,
    session_short: &str,
    seq: u64,
    session_mgr: Option<&Arc<SessionManager>>,
    ctx: Option<&RequestContext>,
    ext_proc: ExtProcCtx<'_>,
) -> Result<(ProviderResult, usize), String> {
    use crate::transform::codex;

    let timeout = Duration::from_secs(config.timeout_secs);
    let mut last_error = String::from("No OpenAI-compatible providers found in chain");
    let profile_tag = format!("[profile={}]", profile_name);
    let session_tag = format!("[{}/{}]", session_short, seq);

    for (i, entry) in chain.iter().enumerate() {
        let provider = config.find_provider(&entry.provider).ok_or_else(|| {
            format!("Provider '{}' not found in config", entry.provider)
        })?;

        // Skip Anthropic providers
        if provider.provider_type == ProviderType::Anthropic {
            continue;
        }

        let provider_model = format!("{}/{}", entry.provider, entry.model);
        let mut retries = 0;
        loop {
            let start = Instant::now();
            let body_for_attempt = match maybe_apply_ext_proc(&ext_proc, seq, codex_body, &entry.model, session_mgr, ctx).await {
                Ok(b) => b,
                Err(block) => {
                    log_provider_error(session_mgr, ctx, &provider_model, &ErrorClass::PolicyRefusal, &block, start.elapsed());
                    return Err(block);
                }
            };
            let send_result = match provider.provider_type {
                ProviderType::OpenAI => {
                    let openai_body = codex::codex_to_openai_chat(&body_for_attempt);
                    provider::send_openai_raw(client, provider, &entry.model, &openai_body, timeout).await
                }
                ProviderType::OpenAIResponses => {
                    provider::send_responses_raw(client, provider, &entry.model, &body_for_attempt, timeout).await
                }
                ProviderType::Anthropic => unreachable!(), // already skipped above
            };

            match send_result {
                Ok(mut result) => {
                    result.provider_name = entry.provider.clone();
                    result.model = entry.model.clone();
                    return Ok((result, i));
                }
                Err(e) => {
                    let elapsed = start.elapsed();
                    let err_class = classify_error(&e, &config.retry_codes);

                    match err_class {
                        ErrorClass::ServerRetryable if retries < MAX_RETRIES_PER_PROVIDER => {
                            let ts = chrono::Local::now().format("%H:%M:%S");
                            eprintln!(
                                "{} {} {} WARN {} {}: {} -> retry {}/{}",
                                ts.to_string().dimmed(),
                                session_tag.cyan().bold(),
                                profile_tag.dimmed(),
                                "x".yellow(), provider_model.yellow(),
                                e.dimmed(), retries + 1, MAX_RETRIES_PER_PROVIDER
                            );
                            log_provider_error(session_mgr, ctx, &provider_model, &err_class, &e, elapsed);
                            last_error = e;
                            retries += 1;
                            tokio::time::sleep(Duration::from_millis(RETRY_BACKOFF_MS)).await;
                            continue;
                        }
                        ErrorClass::ServerRetryable | ErrorClass::NetworkError | ErrorClass::ClientError => {
                            if i + 1 < chain.len() {
                                let next = &chain[i + 1];
                                let ts = chrono::Local::now().format("%H:%M:%S");
                                eprintln!(
                                    "{} {} {} WARN {} {}: {} {} -> {}/{}",
                                    ts.to_string().dimmed(),
                                    session_tag.cyan().bold(),
                                    profile_tag.dimmed(),
                                    "x".red(), provider_model.red(),
                                    e.dimmed(),
                                    format!("({:.1}s)", elapsed.as_secs_f64()).dimmed(),
                                    next.provider.yellow(), next.model.yellow()
                                );
                                log_provider_error(session_mgr, ctx, &provider_model, &err_class, &e, elapsed);
                                last_error = e;
                                break;
                            }
                            let ts = chrono::Local::now().format("%H:%M:%S");
                            eprintln!(
                                "{} {} {} ERROR {} {}: {} (no fallback)",
                                ts.to_string().dimmed(),
                                session_tag.cyan().bold(),
                                profile_tag.dimmed(),
                                "x".red(), provider_model.red(), e.dimmed()
                            );
                            log_provider_error(session_mgr, ctx, &provider_model, &err_class, &e, elapsed);
                            return Err(e);
                        }
                        ErrorClass::Fatal | ErrorClass::PolicyRefusal | ErrorClass::ContextOverflow => {
                            let ts = chrono::Local::now().format("%H:%M:%S");
                            eprintln!(
                                "{} {} {} ERROR {} {}: {}",
                                ts.to_string().dimmed(),
                                session_tag.cyan().bold(),
                                profile_tag.dimmed(),
                                "x".red().bold(), provider_model.red(), e.dimmed()
                            );
                            log_provider_error(session_mgr, ctx, &provider_model, &err_class, &e, elapsed);
                            return Err(e);
                        }
                    }
                }
            }
        }
    }

    let ts = chrono::Local::now().format("%H:%M:%S");
    eprintln!(
        "{} {} ERROR {} {}",
        ts.to_string().dimmed(),
        session_tag.cyan().bold(),
        "ALL FAILED".red().bold(),
        truncate_error(&last_error, 100).red()
    );
    Err(format!("All providers failed. Last error: {last_error}"))
}

pub async fn execute_with_failover(
    client: &Client,
    config: &Config,
    body: &Value,
    chain: &[PriorityEntry],
    profile_name: &str,
    session_short: &str,
    seq: u64,
    session_mgr: Option<&Arc<SessionManager>>,
    ctx: Option<&RequestContext>,
    ext_proc: ExtProcCtx<'_>,
) -> Result<(ProviderResult, usize), String> {
    let timeout = Duration::from_secs(config.timeout_secs);
    let mut last_error = String::from("No providers configured");
    let profile_tag = format!("[profile={}]", profile_name);
    let session_tag = format!("[{}/{}]", session_short, seq);

    #[allow(unused_assignments)]
    for (i, entry) in chain.iter().enumerate() {
        let provider = config.find_provider(&entry.provider).ok_or_else(|| {
            format!("Provider '{}' not found in config", entry.provider)
        })?;

        let provider_model = format!("{}/{}", entry.provider, entry.model);

        let mut retries = 0;
        loop {
            let start = Instant::now();
            let body_for_attempt = match maybe_apply_ext_proc(&ext_proc, seq, body, &entry.model, session_mgr, ctx).await {
                Ok(b) => b,
                Err(block) => {
                    log_provider_error(session_mgr, ctx, &provider_model, &ErrorClass::PolicyRefusal, &block, start.elapsed());
                    return Err(block);
                }
            };
            match provider::send_request(client, provider, &entry.model, &body_for_attempt, timeout).await {
                Ok(result) => {
                    return Ok((result, i));
                }
                Err(e) => {
                    let elapsed = start.elapsed();
                    let err_class = classify_error(&e, &config.retry_codes);

                    match err_class {
                        ErrorClass::ServerRetryable if retries < MAX_RETRIES_PER_PROVIDER => {
                            let ts = chrono::Local::now().format("%H:%M:%S");
                            eprintln!(
                                "{} {} {} WARN {} {}: {} -> retry {}/{}",
                                ts.to_string().dimmed(),
                                session_tag.cyan().bold(),
                                profile_tag.dimmed(),
                                "x".yellow(),
                                provider_model.yellow(),
                                e.dimmed(),
                                retries + 1,
                                MAX_RETRIES_PER_PROVIDER
                            );
                            log_provider_error(session_mgr, ctx, &provider_model, &err_class, &e, elapsed);
                            last_error = e;
                            retries += 1;
                            tokio::time::sleep(Duration::from_millis(RETRY_BACKOFF_MS)).await;
                            continue;
                        }
                        ErrorClass::ServerRetryable | ErrorClass::NetworkError | ErrorClass::ClientError => {
                            if i + 1 < chain.len() {
                                let next = &chain[i + 1];
                                let ts = chrono::Local::now().format("%H:%M:%S");
                                eprintln!(
                                    "{} {} {} WARN {} {}: {} {} -> {}/{}",
                                    ts.to_string().dimmed(),
                                    session_tag.cyan().bold(),
                                    profile_tag.dimmed(),
                                    "x".red(),
                                    provider_model.red(),
                                    e.dimmed(),
                                    format!("({:.1}s)", elapsed.as_secs_f64()).dimmed(),
                                    next.provider.yellow(),
                                    next.model.yellow()
                                );
                                log_provider_error(session_mgr, ctx, &provider_model, &err_class, &e, elapsed);
                                last_error = e;
                                break;
                            }
                            let ts = chrono::Local::now().format("%H:%M:%S");
                            eprintln!(
                                "{} {} {} ERROR {} {}: {} (no fallback)",
                                ts.to_string().dimmed(),
                                session_tag.cyan().bold(),
                                profile_tag.dimmed(),
                                "x".red(),
                                provider_model.red(),
                                e.dimmed()
                            );
                            log_provider_error(session_mgr, ctx, &provider_model, &err_class, &e, elapsed);
                            return Err(e);
                        }
                        ErrorClass::PolicyRefusal => {
                            let ts = chrono::Local::now().format("%H:%M:%S");
                            if i + 1 < chain.len() {
                                let next = &chain[i + 1];
                                eprintln!(
                                    "{} {} {} WARN {} {}: Usage Policy refusal -> {}/{}",
                                    ts.to_string().dimmed(),
                                    session_tag.cyan().bold(),
                                    profile_tag.dimmed(),
                                    "!".yellow().bold(),
                                    provider_model.yellow(),
                                    next.provider.yellow(),
                                    next.model.yellow()
                                );
                                log_provider_error(session_mgr, ctx, &provider_model, &err_class, &e, elapsed);
                                last_error = e;
                                break;
                            }
                            eprintln!(
                                "{} {} {} WARN {} {}: Usage Policy refusal (no fallback in profile)",
                                ts.to_string().dimmed(),
                                session_tag.cyan().bold(),
                                profile_tag.dimmed(),
                                "!".yellow().bold(),
                                provider_model.yellow(),
                            );
                            log_provider_error(session_mgr, ctx, &provider_model, &err_class, &e, elapsed);
                            return Err(e);
                        }
                        ErrorClass::Fatal => {
                            let ts = chrono::Local::now().format("%H:%M:%S");
                            eprintln!(
                                "{} {} {} FATAL {} {}: {} (fatal)",
                                ts.to_string().dimmed(),
                                session_tag.cyan().bold(),
                                profile_tag.dimmed(),
                                "x".red().bold(),
                                provider_model.red(),
                                e.dimmed()
                            );
                            log_provider_error(session_mgr, ctx, &provider_model, &err_class, &e, elapsed);
                            return Err(e);
                        }
                        ErrorClass::ContextOverflow => {
                            let ts = chrono::Local::now().format("%H:%M:%S");
                            log_provider_error(session_mgr, ctx, &provider_model, &err_class, &e, elapsed);

                            if let Some((requested, max_limit, explicit_input)) = detect_context_overflow(&e) {
                                let current_max = body_for_attempt.get("max_tokens")
                                    .and_then(|v| v.as_u64())
                                    .unwrap_or(4096);
                                // Use explicit input_tokens from the error message when available
                                // (GLM detailed format reports this directly); otherwise estimate
                                // from requested - current_max, which may use a wrong fallback
                                let input_tokens = explicit_input
                                    .unwrap_or_else(|| requested.saturating_sub(current_max));
                                let adjusted = max_limit.saturating_sub(input_tokens + 128);

                                // Only retry if input tokens are below 85% of the model's context
                                // window. Above that threshold, the context is too full to sustain
                                // further tool calls — the next request will overflow again even if
                                // this retry succeeds. Triggering compaction (529) now is better.
                                let retry_worthwhile = adjusted >= 1024
                                    && input_tokens < max_limit * 85 / 100;

                                if retry_worthwhile {
                                    eprintln!(
                                        "{} {} {} WARN {} {}: context overflow, shrink max_tokens {} → {}, retrying",
                                        ts.to_string().dimmed(),
                                        session_tag.cyan().bold(),
                                        profile_tag.dimmed(),
                                        "~".yellow(),
                                        provider_model.yellow(),
                                        current_max,
                                        adjusted,
                                    );
                                    let mut body2 = body_for_attempt.clone();
                                    body2["max_tokens"] = Value::Number(serde_json::Number::from(adjusted));
                                    match provider::send_request(client, provider, &entry.model, &body2, timeout).await {
                                        Ok(result) => return Ok((result, i)),
                                        Err(e2) => { last_error = e2; break; }
                                    }
                                }

                                // adjusted too small (< half of requested max_tokens or < 1024):
                                // input tokens fill most of the context window → trigger client compaction
                                eprintln!(
                                    "{} {} {} WARN {} {}: context overflow, input {} tokens fills model window → 529",
                                    ts.to_string().dimmed(),
                                    session_tag.cyan().bold(),
                                    profile_tag.dimmed(),
                                    "!".yellow().bold(),
                                    provider_model.yellow(),
                                    input_tokens,
                                );
                                return Err(format!(
                                    "context_overflow_529=true input_tokens={input_tokens} max_limit={max_limit}"
                                ));
                            }

                            // detect_context_overflow 未能解析（理论上不会发生）
                            eprintln!(
                                "{} {} {} WARN {} {}: context overflow (no fallback)",
                                ts.to_string().dimmed(),
                                session_tag.cyan().bold(),
                                profile_tag.dimmed(),
                                "!".yellow().bold(),
                                provider_model.yellow(),
                            );
                            return Err(e);
                        }
                    }
                }
            }
        }
    }

    let ts = chrono::Local::now().format("%H:%M:%S");
    eprintln!(
        "{} {} ERROR {} {}",
        ts.to_string().dimmed(),
        session_tag.cyan().bold(),
        "ALL FAILED".red().bold(),
        truncate_error(&last_error, 100).red()
    );
    Err(format!("All providers failed. Last error: {last_error}"))
}

fn log_provider_error(
    session_mgr: Option<&Arc<SessionManager>>,
    ctx: Option<&RequestContext>,
    provider_model: &str,
    err_class: &ErrorClass,
    error: &str,
    elapsed: Duration,
) {
    if let (Some(mgr), Some(ctx)) = (session_mgr, ctx) {
        mgr.log_provider_error(ctx, provider_model, err_class.label(), error, elapsed.as_millis());
    }
}

#[derive(Debug, PartialEq)]
enum ErrorClass {
    ServerRetryable,
    NetworkError,
    ClientError,
    PolicyRefusal,
    Fatal,
    ContextOverflow,
}

impl ErrorClass {
    fn label(&self) -> &'static str {
        match self {
            Self::ServerRetryable => "server_retryable",
            Self::NetworkError => "network_error",
            Self::ClientError => "client_error",
            Self::PolicyRefusal => "policy_refusal",
            Self::Fatal => "fatal",
            Self::ContextOverflow => "context_overflow",
        }
    }
}

fn truncate_error(e: &str, max: usize) -> String {
    if let Some(status) = extract_status_code(e) {
        let reason = extract_error_reason(e);
        if let Some(r) = reason {
            let full = format!("status={} {}", status, r);
            if full.len() <= max {
                return full;
            }
            return format!("{}...", &full[..max]);
        }
        return format!("status={}", status);
    }
    if e.len() <= max {
        e.to_string()
    } else {
        format!("{}...", &e[..max])
    }
}

fn extract_error_reason(e: &str) -> Option<String> {
    if let Some(pos) = e.find("\"message\":\"") {
        let rest = &e[pos + 11..];
        if let Some(end) = rest.find('"') {
            let msg = &rest[..end];
            if !msg.is_empty() {
                return Some(msg.to_string());
            }
        }
    }
    if let Some(pos) = e.find("\"cause\":\"") {
        let rest = &e[pos + 9..];
        if let Some(end) = rest.find('"') {
            let msg = &rest[..end];
            if !msg.is_empty() {
                return Some(msg.to_string());
            }
        }
    }
    None
}

fn classify_error(error: &str, retry_codes: &[u16]) -> ErrorClass {
    if error.contains("policy_refusal=true") {
        return ErrorClass::PolicyRefusal;
    }
    if detect_context_overflow(error).is_some() {
        return ErrorClass::ContextOverflow;
    }
    if let Some(status) = extract_status_code(error) {
        if retry_codes.contains(&status) {
            return ErrorClass::ServerRetryable;
        }
        if status == 401 || status == 403 {
            return ErrorClass::Fatal;
        }
        if (400..500).contains(&status) {
            return ErrorClass::ClientError;
        }
        if status >= 500 {
            return ErrorClass::ServerRetryable;
        }
    }

    if error.contains("stream was reset")
        || error.contains("INTERNAL_ERROR")
    {
        return ErrorClass::ServerRetryable;
    }

    if error.contains("timed out")
        || error.contains("connection refused")
        || error.contains("connection reset")
        || error.contains("connection closed")
        || error.contains("dns error")
    {
        return ErrorClass::NetworkError;
    }

    if error.contains("Transform error") {
        return ErrorClass::ClientError;
    }

    ErrorClass::NetworkError
}

fn extract_status_code(error: &str) -> Option<u16> {
    if let Some(pos) = error.find("status=") {
        let rest = &error[pos + 7..];
        let code_str: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
        code_str.parse().ok()
    } else {
        None
    }
}

pub fn detect_context_overflow(error: &str) -> Option<(u64, u64, Option<u64>)> {
    let lower = error.to_lowercase();
    if !lower.contains("context") && !lower.contains("token") {
        return None;
    }

    // GLM detailed: "191571 tokens from the input messages and 32000 tokens for the completion"
    // Reports explicit input_tokens and max_completion separately — use directly
    let re_glm_detail = Regex::new(
        r"(\d+) tokens from the input messages and (\d+) tokens for the completion"
    ).ok()?;
    if let Some(caps) = re_glm_detail.captures(error) {
        let input_tokens: u64 = caps[1].parse().ok()?;
        let completion_tokens: u64 = caps[2].parse().ok()?;
        let requested = input_tokens + completion_tokens;
        // max_limit: look for the "maximum context length of N" part elsewhere in the message
        let re_max = Regex::new(r"maximum context length of (\d+) tokens").ok()?;
        if let Some(mc) = re_max.captures(error) {
            let max_limit: u64 = mc[1].parse().ok()?;
            return Some((requested, max_limit, Some(input_tokens)));
        }
    }

    // GLM: "maximum context length of 202752 tokens. You requested a total of 202941 tokens"
    let re_glm = Regex::new(
        r"maximum context length of (\d+) tokens.*?requested.*?(\d+) tokens"
    ).ok()?;
    if let Some(caps) = re_glm.captures(error) {
        let max_tokens: u64 = caps[1].parse().ok()?;
        let requested: u64 = caps[2].parse().ok()?;
        return Some((requested, max_tokens, None));
    }

    // Anthropic: "prompt is too long: 137500 tokens > 135000 maximum"
    let re_anthropic = Regex::new(
        r"(?i)prompt is too long:\s*(\d+)\s*tokens?\s*>\s*(\d+)"
    ).ok()?;
    if let Some(caps) = re_anthropic.captures(error) {
        let requested: u64 = caps[1].parse().ok()?;
        let max_tokens: u64 = caps[2].parse().ok()?;
        return Some((requested, max_tokens, None));
    }

    // OpenAI: "maximum context length is 128000 tokens ... you requested 130000 tokens"
    let re_openai = Regex::new(
        r"maximum context length is (\d+) tokens.*?requested (\d+) tokens"
    ).ok()?;
    if let Some(caps) = re_openai.captures(error) {
        let max_tokens: u64 = caps[1].parse().ok()?;
        let requested: u64 = caps[2].parse().ok()?;
        return Some((requested, max_tokens, None));
    }

    // Generic: "exceeds.*maximum.*N tokens" or "context.*length.*N"
    let re_generic = Regex::new(
        r"(?i)(?:exceeds|exceed).*?(\d{4,})\s*tokens"
    ).ok()?;
    if re_generic.is_match(error) && lower.contains("context") {
        // Try to extract two numbers
        let re_nums = Regex::new(r"(\d{4,})").ok()?;
        let nums: Vec<u64> = re_nums.find_iter(error)
            .filter_map(|m| m.as_str().parse().ok())
            .collect();
        if nums.len() >= 2 {
            let (max_tokens, requested) = if nums[0] < nums[1] {
                (nums[0], nums[1])
            } else {
                (nums[1], nums[0])
            };
            return Some((requested, max_tokens, None));
        }
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_classify_server_retryable() {
        let codes = vec![429, 500, 502, 503, 529];
        assert_eq!(classify_error("status=429 body={}", &codes), ErrorClass::ServerRetryable);
        assert_eq!(classify_error("status=500 body=server error", &codes), ErrorClass::ServerRetryable);
        assert_eq!(classify_error("status=502 body=bad gateway", &codes), ErrorClass::ServerRetryable);
        assert_eq!(classify_error("status=503 body=unavailable", &codes), ErrorClass::ServerRetryable);
        assert_eq!(classify_error("status=529 body=overloaded", &codes), ErrorClass::ServerRetryable);
    }

    #[test]
    fn test_classify_client_error() {
        let codes = vec![429, 500, 502, 503, 529];
        assert_eq!(classify_error("status=400 body=bad request", &codes), ErrorClass::ClientError);
        assert_eq!(classify_error("status=422 body=unprocessable", &codes), ErrorClass::ClientError);
        assert_eq!(classify_error("status=404 body=not found", &codes), ErrorClass::ClientError);
    }

    #[test]
    fn test_classify_fatal() {
        let codes = vec![429, 500, 502, 503, 529];
        assert_eq!(classify_error("status=401 body=unauthorized", &codes), ErrorClass::Fatal);
        assert_eq!(classify_error("status=403 body=forbidden", &codes), ErrorClass::Fatal);
    }

    #[test]
    fn test_classify_network_error() {
        let codes = vec![429];
        assert_eq!(classify_error("request timed out", &codes), ErrorClass::NetworkError);
        assert_eq!(classify_error("connection refused", &codes), ErrorClass::NetworkError);
        assert_eq!(classify_error("connection reset by peer", &codes), ErrorClass::NetworkError);
        assert_eq!(classify_error("dns error: name not resolved", &codes), ErrorClass::NetworkError);
    }

    #[test]
    fn test_classify_transform_error() {
        let codes = vec![429];
        assert_eq!(classify_error("Transform error: invalid format", &codes), ErrorClass::ClientError);
    }

    #[test]
    fn test_classify_unknown_error() {
        let codes = vec![429];
        assert_eq!(classify_error("some random error", &codes), ErrorClass::NetworkError);
    }

    #[test]
    fn test_classify_custom_retry_codes() {
        let codes = vec![418];
        assert_eq!(classify_error("status=418 I'm a teapot", &codes), ErrorClass::ServerRetryable);
        assert_eq!(classify_error("status=429 rate limited", &codes), ErrorClass::ClientError);
    }

    #[test]
    fn test_classify_empty_retry_codes() {
        let codes: Vec<u16> = vec![];
        assert_eq!(classify_error("status=429 rate limited", &codes), ErrorClass::ClientError);
        assert_eq!(classify_error("status=500 server error", &codes), ErrorClass::ServerRetryable);
        assert_eq!(classify_error("timed out", &codes), ErrorClass::NetworkError);
    }

    #[test]
    fn test_extract_status_code() {
        assert_eq!(extract_status_code("status=429 body={}"), Some(429));
        assert_eq!(extract_status_code("status=503 body=unavailable"), Some(503));
        assert_eq!(extract_status_code("no status here"), None);
        assert_eq!(extract_status_code("status=abc"), None);
    }

    #[test]
    fn test_classify_5xx_not_in_retry_list() {
        let codes = vec![429];
        assert_eq!(classify_error("status=500 internal", &codes), ErrorClass::ServerRetryable);
        assert_eq!(classify_error("status=502 gateway", &codes), ErrorClass::ServerRetryable);
        assert_eq!(classify_error("status=504 timeout", &codes), ErrorClass::ServerRetryable);
    }

    #[test]
    fn test_classify_policy_refusal() {
        let codes = vec![429, 500, 502, 503, 529];
        assert_eq!(
            classify_error("status=400 policy_refusal=true body={\"error\":{\"type\":\"invalid_request_error\"}}", &codes),
            ErrorClass::PolicyRefusal
        );
    }

    #[test]
    fn test_classify_400_without_policy_marker_is_client_error() {
        let codes = vec![429, 500, 502, 503, 529];
        assert_eq!(
            classify_error("status=400 body=some violation text", &codes),
            ErrorClass::ClientError
        );
    }

    #[test]
    fn test_classify_policy_refusal_takes_priority_over_status() {
        let codes = vec![400];
        assert_eq!(
            classify_error("status=400 policy_refusal=true body=test", &codes),
            ErrorClass::PolicyRefusal
        );
    }

    #[test]
    fn test_detect_context_overflow_glm() {
        let err = r#"status=400 body={"error":{"message":"maximum context length of 202752 tokens. You requested a total of 202941 tokens"}}"#;
        let result = detect_context_overflow(err);
        assert_eq!(result, Some((202941, 202752, None)));
    }

    #[test]
    fn test_detect_context_overflow_glm_detailed() {
        // GLM detailed format: explicit input_tokens reported directly in error
        let err = r#"status=400 body={"error":{"message":"maximum context length of 202752 tokens. You requested a total of 223571 tokens: 191571 tokens from the input messages and 32000 tokens for the completion."}}"#;
        let result = detect_context_overflow(err);
        assert_eq!(result, Some((223571, 202752, Some(191571))));
    }

    #[test]
    fn test_detect_context_overflow_anthropic() {
        let err = "prompt is too long: 137500 tokens > 135000 maximum";
        let result = detect_context_overflow(err);
        assert_eq!(result, Some((137500, 135000, None)));
    }

    #[test]
    fn test_detect_context_overflow_openai() {
        let err = "This model's maximum context length is 128000 tokens. However, you requested 130000 tokens";
        let result = detect_context_overflow(err);
        assert_eq!(result, Some((130000, 128000, None)));
    }

    #[test]
    fn test_detect_context_overflow_none() {
        assert_eq!(detect_context_overflow("status=400 body=bad request"), None);
        assert_eq!(detect_context_overflow("rate limit exceeded"), None);
    }

    #[test]
    fn test_classify_context_overflow() {
        let codes = vec![429, 500, 502, 503, 529];
        let err = r#"status=400 body={"error":{"message":"maximum context length of 202752 tokens. You requested a total of 202941 tokens"}}"#;
        assert_eq!(classify_error(err, &codes), ErrorClass::ContextOverflow);
    }

    #[test]
    fn test_overflow_adjusted_max_tokens() {
        // GLM: max=202752, requested=202941, current_max_tokens=32000
        // input = 202941 - 32000 = 170941 = 84.3% of max_limit → < 85%, should retry
        let (requested, max_limit, _) = detect_context_overflow(
            r#"status=400 body={"error":{"message":"maximum context length of 202752 tokens. You requested a total of 202941 tokens"}}"#
        ).unwrap();
        let current_max: u64 = 32000;
        let input_tokens = requested.saturating_sub(current_max);
        let adjusted = max_limit.saturating_sub(input_tokens + 128);
        assert_eq!(input_tokens, 170941);
        assert_eq!(adjusted, 31683);
        assert!(adjusted >= 1024 && input_tokens < max_limit * 85 / 100, "should retry");
    }

    #[test]
    fn test_overflow_adjusted_triggers_529() {
        // input takes almost everything: max=10000, requested=10050, current_max=500
        // input = 10050 - 500 = 9550, adjusted = 10000 - 9550 - 128 = 322 → < 1024, 529
        let (requested, max_limit) = (10050u64, 10000u64);
        let current_max: u64 = 500;
        let input_tokens = requested.saturating_sub(current_max);
        let adjusted = max_limit.saturating_sub(input_tokens + 128);
        assert!(adjusted < 1024, "should trigger 529, got adjusted={adjusted}");
    }

    #[test]
    fn test_overflow_deep_context_triggers_529_not_retry() {
        // Reproduces the actual bug: GLM-5.1 max=202752, input=191571 (94.5% of window)
        // Old code: adjusted=11053 >= 1024 → retry (BAD — next req overflows again immediately)
        // New code: explicit input_tokens=191571 from detailed error → 94.5% > 85% → 529 (GOOD)
        let err = r#"status=400 body={"error":{"message":"maximum context length of 202752 tokens. You requested a total of 223571 tokens: 191571 tokens from the input messages and 32000 tokens for the completion."}}"#;
        let (requested, max_limit, explicit_input) = detect_context_overflow(err).unwrap();
        assert_eq!(explicit_input, Some(191571), "detailed format should give explicit input_tokens");
        let current_max: u64 = 32000;
        let input_tokens = explicit_input.unwrap_or_else(|| requested.saturating_sub(current_max));
        let adjusted = max_limit.saturating_sub(input_tokens + 128);
        assert_eq!(input_tokens, 191571);
        assert_eq!(adjusted, 11053);
        let retry_worthwhile = adjusted >= 1024 && input_tokens < max_limit * 85 / 100;
        assert!(!retry_worthwhile,
            "input {}({:.1}%) > 85% of max_limit {}, should 529",
            input_tokens, input_tokens as f64 / max_limit as f64 * 100.0, max_limit);
    }

    #[test]
    fn test_overflow_borderline_88pct_triggers_529() {
        // input = 88% of window: retry would succeed but overflow again next request
        // max=202752, adjusted=24000, input = 202752-24000-128 = 178624 = 88.1%
        let max_limit: u64 = 202752;
        let input_tokens: u64 = 178624;
        let adjusted: u64 = max_limit - input_tokens - 128;
        assert_eq!(adjusted, 24000);
        let retry_worthwhile = adjusted >= 1024 && input_tokens < max_limit * 85 / 100;
        assert!(!retry_worthwhile, "88% input should trigger 529 not retry");
    }
}
