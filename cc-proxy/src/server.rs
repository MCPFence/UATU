use crate::config::Config;
use crate::control::{self, ControlState};
#[cfg(unix)]
use crate::ext_proc::ExtProcClient;
use crate::hvr::HvrDetector;
use crate::jsonlog::SessionManager;
use crate::memory::MemoryBank;
use crate::pii::VaultManager;
use crate::proxy;
use crate::retrial::RetrialDetector;
use crate::strategy::StrategyCache;
use arc_swap::ArcSwap;
use axum::{extract::State, http::HeaderMap, response::Response, routing::post, Json, Router};
use reqwest::Client;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Arc;

pub struct AppState {
    pub config: ArcSwap<Config>,
    pub client: Client,
    pub session_mgr: Arc<SessionManager>,
    pub hvr: Arc<HvrDetector>,
    pub memory: Option<Arc<MemoryBank>>,
    pub session_overrides: ArcSwap<HashMap<String, String>>,
    pub control: Arc<ControlState>,
    pub strategy: Option<Arc<StrategyCache>>,
    pub retrial: Arc<RetrialDetector>,
    #[cfg(unix)]
    pub ext_proc: Option<Arc<ExtProcClient>>,
    pub pii_vaults: Arc<VaultManager>,
}

pub fn create_router(config: Config) -> (Router, Option<Arc<MemoryBank>>) {
    let client = Client::builder()
        .pool_max_idle_per_host(10)
        .build()
        .expect("Failed to create HTTP client");

    let session_mgr = Arc::new(SessionManager::new(config.log_dir.clone()));

    let hvr = Arc::new(HvrDetector::new());

    let retrial = Arc::new(RetrialDetector::new(config.routing.retrial_window_secs));

    let memory = if config.routing.memory_enabled {
        match MemoryBank::new(&config.routing.memory_db_path) {
            Ok(bank) => Some(Arc::new(bank)),
            Err(e) => {
                eprintln!("  WARNING: Failed to init memory bank: {e}");
                None
            }
        }
    } else {
        None
    };

    let strategy = memory.as_ref().and_then(|mem| {
        match StrategyCache::load_from_db(mem) {
            Ok(cache) => {
                let version = cache.version();
                if version > 0 {
                    tracing::info!("Loaded strategy cache version {version}");
                }
                Some(Arc::new(cache))
            }
            Err(e) => {
                tracing::warn!("Failed to load strategy cache: {e}");
                Some(Arc::new(StrategyCache::empty()))
            }
        }
    });

    let overrides = control::load_overrides(&config.log_dir);

    let refresh_secs = config.routing.strategy_refresh_secs;

    #[cfg(unix)]
    let ext_proc = config.routing.ext_proc.as_ref().map(|cfg| {
        Arc::new(ExtProcClient::new(cfg))
    });

    let state = Arc::new(AppState {
        config: ArcSwap::new(Arc::new(config)),
        client,
        session_mgr,
        hvr,
        memory,
        session_overrides: ArcSwap::new(Arc::new(overrides)),
        control: Arc::new(ControlState::new()),
        strategy,
        retrial,
        #[cfg(unix)]
        ext_proc,
        pii_vaults: Arc::new(VaultManager::new()),
    });

    if let (Some(strategy), Some(memory)) = (&state.strategy, &state.memory) {
        let strategy = Arc::clone(strategy);
        let memory = Arc::clone(memory);
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(refresh_secs)).await;
                let mem = memory.clone();
                let strat = strategy.clone();
                let _ = tokio::task::spawn_blocking(move || {
                    if strat.refresh(&mem) {
                        tracing::info!("Strategy updated to version {}", strat.version());
                    }
                }).await;
            }
        });
    }

    let memory_handle = state.memory.clone();

    let router = Router::new()
        .route("/v1/messages", post(handle_messages))
        .route("/v1/responses", post(handle_responses))
        .route("/v1/chat/completions", post(handle_chat_completions))
        .merge(control::admin_router())
        .with_state(state);

    (router, memory_handle)
}

async fn handle_messages(
    State(state): State<Arc<AppState>>,
    _headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    match proxy::handle_messages(&state, body).await {
        Ok(response) => response,
        Err(e) => axum::response::IntoResponse::into_response(e),
    }
}

async fn handle_responses(
    State(state): State<Arc<AppState>>,
    _headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    match proxy::handle_responses(&state, body).await {
        Ok(response) => response,
        Err(e) => axum::response::IntoResponse::into_response(e),
    }
}

async fn handle_chat_completions(
    State(state): State<Arc<AppState>>,
    _headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    match proxy::handle_chat_completions(&state, body).await {
        Ok(response) => response,
        Err(e) => axum::response::IntoResponse::into_response(e),
    }
}
