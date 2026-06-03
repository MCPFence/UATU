use crate::memory::MemoryBank;
use crate::signals::RequestSignals;
use crate::config::PriorityEntry;
use arc_swap::ArcSwap;
use std::collections::HashMap;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;

pub struct StrategyResult {
    pub profile: String,
    pub rule_id: i64,
    pub confidence: f64,
    pub source: String,
    pub is_exploration: bool,
}

pub struct StrategyMatch {
    pub cluster_id: Option<u32>,
    pub agent_role: Option<String>,
    pub model_pattern: Option<String>,
    pub session_id: Option<String>,
    pub cc_entrypoint: Option<String>,
}

pub enum StrategyAction {
    Direct(String),
    Weighted(Vec<WeightedProfile>),
}

pub struct WeightedProfile {
    pub profile: String,
    pub weight: u32,
}

pub struct StrategyRule {
    pub id: i64,
    pub match_cond: Option<StrategyMatch>,
    pub cel_expr_src: Option<String>,
    pub cel_program: Option<cel_interpreter::Program>,
    pub action: StrategyAction,
    pub confidence: f64,
    pub source: String,
    pub is_exploration: bool,
    pub exploration_budget: AtomicI64,
    pub enabled: bool,
}

pub struct StrategyCache {
    pub(crate) rules: ArcSwap<Vec<Arc<StrategyRule>>>,
    pub(crate) version: AtomicI64,
}

unsafe impl Send for StrategyCache {}
unsafe impl Sync for StrategyCache {}

impl StrategyCache {
    pub fn empty() -> Self {
        Self {
            rules: ArcSwap::new(Arc::new(Vec::new())),
            version: AtomicI64::new(0),
        }
    }

    pub fn from_rules(rules: Vec<StrategyRule>) -> Self {
        let version = rules.iter().map(|r| r.id).max().unwrap_or(0);
        let rules: Vec<Arc<StrategyRule>> = rules.into_iter().map(Arc::new).collect();
        Self {
            rules: ArcSwap::new(Arc::new(rules)),
            version: AtomicI64::new(version),
        }
    }

    pub fn load_from_db(db: &MemoryBank) -> anyhow::Result<Self> {
        let rows = db.load_strategies()?;
        let mut rules = Vec::new();
        for row in rows {
            let cel_program = row.cel_expr.as_ref().and_then(|expr| {
                match cel_interpreter::Program::compile(expr) {
                    Ok(prog) => Some(prog),
                    Err(e) => {
                        tracing::warn!("Strategy rule {} has invalid CEL expr: {e}", row.id);
                        None
                    }
                }
            });

            let action = if let Some(ref weighted_json) = row.weighted {
                match serde_json::from_str::<Vec<WeightedEntry>>(weighted_json) {
                    Ok(entries) => {
                        let ws = entries
                            .into_iter()
                            .map(|e| WeightedProfile {
                                profile: e.profile,
                                weight: e.weight,
                            })
                            .collect();
                        StrategyAction::Weighted(ws)
                    }
                    Err(_) => StrategyAction::Direct(row.profile.clone().unwrap_or_default()),
                }
            } else {
                StrategyAction::Direct(row.profile.clone().unwrap_or_default())
            };

            let match_cond = if row.cluster_id.is_some()
                || row.agent_role.is_some()
                || row.model_pattern.is_some()
                || row.session_id.is_some()
                || row.cc_entrypoint.is_some()
            {
                Some(StrategyMatch {
                    cluster_id: row.cluster_id,
                    agent_role: row.agent_role,
                    model_pattern: row.model_pattern,
                    session_id: row.session_id,
                    cc_entrypoint: row.cc_entrypoint,
                })
            } else {
                None
            };

            rules.push(Arc::new(StrategyRule {
                id: row.id,
                match_cond,
                cel_expr_src: row.cel_expr,
                cel_program,
                action,
                confidence: row.confidence,
                source: row.source,
                is_exploration: row.is_exploration,
                exploration_budget: AtomicI64::new(row.exploration_budget as i64),
                enabled: row.enabled,
            }));
        }
        let version = rules.iter().map(|r| r.id).max().unwrap_or(0);
        Ok(Self {
            rules: ArcSwap::new(Arc::new(rules)),
            version: AtomicI64::new(version),
        })
    }

    pub fn refresh(&self, db: &MemoryBank) -> bool {
        let current_version = self.version.load(Ordering::Relaxed);
        let latest = db.strategy_max_version().unwrap_or(0);
        if latest <= current_version {
            return false;
        }
        match Self::load_from_db(db) {
            Ok(new_cache) => {
                let new_rules = new_cache.rules.load();
                self.rules.store(Arc::clone(&new_rules));
                self.version.store(latest, Ordering::Relaxed);
                true
            }
            Err(e) => {
                tracing::warn!("Failed to refresh strategy: {e}");
                false
            }
        }
    }

    pub fn version(&self) -> i64 {
        self.version.load(Ordering::Relaxed)
    }

    pub fn evaluate(
        &self,
        signals: &RequestSignals,
        profiles: &HashMap<String, Vec<PriorityEntry>>,
    ) -> Option<StrategyResult> {
        let rules = self.rules.load();
        let mut tried = 0u32;
        for rule in rules.iter() {
            if !rule.enabled {
                continue;
            }
            tried += 1;

            if let Some(ref m) = rule.match_cond {
                if !field_matches(m, signals) {
                    continue;
                }
            }

            if let Some(ref prog) = rule.cel_program {
                let cel_ctx = signals.to_cel_context();
                let mut context = cel_interpreter::Context::default();
                for (k, v) in &cel_ctx {
                    context.add_variable_from_value(k, v.clone());
                }
                match prog.execute(&context) {
                    Ok(cel_interpreter::Value::Bool(true)) => {}
                    _ => continue,
                }
            }

            if rule.match_cond.is_none() && rule.cel_program.is_none() {
                continue;
            }

            let profile = match &rule.action {
                StrategyAction::Direct(p) => {
                    if !profiles.contains_key(p) {
                        continue;
                    }
                    p.clone()
                }
                StrategyAction::Weighted(ws) => {
                    let selected = weighted_select(ws);
                    if !profiles.contains_key(&selected) {
                        continue;
                    }
                    selected
                }
            };

            if rule.is_exploration {
                let remaining = rule.exploration_budget.fetch_sub(1, Ordering::Relaxed);
                if remaining <= 0 {
                    rule.exploration_budget.store(0, Ordering::Relaxed);
                    continue;
                }
            }

            return Some(StrategyResult {
                profile,
                rule_id: rule.id,
                confidence: rule.confidence,
                source: rule.source.clone(),
                is_exploration: rule.is_exploration,
            });
        }
        if tried > 0 {
            tracing::debug!(
                "strategy evaluate: no match (tried {} enabled rules, role={} model={})",
                tried, signals.agent_role_str, signals.model
            );
        }
        None
    }
}

fn field_matches(m: &StrategyMatch, signals: &RequestSignals) -> bool {
    if let Some(cid) = m.cluster_id {
        if cid != signals.cluster_id {
            tracing::debug!(
                "strategy field_matches: cluster_id mismatch rule={} signal={}",
                cid, signals.cluster_id
            );
            return false;
        }
    }
    if let Some(ref role) = m.agent_role {
        let role_lower = role.to_lowercase();
        if role_lower != signals.agent_role_str && role_lower != signals.agent_role_family {
            tracing::debug!(
                "strategy field_matches: agent_role mismatch rule={} signal_str={} signal_family={}",
                role_lower, signals.agent_role_str, signals.agent_role_family
            );
            return false;
        }
    }
    if let Some(ref pattern) = m.model_pattern {
        if !signals.model.to_lowercase().contains(&pattern.to_lowercase()) {
            tracing::debug!(
                "strategy field_matches: model_pattern mismatch rule={} signal={}",
                pattern, signals.model
            );
            return false;
        }
    }
    if let Some(ref sid) = m.session_id {
        if sid != &signals.session_id {
            tracing::debug!(
                "strategy field_matches: session_id mismatch rule={} signal={}",
                sid, signals.session_id
            );
            return false;
        }
    }
    if let Some(ref ep) = m.cc_entrypoint {
        match &signals.cc_entrypoint {
            Some(actual) => {
                if !actual.to_lowercase().contains(&ep.to_lowercase()) {
                    tracing::debug!(
                        "strategy field_matches: cc_entrypoint mismatch rule={} signal={}",
                        ep, actual
                    );
                    return false;
                }
            }
            None => {
                tracing::debug!(
                    "strategy field_matches: cc_entrypoint mismatch rule={} signal=None",
                    ep
                );
                return false;
            }
        }
    }
    true
}

fn weighted_select(weights: &[WeightedProfile]) -> String {
    use rand::Rng;
    let total: u32 = weights.iter().map(|w| w.weight).sum();
    if total == 0 {
        return weights.first().map(|w| w.profile.clone()).unwrap_or_default();
    }
    let mut rng = rand::thread_rng();
    let roll = rng.gen_range(0..total);
    let mut acc = 0;
    for w in weights {
        acc += w.weight;
        if roll < acc {
            return w.profile.clone();
        }
    }
    weights.last().map(|w| w.profile.clone()).unwrap_or_default()
}

#[derive(serde::Deserialize)]
struct WeightedEntry {
    profile: String,
    weight: u32,
}

pub struct StrategyRow {
    pub id: i64,
    pub version: i64,
    pub cluster_id: Option<u32>,
    pub agent_role: Option<String>,
    pub model_pattern: Option<String>,
    pub cel_expr: Option<String>,
    pub profile: Option<String>,
    pub weighted: Option<String>,
    pub confidence: f64,
    pub source: String,
    pub is_exploration: bool,
    pub exploration_budget: i32,
    pub enabled: bool,
    pub session_id: Option<String>,
    pub cc_entrypoint: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_signals(model: &str, agent_role: &str, msg_count: u64) -> RequestSignals {
        let role = crate::agent_role::AgentRole::from_str_loose(agent_role);
        let family = role.family().to_string();
        let tool_cat = role.tool_category().map(String::from);
        let is_main = role.is_main();
        let is_subagent = role.is_subagent();
        let is_sidequery = role.is_sidequery();
        let is_ir = role.is_independently_routable();
        RequestSignals {
            model: model.to_string(),
            session_id: "test-sess".to_string(),
            agent_role: role,
            agent_role_str: agent_role.to_string(),
            agent_role_family: family,
            tool_category: tool_cat,
            cc_version_suffix: None,
            cc_entrypoint: None,
            cluster_id: 42,
            msg_count,
            tool_call_count: 0,
            has_code: false,
            has_tools: false,
            user_msg_length: 10,
            user_word_count: 2,
            is_stream: false,
            is_retrial: false,
            is_main,
            is_subagent,
            is_sidequery,
            is_independently_routable: is_ir,
        }
    }

    fn make_profiles() -> HashMap<String, Vec<PriorityEntry>> {
        let mut m = HashMap::new();
        m.insert("premium".to_string(), vec![PriorityEntry { provider: "a".into(), model: "m".into() }]);
        m.insert("cheap".to_string(), vec![PriorityEntry { provider: "b".into(), model: "n".into() }]);
        m.insert("balanced".to_string(), vec![PriorityEntry { provider: "c".into(), model: "o".into() }]);
        m
    }

    #[test]
    fn test_empty_cache_returns_none() {
        let cache = StrategyCache::empty();
        let sig = make_signals("opus", "main", 5);
        assert!(cache.evaluate(&sig, &make_profiles()).is_none());
    }

    #[test]
    fn test_field_match_agent_role() {
        let cache = StrategyCache {
            rules: ArcSwap::new(Arc::new(vec![Arc::new(StrategyRule {
                id: 1,
                match_cond: Some(StrategyMatch {
                    cluster_id: None,
                    agent_role: Some("subagent".into()),
                    model_pattern: None,
                    session_id: None,
                    cc_entrypoint: None,
                }),
                cel_expr_src: None,
                cel_program: None,
                action: StrategyAction::Direct("cheap".into()),
                confidence: 1.0,
                source: "test".into(),
                is_exploration: false,
                exploration_budget: AtomicI64::new(0),
                enabled: true,
            })])),
            version: AtomicI64::new(1),
        };
        let sig = make_signals("opus", "subagent", 5);
        let result = cache.evaluate(&sig, &make_profiles());
        assert!(result.is_some());
        assert_eq!(result.unwrap().profile, "cheap");

        let sig2 = make_signals("opus", "main", 5);
        assert!(cache.evaluate(&sig2, &make_profiles()).is_none());
    }

    #[test]
    fn test_field_match_model_pattern() {
        let cache = StrategyCache {
            rules: ArcSwap::new(Arc::new(vec![Arc::new(StrategyRule {
                id: 1,
                match_cond: Some(StrategyMatch {
                    cluster_id: None,
                    agent_role: None,
                    model_pattern: Some("haiku".into()),
                    session_id: None,
                    cc_entrypoint: None,
                }),
                cel_expr_src: None,
                cel_program: None,
                action: StrategyAction::Direct("cheap".into()),
                confidence: 0.9,
                source: "bayesian".into(),
                is_exploration: false,
                exploration_budget: AtomicI64::new(0),
                enabled: true,
            })])),
            version: AtomicI64::new(1),
        };
        let sig = make_signals("claude-haiku-4", "main", 1);
        let r = cache.evaluate(&sig, &make_profiles()).unwrap();
        assert_eq!(r.profile, "cheap");
        assert_eq!(r.source, "bayesian");
    }

    #[test]
    fn test_cel_expression() {
        let prog = cel_interpreter::Program::compile("msg_count > 3 && has_tools == false").unwrap();
        let cache = StrategyCache {
            rules: ArcSwap::new(Arc::new(vec![Arc::new(StrategyRule {
                id: 2,
                match_cond: None,
                cel_expr_src: Some("msg_count > 3 && has_tools == false".into()),
                cel_program: Some(prog),
                action: StrategyAction::Direct("premium".into()),
                confidence: 0.85,
                source: "ensemble".into(),
                is_exploration: false,
                exploration_budget: AtomicI64::new(0),
                enabled: true,
            })])),
            version: AtomicI64::new(1),
        };
        let sig = make_signals("test", "main", 5);
        let r = cache.evaluate(&sig, &make_profiles()).unwrap();
        assert_eq!(r.profile, "premium");

        let sig2 = make_signals("test", "main", 2);
        assert!(cache.evaluate(&sig2, &make_profiles()).is_none());
    }

    #[test]
    fn test_disabled_rule_skipped() {
        let cache = StrategyCache {
            rules: ArcSwap::new(Arc::new(vec![Arc::new(StrategyRule {
                id: 1,
                match_cond: Some(StrategyMatch {
                    cluster_id: None,
                    agent_role: Some("main".into()),
                    model_pattern: None,
                    session_id: None,
                    cc_entrypoint: None,
                }),
                cel_expr_src: None,
                cel_program: None,
                action: StrategyAction::Direct("premium".into()),
                confidence: 1.0,
                source: "test".into(),
                is_exploration: false,
                exploration_budget: AtomicI64::new(0),
                enabled: false,
            })])),
            version: AtomicI64::new(1),
        };
        let sig = make_signals("opus", "main", 1);
        assert!(cache.evaluate(&sig, &make_profiles()).is_none());
    }

    #[test]
    fn test_exploration_budget_depletes() {
        let cache = StrategyCache {
            rules: ArcSwap::new(Arc::new(vec![Arc::new(StrategyRule {
                id: 1,
                match_cond: Some(StrategyMatch {
                    cluster_id: None,
                    agent_role: None,
                    model_pattern: Some("test".into()),
                    session_id: None,
                    cc_entrypoint: None,
                }),
                cel_expr_src: None,
                cel_program: None,
                action: StrategyAction::Direct("balanced".into()),
                confidence: 0.5,
                source: "thompson".into(),
                is_exploration: true,
                exploration_budget: AtomicI64::new(2),
                enabled: true,
            })])),
            version: AtomicI64::new(1),
        };
        let sig = make_signals("test-model", "main", 1);
        assert!(cache.evaluate(&sig, &make_profiles()).is_some());
        assert!(cache.evaluate(&sig, &make_profiles()).is_some());
        assert!(cache.evaluate(&sig, &make_profiles()).is_none());
    }

    #[test]
    fn test_unknown_profile_skipped() {
        let cache = StrategyCache {
            rules: ArcSwap::new(Arc::new(vec![Arc::new(StrategyRule {
                id: 1,
                match_cond: Some(StrategyMatch {
                    cluster_id: None,
                    agent_role: Some("main".into()),
                    model_pattern: None,
                    session_id: None,
                    cc_entrypoint: None,
                }),
                cel_expr_src: None,
                cel_program: None,
                action: StrategyAction::Direct("nonexistent_profile".into()),
                confidence: 1.0,
                source: "test".into(),
                is_exploration: false,
                exploration_budget: AtomicI64::new(0),
                enabled: true,
            })])),
            version: AtomicI64::new(1),
        };
        let sig = make_signals("opus", "main", 1);
        assert!(cache.evaluate(&sig, &make_profiles()).is_none());
    }

    #[test]
    fn test_weighted_action() {
        let cache = StrategyCache {
            rules: ArcSwap::new(Arc::new(vec![Arc::new(StrategyRule {
                id: 1,
                match_cond: Some(StrategyMatch {
                    cluster_id: None,
                    agent_role: Some("main".into()),
                    model_pattern: None,
                    session_id: None,
                    cc_entrypoint: None,
                }),
                cel_expr_src: None,
                cel_program: None,
                action: StrategyAction::Weighted(vec![
                    WeightedProfile { profile: "premium".into(), weight: 100 },
                    WeightedProfile { profile: "cheap".into(), weight: 0 },
                ]),
                confidence: 0.7,
                source: "test".into(),
                is_exploration: false,
                exploration_budget: AtomicI64::new(0),
                enabled: true,
            })])),
            version: AtomicI64::new(1),
        };
        let sig = make_signals("opus", "main", 1);
        let r = cache.evaluate(&sig, &make_profiles()).unwrap();
        assert_eq!(r.profile, "premium");
    }
}
