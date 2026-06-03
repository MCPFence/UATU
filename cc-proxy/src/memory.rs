use duckdb::{params, Connection};
use std::path::Path;
use std::sync::Mutex;

pub struct RoutingEntry {
    pub session_id: String,
    pub request_seq: u64,
    pub cluster_id: u32,
    pub query_preview: String,
    pub actual_provider: String,
    pub actual_model: String,
    pub actual_latency_ms: u64,
    pub actual_cost_usd: f64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub hvr_score: f64,
    pub hvr_gate_passed: bool,
    pub stop_reason: String,
    pub is_stream: bool,
    pub profile_name: String,
    pub agent_role: String,
    pub cc_version_suffix: String,

    pub msg_count: u64,
    pub tool_call_count: u64,
    pub has_code: bool,
    pub user_msg_length: u64,
    pub is_retrial: bool,
    pub strategy_version: i64,
    pub strategy_rule_id: Option<i64>,
    pub dispatch_source: String,
}

pub struct ShadowEntry {
    pub routing_log_id: i64,
    pub shadow_provider: String,
    pub shadow_model: String,
    pub shadow_latency_ms: u64,
    pub shadow_cost_usd: f64,
    pub quality_comparison: String,
    pub semantic_consistency: f64,
}

pub struct ClusterStats {
    pub cluster_id: u32,
    pub model_name: String,
    pub alpha: i32,
    pub beta: i32,
    pub total_requests: i64,
}

pub struct MemoryBank {
    conn: Mutex<Connection>,
}

impl MemoryBank {
    pub fn new(db_path: &str) -> anyhow::Result<Self> {
        if let Some(parent) = Path::new(db_path).parent() {
            std::fs::create_dir_all(parent)?;
        }

        let open_and_init = |path: &str| -> anyhow::Result<Self> {
            let conn = Connection::open(path)?;
            let bank = Self {
                conn: Mutex::new(conn),
            };
            bank.init_schema()?;
            Ok(bank)
        };

        match open_and_init(db_path) {
            Ok(bank) => Ok(bank),
            Err(first_err) => {
                let msg = first_err.to_string();

                if msg.contains("Conflicting lock") || msg.contains("Could not set lock") {
                    if let Some(pid) = Self::extract_lock_pid(&msg) {
                        if Self::is_process_alive(pid) {
                            anyhow::bail!(
                                "DuckDB is locked by a running cc-proxy (PID {pid}). \
                                 Stop it first, or set a different routing.memory_db_path."
                            );
                        }
                        anyhow::bail!(
                            "DuckDB is locked by a dead process (PID {pid}). \
                             Refusing to delete memory DB automatically; recover or remove stale lock files manually."
                        );
                    }
                }

                // WAL corruption: try removing the WAL and reopening
                let wal_path = format!("{}.wal", db_path);
                if Path::new(&wal_path).exists() && (
                    msg.contains("WAL") || msg.contains("INTERNAL") ||
                    msg.contains("assertion") || msg.contains("Failure while replaying")
                ) {
                    eprintln!("  WARNING: DuckDB WAL appears corrupted, attempting recovery...");
                    eprintln!("  WARNING: Backing up WAL to {}.corrupted", wal_path);
                    let _ = std::fs::rename(&wal_path, format!("{}.corrupted", wal_path));

                    match open_and_init(db_path) {
                        Ok(bank) => {
                            eprintln!("  WARNING: Recovery successful. Recent uncommitted writes may be lost.");
                            return Ok(bank);
                        }
                        Err(second_err) => {
                            anyhow::bail!(
                                "DuckDB recovery failed after WAL removal: {second_err} (original: {first_err})"
                            );
                        }
                    }
                }

                anyhow::bail!(
                    "DuckDB open failed; refusing to wipe memory DB automatically: {first_err}"
                )
            }
        }
    }

    fn extract_lock_pid(err: &str) -> Option<u32> {
        err.find("PID ")
            .and_then(|start| {
                let after = &err[start + 4..];
                let end = after.find(')').unwrap_or(after.len());
                after[..end].trim().parse().ok()
            })
    }

    fn is_process_alive(_pid: u32) -> bool {
        #[cfg(unix)]
        { unsafe { libc::kill(_pid as i32, 0) == 0 } }
        #[cfg(not(unix))]
        { false }
    }

    fn init_schema(&self) -> anyhow::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute_batch(
            "CREATE SEQUENCE IF NOT EXISTS routing_log_seq START 1;
             CREATE TABLE IF NOT EXISTS routing_log (
                 id BIGINT DEFAULT nextval('routing_log_seq') PRIMARY KEY,
                 timestamp TIMESTAMP DEFAULT current_timestamp,
                 session_id VARCHAR,
                 request_seq BIGINT,
                 cluster_id INTEGER,
                 query_preview VARCHAR,
                 actual_provider VARCHAR,
                 actual_model VARCHAR,
                 actual_latency_ms BIGINT,
                 actual_cost_usd DOUBLE,
                 input_tokens BIGINT,
                 output_tokens BIGINT,
                 hvr_score DOUBLE,
                 hvr_gate_passed BOOLEAN,
                 stop_reason VARCHAR,
                 is_stream BOOLEAN
             );
             CREATE SEQUENCE IF NOT EXISTS shadow_seq START 1;
             CREATE TABLE IF NOT EXISTS shadow_verification (
                 id BIGINT DEFAULT nextval('shadow_seq') PRIMARY KEY,
                 routing_log_id BIGINT,
                 shadow_provider VARCHAR,
                 shadow_model VARCHAR,
                 shadow_latency_ms BIGINT,
                 shadow_cost_usd DOUBLE,
                 quality_comparison VARCHAR,
                 semantic_consistency DOUBLE,
                 timestamp TIMESTAMP DEFAULT current_timestamp
             );
             CREATE TABLE IF NOT EXISTS cluster_reputation (
                 cluster_id INTEGER,
                 model_name VARCHAR,
                 alpha INTEGER DEFAULT 1,
                 beta INTEGER DEFAULT 1,
                 total_requests INTEGER DEFAULT 0,
                 last_updated TIMESTAMP DEFAULT current_timestamp,
                 PRIMARY KEY (cluster_id, model_name)
             );
             CREATE SEQUENCE IF NOT EXISTS strategy_seq START 1;
             CREATE TABLE IF NOT EXISTS routing_strategy (
                 id BIGINT DEFAULT nextval('strategy_seq') PRIMARY KEY,
                 version BIGINT NOT NULL,
                 updated_at TIMESTAMP DEFAULT current_timestamp,
                 cluster_id INTEGER,
                 agent_role VARCHAR,
                 model_pattern VARCHAR,
                 cel_expr VARCHAR,
                 profile VARCHAR,
                 weighted VARCHAR,
                 confidence DOUBLE DEFAULT 1.0,
                 source VARCHAR DEFAULT 'manual',
                 is_exploration BOOLEAN DEFAULT FALSE,
                 exploration_budget INTEGER DEFAULT 0,
                 priority_order INTEGER DEFAULT 100,
                 enabled BOOLEAN DEFAULT TRUE
             );",
        )?;
        let migration_sql = [
            "ALTER TABLE routing_log ADD COLUMN IF NOT EXISTS profile_name VARCHAR DEFAULT ''",
            "ALTER TABLE routing_log ADD COLUMN IF NOT EXISTS agent_role VARCHAR DEFAULT ''",
            "ALTER TABLE routing_log ADD COLUMN IF NOT EXISTS cc_version_suffix VARCHAR DEFAULT ''",
            "ALTER TABLE routing_log ADD COLUMN IF NOT EXISTS msg_count BIGINT DEFAULT 0",
            "ALTER TABLE routing_log ADD COLUMN IF NOT EXISTS tool_call_count BIGINT DEFAULT 0",
            "ALTER TABLE routing_log ADD COLUMN IF NOT EXISTS has_code BOOLEAN DEFAULT FALSE",
            "ALTER TABLE routing_log ADD COLUMN IF NOT EXISTS user_msg_length BIGINT DEFAULT 0",
            "ALTER TABLE routing_log ADD COLUMN IF NOT EXISTS is_retrial BOOLEAN DEFAULT FALSE",
            "ALTER TABLE routing_log ADD COLUMN IF NOT EXISTS strategy_version BIGINT DEFAULT 0",
            "ALTER TABLE routing_log ADD COLUMN IF NOT EXISTS strategy_rule_id BIGINT",
            "ALTER TABLE routing_log ADD COLUMN IF NOT EXISTS dispatch_source VARCHAR DEFAULT 'local'",
            "ALTER TABLE routing_strategy ADD COLUMN IF NOT EXISTS session_id VARCHAR",
            "ALTER TABLE routing_strategy ADD COLUMN IF NOT EXISTS cc_entrypoint VARCHAR",
            "ALTER TABLE routing_log ADD COLUMN IF NOT EXISTS cache_read_tokens BIGINT DEFAULT 0",
        ];
        for sql in migration_sql {
            let _ = conn.execute(sql, []);
        }
        Ok(())
    }

    pub fn log_routing(&self, entry: &RoutingEntry) -> anyhow::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO routing_log (
                session_id, request_seq, cluster_id, query_preview,
                actual_provider, actual_model, actual_latency_ms, actual_cost_usd,
                input_tokens, output_tokens, cache_read_tokens, hvr_score, hvr_gate_passed,
                stop_reason, is_stream, profile_name, agent_role, cc_version_suffix,
                msg_count, tool_call_count, has_code, user_msg_length,
                is_retrial, strategy_version, strategy_rule_id, dispatch_source
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                entry.session_id,
                entry.request_seq as i64,
                entry.cluster_id as i32,
                entry.query_preview,
                entry.actual_provider,
                entry.actual_model,
                entry.actual_latency_ms as i64,
                entry.actual_cost_usd,
                entry.input_tokens as i64,
                entry.output_tokens as i64,
                entry.cache_read_tokens as i64,
                entry.hvr_score,
                entry.hvr_gate_passed,
                entry.stop_reason,
                entry.is_stream,
                entry.profile_name,
                entry.agent_role,
                entry.cc_version_suffix,
                entry.msg_count as i64,
                entry.tool_call_count as i64,
                entry.has_code,
                entry.user_msg_length as i64,
                entry.is_retrial,
                entry.strategy_version,
                entry.strategy_rule_id,
                entry.dispatch_source,
            ],
        )?;
        Ok(())
    }

    pub fn log_shadow_verification(&self, entry: &ShadowEntry) -> anyhow::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO shadow_verification (
                routing_log_id, shadow_provider, shadow_model,
                shadow_latency_ms, shadow_cost_usd,
                quality_comparison, semantic_consistency
             ) VALUES (?, ?, ?, ?, ?, ?, ?)",
            params![
                entry.routing_log_id,
                entry.shadow_provider,
                entry.shadow_model,
                entry.shadow_latency_ms as i64,
                entry.shadow_cost_usd,
                entry.quality_comparison,
                entry.semantic_consistency,
            ],
        )?;
        Ok(())
    }

    pub fn get_cluster_stats(&self, cluster_id: u32, model_name: &str) -> anyhow::Result<Option<ClusterStats>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT cluster_id, model_name, alpha, beta, total_requests
             FROM cluster_reputation
             WHERE cluster_id = ? AND model_name = ?",
        )?;
        let mut rows = stmt.query(params![cluster_id as i32, model_name])?;
        if let Some(row) = rows.next()? {
            Ok(Some(ClusterStats {
                cluster_id: row.get::<_, i32>(0)? as u32,
                model_name: row.get(1)?,
                alpha: row.get(2)?,
                beta: row.get(3)?,
                total_requests: row.get(4)?,
            }))
        } else {
            Ok(None)
        }
    }

    pub fn update_reputation(
        &self,
        cluster_id: u32,
        model_name: &str,
        success: bool,
    ) -> anyhow::Result<()> {
        let conn = self.conn.lock().unwrap();
        let (alpha_inc, beta_inc): (i32, i32) = if success { (1, 0) } else { (0, 1) };

        let exists: bool = {
            let mut stmt = conn.prepare(
                "SELECT 1 FROM cluster_reputation WHERE cluster_id = ? AND model_name = ?",
            )?;
            let mut rows = stmt.query(params![cluster_id as i32, model_name])?;
            rows.next()?.is_some()
        };

        if exists {
            conn.execute(
                "UPDATE cluster_reputation SET
                     alpha = alpha + ?,
                     beta = beta + ?,
                     total_requests = total_requests + 1
                 WHERE cluster_id = ? AND model_name = ?",
                params![alpha_inc, beta_inc, cluster_id as i32, model_name],
            )?;
        } else {
            conn.execute(
                "INSERT INTO cluster_reputation (cluster_id, model_name, alpha, beta, total_requests)
                 VALUES (?, ?, ?, ?, 1)",
                params![
                    cluster_id as i32,
                    model_name,
                    1 + alpha_inc,
                    1 + beta_inc,
                ],
            )?;
        }
        Ok(())
    }

    pub fn load_strategies(&self) -> anyhow::Result<Vec<crate::strategy::StrategyRow>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, version, cluster_id, agent_role, model_pattern,
                    cel_expr, profile, weighted, confidence, source,
                    is_exploration, exploration_budget, enabled, session_id, cc_entrypoint
             FROM routing_strategy
             WHERE enabled = TRUE
             ORDER BY priority_order ASC, id ASC",
        )?;
        let mut rows = stmt.query([])?;
        let mut result = Vec::new();
        while let Some(row) = rows.next()? {
            result.push(crate::strategy::StrategyRow {
                id: row.get(0)?,
                version: row.get(1)?,
                cluster_id: row.get::<_, Option<i32>>(2)?.map(|v| v as u32),
                agent_role: row.get(3)?,
                model_pattern: row.get(4)?,
                cel_expr: row.get(5)?,
                profile: row.get(6)?,
                weighted: row.get(7)?,
                confidence: row.get(8)?,
                source: row.get(9)?,
                is_exploration: row.get(10)?,
                exploration_budget: row.get(11)?,
                enabled: row.get(12)?,
                session_id: row.get(13)?,
                cc_entrypoint: row.get(14)?,
            });
        }
        Ok(result)
    }

    pub fn strategy_max_version(&self) -> anyhow::Result<i64> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT COALESCE(MAX(version), 0) FROM routing_strategy")?;
        let mut rows = stmt.query([])?;
        if let Some(row) = rows.next()? {
            Ok(row.get(0)?)
        } else {
            Ok(0)
        }
    }

    pub fn routing_count(&self) -> anyhow::Result<i64> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT count(*) FROM routing_log")?;
        let mut rows = stmt.query([])?;
        if let Some(row) = rows.next()? {
            Ok(row.get(0)?)
        } else {
            Ok(0)
        }
    }

    pub fn list_all_strategies(&self) -> anyhow::Result<Vec<serde_json::Value>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, version, CAST(updated_at AS VARCHAR), cluster_id, agent_role, model_pattern,
                    cel_expr, profile, weighted, confidence, source,
                    is_exploration, exploration_budget, priority_order, enabled, session_id, cc_entrypoint
             FROM routing_strategy
             ORDER BY priority_order ASC, id ASC",
        )?;
        let mut rows = stmt.query([])?;
        let mut result = Vec::new();
        while let Some(row) = rows.next()? {
            result.push(serde_json::json!({
                "id": row.get::<_, i64>(0)?,
                "version": row.get::<_, i64>(1)?,
                "updated_at": row.get::<_, Option<String>>(2)?,
                "cluster_id": row.get::<_, Option<i32>>(3)?,
                "agent_role": row.get::<_, Option<String>>(4)?,
                "model_pattern": row.get::<_, Option<String>>(5)?,
                "cel_expr": row.get::<_, Option<String>>(6)?,
                "profile": row.get::<_, Option<String>>(7)?,
                "weighted": row.get::<_, Option<String>>(8)?,
                "confidence": row.get::<_, f64>(9)?,
                "source": row.get::<_, Option<String>>(10)?,
                "is_exploration": row.get::<_, bool>(11)?,
                "exploration_budget": row.get::<_, i32>(12)?,
                "priority_order": row.get::<_, i32>(13)?,
                "enabled": row.get::<_, bool>(14)?,
                "session_id": row.get::<_, Option<String>>(15)?,
                "cc_entrypoint": row.get::<_, Option<String>>(16)?,
            }));
        }
        Ok(result)
    }

    pub fn get_strategy_by_id(&self, id: i64) -> anyhow::Result<Option<serde_json::Value>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, version, CAST(updated_at AS VARCHAR), cluster_id, agent_role, model_pattern,
                    cel_expr, profile, weighted, confidence, source,
                    is_exploration, exploration_budget, priority_order, enabled, session_id, cc_entrypoint
             FROM routing_strategy WHERE id = ?",
        )?;
        let mut rows = stmt.query(params![id])?;
        if let Some(row) = rows.next()? {
            Ok(Some(serde_json::json!({
                "id": row.get::<_, i64>(0)?,
                "version": row.get::<_, i64>(1)?,
                "updated_at": row.get::<_, Option<String>>(2)?,
                "cluster_id": row.get::<_, Option<i32>>(3)?,
                "agent_role": row.get::<_, Option<String>>(4)?,
                "model_pattern": row.get::<_, Option<String>>(5)?,
                "cel_expr": row.get::<_, Option<String>>(6)?,
                "profile": row.get::<_, Option<String>>(7)?,
                "weighted": row.get::<_, Option<String>>(8)?,
                "confidence": row.get::<_, f64>(9)?,
                "source": row.get::<_, Option<String>>(10)?,
                "is_exploration": row.get::<_, bool>(11)?,
                "exploration_budget": row.get::<_, i32>(12)?,
                "priority_order": row.get::<_, i32>(13)?,
                "enabled": row.get::<_, bool>(14)?,
                "session_id": row.get::<_, Option<String>>(15)?,
                "cc_entrypoint": row.get::<_, Option<String>>(16)?,
            })))
        } else {
            Ok(None)
        }
    }

    pub fn create_strategy_row(&self, fields: &serde_json::Value) -> anyhow::Result<serde_json::Value> {
        let conn = self.conn.lock().unwrap();
        let version = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        conn.execute(
            "INSERT INTO routing_strategy
             (version, cluster_id, agent_role, model_pattern, cel_expr,
              profile, weighted, confidence, source,
              is_exploration, exploration_budget, priority_order, enabled, session_id, cc_entrypoint)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                version,
                fields.get("cluster_id").and_then(|v| v.as_i64()).map(|v| v as i32),
                fields.get("agent_role").and_then(|v| v.as_str()),
                fields.get("model_pattern").and_then(|v| v.as_str()),
                fields.get("cel_expr").and_then(|v| v.as_str()),
                fields.get("profile").and_then(|v| v.as_str()),
                fields.get("weighted").and_then(|v| v.as_str()),
                fields.get("confidence").and_then(|v| v.as_f64()).unwrap_or(1.0),
                fields.get("source").and_then(|v| v.as_str()).unwrap_or("manual"),
                fields.get("is_exploration").and_then(|v| v.as_bool()).unwrap_or(false),
                fields.get("exploration_budget").and_then(|v| v.as_i64()).unwrap_or(0) as i32,
                fields.get("priority_order").and_then(|v| v.as_i64()).unwrap_or(100) as i32,
                fields.get("enabled").and_then(|v| v.as_bool()).unwrap_or(true),
                fields.get("session_id").and_then(|v| v.as_str()),
                fields.get("cc_entrypoint").and_then(|v| v.as_str()),
            ],
        )?;
        let mut stmt = conn.prepare(
            "SELECT id, version, CAST(updated_at AS VARCHAR), cluster_id, agent_role, model_pattern,
                    cel_expr, profile, weighted, confidence, source,
                    is_exploration, exploration_budget, priority_order, enabled, session_id, cc_entrypoint
             FROM routing_strategy WHERE version = ? ORDER BY id DESC LIMIT 1",
        )?;
        let mut rows = stmt.query(params![version])?;
        if let Some(row) = rows.next()? {
            Ok(serde_json::json!({
                "id": row.get::<_, i64>(0)?,
                "version": row.get::<_, i64>(1)?,
                "updated_at": row.get::<_, Option<String>>(2)?,
                "cluster_id": row.get::<_, Option<i32>>(3)?,
                "agent_role": row.get::<_, Option<String>>(4)?,
                "model_pattern": row.get::<_, Option<String>>(5)?,
                "cel_expr": row.get::<_, Option<String>>(6)?,
                "profile": row.get::<_, Option<String>>(7)?,
                "weighted": row.get::<_, Option<String>>(8)?,
                "confidence": row.get::<_, f64>(9)?,
                "source": row.get::<_, Option<String>>(10)?,
                "is_exploration": row.get::<_, bool>(11)?,
                "exploration_budget": row.get::<_, i32>(12)?,
                "priority_order": row.get::<_, i32>(13)?,
                "enabled": row.get::<_, bool>(14)?,
                "session_id": row.get::<_, Option<String>>(15)?,
                "cc_entrypoint": row.get::<_, Option<String>>(16)?,
            }))
        } else {
            anyhow::bail!("Failed to read back inserted strategy")
        }
    }

    pub fn update_strategy_row(&self, id: i64, fields: &serde_json::Value) -> anyhow::Result<Option<serde_json::Value>> {
        let conn = self.conn.lock().unwrap();
        let version = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;

        let allowed: &[&str] = &[
            "cluster_id", "agent_role", "model_pattern", "cel_expr",
            "profile", "weighted", "confidence", "source",
            "is_exploration", "exploration_budget", "priority_order", "enabled", "session_id",
            "cc_entrypoint",
        ];
        let mut set_parts: Vec<String> = vec!["version = ?".into(), "updated_at = current_timestamp".into()];
        let mut param_values: Vec<Box<dyn duckdb::ToSql>> = vec![Box::new(version)];

        for key in allowed {
            if let Some(val) = fields.get(key) {
                set_parts.push(format!("{} = ?", key));
                match *key {
                    "cluster_id" | "exploration_budget" | "priority_order" => {
                        param_values.push(Box::new(val.as_i64().map(|v| v as i32)));
                    }
                    "confidence" => {
                        param_values.push(Box::new(val.as_f64()));
                    }
                    "is_exploration" | "enabled" => {
                        param_values.push(Box::new(val.as_bool()));
                    }
                    _ => {
                        param_values.push(Box::new(val.as_str().map(|s| s.to_string())));
                    }
                }
            }
        }

        if set_parts.len() == 2 {
            drop(conn);
            return self.get_strategy_by_id(id);
        }

        param_values.push(Box::new(id));
        let sql = format!(
            "UPDATE routing_strategy SET {} WHERE id = ?",
            set_parts.join(", ")
        );
        let params_ref: Vec<&dyn duckdb::ToSql> = param_values.iter().map(|b| b.as_ref()).collect();
        conn.execute(&sql, params_ref.as_slice())?;
        drop(conn);
        self.get_strategy_by_id(id)
    }

    pub fn delete_strategy_row(&self, id: i64) -> anyhow::Result<bool> {
        let conn = self.conn.lock().unwrap();
        let count: i64 = {
            let mut stmt = conn.prepare("SELECT COUNT(*) FROM routing_strategy WHERE id = ?")?;
            let mut rows = stmt.query(params![id])?;
            rows.next()?.map(|r| r.get(0).unwrap_or(0)).unwrap_or(0)
        };
        if count == 0 {
            return Ok(false);
        }
        conn.execute("DELETE FROM routing_strategy WHERE id = ?", params![id])?;
        Ok(true)
    }

    pub fn list_routing_log(&self, limit: i64, offset: i64) -> anyhow::Result<(Vec<serde_json::Value>, i64)> {
        let conn = self.conn.lock().unwrap();
        let total: i64 = {
            let mut stmt = conn.prepare("SELECT count(*) FROM routing_log")?;
            let mut rows = stmt.query([])?;
            rows.next()?.map(|r| r.get(0).unwrap_or(0)).unwrap_or(0)
        };
        let mut stmt = conn.prepare(
            "SELECT id, CAST(timestamp AS VARCHAR), session_id, request_seq, cluster_id, query_preview,
                    actual_provider, actual_model, actual_latency_ms, actual_cost_usd,
                    input_tokens, output_tokens, hvr_score, hvr_gate_passed,
                    stop_reason, is_stream, profile_name, agent_role,
                    strategy_version, strategy_rule_id, dispatch_source
             FROM routing_log ORDER BY id DESC LIMIT ? OFFSET ?",
        )?;
        let mut rows = stmt.query(params![limit, offset])?;
        let mut result = Vec::new();
        while let Some(row) = rows.next()? {
            result.push(serde_json::json!({
                "id": row.get::<_, i64>(0)?,
                "timestamp": row.get::<_, Option<String>>(1)?,
                "session_id": row.get::<_, Option<String>>(2)?,
                "request_seq": row.get::<_, i64>(3)?,
                "cluster_id": row.get::<_, i32>(4)?,
                "query_preview": row.get::<_, Option<String>>(5)?,
                "actual_provider": row.get::<_, Option<String>>(6)?,
                "actual_model": row.get::<_, Option<String>>(7)?,
                "actual_latency_ms": row.get::<_, i64>(8)?,
                "actual_cost_usd": row.get::<_, f64>(9)?,
                "input_tokens": row.get::<_, i64>(10)?,
                "output_tokens": row.get::<_, i64>(11)?,
                "hvr_score": row.get::<_, f64>(12)?,
                "hvr_gate_passed": row.get::<_, bool>(13)?,
                "stop_reason": row.get::<_, Option<String>>(14)?,
                "is_stream": row.get::<_, bool>(15)?,
                "profile_name": row.get::<_, Option<String>>(16)?,
                "agent_role": row.get::<_, Option<String>>(17)?,
                "strategy_version": row.get::<_, i64>(18)?,
                "strategy_rule_id": row.get::<_, Option<i64>>(19)?,
                "dispatch_source": row.get::<_, Option<String>>(20)?,
            }));
        }
        Ok((result, total))
    }

    pub fn list_reputation(&self) -> anyhow::Result<Vec<serde_json::Value>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT cluster_id, model_name, alpha, beta, total_requests, CAST(last_updated AS VARCHAR)
             FROM cluster_reputation ORDER BY cluster_id, model_name",
        )?;
        let mut rows = stmt.query([])?;
        let mut result = Vec::new();
        while let Some(row) = rows.next()? {
            result.push(serde_json::json!({
                "cluster_id": row.get::<_, i32>(0)?,
                "model_name": row.get::<_, String>(1)?,
                "alpha": row.get::<_, i32>(2)?,
                "beta": row.get::<_, i32>(3)?,
                "total_requests": row.get::<_, i64>(4)?,
                "last_updated": row.get::<_, Option<String>>(5)?,
            }));
        }
        Ok(result)
    }

    pub fn checkpoint(&self) -> anyhow::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute_batch("CHECKPOINT")?;
        Ok(())
    }
}

unsafe impl Send for MemoryBank {}
unsafe impl Sync for MemoryBank {}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_bank() -> MemoryBank {
        MemoryBank::new(":memory:").unwrap()
    }

    fn sample_entry() -> RoutingEntry {
        RoutingEntry {
            session_id: "sess-1".into(),
            request_seq: 1,
            cluster_id: 42,
            query_preview: "Hello world".into(),
            actual_provider: "anthropic".into(),
            actual_model: "claude-opus-4".into(),
            actual_latency_ms: 1200,
            actual_cost_usd: 0.015,
            input_tokens: 100,
            output_tokens: 50,
            cache_read_tokens: 0,
            hvr_score: 0.95,
            hvr_gate_passed: true,
            stop_reason: "end_turn".into(),
            is_stream: false,
            profile_name: "premium".into(),
            agent_role: "main".into(),
            cc_version_suffix: "437".into(),
            msg_count: 5,
            tool_call_count: 2,
            has_code: true,
            user_msg_length: 120,
            is_retrial: false,
            strategy_version: 1,
            strategy_rule_id: Some(10),
            dispatch_source: "strategy".into(),
        }
    }

    #[test]
    fn test_log_and_count() {
        let bank = test_bank();
        assert_eq!(bank.routing_count().unwrap(), 0);
        bank.log_routing(&sample_entry()).unwrap();
        assert_eq!(bank.routing_count().unwrap(), 1);
        bank.log_routing(&sample_entry()).unwrap();
        assert_eq!(bank.routing_count().unwrap(), 2);
    }

    #[test]
    fn test_reputation_update() {
        let bank = test_bank();
        bank.update_reputation(42, "claude-opus-4", true).unwrap();
        let stats = bank.get_cluster_stats(42, "claude-opus-4").unwrap().unwrap();
        assert_eq!(stats.alpha, 2); // 1 (default) + 1
        assert_eq!(stats.beta, 1);  // 1 (default) + 0
        assert_eq!(stats.total_requests, 1);

        bank.update_reputation(42, "claude-opus-4", false).unwrap();
        let stats = bank.get_cluster_stats(42, "claude-opus-4").unwrap().unwrap();
        assert_eq!(stats.alpha, 2);
        assert_eq!(stats.beta, 2);
        assert_eq!(stats.total_requests, 2);
    }

    #[test]
    fn test_no_stats_for_unknown() {
        let bank = test_bank();
        assert!(bank.get_cluster_stats(999, "unknown").unwrap().is_none());
    }

    #[test]
    fn test_open_failure_does_not_delete_db_file() {
        let path = std::env::temp_dir().join(format!(
            "cc-proxy-bad-memory-{}.duckdb",
            std::process::id()
        ));
        std::fs::write(&path, b"not a duckdb database").unwrap();

        let result = MemoryBank::new(path.to_str().unwrap());

        assert!(result.is_err());
        assert!(path.exists());
        let contents = std::fs::read(&path).unwrap();
        assert_eq!(contents, b"not a duckdb database");
        let _ = std::fs::remove_file(path);
    }
}
