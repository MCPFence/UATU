use crate::config::Config;
use crate::server::AppState;
use axum::extract::State;
use axum::response::IntoResponse;
use axum::extract::Path;
use axum::routing::{delete, get, post, put};
use axum::{Json, Router};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, RwLock};

pub struct ControlState {
    pub profile_hits: RwLock<HashMap<String, AtomicU64>>,
    pub start_time: std::time::Instant,
}

impl ControlState {
    pub fn new() -> Self {
        Self {
            profile_hits: RwLock::new(HashMap::new()),
            start_time: std::time::Instant::now(),
        }
    }

    pub fn record_hit(&self, profile: &str) {
        {
            let hits = self.profile_hits.read().unwrap();
            if let Some(counter) = hits.get(profile) {
                counter.fetch_add(1, Ordering::Relaxed);
                return;
            }
        }
        let mut hits = self.profile_hits.write().unwrap();
        hits.entry(profile.to_string())
            .or_insert_with(|| AtomicU64::new(0))
            .fetch_add(1, Ordering::Relaxed);
    }
}

pub fn admin_router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/_admin/status", get(admin_status))
        .route("/_admin/profiles", get(admin_profiles))
        .route("/_admin/sessions", get(admin_sessions))
        .route("/_admin/session/bind", post(admin_session_bind))
        .route("/_admin/session/unbind", post(admin_session_unbind))
        .route("/_admin/role-hooks", get(admin_role_hooks))
        .route("/_admin/reload", post(admin_reload))
        .route("/_admin/strategies/refresh", post(admin_strategy_refresh))
        .route("/_admin/strategies", get(admin_list_strategies))
        .route("/_admin/strategies", post(admin_create_strategy))
        .route("/_admin/strategies/{id}", get(admin_get_strategy))
        .route("/_admin/strategies/{id}", put(admin_update_strategy))
        .route("/_admin/strategies/{id}", delete(admin_delete_strategy))
        .route("/_admin/routing-log", get(admin_routing_log))
        .route("/_admin/reputation", get(admin_reputation))
        .route("/_admin/checkpoint", post(admin_checkpoint))
}

async fn admin_status(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let config = state.config.load();
    let uptime = state.control.start_time.elapsed();

    let mut hits: Vec<Value> = Vec::new();
    {
        let profile_hits = state.control.profile_hits.read().unwrap();
        for (name, counter) in profile_hits.iter() {
            hits.push(json!({
                "profile": name,
                "count": counter.load(Ordering::Relaxed),
            }));
        }
    }
    hits.sort_by(|a, b| {
        b.get("count").and_then(|c| c.as_u64()).unwrap_or(0)
            .cmp(&a.get("count").and_then(|c| c.as_u64()).unwrap_or(0))
    });

    let overrides = state.session_overrides.load();
    let override_count = overrides.len();

    let routing_count = state.memory.as_ref()
        .and_then(|m| m.routing_count().ok())
        .unwrap_or(0);

    Json(json!({
        "status": "running",
        "uptime_secs": uptime.as_secs(),
        "profile_count": config.profiles.len(),
        "dispatch_rules": config.routing.dispatch.rules.len(),
        "role_hooks": config.routing.role_hooks.len(),
        "profile_hits": hits,
        "session_overrides": override_count,
        "routing_log_total": routing_count,
    }))
}

async fn admin_profiles(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let config = state.config.load();
    let mut profiles = json!({});
    for (name, chain) in &config.profiles {
        let entries: Vec<Value> = chain.iter().map(|e| {
            json!({"provider": e.provider, "model": e.model})
        }).collect();
        profiles[name] = json!(entries);
    }
    Json(json!({
        "default_profile": config.routing.dispatch.default_profile,
        "profiles": profiles,
        "rules": config.routing.dispatch.rules.iter().map(|r| {
            json!({
                "match": {
                    "model_pattern": r.match_cond.model_pattern,
                    "agent_role": r.match_cond.agent_role,
                    "session_id": r.match_cond.session_id,
                    "cc_version_suffix": r.match_cond.cc_version_suffix,
                },
                "profile": r.profile,
            })
        }).collect::<Vec<_>>(),
    }))
}

async fn admin_sessions(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let overrides = state.session_overrides.load();
    let bindings: Vec<Value> = overrides.iter().map(|(sid, prof)| {
        json!({"session_id": sid, "profile": prof})
    }).collect();

    Json(json!({
        "session_overrides": bindings,
    }))
}

async fn admin_session_bind(
    State(state): State<Arc<AppState>>,
    Json(body): Json<Value>,
) -> impl IntoResponse {
    let session_id = body.get("session_id").and_then(|v| v.as_str());
    let profile = body.get("profile").and_then(|v| v.as_str());

    match (session_id, profile) {
        (Some(sid), Some(prof)) => {
            let config = state.config.load();
            if !config.profiles.contains_key(prof) {
                return Json(json!({"error": format!("Unknown profile: {}", prof)}));
            }
            let mut new_overrides = (**state.session_overrides.load()).clone();
            new_overrides.insert(sid.to_string(), prof.to_string());
            state.session_overrides.store(Arc::new(new_overrides));
            save_overrides(&state);
            Json(json!({"ok": true, "session_id": sid, "profile": prof}))
        }
        _ => Json(json!({"error": "Missing session_id or profile"})),
    }
}

async fn admin_session_unbind(
    State(state): State<Arc<AppState>>,
    Json(body): Json<Value>,
) -> impl IntoResponse {
    let session_id = body.get("session_id").and_then(|v| v.as_str());
    match session_id {
        Some(sid) => {
            let mut new_overrides = (**state.session_overrides.load()).clone();
            new_overrides.remove(sid);
            state.session_overrides.store(Arc::new(new_overrides));
            save_overrides(&state);
            Json(json!({"ok": true, "session_id": sid}))
        }
        None => Json(json!({"error": "Missing session_id"})),
    }
}

async fn admin_reload(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let config_path = Config::default_path();
    match config_path {
        Ok(path) => match Config::load(Some(path.to_str().unwrap_or(""))) {
            Ok(new_config) => {
                state.config.store(Arc::new(new_config));
                Json(json!({"ok": true, "message": "Config reloaded"}))
            }
            Err(e) => Json(json!({"error": format!("Failed to load config: {}", e)})),
        },
        Err(e) => Json(json!({"error": format!("Cannot determine config path: {}", e)})),
    }
}

async fn admin_strategy_refresh(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let strategy = match &state.strategy {
        Some(s) => s.clone(),
        None => return Json(json!({"error": "strategy engine disabled (no DuckDB)"})),
    };
    let memory = match &state.memory {
        Some(m) => m.clone(),
        None => return Json(json!({"error": "memory disabled"})),
    };

    let old_version = strategy.version();
    let result = tokio::task::spawn_blocking(move || strategy.refresh(&memory)).await;

    match result {
        Ok(true) => {
            let new_version = state.strategy.as_ref().unwrap().version();
            Json(json!({
                "ok": true,
                "previous_version": old_version,
                "current_version": new_version,
                "message": "Strategy refreshed"
            }))
        }
        Ok(false) => Json(json!({
            "ok": true,
            "version": old_version,
            "message": "No new strategies found"
        })),
        Err(e) => Json(json!({"error": format!("Refresh task failed: {}", e)})),
    }
}

fn save_overrides(state: &AppState) {
    let overrides = state.session_overrides.load();
    let config = state.config.load();
    let log_dir = &config.log_dir;
    let parent = std::path::Path::new(log_dir).parent().unwrap_or(std::path::Path::new("."));
    let path = parent.join("session_overrides.json");
    if let Ok(json) = serde_json::to_string_pretty(&**overrides) {
        let _ = std::fs::write(&path, json);
    }
}

pub fn load_overrides(log_dir: &str) -> HashMap<String, String> {
    let parent = std::path::Path::new(log_dir).parent().unwrap_or(std::path::Path::new("."));
    let path = parent.join("session_overrides.json");
    if let Ok(content) = std::fs::read_to_string(&path) {
        serde_json::from_str(&content).unwrap_or_default()
    } else {
        HashMap::new()
    }
}

async fn admin_role_hooks(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let config = state.config.load();
    let hooks: Vec<Value> = config.routing.role_hooks.iter().map(|(role, hook)| {
        json!({
            "role_pattern": role,
            "pre_request": hook.pre_request.as_ref().map(|h| json!({
                "override_profile": h.override_profile,
                "override_max_tokens": h.override_max_tokens,
                "override_temperature": h.override_temperature,
                "inject_system_suffix": h.inject_system_suffix.is_some(),
                "strip_tools": h.strip_tools,
                "cel_condition": h.cel_condition,
            })),
            "post_response": hook.post_response.as_ref().map(|h| json!({
                "log_level": h.log_level,
                "alert_on_stop_reason": h.alert_on_stop_reason,
                "cel_condition": h.cel_condition,
            })),
        })
    }).collect();

    Json(json!({
        "role_hooks": hooks,
        "match_order": "exact role string first, then family fallback",
        "available_roles": [
            "main:first_turn", "main:user_turn",
            "main:tool:info", "main:tool:exec", "main:tool:mutation",
            "main:tool:coord", "main:tool:flow", "main:tool:unknown",
            "main:sdk",
            "subagent:explore", "subagent:general", "subagent:plan",
            "subagent:guide", "subagent:statusline", "subagent:verification", "subagent:fork",
            "sidequery:title", "sidequery:naming", "sidequery:web_search",
            "sidequery:web_fetch", "sidequery:other",
            "compaction", "raw_api"
        ],
        "available_families": ["main", "subagent", "sidequery", "compaction", "raw_api"]
    }))
}

async fn admin_list_strategies(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    match &state.memory {
        Some(mem) => match mem.list_all_strategies() {
            Ok(rows) => Json(json!({"strategies": rows})),
            Err(e) => Json(json!({"error": format!("{}", e)})),
        },
        None => Json(json!({"error": "memory disabled"})),
    }
}

async fn admin_get_strategy(
    State(state): State<Arc<AppState>>,
    Path(id): Path<i64>,
) -> impl IntoResponse {
    match &state.memory {
        Some(mem) => match mem.get_strategy_by_id(id) {
            Ok(Some(row)) => Json(json!(row)),
            Ok(None) => Json(json!({"error": "not found"})),
            Err(e) => Json(json!({"error": format!("{}", e)})),
        },
        None => Json(json!({"error": "memory disabled"})),
    }
}

async fn admin_create_strategy(
    State(state): State<Arc<AppState>>,
    Json(body): Json<Value>,
) -> impl IntoResponse {
    match &state.memory {
        Some(mem) => match mem.create_strategy_row(&body) {
            Ok(row) => Json(json!(row)),
            Err(e) => Json(json!({"error": format!("{}", e)})),
        },
        None => Json(json!({"error": "memory disabled"})),
    }
}

async fn admin_update_strategy(
    State(state): State<Arc<AppState>>,
    Path(id): Path<i64>,
    Json(body): Json<Value>,
) -> impl IntoResponse {
    match &state.memory {
        Some(mem) => match mem.update_strategy_row(id, &body) {
            Ok(Some(row)) => Json(json!(row)),
            Ok(None) => Json(json!({"error": "not found"})),
            Err(e) => Json(json!({"error": format!("{}", e)})),
        },
        None => Json(json!({"error": "memory disabled"})),
    }
}

async fn admin_delete_strategy(
    State(state): State<Arc<AppState>>,
    Path(id): Path<i64>,
) -> impl IntoResponse {
    match &state.memory {
        Some(mem) => match mem.delete_strategy_row(id) {
            Ok(true) => Json(json!({"ok": true})),
            Ok(false) => Json(json!({"error": "not found"})),
            Err(e) => Json(json!({"error": format!("{}", e)})),
        },
        None => Json(json!({"error": "memory disabled"})),
    }
}

async fn admin_routing_log(
    State(state): State<Arc<AppState>>,
    axum::extract::Query(params): axum::extract::Query<HashMap<String, String>>,
) -> impl IntoResponse {
    let limit = params.get("limit").and_then(|v| v.parse().ok()).unwrap_or(50i64);
    let offset = params.get("offset").and_then(|v| v.parse().ok()).unwrap_or(0i64);
    match &state.memory {
        Some(mem) => match mem.list_routing_log(limit, offset) {
            Ok((rows, total)) => Json(json!({"entries": rows, "total": total, "limit": limit, "offset": offset})),
            Err(e) => Json(json!({"error": format!("{}", e)})),
        },
        None => Json(json!({"error": "memory disabled"})),
    }
}

async fn admin_reputation(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    match &state.memory {
        Some(mem) => match mem.list_reputation() {
            Ok(rows) => Json(json!({"entries": rows})),
            Err(e) => Json(json!({"error": format!("{}", e)})),
        },
        None => Json(json!({"error": "memory disabled"})),
    }
}

async fn admin_checkpoint(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    match &state.memory {
        Some(mem) => match mem.checkpoint() {
            Ok(()) => Json(json!({"ok": true, "message": "WAL checkpoint completed"})),
            Err(e) => Json(json!({"error": format!("{}", e)})),
        },
        None => Json(json!({"error": "memory disabled"})),
    }
}
