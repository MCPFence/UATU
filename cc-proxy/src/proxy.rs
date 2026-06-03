use crate::agent_role;
use crate::cluster;
use crate::config::{PreRequestHook, PostResponseHook, ProviderType};
use crate::cost;
use crate::dispatch::{self, DispatchSignals};
use crate::error::AppError;
use crate::jsonlog::{RequestContext, SessionManager};
use crate::memory::RoutingEntry;
use crate::priority;
use crate::provider::{self, ProviderBody};
use crate::server::AppState;
use axum::body::Body;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use bytes::Bytes;
use colored::Colorize;
use futures::StreamExt;
use serde_json::Value;
use std::sync::Arc;
use std::time::{Duration, Instant};

pub async fn handle_messages(
    state: &AppState,
    body: Value,
) -> Result<Response, AppError> {
    let config = state.config.load();
    let config_arc: std::sync::Arc<crate::config::Config> = state.config.load_full();
    let msg_count = body.get("messages").and_then(|m| m.as_array()).map(|a| a.len()).unwrap_or(0);

    let ctx = state.session_mgr.begin_request(&body);
    let prefix = format!("[{}/{}]", ctx.session_short, ctx.seq);

    state.session_mgr.log_request(&ctx, &body);

    // ── PII mask（in-place 对 messages 中 user/tool_result 文本做 mask） ───────
    let mut body = body;
    let pii_enabled = config.routing.pii.enabled;
    let pii_inject_rules = config.routing.pii.inject_system_rules;
    let vault_arc = state.pii_vaults.get(&ctx.session_id);
    if pii_enabled {
        let mut vault = vault_arc.lock().unwrap();
        crate::pii::mask_messages(&mut body, &mut vault, &ctx.session_id, ctx.seq);
        if pii_inject_rules && msg_count <= 1 {
            crate::pii::inject_pii_system_rules(&mut body);
        }
    }

    let cluster_id = cluster::compute_cluster_id(&body);

    let model = body.get("model").and_then(|m| m.as_str()).unwrap_or("unknown").to_string();
    let agent = agent_role::detect(&body);
    let cc_version_suffix = agent_role::extract_cc_version_suffix(&body);

    let signals = DispatchSignals {
        model: &model,
        session_id: &ctx.session_id,
        agent_role: agent.clone(),
        cc_version_suffix: cc_version_suffix.as_deref(),
    };

    let overrides = state.session_overrides.load();
    let request_signals = crate::signals::RequestSignals::extract(
        &body, &ctx.session_id, Some(&state.retrial),
    );
    let strategy_ref = state.strategy.as_deref();
    let dispatch_result = dispatch::select_profile(
        &config, &signals, &overrides, strategy_ref, Some(&request_signals),
    );
    let profile_name = dispatch_result.profile.to_string();
    let dispatch_source = dispatch_result.source.label().to_string();
    let dispatch_rule_id = match &dispatch_result.source {
        dispatch::DispatchSource::Strategy { rule_id, .. } => Some(*rule_id),
        _ => None,
    };
    let dispatch_strategy_version = state.strategy.as_ref()
        .map(|s| s.version()).unwrap_or(0);
    state.control.record_hit(&profile_name);

    let agent_role_str = agent.to_string();
    let agent_family = agent.family().to_string();
    let cc_version_str = cc_version_suffix.clone().unwrap_or_default();

    #[cfg(unix)]
    let ext_proc_ctx = crate::priority::ExtProcCtx {
        client: state.ext_proc.as_ref(),
        config: config.routing.ext_proc.as_ref(),
        signals: Some(&request_signals),
        session_id: &ctx.session_id,
    };
    #[cfg(not(unix))]
    let ext_proc_ctx = crate::priority::ExtProcCtx::none();

    let role_hook = config.get_role_hook(&agent_role_str, &agent_family);

    let mut body = body;
    let (profile_name, chain) = if let Some(hook) = role_hook.and_then(|h| h.pre_request.as_ref()) {
        if eval_cel_condition(hook.cel_condition.as_deref(), &body, msg_count) {
            let mut effective_profile = profile_name;

            if let Some(ref override_profile) = hook.override_profile {
                if config.profiles.contains_key(override_profile) {
                    effective_profile = override_profile.clone();
                }
            }

            apply_pre_request_hook(hook, &mut body);

            let chain = config
                .get_profile_chain(&effective_profile)
                .cloned()
                .unwrap_or_else(|| config.priority.clone());
            (effective_profile, chain)
        } else {
            let chain = config
                .get_profile_chain(&profile_name)
                .cloned()
                .unwrap_or_else(|| config.priority.clone());
            (profile_name, chain)
        }
    } else {
        let chain = config
            .get_profile_chain(&profile_name)
            .cloned()
            .unwrap_or_else(|| config.priority.clone());
        (profile_name, chain)
    };

    let post_hook = role_hook.and_then(|h| h.post_response.clone());

    let start = Instant::now();
    let (result, chain_used_idx) = match priority::execute_with_failover(
        &state.client, &config, &body, &chain, &profile_name,
        &ctx.session_short, ctx.seq,
        Some(&state.session_mgr), Some(&ctx),
        ext_proc_ctx,
    ).await {
        Ok(r) => r,
        Err(e) if e.contains("context_overflow_529=true") => {
            state.session_mgr.log_error(&ctx, &e);
            return Err(AppError::ContextOverflow(e));
        }
        Err(e) if e.contains("policy_refusal=true") => {
            match try_policy_fallback(
                state, &config, &body, &ctx, &prefix, &profile_name, ext_proc_ctx,
            ).await {
                Some(r) => (r, usize::MAX), // policy fallback has no remaining chain
                None => {
                    state.session_mgr.log_error(&ctx, &e);
                    return Err(AppError::PolicyRefusal(e));
                }
            }
        }
        Err(e) => {
            state.session_mgr.log_error(&ctx, &e);
            return Err(AppError::AllProvidersFailed(e));
        }
    };

    let elapsed = start.elapsed();
    let actual_provider = result.provider_name.clone();
    let actual_model = result.model.clone();
    let is_stream = matches!(&result.body, ProviderBody::Stream(_));
    let _ = is_stream;
    // Entries not yet tried — passed to stream handlers for mid-stream failover
    let remaining_chain: Vec<_> = chain.get(chain_used_idx + 1..).unwrap_or(&[]).to_vec();

    match result.body {
        ProviderBody::Json(json_body) => {
            let mut json_body = json_body;
            // ── PII unmask（response 中 text + tool_use.input 还原） ─────────
            if pii_enabled {
                let vault = vault_arc.lock().unwrap();
                let unknown = crate::pii::unmask_response(&mut json_body, &vault, &ctx.session_id, ctx.seq);
                if !unknown.is_empty() {
                    tracing::warn!(
                        "{} pii unknown tokens (likely LLM-generated examples): {:?}",
                        prefix, unknown
                    );
                }
            }

            let stop_reason = json_body
                .get("stop_reason")
                .and_then(|s| s.as_str())
                .unwrap_or("unknown");

            if stop_reason == "refusal" {
                let ts = chrono::Local::now().format("%H:%M:%S");
                eprintln!(
                    "{} {} {} stop_reason=refusal, trying policy fallback",
                    ts.to_string().dimmed(),
                    prefix.cyan().bold(),
                    "[refusal]".yellow().bold(),
                );

                // Try remaining models in same profile chain first
                if !remaining_chain.is_empty() {
                    eprintln!(
                        "{} {} {} retrying remaining chain ({} entries)",
                        chrono::Local::now().format("%H:%M:%S").to_string().dimmed(),
                        prefix.cyan().bold(),
                        "[refusal-retry]".yellow().bold(),
                        remaining_chain.len(),
                    );
                    match priority::execute_with_failover(
                        &state.client, &config, &body, &remaining_chain, &profile_name,
                        &ctx.session_short, ctx.seq,
                        Some(&state.session_mgr), Some(&ctx),
                        ext_proc_ctx,
                    ).await {
                        Ok((retry_result, _)) => {
                            let fb_elapsed = start.elapsed();
                            return handle_fallback_result(
                                retry_result, state, &config, config_arc.clone(), &body, &ctx, &prefix,
                                msg_count, cluster_id, start, fb_elapsed,
                                &profile_name, &agent_role_str, &cc_version_str,
                                &dispatch_source, dispatch_rule_id, dispatch_strategy_version,
                                pii_enabled, vault_arc.clone(),
                            ).await;
                        }
                        Err(_) => {} // fall through to try other profiles
                    }
                }

                if let Some(fallback_result) = try_policy_fallback(
                    state, &config, &body, &ctx, &prefix, &profile_name, ext_proc_ctx,
                ).await {
                    let fb_elapsed = start.elapsed();
                    return handle_fallback_result(
                        fallback_result, state, &config, config_arc.clone(), &body, &ctx, &prefix,
                        msg_count, cluster_id, start, fb_elapsed,
                        &profile_name, &agent_role_str, &cc_version_str,
                        &dispatch_source, dispatch_rule_id, dispatch_strategy_version,
                        pii_enabled, vault_arc.clone(),
                    ).await;
                }
            }

            let output_tokens = json_body
                .get("usage")
                .and_then(|u| u.get("output_tokens"))
                .and_then(|t| t.as_u64())
                .unwrap_or(0);
            let input_tokens = json_body
                .get("usage")
                .and_then(|u| u.get("input_tokens"))
                .and_then(|t| t.as_u64())
                .unwrap_or(0);

            let ts = chrono::Local::now().format("%H:%M:%S");
            let provider_model = format!("{}/{}", actual_provider, actual_model);
            let profile_tag = format!("[profile={} via={} role={}]", profile_name, dispatch_source, agent_role_str);
            eprintln!(
                "{} {} {} {} {} msgs={} tokens={}/{} stop={} {}",
                ts.to_string().dimmed(),
                prefix.cyan().bold(),
                profile_tag.dimmed(),
                "->".green(),
                provider_model.green(),
                msg_count,
                input_tokens,
                output_tokens,
                stop_reason,
                format!("({:.1}s)", elapsed.as_secs_f64()).dimmed()
            );

            state.session_mgr.log_response(&ctx, &actual_provider, &actual_model, &json_body, elapsed.as_millis());

            if config.routing.hvr_enabled {
                let response_text = extract_response_text(&json_body);
                let hvr_result = state.hvr.analyze(&response_text);
                let cost_usd = cost::estimate_cost(&actual_model, input_tokens, output_tokens);

                if let Some(ref mem) = state.memory {
                    let entry = RoutingEntry {
                        session_id: ctx.session_id.clone(),
                        request_seq: ctx.seq,
                        cluster_id,
                        query_preview: extract_query_preview(&body),
                        actual_provider: actual_provider.clone(),
                        actual_model: actual_model.clone(),
                        actual_latency_ms: elapsed.as_millis() as u64,
                        actual_cost_usd: cost_usd,
                        input_tokens,
                        output_tokens,
                        cache_read_tokens: 0,
                        hvr_score: hvr_result.hvr_score,
                        hvr_gate_passed: hvr_result.gate_passed,
                        stop_reason: stop_reason.to_string(),
                        is_stream: false,
                        profile_name: profile_name.clone(),
                        agent_role: agent_role_str.clone(),
                        cc_version_suffix: cc_version_str.clone(),
                        msg_count: msg_count as u64,
                        tool_call_count: 0,
                        has_code: false,
                        user_msg_length: 0,
                        is_retrial: false,
                        strategy_version: dispatch_strategy_version,
                        strategy_rule_id: dispatch_rule_id,
                        dispatch_source: dispatch_source.clone(),
                    };
                    let mem = mem.clone();
                    tokio::spawn(async move {
                        if let Err(e) = tokio::task::spawn_blocking(move || mem.log_routing(&entry)).await {
                            tracing::warn!("memory log failed: {e}");
                        }
                    });
                }
            }

            if let Some(ref hook) = post_hook {
                apply_post_response_hook(hook, &prefix, &agent_role_str, stop_reason, &json_body);
            }

            Ok((StatusCode::OK, axum::Json(json_body)).into_response())
        }
        ProviderBody::Stream(mut byte_stream) => {
            let is_openai = result.provider_type == ProviderType::OpenAI;
            let model = result.model;

            if is_openai {
                state.session_mgr.log_stream_start(&ctx, &actual_provider, &model);
                handle_openai_stream(
                    byte_stream, model, ctx, state.session_mgr.clone(),
                    actual_provider, start, msg_count,
                    state.hvr.clone(), state.memory.clone(),
                    config.routing.hvr_enabled, cluster_id, body,
                    profile_name, agent_role_str, cc_version_str,
                    dispatch_source, dispatch_rule_id, dispatch_strategy_version,
                    remaining_chain, state.client.clone(), config_arc.clone(),
                    pii_enabled, vault_arc.clone(),
                ).await
            } else {
                let (buffered, is_refusal) = drain_and_detect_refusal(&mut byte_stream).await;

                if is_refusal {
                    let ts = chrono::Local::now().format("%H:%M:%S");
                    eprintln!(
                        "{} {} {} stream stop_reason=refusal, trying policy fallback",
                        ts.to_string().dimmed(),
                        prefix.cyan().bold(),
                        "[refusal]".yellow().bold(),
                    );

                    // Try remaining models in same profile chain first
                    if !remaining_chain.is_empty() {
                        eprintln!(
                            "{} {} {} retrying remaining chain ({} entries)",
                            chrono::Local::now().format("%H:%M:%S").to_string().dimmed(),
                            prefix.cyan().bold(),
                            "[refusal-retry]".yellow().bold(),
                            remaining_chain.len(),
                        );
                        match priority::execute_with_failover(
                            &state.client, &config, &body, &remaining_chain, &profile_name,
                            &ctx.session_short, ctx.seq,
                            Some(&state.session_mgr), Some(&ctx),
                            ext_proc_ctx,
                        ).await {
                            Ok((retry_result, _)) => {
                                let fb_elapsed = start.elapsed();
                                return handle_fallback_result(
                                    retry_result, state, &config, config_arc.clone(), &body, &ctx, &prefix,
                                    msg_count, cluster_id, start, fb_elapsed,
                                    &profile_name, &agent_role_str, &cc_version_str,
                                    &dispatch_source, dispatch_rule_id, dispatch_strategy_version,
                                    pii_enabled, vault_arc.clone(),
                                ).await;
                            }
                            Err(_) => {} // fall through to try other profiles
                        }
                    }

                    if let Some(fallback_result) = try_policy_fallback(
                        state, &config, &body, &ctx, &prefix, &profile_name, ext_proc_ctx,
                    ).await {
                        let fb_elapsed = start.elapsed();
                        return handle_fallback_result(
                            fallback_result, state, &config, config_arc.clone(), &body, &ctx, &prefix,
                            msg_count, cluster_id, start, fb_elapsed,
                            &profile_name, &agent_role_str, &cc_version_str,
                            &dispatch_source, dispatch_rule_id, dispatch_strategy_version,
                            pii_enabled, vault_arc.clone(),
                        ).await;
                    }
                }

                let combined = combine_streams(buffered, byte_stream);
                state.session_mgr.log_stream_start(&ctx, &actual_provider, &model);
                handle_anthropic_stream(
                    combined, ctx, state.session_mgr.clone(),
                    actual_provider, model, start, msg_count,
                    state.hvr.clone(), state.memory.clone(),
                    config.routing.hvr_enabled, cluster_id, body,
                    profile_name, agent_role_str, cc_version_str,
                    dispatch_source, dispatch_rule_id, dispatch_strategy_version,
                    pii_enabled, vault_arc.clone(),
                ).await
            }
        }
    }
}

fn extract_response_text(body: &Value) -> String {
    let mut text = String::new();
    if let Some(content) = body.get("content").and_then(|c| c.as_array()) {
        for block in content {
            if block.get("type").and_then(|t| t.as_str()) == Some("text") {
                if let Some(t) = block.get("text").and_then(|t| t.as_str()) {
                    text.push_str(t);
                }
            }
        }
    }
    text
}

fn extract_query_preview(body: &Value) -> String {
    if let Some(messages) = body.get("messages").and_then(|m| m.as_array()) {
        if let Some(last) = messages.last() {
            let content = last.get("content");
            match content {
                Some(Value::String(s)) => return s.chars().take(100).collect(),
                Some(Value::Array(arr)) => {
                    for block in arr {
                        if block.get("type").and_then(|t| t.as_str()) == Some("text") {
                            if let Some(t) = block.get("text").and_then(|t| t.as_str()) {
                                return t.chars().take(100).collect();
                            }
                        }
                    }
                }
                _ => {}
            }
        }
    }
    String::new()
}

fn profile_tier_score(name: &str) -> usize {
    match name {
        "premium" => 0,
        "balanced" => 1,
        "cheap" => 2,
        _ => 3,
    }
}

async fn try_policy_fallback(
    state: &AppState,
    config: &crate::config::Config,
    body: &Value,
    ctx: &RequestContext,
    prefix: &str,
    current_profile: &str,
    ext_proc: crate::priority::ExtProcCtx<'_>,
) -> Option<provider::ProviderResult> {
    let current_chain = config.get_profile_chain(current_profile);
    let current_chain_json = current_chain.and_then(|c| serde_json::to_string(c).ok());

    // Collect all profiles except current, excluding identical chains (avoid no-op retry)
    let mut candidates: Vec<(String, usize)> = config.profiles
        .iter()
        .filter(|(name, chain)| {
            if name.as_str() == current_profile { return false; }
            if chain.is_empty() { return false; }
            if let Some(ref cur_json) = current_chain_json {
                if serde_json::to_string(chain).ok().as_ref() == Some(cur_json) { return false; }
            }
            true
        })
        .map(|(name, _chain)| (name.clone(), profile_tier_score(name)))
        .collect();

    // Sort by priority score ascending — lowest index (strongest) first
    candidates.sort_by_key(|(_, score)| *score);

    if candidates.is_empty() {
        return None;
    }

    for (fallback_profile, _) in &candidates {
        let Some(chain) = config.get_profile_chain(fallback_profile) else { continue; };
        let ts = chrono::Local::now().format("%H:%M:%S");
        eprintln!(
            "{} {} {} -> profile={}",
            ts.to_string().dimmed(),
            prefix.cyan().bold(),
            "[policy-fallback]".yellow().bold(),
            fallback_profile.yellow(),
        );
        match priority::execute_with_failover(
            &state.client, config, body, chain, fallback_profile,
            &ctx.session_short, ctx.seq,
            Some(&state.session_mgr), Some(ctx),
            ext_proc,
        ).await {
            Ok((r, _)) => return Some(r),
            Err(e) if e.contains("policy_refusal=true") => continue,
            Err(_) => continue,
        }
    }
    None
}

#[allow(clippy::too_many_arguments)]
async fn handle_fallback_result(
    fallback_result: provider::ProviderResult,
    state: &AppState,
    config: &crate::config::Config,
    config_arc: std::sync::Arc<crate::config::Config>,
    body: &Value,
    ctx: &RequestContext,
    prefix: &str,
    msg_count: usize,
    cluster_id: u32,
    start: Instant,
    elapsed: std::time::Duration,
    profile_name: &str,
    agent_role_str: &str,
    cc_version_str: &str,
    dispatch_source: &str,
    dispatch_rule_id: Option<i64>,
    dispatch_strategy_version: i64,
    pii_enabled: bool,
    pii_vault: std::sync::Arc<std::sync::Mutex<crate::pii::PiiVault>>,
) -> Result<Response, AppError> {
    let fb_provider = fallback_result.provider_name.clone();
    let fb_model = fallback_result.model.clone();
    let fb_type = fallback_result.provider_type.clone();

    match fallback_result.body {
        ProviderBody::Json(json_body) => {
            let mut json_body = json_body;
            if pii_enabled {
                let vault = pii_vault.lock().unwrap();
                let _ = crate::pii::unmask_response(&mut json_body, &vault, &ctx.session_id, ctx.seq);
            }
            let stop_reason = json_body
                .get("stop_reason")
                .and_then(|s| s.as_str())
                .unwrap_or("unknown");
            let output_tokens = json_body
                .get("usage")
                .and_then(|u| u.get("output_tokens"))
                .and_then(|t| t.as_u64())
                .unwrap_or(0);
            let input_tokens = json_body
                .get("usage")
                .and_then(|u| u.get("input_tokens"))
                .and_then(|t| t.as_u64())
                .unwrap_or(0);

            let ts = chrono::Local::now().format("%H:%M:%S");
            let provider_model = format!("{}/{}", fb_provider, fb_model);
            eprintln!(
                "{} {} {} {} {} msgs={} tokens={}/{} stop={} {}",
                ts.to_string().dimmed(),
                prefix.cyan().bold(),
                "[policy-fallback]".yellow().bold(),
                "->".green(),
                provider_model.green(),
                msg_count,
                input_tokens,
                output_tokens,
                stop_reason,
                format!("({:.1}s)", elapsed.as_secs_f64()).dimmed()
            );

            state.session_mgr.log_response(ctx, &fb_provider, &fb_model, &json_body, elapsed.as_millis());
            Ok((StatusCode::OK, axum::Json(json_body)).into_response())
        }
        ProviderBody::Stream(fb_stream) => {
            state.session_mgr.log_stream_start(ctx, &fb_provider, &fb_model);
            if fb_type == ProviderType::OpenAI {
                handle_openai_stream(
                    fb_stream, fb_model, ctx.clone(), state.session_mgr.clone(),
                    fb_provider, start, msg_count,
                    state.hvr.clone(), state.memory.clone(),
                    config.routing.hvr_enabled, cluster_id, body.clone(),
                    profile_name.to_string(), agent_role_str.to_string(), cc_version_str.to_string(),
                    dispatch_source.to_string(), dispatch_rule_id, dispatch_strategy_version,
                    vec![], state.client.clone(), config_arc.clone(),
                    pii_enabled, pii_vault.clone(),
                ).await
            } else {
                handle_anthropic_stream(
                    fb_stream, ctx.clone(), state.session_mgr.clone(),
                    fb_provider, fb_model, start, msg_count,
                    state.hvr.clone(), state.memory.clone(),
                    config.routing.hvr_enabled, cluster_id, body.clone(),
                    profile_name.to_string(), agent_role_str.to_string(), cc_version_str.to_string(),
                    dispatch_source.to_string(), dispatch_rule_id, dispatch_strategy_version,
                    pii_enabled, pii_vault.clone(),
                ).await
            }
        }
    }
}

const REFUSAL_BUFFER_LIMIT: usize = 32 * 1024;

async fn drain_and_detect_refusal(
    stream: &mut (impl futures::Stream<Item = Result<Bytes, reqwest::Error>> + Unpin),
) -> (Vec<Bytes>, bool) {
    use futures::StreamExt;

    let mut buffered: Vec<Bytes> = Vec::new();
    let mut parse_buf: Vec<u8> = Vec::new();
    let mut total_bytes: usize = 0;

    while let Some(chunk) = stream.next().await {
        let Ok(bytes) = chunk else { break };
        total_bytes += bytes.len();
        buffered.push(bytes.clone());
        parse_buf.extend_from_slice(&bytes);

        if total_bytes > REFUSAL_BUFFER_LIMIT {
            return (buffered, false);
        }

        loop {
            let pos = parse_buf.windows(2).position(|w| w == b"\n\n");
            let Some(pos) = pos else { break };

            let block = &parse_buf[..pos];
            let block_str = match std::str::from_utf8(block) {
                Ok(s) => s.to_string(),
                Err(_) => {
                    parse_buf.drain(..pos + 2);
                    continue;
                }
            };
            parse_buf.drain(..pos + 2);

            let mut event_type = String::new();
            let mut data_str = String::new();
            for line in block_str.lines() {
                let line = line.trim();
                if let Some(et) = line.strip_prefix("event: ") {
                    event_type = et.trim().to_string();
                } else if let Some(d) = line.strip_prefix("data: ") {
                    data_str = d.to_string();
                }
            }

            if event_type == "content_block_start" {
                return (buffered, false);
            }

            if event_type == "message_delta" {
                if let Ok(data_json) = serde_json::from_str::<Value>(&data_str) {
                    if let Some(sr) = data_json.pointer("/delta/stop_reason").and_then(|v| v.as_str()) {
                        return (buffered, sr == "refusal");
                    }
                }
            }

            if event_type == "message_stop" {
                return (buffered, false);
            }
        }
    }

    (buffered, false)
}

fn combine_streams(
    buffered: Vec<Bytes>,
    remaining: Box<dyn futures::Stream<Item = Result<Bytes, reqwest::Error>> + Send + Unpin>,
) -> Box<dyn futures::Stream<Item = Result<Bytes, reqwest::Error>> + Send + Unpin> {
    let head = futures::stream::iter(
        buffered.into_iter().map(|b| Ok(b)),
    );
    Box::new(head.chain(remaining))
}

async fn handle_anthropic_stream(
    byte_stream: Box<dyn futures::Stream<Item = Result<Bytes, reqwest::Error>> + Send + Unpin>,
    ctx: RequestContext,
    session_mgr: Arc<SessionManager>,
    provider: String,
    model: String,
    start: Instant,
    msg_count: usize,
    hvr: Arc<crate::hvr::HvrDetector>,
    memory: Option<Arc<crate::memory::MemoryBank>>,
    hvr_enabled: bool,
    cluster_id: u32,
    original_body: Value,
    profile_name: String,
    agent_role: String,
    cc_version_suffix: String,
    dispatch_source: String,
    dispatch_rule_id: Option<i64>,
    dispatch_strategy_version: i64,
    pii_enabled: bool,
    pii_vault: std::sync::Arc<std::sync::Mutex<crate::pii::PiiVault>>,
) -> Result<Response, AppError> {
    let mut buf: Vec<u8> = Vec::new();
    let mut accumulator = crate::jsonlog::AnthropicStreamAccumulator::new();
    let ctx_clone = ctx.clone();
    let provider_clone = provider.clone();
    let model_clone = model.clone();
    let prefix = format!("[{}/{}]", ctx.session_short, ctx.seq);

    // PII reverse map (snapshot at stream start). Per-block buffers for
    // safely replacing tokens that may span chunk boundaries.
    let pii_reverse = if pii_enabled {
        pii_vault.lock().unwrap().reverse_map()
    } else {
        std::collections::HashMap::new()
    };
    let mut text_replacers: std::collections::HashMap<u64, crate::pii::StreamTextReplacer> =
        std::collections::HashMap::new();
    let mut json_replacers: std::collections::HashMap<u64, crate::pii::StreamTextReplacer> =
        std::collections::HashMap::new();
    let pii_active = pii_enabled && !pii_reverse.is_empty();
    let session_id_for_pii = ctx.session_id.clone();
    let seq_for_pii = ctx.seq;

    let stream = byte_stream.flat_map(move |chunk| {
        let mut events: Vec<Result<Bytes, std::io::Error>> = Vec::new();

        match chunk {
            Ok(bytes) => {
                buf.extend_from_slice(&bytes);

                loop {
                    let pos = buf.windows(2).position(|w| w == b"\n\n");
                    let Some(pos) = pos else { break };

                    let block = &buf[..pos];
                    let block_str = match std::str::from_utf8(block) {
                        Ok(s) => s.to_string(),
                        Err(_) => {
                            buf.drain(..pos + 2);
                            continue;
                        }
                    };
                    buf.drain(..pos + 2);

                    let mut event_type = String::new();
                    let mut data_str = String::new();
                    for line in block_str.lines() {
                        let line = line.trim();
                        if let Some(et) = line.strip_prefix("event: ") {
                            event_type = et.trim().to_string();
                        } else if let Some(d) = line.strip_prefix("data: ") {
                            data_str = d.to_string();
                        }
                    }

                    let mut data_json: Option<Value> = if !data_str.is_empty() {
                        serde_json::from_str::<Value>(&data_str).ok()
                    } else {
                        None
                    };

                    // Feed accumulator (uses original, possibly token-bearing data —
                    // that's what we want, since the final log unmasks separately).
                    if !event_type.is_empty() {
                        if let Some(ref dj) = data_json {
                            accumulator.process_event(&event_type, dj);
                        }
                    }

                    // PII: rewrite text_delta / input_json_delta in-place; emit any
                    // flushed remainder on content_block_stop / message_stop.
                    let mut block_modified = false;
                    if pii_active {
                        if event_type == "content_block_delta" {
                            if let Some(ref mut dj) = data_json {
                                let index = dj.get("index").and_then(|v| v.as_u64()).unwrap_or(0);
                                let delta_type = dj
                                    .get("delta")
                                    .and_then(|d| d.get("type"))
                                    .and_then(|t| t.as_str())
                                    .unwrap_or("")
                                    .to_string();
                                if delta_type == "text_delta" {
                                    if let Some(text) = dj
                                        .get("delta")
                                        .and_then(|d| d.get("text"))
                                        .and_then(|t| t.as_str())
                                        .map(|s| s.to_string())
                                    {
                                        let r = text_replacers
                                            .entry(index)
                                            .or_insert_with(crate::pii::StreamTextReplacer::new);
                                        let safe = r.feed(&text, &pii_reverse);
                                        if let Some(d) = dj.get_mut("delta") {
                                            d["text"] = Value::String(safe);
                                        }
                                        block_modified = true;
                                    }
                                } else if delta_type == "input_json_delta" {
                                    if let Some(text) = dj
                                        .get("delta")
                                        .and_then(|d| d.get("partial_json"))
                                        .and_then(|t| t.as_str())
                                        .map(|s| s.to_string())
                                    {
                                        let r = json_replacers
                                            .entry(index)
                                            .or_insert_with(crate::pii::StreamTextReplacer::new);
                                        let safe = r.feed(&text, &pii_reverse);
                                        if let Some(d) = dj.get_mut("delta") {
                                            d["partial_json"] = Value::String(safe);
                                        }
                                        block_modified = true;
                                    }
                                }
                            }
                        } else if event_type == "content_block_stop" {
                            if let Some(ref dj) = data_json {
                                let index = dj.get("index").and_then(|v| v.as_u64()).unwrap_or(0);
                                if let Some(r) = text_replacers.get_mut(&index) {
                                    let flushed = r.flush(&pii_reverse);
                                    if !flushed.is_empty() {
                                        let extra = serde_json::json!({
                                            "type": "content_block_delta",
                                            "index": index,
                                            "delta": {"type": "text_delta", "text": flushed}
                                        });
                                        let line = format!(
                                            "event: content_block_delta\ndata: {}\n\n",
                                            serde_json::to_string(&extra).unwrap_or_default()
                                        );
                                        events.push(Ok(Bytes::from(line)));
                                    }
                                }
                                if let Some(r) = json_replacers.get_mut(&index) {
                                    let flushed = r.flush(&pii_reverse);
                                    if !flushed.is_empty() {
                                        let extra = serde_json::json!({
                                            "type": "content_block_delta",
                                            "index": index,
                                            "delta": {"type": "input_json_delta", "partial_json": flushed}
                                        });
                                        let line = format!(
                                            "event: content_block_delta\ndata: {}\n\n",
                                            serde_json::to_string(&extra).unwrap_or_default()
                                        );
                                        events.push(Ok(Bytes::from(line)));
                                    }
                                }
                            }
                        }
                    }

                    // Emit the (possibly modified) block.
                    let out_block: String = if block_modified {
                        if let Some(ref dj) = data_json {
                            format!(
                                "event: {}\ndata: {}\n\n",
                                event_type,
                                serde_json::to_string(dj).unwrap_or_default()
                            )
                        } else {
                            format!("{}\n\n", block_str)
                        }
                    } else {
                        format!("{}\n\n", block_str)
                    };
                    events.push(Ok(Bytes::from(out_block)));

                    if event_type == "message_stop" {
                        let _ = (&session_id_for_pii, seq_for_pii);
                        let accumulated = accumulator.finalize();
                        let elapsed = start.elapsed();
                        let output_tokens = accumulated.get("usage")
                            .and_then(|u| u.get("output_tokens"))
                            .and_then(|t| t.as_u64()).unwrap_or(0);
                        let input_tokens = accumulated.get("usage")
                            .and_then(|u| u.get("input_tokens"))
                            .and_then(|t| t.as_u64()).unwrap_or(0);
                        let stop = accumulated.get("stop_reason")
                            .and_then(|s| s.as_str()).unwrap_or("?");
                        let ts = chrono::Local::now().format("%H:%M:%S");
                        let provider_model = format!("{}/{}", provider_clone, model_clone);
                        let profile_tag = format!("[profile={} via={} role={}]", profile_name, dispatch_source, agent_role);
                        eprintln!(
                            "{} {} {} {} {} stream msgs={} out={} stop={} {}",
                            ts.to_string().dimmed(),
                            prefix.cyan().bold(),
                            profile_tag.dimmed(),
                            "->".green(),
                            provider_model.green(),
                            msg_count,
                            output_tokens,
                            stop,
                            format!("({:.1}s)", elapsed.as_secs_f64()).dimmed()
                        );

                        let mgr = session_mgr.clone();
                        let ctx_c = ctx_clone.clone();
                        let prov = provider_clone.clone();
                        let mdl = model_clone.clone();
                        let elapsed_ms = elapsed.as_millis();

                        let hvr_c = hvr.clone();
                        let mem_c = memory.clone();
                        let body_c = original_body.clone();
                        let stop_s = stop.to_string();
                        let profile_c = profile_name.clone();
                        let agent_c = agent_role.clone();
                        let ccv_c = cc_version_suffix.clone();
                        let dsrc_c = dispatch_source.clone();
                        let drid_c = dispatch_rule_id;
                        let dsver_c = dispatch_strategy_version;
                        // Unmask the accumulated body so log_stream_complete writes
                        // plaintext (matching the user-visible stream).
                        let mut accumulated_c = accumulated.clone();
                        if pii_active {
                            let vault = pii_vault.lock().unwrap();
                            let _ = crate::pii::unmask_response(
                                &mut accumulated_c,
                                &vault,
                                &session_id_for_pii,
                                seq_for_pii,
                            );
                        }
                        tokio::spawn(async move {
                            mgr.log_stream_complete(&ctx_c, &prov, &mdl, &accumulated_c, elapsed_ms);

                            if hvr_enabled {
                                let response_text = extract_response_text(&accumulated_c);
                                let hvr_result = hvr_c.analyze(&response_text);
                                let cost_usd = crate::cost::estimate_cost(&mdl, input_tokens, output_tokens);

                                if let Some(ref mem) = mem_c {
                                    let entry = RoutingEntry {
                                        session_id: ctx_c.session_id.clone(),
                                        request_seq: ctx_c.seq,
                                        cluster_id,
                                        query_preview: extract_query_preview(&body_c),
                                        actual_provider: prov,
                                        actual_model: mdl,
                                        actual_latency_ms: elapsed_ms as u64,
                                        actual_cost_usd: cost_usd,
                                        input_tokens,
                                        output_tokens,
                                        cache_read_tokens: 0,
                                        hvr_score: hvr_result.hvr_score,
                                        hvr_gate_passed: hvr_result.gate_passed,
                                        stop_reason: stop_s,
                                        is_stream: true,
                                        profile_name: profile_c,
                                        agent_role: agent_c,
                                        cc_version_suffix: ccv_c,
                                        msg_count: 0,
                                        tool_call_count: 0,
                                        has_code: false,
                                        user_msg_length: 0,
                                        is_retrial: false,
                                        strategy_version: dsver_c,
                                        strategy_rule_id: drid_c,
                                        dispatch_source: dsrc_c.clone(),
                                    };
                                    let mem = mem.clone();
                                    let _ = tokio::task::spawn_blocking(move || mem.log_routing(&entry)).await;
                                }
                            }
                        });
                    }
                }
            }
            Err(e) => {
                let msg = e.to_string();
                // h2 CANCEL means the client disconnected cleanly — end silently.
                // "stream was reset" with INTERNAL_ERROR is an upstream server crash
                // — must surface as an error so the client can retry.
                if msg.contains("CANCEL") {
                    tracing::debug!("stream closed (client cancel), ending silently");
                } else if msg.contains("stream was reset") || msg.contains("connection was reset") {
                    tracing::warn!("stream reset ({}), sending error to trigger retry", msg);
                    let error_event = format!(
                        "event: error\ndata: {{\"type\":\"error\",\"error\":{{\"type\":\"api_error\",\"message\":\"Stream reset: {}\"}}}}\n\n",
                        msg.replace('"', "'")
                    );
                    events.push(Ok(Bytes::from(error_event)));
                } else {
                    let error_event = format!(
                        "event: error\ndata: {{\"type\":\"error\",\"error\":{{\"type\":\"overloaded_error\",\"message\":\"Stream interrupted: {}\"}}}}\n\n",
                        msg.replace('"', "'")
                    );
                    events.push(Ok(Bytes::from(error_event)));
                }
            }
        }

        futures::stream::iter(events)
    });

    let body = Body::from_stream(stream);
    Ok(Response::builder()
        .status(200)
        .header("content-type", "text/event-stream")
        .header("cache-control", "no-cache")
        .header("connection", "keep-alive")
        .body(body)
        .unwrap())
}

async fn handle_openai_stream(
    byte_stream: Box<dyn futures::Stream<Item = Result<Bytes, reqwest::Error>> + Send + Unpin>,
    model: String,
    ctx: RequestContext,
    session_mgr: Arc<SessionManager>,
    provider: String,
    start: Instant,
    msg_count: usize,
    hvr: Arc<crate::hvr::HvrDetector>,
    memory: Option<Arc<crate::memory::MemoryBank>>,
    hvr_enabled: bool,
    cluster_id: u32,
    original_body: Value,
    profile_name: String,
    agent_role: String,
    cc_version_suffix: String,
    dispatch_source: String,
    dispatch_rule_id: Option<i64>,
    dispatch_strategy_version: i64,
    remaining_chain: Vec<crate::config::PriorityEntry>,
    client: reqwest::Client,
    config: std::sync::Arc<crate::config::Config>,
    _pii_enabled: bool,
    _pii_vault: std::sync::Arc<std::sync::Mutex<crate::pii::PiiVault>>,
) -> Result<Response, AppError> {
    let prefix = format!("[{}/{}]", ctx.session_short, ctx.seq);
    let timeout = Duration::from_secs(config.timeout_secs);
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<Bytes, std::io::Error>>(256);

    tokio::spawn(async move {
        let timeout = Duration::from_secs(config.timeout_secs);
        let mut current_stream: Box<dyn futures::Stream<Item = Result<Bytes, reqwest::Error>> + Send + Unpin> = byte_stream;
        let mut current_provider = provider.clone();
        let mut current_model = model.clone();
        let mut retry_chain = remaining_chain.into_iter();
        let mut is_first_attempt = true;

        loop {
            let mut converter = provider::create_openai_stream_converter(current_model.clone());
            let mut buf: Vec<u8> = Vec::new();
            let mut chunk_count: u64 = 0;
            let mut stream_ok = false;

            // If this is a continuation (not first attempt), inject partial text as continuation context
            // by sending a ping to keep the connection alive
            if !is_first_attempt {
                let ping = crate::transform::openai_to_anthropic::StreamState::ping_event();
                if tx.send(Ok(Bytes::from(ping))).await.is_err() { break; }
            }
            is_first_attempt = false;

            'chunk_loop: loop {
                let chunk = current_stream.next().await;
                match chunk {
                    None => { stream_ok = true; break 'chunk_loop; }
                    Some(Ok(bytes)) => {
                        buf.extend_from_slice(&bytes);
                        chunk_count += 1;

                        if chunk_count % 50 == 0 {
                            let ping = crate::transform::openai_to_anthropic::StreamState::ping_event();
                            if tx.send(Ok(Bytes::from(ping))).await.is_err() { break 'chunk_loop; }
                        }

                        loop {
                            let pos = buf.windows(2).position(|w| w == b"\n\n");
                            let Some(pos) = pos else { break };
                            let block_str = match std::str::from_utf8(&buf[..pos]) {
                                Ok(s) => s.to_string(),
                                Err(_) => { buf.drain(..pos + 2); continue; }
                            };
                            buf.drain(..pos + 2);

                            for line in block_str.lines() {
                                let line = line.trim();
                                if let Some(data) = line.strip_prefix("data: ") {
                                    if data.trim() == "[DONE]" {
                                        for event in converter.flush() {
                                            if tx.send(Ok(Bytes::from(event))).await.is_err() { break; }
                                        }
                                        let elapsed = start.elapsed();
                                        let input_toks = converter.input_tokens;
                                        let output_toks = converter.output_tokens;
                                        let accumulated = converter.finalize();
                                        let stop = accumulated.get("stop_reason")
                                            .and_then(|s| s.as_str()).unwrap_or("end_turn").to_string();
                                        let ts = chrono::Local::now().format("%H:%M:%S");
                                        let profile_tag = format!("[profile={} via={} role={}]", profile_name, dispatch_source, agent_role);
                                        eprintln!(
                                            "{} {} {} {} {} stream msgs={} out={} stop={} {}",
                                            ts.to_string().dimmed(),
                                            prefix.cyan().bold(),
                                            profile_tag.dimmed(),
                                            "->".green(),
                                            format!("{}/{}", current_provider, current_model).green(),
                                            msg_count, output_toks, stop,
                                            format!("({:.1}s)", elapsed.as_secs_f64()).dimmed()
                                        );
                                        let mgr = session_mgr.clone();
                                        let ctx_c = ctx.clone();
                                        let prov = current_provider.clone();
                                        let mdl = current_model.clone();
                                        let elapsed_ms = elapsed.as_millis();
                                        let hvr_c = hvr.clone();
                                        let mem_c = memory.clone();
                                        let body_c = original_body.clone();
                                        let profile_c = profile_name.clone();
                                        let agent_c = agent_role.clone();
                                        let ccv_c = cc_version_suffix.clone();
                                        let dsrc_c = dispatch_source.clone();
                                        tokio::spawn(async move {
                                            mgr.log_stream_complete(&ctx_c, &prov, &mdl, &accumulated, elapsed_ms);
                                            if hvr_enabled {
                                                let response_text = extract_response_text(&accumulated);
                                                let hvr_result = hvr_c.analyze(&response_text);
                                                let cost_usd = crate::cost::estimate_cost(&mdl, input_toks, output_toks);
                                                if let Some(ref mem) = mem_c {
                                                    let entry = RoutingEntry {
                                                        session_id: ctx_c.session_id.clone(),
                                                        request_seq: ctx_c.seq,
                                                        cluster_id,
                                                        query_preview: extract_query_preview(&body_c),
                                                        actual_provider: prov,
                                                        actual_model: mdl,
                                                        actual_latency_ms: elapsed_ms as u64,
                                                        actual_cost_usd: cost_usd,
                                                        input_tokens: input_toks,
                                                        output_tokens: output_toks,
                                                        cache_read_tokens: 0,
                                                        hvr_score: hvr_result.hvr_score,
                                                        hvr_gate_passed: hvr_result.gate_passed,
                                                        stop_reason: stop,
                                                        is_stream: true,
                                                        profile_name: profile_c,
                                                        agent_role: agent_c,
                                                        cc_version_suffix: ccv_c,
                                                        msg_count: 0,
                                                        tool_call_count: 0,
                                                        has_code: false,
                                                        user_msg_length: 0,
                                                        is_retrial: false,
                                                        strategy_version: dispatch_strategy_version,
                                                        strategy_rule_id: dispatch_rule_id,
                                                        dispatch_source: dsrc_c,
                                                    };
                                                    let mem = mem.clone();
                                                    let _ = tokio::task::spawn_blocking(move || mem.log_routing(&entry)).await;
                                                }
                                            }
                                        });
                                        stream_ok = true;
                                        break 'chunk_loop;
                                    }
                                    if let Ok(chunk_json) = serde_json::from_str::<Value>(data) {
                                        for event in converter.process_chunk(&chunk_json) {
                                            if tx.send(Ok(Bytes::from(event))).await.is_err() { break; }
                                        }
                                    }
                                }
                            }
                        }
                    }
                    Some(Err(e)) => {
                        // Stream failed mid-way — restart from scratch with next provider
                        let err_msg = e.to_string();
                        let ts = chrono::Local::now().format("%H:%M:%S");
                        eprintln!(
                            "{} {} [stream-failover] {} stream interrupted: {}",
                            ts.to_string().dimmed(), prefix.cyan().bold(),
                            format!("{}/{}", current_provider, current_model).yellow(),
                            err_msg.dimmed()
                        );

                        // Try next provider in chain with the original request body
                        if let Some(next_entry) = retry_chain.next() {
                            let cont_body = original_body.clone();

                            let provider_name = next_entry.provider.clone();
                            let model_name = next_entry.model.clone();
                            eprintln!(
                                "{} {} [stream-failover] retrying with {}/{}",
                                ts.to_string().dimmed(), prefix.cyan().bold(),
                                provider_name.green(), model_name.green()
                            );

                            // Look up the actual provider config
                            let provider_cfg = config.find_provider(&provider_name);
                            let _ = tx.send(Ok(Bytes::from(
                                "event: ping\ndata: {\"type\":\"ping\"}\n\n".to_string()
                            ))).await;

                            match provider_cfg {
                                Some(prov_cfg) => {
                                    match provider::send_request(&client, prov_cfg, &model_name, &cont_body, timeout).await {
                                        Ok(new_result) => {
                                            if let provider::ProviderBody::Stream(new_stream) = new_result.body {
                                                current_stream = new_stream;
                                                current_provider = provider_name;
                                                current_model = model_name;
                                                continue; // restart chunk_loop with new stream
                                            }
                                        }
                                        Err(_) => {}
                                    }
                                }
                                None => {}
                            }
                        } // end if let Some(next_entry)

                        // No more providers or retry failed — send error event
                        // Only silence client-initiated CANCEL; server resets must surface
                        if err_msg.contains("CANCEL") {
                            tracing::debug!("stream closed (client cancel), ending silently");
                        } else if err_msg.contains("stream was reset") || err_msg.contains("connection was reset") {
                            tracing::warn!("stream reset ({}), sending error to trigger retry", err_msg);
                            let error_event = format!(
                                "event: error\ndata: {{\"type\":\"error\",\"error\":{{\"type\":\"api_error\",\"message\":\"Stream reset: {}\"}}}}\n\n",
                                err_msg.replace('"', "'")
                            );
                            let _ = tx.send(Ok(Bytes::from(error_event))).await;
                        } else {
                            let error_event = format!(
                                "event: error\ndata: {{\"type\":\"error\",\"error\":{{\"type\":\"overloaded_error\",\"message\":\"Stream interrupted: {}\"}}}}\n\n",
                                err_msg.replace('"', "'")
                            );
                            let _ = tx.send(Ok(Bytes::from(error_event))).await;
                        }
                        break 'chunk_loop;
                    } // end Some(Err(e))
                } // end match chunk
            } // end 'chunk_loop

            if stream_ok { break; }
            // If not stream_ok and no more retry entries, break
            break;
        }
    });

    let rx_stream = tokio_stream::wrappers::ReceiverStream::new(rx);
    let body = Body::from_stream(rx_stream);
    Ok(Response::builder()
        .status(200)
        .header("content-type", "text/event-stream")
        .header("cache-control", "no-cache")
        .header("connection", "keep-alive")
        .body(body)
        .unwrap())
}

/// Handle OpenAI Codex Responses API (POST /v1/responses).
/// Routes to OpenAI or OpenAIResponses providers (skips Anthropic).
/// OpenAI provider: codex→openai_chat conversion + CodexStreamConverter for SSE.
/// OpenAIResponses provider: direct pass-through.
pub async fn handle_responses(
    state: &AppState,
    body: Value,
) -> Result<Response, AppError> {
    use crate::transform::codex;

    let config = state.config.load();
    let ctx = state.session_mgr.begin_request(&body);
    state.session_mgr.log_request(&ctx, &body);

    let model = body.get("model").and_then(|v| v.as_str()).unwrap_or("unknown").to_string();
    let is_stream = body.get("stream").and_then(|v| v.as_bool()).unwrap_or(false);

    let agent = agent_role::detect(&body);
    let cc_version_suffix = agent_role::extract_cc_version_suffix(&body);
    let signals = crate::dispatch::DispatchSignals {
        model: &model,
        session_id: &ctx.session_id,
        agent_role: agent.clone(),
        cc_version_suffix: cc_version_suffix.as_deref(),
    };
    let overrides = state.session_overrides.load();
    let dispatch_result = crate::dispatch::select_profile(&config, &signals, &overrides, state.strategy.as_deref(), None);
    let profile_name = dispatch_result.profile.to_string();
    let dispatch_source = dispatch_result.source.label().to_string();
    let agent_role_str = agent.to_string();
    state.control.record_hit(&profile_name);

    let chain = config.get_effective_chain(&profile_name);
    let start = Instant::now();
    let cluster_id = 0u32;

    match priority::execute_responses_with_failover(
        &state.client, &config, &body, &chain,
        &profile_name, &ctx.session_short, ctx.seq,
        Some(&state.session_mgr), Some(&ctx),
        crate::priority::ExtProcCtx::none(),
    ).await {
        Ok((result, _idx)) => {
            let actual_provider = if result.provider_name.is_empty() {
                chain.first().map(|e| e.provider.clone()).unwrap_or_default()
            } else {
                result.provider_name.clone()
            };
            let actual_model = if result.model.is_empty() { model.clone() } else { result.model.clone() };
            let provider_type = result.provider_type.clone();

            let prefix = format!("[{}/{}]", ctx.session_short, ctx.seq);
            let ts = chrono::Local::now().format("%H:%M:%S");
            eprintln!(
                "{} {} {} codex {}/{} stream={} type={:?}",
                ts.to_string().dimmed(), prefix.cyan().bold(),
                "codex".green(),
                actual_provider.yellow(), actual_model.yellow(),
                is_stream, provider_type
            );

            match result.body {
                ProviderBody::Stream(byte_stream) => {
                    state.session_mgr.log_stream_start(&ctx, &actual_provider, &actual_model);
                    let session_mgr = state.session_mgr.clone();
                    let memory = state.memory.clone();
                    let hvr_enabled = config.routing.hvr_enabled;
                    let (tx, rx) = tokio::sync::mpsc::channel::<Result<Bytes, std::io::Error>>(256);
                    let actual_model_c = actual_model.clone();
                    let actual_provider_c = actual_provider.clone();
                    let profile_name_c = profile_name.clone();
                    let prefix_c = prefix.clone();
                    let agent_role_c = agent_role_str.clone();
                    let dispatch_source_c = dispatch_source.clone();

                    if provider_type == ProviderType::OpenAI {
                        // OpenAI Chat SSE → CodexStreamConverter → Codex SSE
                        tokio::spawn(async move {
                            let mut converter = codex::CodexStreamConverter::new();
                            let mut byte_stream = byte_stream;
                            let mut buf = String::new();
                            let stream_start = Instant::now();

                            loop {
                                match byte_stream.next().await {
                                    None => break,
                                    Some(Err(e)) => {
                                        let remaining = converter.flush();
                                        for ev in remaining {
                                            let _ = tx.send(Ok(Bytes::from(ev))).await;
                                        }
                                        let err_msg = e.to_string();
                                        tracing::warn!("codex stream error: {err_msg}");
                                        if !err_msg.contains("CANCEL") {
                                            let error_event = format!(
                                                "event: error\ndata: {{\"type\":\"error\",\"error\":{{\"type\":\"api_error\",\"message\":\"Stream reset: {}\"}}}}\n\n",
                                                err_msg.replace('"', "'")
                                            );
                                            let _ = tx.send(Ok(Bytes::from(error_event))).await;
                                        }
                                        break;
                                    }
                                    Some(Ok(chunk)) => {
                                        buf.push_str(&String::from_utf8_lossy(&chunk));
                                        loop {
                                            if let Some(pos) = buf.find("\n\n") {
                                                let block = buf[..pos + 2].to_string();
                                                buf = buf[pos + 2..].to_string();
                                                for line in block.lines() {
                                                    if let Some(d) = line.strip_prefix("data: ") {
                                                        if d == "[DONE]" { break; }
                                                        if let Ok(chunk_json) = serde_json::from_str::<Value>(d) {
                                                            for ev in converter.process_chunk(&chunk_json) {
                                                                if tx.send(Ok(Bytes::from(ev))).await.is_err() { return; }
                                                            }
                                                        }
                                                    }
                                                }
                                            } else {
                                                break;
                                            }
                                        }
                                    }
                                }
                            }

                            let elapsed_ms = stream_start.elapsed().as_millis();
                            let input_tokens = converter.input_tokens;
                            let output_tokens = converter.output_tokens;
                            let accumulated = serde_json::json!({
                                "usage": {"input_tokens": input_tokens, "output_tokens": output_tokens}
                            });
                            session_mgr.log_stream_complete(&ctx, &actual_provider_c, &actual_model_c, &accumulated, elapsed_ms);

                            let ts = chrono::Local::now().format("%H:%M:%S");
                            let provider_model = format!("{}/{}", actual_provider_c, actual_model_c);
                            eprintln!(
                                "{} {} {} {} {} stream out={} stop=end_turn {}",
                                ts.to_string().dimmed(),
                                prefix_c.cyan().bold(),
                                format!("[profile={} via=openai role=codex]", profile_name_c).dimmed(),
                                "->".green(),
                                provider_model.green(),
                                output_tokens,
                                format!("({:.1}s)", elapsed_ms as f64 / 1000.0).dimmed()
                            );

                            if hvr_enabled {
                                if let Some(ref mem) = memory {
                                    let cost_usd = crate::cost::estimate_cost(&actual_model_c, input_tokens, output_tokens);
                                    let entry = RoutingEntry {
                                        session_id: ctx.session_id.clone(),
                                        request_seq: ctx.seq,
                                        cluster_id,
                                        query_preview: extract_codex_query_preview(&body),
                                        actual_provider: actual_provider_c,
                                        actual_model: actual_model_c,
                                        actual_latency_ms: elapsed_ms as u64,
                                        actual_cost_usd: cost_usd,
                                        input_tokens,
                                        output_tokens,
                                        cache_read_tokens: 0,
                                        hvr_score: 0.0,
                                        hvr_gate_passed: true,
                                        stop_reason: "end_turn".to_string(),
                                        is_stream: true,
                                        profile_name: profile_name_c,
                                        agent_role: agent_role_c,
                                        cc_version_suffix: String::new(),
                                        msg_count: 0,
                                        tool_call_count: 0,
                                        has_code: false,
                                        user_msg_length: 0,
                                        is_retrial: false,
                                        strategy_version: 0,
                                        strategy_rule_id: None,
                                        dispatch_source: dispatch_source_c,
                                    };
                                    let mem = mem.clone();
                                    let _ = tokio::task::spawn_blocking(move || mem.log_routing(&entry)).await;
                                }
                            }
                        });
                    } else {
                        // OpenAIResponses: direct pass-through SSE
                        let prefix_c2 = prefix.clone();
                        let agent_role_c2 = agent_role_str.clone();
                        let dispatch_source_c2 = dispatch_source.clone();
                        tokio::spawn(async move {
                            let mut byte_stream = byte_stream;
                            let stream_start = Instant::now();
                            let mut input_tokens: u64 = 0;
                            let mut output_tokens: u64 = 0;

                            loop {
                                match byte_stream.next().await {
                                    None => break,
                                    Some(Err(e)) => {
                                        let err_msg = e.to_string();
                                        tracing::warn!("responses pass-through stream error: {err_msg}");
                                        if !err_msg.contains("CANCEL") {
                                            let error_event = format!(
                                                "event: error\ndata: {{\"type\":\"error\",\"error\":{{\"type\":\"api_error\",\"message\":\"Stream reset: {}\"}}}}\n\n",
                                                err_msg.replace('"', "'")
                                            );
                                            let _ = tx.send(Ok(Bytes::from(error_event))).await;
                                        }
                                        break;
                                    }
                                    Some(Ok(chunk)) => {
                                        // Try to extract token counts from response.completed events
                                        if let Ok(s) = std::str::from_utf8(&chunk) {
                                            for line in s.lines() {
                                                if let Some(d) = line.strip_prefix("data: ") {
                                                    if let Ok(j) = serde_json::from_str::<Value>(d) {
                                                        if let Some(usage) = j.get("usage") {
                                                            input_tokens = usage.get("input_tokens").and_then(|v| v.as_u64()).unwrap_or(input_tokens);
                                                            output_tokens = usage.get("output_tokens").and_then(|v| v.as_u64()).unwrap_or(output_tokens);
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                        if tx.send(Ok(chunk)).await.is_err() { break; }
                                    }
                                }
                            }

                            let elapsed_ms = stream_start.elapsed().as_millis();
                            let accumulated = serde_json::json!({
                                "usage": {"input_tokens": input_tokens, "output_tokens": output_tokens}
                            });
                            session_mgr.log_stream_complete(&ctx, &actual_provider_c, &actual_model_c, &accumulated, elapsed_ms);

                            let ts = chrono::Local::now().format("%H:%M:%S");
                            let provider_model = format!("{}/{}", actual_provider_c, actual_model_c);
                            eprintln!(
                                "{} {} {} {} {} stream out={} stop=end_turn {}",
                                ts.to_string().dimmed(),
                                prefix_c2.cyan().bold(),
                                format!("[profile={} via=openai role=codex]", profile_name_c).dimmed(),
                                "->".green(),
                                provider_model.green(),
                                output_tokens,
                                format!("({:.1}s)", elapsed_ms as f64 / 1000.0).dimmed()
                            );

                            if hvr_enabled {
                                if let Some(ref mem) = memory {
                                    let cost_usd = crate::cost::estimate_cost(&actual_model_c, input_tokens, output_tokens);
                                    let entry = RoutingEntry {
                                        session_id: ctx.session_id.clone(),
                                        request_seq: ctx.seq,
                                        cluster_id,
                                        query_preview: extract_codex_query_preview(&body),
                                        actual_provider: actual_provider_c,
                                        actual_model: actual_model_c,
                                        actual_latency_ms: elapsed_ms as u64,
                                        actual_cost_usd: cost_usd,
                                        input_tokens,
                                        output_tokens,
                                        cache_read_tokens: 0,
                                        hvr_score: 0.0,
                                        hvr_gate_passed: true,
                                        stop_reason: "end_turn".to_string(),
                                        is_stream: true,
                                        profile_name: profile_name_c,
                                        agent_role: agent_role_c2,
                                        cc_version_suffix: String::new(),
                                        msg_count: 0,
                                        tool_call_count: 0,
                                        has_code: false,
                                        user_msg_length: 0,
                                        is_retrial: false,
                                        strategy_version: 0,
                                        strategy_rule_id: None,
                                        dispatch_source: dispatch_source_c2,
                                    };
                                    let mem = mem.clone();
                                    let _ = tokio::task::spawn_blocking(move || mem.log_routing(&entry)).await;
                                }
                            }
                        });
                    }

                    let rx_stream = tokio_stream::wrappers::ReceiverStream::new(rx);
                    Ok(Response::builder()
                        .status(200)
                        .header("content-type", "text/event-stream")
                        .header("cache-control", "no-cache")
                        .header("connection", "keep-alive")
                        .body(Body::from_stream(rx_stream))
                        .unwrap())
                }
                ProviderBody::Json(json_body) => {
                    let elapsed = start.elapsed();
                    let elapsed_ms = elapsed.as_millis();

                    let (input_tokens, output_tokens, codex_resp) = if provider_type == ProviderType::OpenAI {
                        // Convert OpenAI Chat JSON → Codex response format
                        let in_tok = json_body.get("usage")
                            .and_then(|u| u.get("prompt_tokens")).and_then(|v| v.as_u64()).unwrap_or(0);
                        let out_tok = json_body.get("usage")
                            .and_then(|u| u.get("completion_tokens")).and_then(|v| v.as_u64()).unwrap_or(0);
                        let text = json_body.get("choices")
                            .and_then(|c| c.get(0))
                            .and_then(|ch| ch.get("message"))
                            .and_then(|m| m.get("content"))
                            .and_then(|c| c.as_str())
                            .unwrap_or("").to_string();
                        let resp_id = format!("resp_{}", uuid::Uuid::new_v4().simple());
                        let resp = serde_json::json!({
                            "id": resp_id,
                            "object": "response",
                            "status": "completed",
                            "output": [{
                                "type": "message",
                                "role": "assistant",
                                "content": [{"type": "output_text", "text": text, "annotations": []}]
                            }],
                            "usage": {
                                "input_tokens": in_tok,
                                "output_tokens": out_tok,
                                "total_tokens": in_tok + out_tok
                            }
                        });
                        (in_tok, out_tok, resp)
                    } else {
                        // OpenAIResponses: pass-through
                        let in_tok = json_body.get("usage")
                            .and_then(|u| u.get("input_tokens")).and_then(|v| v.as_u64()).unwrap_or(0);
                        let out_tok = json_body.get("usage")
                            .and_then(|u| u.get("output_tokens")).and_then(|v| v.as_u64()).unwrap_or(0);
                        (in_tok, out_tok, json_body.clone())
                    };

                    state.session_mgr.log_response(&ctx, &actual_provider, &actual_model, &codex_resp, elapsed_ms);

                    if config.routing.hvr_enabled {
                        if let Some(ref mem) = state.memory {
                            let cost_usd = cost::estimate_cost(&actual_model, input_tokens, output_tokens);
                            let entry = RoutingEntry {
                                session_id: ctx.session_id.clone(),
                                request_seq: ctx.seq,
                                cluster_id,
                                query_preview: extract_codex_query_preview(&body),
                                actual_provider: actual_provider.clone(),
                                actual_model: actual_model.clone(),
                                actual_latency_ms: elapsed_ms as u64,
                                actual_cost_usd: cost_usd,
                                input_tokens,
                                output_tokens,
                                cache_read_tokens: 0,
                                hvr_score: 0.0,
                                hvr_gate_passed: true,
                                stop_reason: "end_turn".to_string(),
                                is_stream: false,
                                profile_name: profile_name.clone(),
                                agent_role: agent_role_str.clone(),
                                cc_version_suffix: String::new(),
                                msg_count: 0,
                                tool_call_count: 0,
                                has_code: false,
                                user_msg_length: 0,
                                is_retrial: false,
                                strategy_version: 0,
                                strategy_rule_id: None,
                                dispatch_source: dispatch_source.clone(),
                            };
                            let mem = mem.clone();
                            tokio::spawn(async move {
                                if let Err(e) = tokio::task::spawn_blocking(move || mem.log_routing(&entry)).await {
                                    tracing::warn!("memory log failed: {e}");
                                }
                            });
                        }
                    }

                    Ok(Response::builder()
                        .status(200)
                        .header("content-type", "application/json")
                        .body(Body::from(codex_resp.to_string()))
                        .unwrap())
                }
            }
        }
        Err(e) => {
            state.session_mgr.log_error(&ctx, &e);
            Err(AppError::AllProvidersFailed(e))
        }
    }
}

/// Handle OpenAI Chat Completions (POST /v1/chat/completions).
/// Routes directly to an OpenAI-type provider without Anthropic format conversion.
pub async fn handle_chat_completions(
    state: &AppState,
    body: Value,
) -> Result<Response, AppError> {
    let config = state.config.load();
    let ctx = state.session_mgr.begin_request(&body);
    state.session_mgr.log_request(&ctx, &body);

    let model = body.get("model").and_then(|v| v.as_str()).unwrap_or("unknown").to_string();
    let is_stream = body.get("stream").and_then(|v| v.as_bool()).unwrap_or(false);

    let agent = agent_role::detect(&body);
    let cc_version_suffix = agent_role::extract_cc_version_suffix(&body);
    let signals = crate::dispatch::DispatchSignals {
        model: &model,
        session_id: &ctx.session_id,
        agent_role: agent.clone(),
        cc_version_suffix: cc_version_suffix.as_deref(),
    };
    let overrides = state.session_overrides.load();
    let dispatch_result = crate::dispatch::select_profile(&config, &signals, &overrides, state.strategy.as_deref(), None);
    let profile_name = dispatch_result.profile.to_string();
    let dispatch_source = dispatch_result.source.label().to_string();
    let agent_role_str = agent.to_string();
    state.control.record_hit(&profile_name);

    let chain = config.get_effective_chain(&profile_name);
    let start = Instant::now();
    let cluster_id = 0u32;

    match priority::execute_openai_with_failover(
        &state.client, &config, &body, &chain,
        &profile_name, &ctx.session_short, ctx.seq,
        Some(&state.session_mgr), Some(&ctx),
        crate::priority::ExtProcCtx::none(),
    ).await {
        Ok((result, _idx)) => {
            let actual_provider = if result.provider_name.is_empty() {
                chain.first().map(|e| e.provider.clone()).unwrap_or_default()
            } else {
                result.provider_name.clone()
            };
            let actual_model = if result.model.is_empty() { model.clone() } else { result.model.clone() };

            let prefix = format!("[{}/{}]", ctx.session_short, ctx.seq);
            let ts = chrono::Local::now().format("%H:%M:%S");
            eprintln!(
                "{} {} {} chat {}/{} stream={}",
                ts.to_string().dimmed(), prefix.cyan().bold(),
                "openai".green(),
                actual_provider.yellow(), actual_model.yellow(),
                is_stream
            );

            match result.body {
                ProviderBody::Stream(byte_stream) => {
                    state.session_mgr.log_stream_start(&ctx, &actual_provider, &actual_model);
                    let session_mgr = state.session_mgr.clone();
                    let memory = state.memory.clone();
                    let hvr_enabled = config.routing.hvr_enabled;
                    let (tx, rx) = tokio::sync::mpsc::channel::<Result<Bytes, std::io::Error>>(256);
                    let actual_model_c = actual_model.clone();
                    let actual_provider_c = actual_provider.clone();
                    let profile_name_c = profile_name.clone();
                    let agent_role_c = agent_role_str.clone();
                    let dispatch_source_c = dispatch_source.clone();

                    tokio::spawn(async move {
                        let mut byte_stream = byte_stream;
                        let mut input_tokens: u64 = 0;
                        let mut cached_tokens: u64 = 0;
                        let mut output_tokens: u64 = 0;
                        let stream_start = Instant::now();
                        let mut buf = String::new();

                        loop {
                            match byte_stream.next().await {
                                None => break,
                                Some(Err(_)) => break,
                                Some(Ok(chunk)) => {
                                    buf.push_str(&String::from_utf8_lossy(&chunk));
                                    loop {
                                        if let Some(pos) = buf.find("\n\n") {
                                            let block = buf[..pos + 2].to_string();
                                            buf = buf[pos + 2..].to_string();
                                            for line in block.lines() {
                                                if let Some(d) = line.strip_prefix("data: ") {
                                                    if d != "[DONE]" {
                                                        if let Ok(j) = serde_json::from_str::<Value>(d) {
                                                            if let Some(usage) = j.get("usage") {
                                                                input_tokens = usage.get("prompt_tokens").and_then(|v| v.as_u64()).unwrap_or(input_tokens);
                                                                output_tokens = usage.get("completion_tokens").and_then(|v| v.as_u64()).unwrap_or(output_tokens);
                                                                cached_tokens = usage.get("prompt_tokens_details")
                                                                    .and_then(|d| d.get("cached_tokens"))
                                                                    .and_then(|v| v.as_u64())
                                                                    .unwrap_or(cached_tokens);
                                                            }
                                                        }
                                                    }
                                                }
                                            }
                                        } else {
                                            break;
                                        }
                                    }
                                    if tx.send(Ok(chunk)).await.is_err() { break; }
                                }
                            }
                        }

                        let elapsed_ms = stream_start.elapsed().as_millis();
                        let accumulated = serde_json::json!({
                            "usage": {"input_tokens": input_tokens, "output_tokens": output_tokens}
                        });
                        session_mgr.log_stream_complete(&ctx, &actual_provider_c, &actual_model_c, &accumulated, elapsed_ms);

                        if hvr_enabled {
                            if let Some(ref mem) = memory {
                                let cost_usd = crate::cost::estimate_cost_with_cache(&actual_model_c, input_tokens, cached_tokens, output_tokens);
                                let entry = RoutingEntry {
                                    session_id: ctx.session_id.clone(),
                                    request_seq: ctx.seq,
                                    cluster_id,
                                    query_preview: extract_query_preview(&body),
                                    actual_provider: actual_provider_c,
                                    actual_model: actual_model_c,
                                    actual_latency_ms: elapsed_ms as u64,
                                    actual_cost_usd: cost_usd,
                                    input_tokens,
                                    output_tokens,
                                    cache_read_tokens: cached_tokens,
                                    hvr_score: 0.0,
                                    hvr_gate_passed: true,
                                    stop_reason: "end_turn".to_string(),
                                    is_stream: true,
                                    profile_name: profile_name_c,
                                    agent_role: agent_role_c,
                                    cc_version_suffix: String::new(),
                                    msg_count: 0,
                                    tool_call_count: 0,
                                    has_code: false,
                                    user_msg_length: 0,
                                    is_retrial: false,
                                    strategy_version: 0,
                                    strategy_rule_id: None,
                                    dispatch_source: dispatch_source_c,
                                };
                                let mem = mem.clone();
                                let _ = tokio::task::spawn_blocking(move || mem.log_routing(&entry)).await;
                            }
                        }
                    });

                    let rx_stream = tokio_stream::wrappers::ReceiverStream::new(rx);
                    Ok(Response::builder()
                        .status(200)
                        .header("content-type", "text/event-stream")
                        .header("cache-control", "no-cache")
                        .header("connection", "keep-alive")
                        .body(Body::from_stream(rx_stream))
                        .unwrap())
                }
                ProviderBody::Json(json_body) => {
                    let elapsed = start.elapsed();
                    let elapsed_ms = elapsed.as_millis();
                    let input_tokens = json_body.get("usage")
                        .and_then(|u| u.get("prompt_tokens")).and_then(|v| v.as_u64()).unwrap_or(0);
                    let output_tokens = json_body.get("usage")
                        .and_then(|u| u.get("completion_tokens")).and_then(|v| v.as_u64()).unwrap_or(0);
                    let cached_tokens = json_body.get("usage")
                        .and_then(|u| u.get("prompt_tokens_details"))
                        .and_then(|d| d.get("cached_tokens"))
                        .and_then(|v| v.as_u64()).unwrap_or(0);

                    state.session_mgr.log_response(&ctx, &actual_provider, &actual_model, &json_body, elapsed_ms);

                    if config.routing.hvr_enabled {
                        if let Some(ref mem) = state.memory {
                            let cost_usd = cost::estimate_cost_with_cache(&actual_model, input_tokens, cached_tokens, output_tokens);
                            let entry = RoutingEntry {
                                session_id: ctx.session_id.clone(),
                                request_seq: ctx.seq,
                                cluster_id,
                                query_preview: extract_query_preview(&body),
                                actual_provider: actual_provider.clone(),
                                actual_model: actual_model.clone(),
                                actual_latency_ms: elapsed_ms as u64,
                                actual_cost_usd: cost_usd,
                                input_tokens,
                                output_tokens,
                                cache_read_tokens: cached_tokens,
                                hvr_score: 0.0,
                                hvr_gate_passed: true,
                                stop_reason: "end_turn".to_string(),
                                is_stream: false,
                                profile_name: profile_name.clone(),
                                agent_role: agent_role_str.clone(),
                                cc_version_suffix: String::new(),
                                msg_count: 0,
                                tool_call_count: 0,
                                has_code: false,
                                user_msg_length: 0,
                                is_retrial: false,
                                strategy_version: 0,
                                strategy_rule_id: None,
                                dispatch_source: dispatch_source.clone(),
                            };
                            let mem = mem.clone();
                            tokio::spawn(async move {
                                if let Err(e) = tokio::task::spawn_blocking(move || mem.log_routing(&entry)).await {
                                    tracing::warn!("memory log failed: {e}");
                                }
                            });
                        }
                    }

                    Ok(Response::builder()
                        .status(200)
                        .header("content-type", "application/json")
                        .body(Body::from(json_body.to_string()))
                        .unwrap())
                }
            }
        }
        Err(e) => {
            state.session_mgr.log_error(&ctx, &e);
            Err(AppError::AllProvidersFailed(e))
        }
    }
}

fn extract_codex_query_preview(body: &Value) -> String {
    if let Some(input) = body.get("input").and_then(|i| i.as_array()) {
        if let Some(last) = input.last() {
            if let Some(content) = last.get("content") {
                match content {
                    Value::String(s) => return s.chars().take(100).collect(),
                    Value::Array(arr) => {
                        for block in arr {
                            if let Some(t) = block.get("text").and_then(|t| t.as_str()) {
                                return t.chars().take(100).collect();
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
    }
    String::new()
}

fn apply_pre_request_hook(hook: &PreRequestHook, body: &mut Value) {

    if let Some(temp) = hook.override_temperature {
        if let Some(t) = serde_json::Number::from_f64(temp) {
            body["temperature"] = Value::Number(t);
        }
    }

    if let Some(ref suffix) = hook.inject_system_suffix {
        if let Some(system) = body.get_mut("system").and_then(|s| s.as_array_mut()) {
            system.push(serde_json::json!({
                "type": "text",
                "text": suffix,
            }));
        }
    }

    if let Some(ref strip_list) = hook.strip_tools {
        if let Some(tools) = body.get_mut("tools").and_then(|t| t.as_array_mut()) {
            tools.retain(|tool| {
                let name = tool.get("name").and_then(|n| n.as_str()).unwrap_or("");
                !strip_list.contains(&name.to_string())
            });
        }
    }
}

fn apply_post_response_hook(
    hook: &PostResponseHook,
    prefix: &str,
    agent_role: &str,
    stop_reason: &str,
    response: &Value,
) {
    if let Some(ref alert_reasons) = hook.alert_on_stop_reason {
        if alert_reasons.iter().any(|r| r == stop_reason) {
            let ts = chrono::Local::now().format("%H:%M:%S");
            eprintln!(
                "{} {} {} role={} stop_reason={} triggered alert",
                ts.to_string().dimmed(),
                prefix.cyan().bold(),
                "[role-hook-alert]".red().bold(),
                agent_role.yellow(),
                stop_reason.red(),
            );
        }
    }

    if let Some(ref level) = hook.log_level {
        let output_tokens = response
            .get("usage")
            .and_then(|u| u.get("output_tokens"))
            .and_then(|t| t.as_u64())
            .unwrap_or(0);
        match level.as_str() {
            "debug" => tracing::debug!(
                prefix = prefix, role = agent_role,
                stop_reason = stop_reason, output_tokens = output_tokens,
                "post_response hook"
            ),
            "warn" => tracing::warn!(
                prefix = prefix, role = agent_role,
                stop_reason = stop_reason, output_tokens = output_tokens,
                "post_response hook"
            ),
            _ => tracing::info!(
                prefix = prefix, role = agent_role,
                stop_reason = stop_reason, output_tokens = output_tokens,
                "post_response hook"
            ),
        }
    }
}

fn eval_cel_condition(cel_expr: Option<&str>, body: &Value, msg_count: usize) -> bool {
    let Some(expr) = cel_expr else {
        return true;
    };
    let program = match cel_interpreter::Program::compile(expr) {
        Ok(p) => p,
        Err(e) => {
            tracing::warn!("Invalid CEL in role_hook: {e}");
            return false;
        }
    };
    let mut context = cel_interpreter::Context::default();
    context.add_variable_from_value("msg_count", cel_interpreter::Value::UInt(msg_count as u64));

    let is_stream = body.get("stream").and_then(|s| s.as_bool()).unwrap_or(false);
    context.add_variable_from_value("is_stream", cel_interpreter::Value::Bool(is_stream));

    let model = body.get("model").and_then(|m| m.as_str()).unwrap_or("unknown");
    context.add_variable_from_value("model", cel_interpreter::Value::String(model.to_string().into()));

    let tool_count = body.get("tools").and_then(|t| t.as_array()).map(|a| a.len()).unwrap_or(0);
    context.add_variable_from_value("tool_count", cel_interpreter::Value::UInt(tool_count as u64));

    matches!(program.execute(&context), Ok(cel_interpreter::Value::Bool(true)))
}
