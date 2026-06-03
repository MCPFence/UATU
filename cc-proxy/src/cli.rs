use crate::config::Config;
use anyhow::{anyhow, Result};
use colored::Colorize;
use serde_json::Value;

fn admin_base(cfg: &Config) -> String {
    format!("http://{}:{}", cfg.host, cfg.port)
}

async fn admin_get(cfg: &Config, path: &str) -> Result<Value> {
    let url = format!("{}{}", admin_base(cfg), path);
    let resp = reqwest::get(&url).await
        .map_err(|e| anyhow!("Cannot reach daemon at {url}: {e}. Is `cc-proxy serve` running?"))?;
    let v: Value = resp.json().await?;
    Ok(v)
}

async fn admin_post(cfg: &Config, path: &str, body: Value) -> Result<Value> {
    let url = format!("{}{}", admin_base(cfg), path);
    let client = reqwest::Client::new();
    let resp = client.post(&url).json(&body).send().await
        .map_err(|e| anyhow!("Cannot reach daemon at {url}: {e}. Is `cc-proxy serve` running?"))?;
    let v: Value = resp.json().await?;
    Ok(v)
}

pub async fn cmd_status(config_path: Option<&str>) -> Result<()> {
    let cfg = Config::load(config_path)?;
    let v = admin_get(&cfg, "/_admin/status").await?;
    println!("{}", "cc-proxy status".bold());
    println!("  uptime:  {}s", v.get("uptime_secs").and_then(|x| x.as_u64()).unwrap_or(0));
    println!("  profiles configured: {}", v.get("profile_count").and_then(|x| x.as_u64()).unwrap_or(0));
    println!("  dispatch rules:      {}", v.get("dispatch_rules").and_then(|x| x.as_u64()).unwrap_or(0));
    println!("  session bindings:    {}", v.get("session_overrides").and_then(|x| x.as_u64()).unwrap_or(0));
    println!("  routing log entries: {}", v.get("routing_log_total").and_then(|x| x.as_u64()).unwrap_or(0));
    println!();
    println!("  {}", "profile hits:".yellow());
    if let Some(arr) = v.get("profile_hits").and_then(|x| x.as_array()) {
        if arr.is_empty() {
            println!("    (none yet)");
        }
        for h in arr {
            println!(
                "    {:>10}  {:>6}",
                h.get("profile").and_then(|x| x.as_str()).unwrap_or("?").cyan(),
                h.get("count").and_then(|x| x.as_u64()).unwrap_or(0)
            );
        }
    }
    Ok(())
}

pub async fn cmd_reload(config_path: Option<&str>) -> Result<()> {
    let cfg = Config::load(config_path)?;
    let v = admin_post(&cfg, "/_admin/reload", serde_json::json!({})).await?;
    if v.get("ok").and_then(|x| x.as_bool()).unwrap_or(false) {
        println!("{}", "✓ config reloaded".green());
    } else {
        println!("{} {}", "✗".red(), v);
    }
    Ok(())
}

pub async fn cmd_strategy_refresh(config_path: Option<&str>) -> Result<()> {
    let cfg = Config::load(config_path)?;
    let v = admin_post(&cfg, "/_admin/strategies/refresh", serde_json::json!({})).await?;
    if v.get("ok").and_then(|x| x.as_bool()).unwrap_or(false) {
        let msg = v.get("message").and_then(|x| x.as_str()).unwrap_or("");
        let ver = v.get("current_version").or(v.get("version")).and_then(|x| x.as_i64()).unwrap_or(0);
        println!("{} {} (version: {})", "✓".green(), msg, ver);
    } else {
        println!("{} {}", "✗".red(), v);
    }
    Ok(())
}

pub async fn cmd_profile_list(config_path: Option<&str>) -> Result<()> {
    let cfg = Config::load(config_path)?;
    let v = admin_get(&cfg, "/_admin/profiles").await?;
    let default = v.get("default_profile").and_then(|x| x.as_str()).unwrap_or("default");
    println!("{} {}", "default profile:".dimmed(), default.cyan().bold());
    println!();
    println!("{}", "profiles:".yellow().bold());
    if let Some(profs) = v.get("profiles").and_then(|x| x.as_object()) {
        for (name, chain) in profs {
            println!("  {}", name.cyan().bold());
            if let Some(arr) = chain.as_array() {
                for (i, e) in arr.iter().enumerate() {
                    let prov = e.get("provider").and_then(|x| x.as_str()).unwrap_or("?");
                    let mdl = e.get("model").and_then(|x| x.as_str()).unwrap_or("?");
                    let tag = if i == 0 { "PRIMARY".green().to_string() } else { format!("FB#{i}").yellow().to_string() };
                    println!("    {} {}/{}", tag, prov, mdl);
                }
            }
        }
    }
    println!();
    println!("{}", "dispatch rules:".yellow().bold());
    if let Some(rules) = v.get("rules").and_then(|x| x.as_array()) {
        if rules.is_empty() {
            println!("  (no rules — all requests use default profile)");
        }
        for (i, r) in rules.iter().enumerate() {
            let m = r.get("match").cloned().unwrap_or(serde_json::json!({}));
            let prof = r.get("profile").and_then(|x| x.as_str()).unwrap_or("?");
            println!("  [{}] {} -> {}", i, m, prof.cyan());
        }
    }
    Ok(())
}

pub async fn cmd_profile_show(config_path: Option<&str>, name: &str) -> Result<()> {
    let cfg = Config::load(config_path)?;
    let v = admin_get(&cfg, "/_admin/profiles").await?;
    if let Some(chain) = v.get("profiles").and_then(|x| x.get(name)).and_then(|x| x.as_array()) {
        println!("{}: {}", "profile".dimmed(), name.cyan().bold());
        for (i, e) in chain.iter().enumerate() {
            let prov = e.get("provider").and_then(|x| x.as_str()).unwrap_or("?");
            let mdl = e.get("model").and_then(|x| x.as_str()).unwrap_or("?");
            let tag = if i == 0 { "PRIMARY".green().to_string() } else { format!("FB#{i}").yellow().to_string() };
            println!("  {} {}/{}", tag, prov, mdl);
        }
    } else {
        println!("{} unknown profile: {}", "✗".red(), name);
    }
    Ok(())
}

pub async fn cmd_profile_test(config_path: Option<&str>, name: &str, model: Option<&str>) -> Result<()> {
    use crate::dispatch::{select_profile, DispatchSignals};
    use crate::agent_role::AgentRole;
    use std::collections::HashMap;

    let cfg = Config::load(config_path)?;
    let m = model.unwrap_or("claude-opus-4-20250514");
    let signals = DispatchSignals {
        model: m,
        session_id: "dry-run",
        agent_role: AgentRole::RawApi,
        cc_version_suffix: None,
    };
    let overrides: HashMap<String, String> = HashMap::new();
    let result = select_profile(&cfg, &signals, &overrides, None, None);
    let resolved = result.profile;
    println!("{} {}", "model:".dimmed(), m.cyan());
    println!("{} {}", "expected profile:".dimmed(), name.cyan());
    println!("{} {}", "resolved profile:".dimmed(), resolved.cyan().bold());
    if resolved == name {
        println!("{}", "✓ match".green());
    } else {
        println!("{} dispatch resolved differently", "!".yellow());
    }
    Ok(())
}

pub async fn cmd_session_list(config_path: Option<&str>) -> Result<()> {
    let cfg = Config::load(config_path)?;
    let v = admin_get(&cfg, "/_admin/sessions").await?;
    println!("{}", "session overrides:".yellow().bold());
    if let Some(arr) = v.get("session_overrides").and_then(|x| x.as_array()) {
        if arr.is_empty() {
            println!("  (none)");
        }
        for b in arr {
            let sid = b.get("session_id").and_then(|x| x.as_str()).unwrap_or("?");
            let prof = b.get("profile").and_then(|x| x.as_str()).unwrap_or("?");
            println!("  {} -> {}", sid.dimmed(), prof.cyan());
        }
    }
    Ok(())
}

pub async fn cmd_session_bind(config_path: Option<&str>, sid: &str, profile: &str) -> Result<()> {
    let cfg = Config::load(config_path)?;
    let body = serde_json::json!({"session_id": sid, "profile": profile});
    let v = admin_post(&cfg, "/_admin/session/bind", body).await?;
    if v.get("ok").and_then(|x| x.as_bool()).unwrap_or(false) {
        println!("{} {} -> {}", "✓".green(), sid.dimmed(), profile.cyan());
    } else {
        println!("{} {}", "✗".red(), v);
    }
    Ok(())
}

pub async fn cmd_session_unbind(config_path: Option<&str>, sid: &str) -> Result<()> {
    let cfg = Config::load(config_path)?;
    let body = serde_json::json!({"session_id": sid});
    let v = admin_post(&cfg, "/_admin/session/unbind", body).await?;
    if v.get("ok").and_then(|x| x.as_bool()).unwrap_or(false) {
        println!("{} unbound {}", "✓".green(), sid.dimmed());
    } else {
        println!("{} {}", "✗".red(), v);
    }
    Ok(())
}

pub fn cmd_session_show(config_path: Option<&str>, sid: &str) -> Result<()> {
    let cfg = Config::load(config_path)?;
    let log_dir = expand_home(&cfg.log_dir);
    let session_dir = std::path::Path::new(&log_dir).join(sid);
    if !session_dir.exists() {
        println!("{} no logs for session: {}", "✗".red(), sid);
        return Ok(());
    }
    println!("{} {}", "session:".dimmed(), sid.cyan().bold());
    println!("{} {}", "log dir:".dimmed(), session_dir.display());
    let entries = std::fs::read_dir(&session_dir)?;
    let mut files: Vec<_> = entries.filter_map(|e| e.ok()).collect();
    files.sort_by_key(|e| e.file_name());
    println!("{} {} files", "events:".dimmed(), files.len());
    for f in files.iter().take(20) {
        println!("  {}", f.file_name().to_string_lossy().dimmed());
    }
    if files.len() > 20 {
        println!("  ... ({} more)", files.len() - 20);
    }
    Ok(())
}

pub fn cmd_session_tail(config_path: Option<&str>, sid: &str) -> Result<()> {
    let cfg = Config::load(config_path)?;
    let log_dir = expand_home(&cfg.log_dir);
    let session_dir = std::path::Path::new(&log_dir).join(sid);
    println!("{} use: tail -f {}/*.jsonl", "hint:".dimmed(), session_dir.display());
    Ok(())
}

pub fn cmd_logs(config_path: Option<&str>, sid: &str) -> Result<()> {
    let cfg = Config::load(config_path)?;
    let log_dir = expand_home(&cfg.log_dir);
    let session_dir = std::path::Path::new(&log_dir).join(sid);
    println!("{}", session_dir.display());
    Ok(())
}

pub fn cmd_stats_overview(config_path: Option<&str>) -> Result<()> {
    let cfg = Config::load(config_path)?;
    if !cfg.routing.memory_enabled {
        println!("{} memory is disabled in config", "✗".red());
        return Ok(());
    }
    let db_path = expand_home(&cfg.routing.memory_db_path);
    let conn = duckdb::Connection::open(&db_path)?;
    let mut stmt = conn.prepare(
        "SELECT count(*), coalesce(sum(actual_cost_usd), 0), coalesce(sum(input_tokens), 0), coalesce(sum(output_tokens), 0)
         FROM routing_log",
    )?;
    let mut rows = stmt.query([])?;
    if let Some(row) = rows.next()? {
        let n: i64 = row.get(0)?;
        let cost: f64 = row.get(1)?;
        let i_tok: i64 = row.get(2)?;
        let o_tok: i64 = row.get(3)?;
        println!("{}", "overview:".yellow().bold());
        println!("  total requests: {}", n);
        println!("  total cost:     ¥{:.4}", cost);
        println!("  input tokens:   {}", i_tok);
        println!("  output tokens:  {}", o_tok);
    }
    Ok(())
}

pub fn cmd_stats_by_profile(config_path: Option<&str>) -> Result<()> {
    let cfg = Config::load(config_path)?;
    if !cfg.routing.memory_enabled { println!("{} memory disabled", "✗".red()); return Ok(()); }
    let db_path = expand_home(&cfg.routing.memory_db_path);
    let conn = duckdb::Connection::open(&db_path)?;
    let mut stmt = conn.prepare(
        "SELECT coalesce(profile_name, ''), count(*), coalesce(sum(actual_cost_usd), 0), coalesce(avg(actual_latency_ms), 0)
         FROM routing_log GROUP BY profile_name ORDER BY count(*) DESC",
    )?;
    let mut rows = stmt.query([])?;
    println!("{:<15} {:>8} {:>12} {:>10}", "PROFILE", "COUNT", "COST_RMB", "AVG_MS");
    while let Some(row) = rows.next()? {
        let p: String = row.get(0)?;
        let c: i64 = row.get(1)?;
        let cost: f64 = row.get(2)?;
        let lat: f64 = row.get(3)?;
        let pname = if p.is_empty() { "(none)".to_string() } else { p };
        println!("{:<15} {:>8} {:>12.4} {:>10.0}", pname, c, cost, lat);
    }
    Ok(())
}

pub fn cmd_stats_by_model(config_path: Option<&str>) -> Result<()> {
    let cfg = Config::load(config_path)?;
    if !cfg.routing.memory_enabled { println!("{} memory disabled", "✗".red()); return Ok(()); }
    let db_path = expand_home(&cfg.routing.memory_db_path);
    let conn = duckdb::Connection::open(&db_path)?;
    let mut stmt = conn.prepare(
        "SELECT actual_provider || '/' || actual_model, count(*), coalesce(sum(actual_cost_usd), 0)
         FROM routing_log GROUP BY 1 ORDER BY count(*) DESC LIMIT 20",
    )?;
    let mut rows = stmt.query([])?;
    println!("{:<50} {:>8} {:>12}", "PROVIDER/MODEL", "COUNT", "COST_RMB");
    while let Some(row) = rows.next()? {
        let m: String = row.get(0)?;
        let c: i64 = row.get(1)?;
        let cost: f64 = row.get(2)?;
        println!("{:<50} {:>8} {:>12.4}", m, c, cost);
    }
    Ok(())
}

pub fn cmd_stats_by_cluster(config_path: Option<&str>, top: usize) -> Result<()> {
    let cfg = Config::load(config_path)?;
    if !cfg.routing.memory_enabled { println!("{} memory disabled", "✗".red()); return Ok(()); }
    let db_path = expand_home(&cfg.routing.memory_db_path);
    let conn = duckdb::Connection::open(&db_path)?;
    let sql = format!(
        "SELECT cluster_id, count(*), coalesce(avg(hvr_score), 0), coalesce(sum(actual_cost_usd), 0)
         FROM routing_log GROUP BY cluster_id ORDER BY count(*) DESC LIMIT {}", top);
    let mut stmt = conn.prepare(&sql)?;
    let mut rows = stmt.query([])?;
    println!("{:<12} {:>8} {:>10} {:>12}", "CLUSTER", "COUNT", "AVG_HVR", "COST_RMB");
    while let Some(row) = rows.next()? {
        let cid: i32 = row.get(0)?;
        let c: i64 = row.get(1)?;
        let hvr: f64 = row.get(2)?;
        let cost: f64 = row.get(3)?;
        println!("{:<12} {:>8} {:>10.3} {:>12.4}", cid, c, hvr, cost);
    }
    Ok(())
}

pub fn cmd_stats_hesitant(config_path: Option<&str>, limit: usize) -> Result<()> {
    let cfg = Config::load(config_path)?;
    if !cfg.routing.memory_enabled { println!("{} memory disabled", "✗".red()); return Ok(()); }
    let db_path = expand_home(&cfg.routing.memory_db_path);
    let conn = duckdb::Connection::open(&db_path)?;
    let sql = format!(
        "SELECT session_id, request_seq, actual_model, hvr_score, query_preview
         FROM routing_log WHERE hvr_gate_passed = FALSE ORDER BY hvr_score ASC LIMIT {}", limit);
    let mut stmt = conn.prepare(&sql)?;
    let mut rows = stmt.query([])?;
    println!("{:<20} {:>6} {:<30} {:>8}  PREVIEW", "SESSION", "SEQ", "MODEL", "HVR");
    while let Some(row) = rows.next()? {
        let sid: String = row.get(0)?;
        let seq: i64 = row.get(1)?;
        let mdl: String = row.get(2)?;
        let hvr: f64 = row.get(3)?;
        let prev: String = row.get(4)?;
        let sid_short: String = sid.chars().take(20).collect();
        let mdl_short: String = mdl.chars().take(30).collect();
        let prev_short: String = prev.chars().take(60).collect();
        println!("{:<20} {:>6} {:<30} {:>8.3}  {}", sid_short, seq, mdl_short, hvr, prev_short);
    }
    Ok(())
}

pub fn cmd_doctor(config_path: Option<&str>) -> Result<()> {
    println!("{}", "cc-proxy doctor".bold());
    match Config::load(config_path) {
        Ok(cfg) => {
            println!("  {} config loads OK ({} providers, {} priority entries, {} profiles)",
                "✓".green(), cfg.providers.len(), cfg.priority.len(), cfg.profiles.len());
            for p in &cfg.providers {
                let key_ok = !p.api_key.is_empty() && !p.api_key.starts_with('$');
                let label = if key_ok { "✓".green() } else { "!".yellow() };
                println!("  {} provider {}: api_key={}", label, p.name,
                    if key_ok { "set".to_string() } else { "missing/unresolved".to_string() });
            }
            let log_dir = expand_home(&cfg.log_dir);
            let exists = std::path::Path::new(&log_dir).exists();
            println!("  {} log_dir {} {}",
                if exists { "✓".green() } else { "!".yellow() },
                log_dir,
                if exists { "exists" } else { "will be created" });
            if cfg.routing.memory_enabled {
                let db = expand_home(&cfg.routing.memory_db_path);
                let exists = std::path::Path::new(&db).exists();
                println!("  {} memory db {} {}",
                    if exists { "✓".green() } else { "!".yellow() },
                    db,
                    if exists { "exists" } else { "will be created" });
            }
        }
        Err(e) => {
            println!("  {} config load failed: {}", "✗".red(), e);
        }
    }
    Ok(())
}

fn expand_home(p: &str) -> String {
    if let Some(rest) = p.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest).to_string_lossy().to_string();
        }
    }
    p.to_string()
}
