use crate::agent_role::AgentRole;
use crate::config::Config;
use crate::signals::RequestSignals;
use crate::strategy::StrategyCache;
use regex::Regex;
use std::collections::HashMap;

pub struct DispatchSignals<'a> {
    pub model: &'a str,
    pub session_id: &'a str,
    pub agent_role: AgentRole,
    pub cc_version_suffix: Option<&'a str>,
}

pub struct DispatchResult<'a> {
    pub profile: &'a str,
    pub source: DispatchSource,
}

pub enum DispatchSource {
    SessionOverride,
    Strategy { rule_id: i64, confidence: f64 },
    LocalRule { rule_index: usize },
    Default,
}

impl DispatchSource {
    pub fn label(&self) -> &'static str {
        match self {
            DispatchSource::SessionOverride => "session_override",
            DispatchSource::Strategy { .. } => "strategy",
            DispatchSource::LocalRule { .. } => "local_rule",
            DispatchSource::Default => "default",
        }
    }
}

pub fn select_profile<'a>(
    cfg: &'a Config,
    signals: &DispatchSignals,
    session_overrides: &HashMap<String, String>,
    strategy: Option<&StrategyCache>,
    request_signals: Option<&RequestSignals>,
) -> DispatchResult<'a> {
    if let Some(profile) = session_overrides.get(signals.session_id) {
        if cfg.profiles.contains_key(profile.as_str()) {
            return DispatchResult {
                profile: profile_ref(cfg, profile),
                source: DispatchSource::SessionOverride,
            };
        }
    }

    if let (Some(cache), Some(req_sig)) = (strategy, request_signals) {
        if let Some(result) = cache.evaluate(req_sig, &cfg.profiles) {
            if let Some(key) = cfg.profiles.keys().find(|k| k.as_str() == result.profile) {
                return DispatchResult {
                    profile: key.as_str(),
                    source: DispatchSource::Strategy {
                        rule_id: result.rule_id,
                        confidence: result.confidence,
                    },
                };
            }
        }
    }

    for (idx, rule) in cfg.routing.dispatch.rules.iter().enumerate() {
        if rule_matches(&rule.match_cond, signals) {
            return DispatchResult {
                profile: profile_ref(cfg, &rule.profile),
                source: DispatchSource::LocalRule { rule_index: idx },
            };
        }
    }

    // Built-in: raw_api sessions always use "balanced" (API callers don't need premium capacity)
    if signals.agent_role == AgentRole::RawApi && cfg.profiles.contains_key("balanced") {
        return DispatchResult {
            profile: profile_ref(cfg, "balanced"),
            source: DispatchSource::Default,
        };
    }

    // Built-in: Codex CLI agent uses "premium" if available (same level as Claude Code main agent)
    if signals.agent_role == AgentRole::CodexAgent && cfg.profiles.contains_key("premium") {
        return DispatchResult {
            profile: profile_ref(cfg, "premium"),
            source: DispatchSource::Default,
        };
    }

    DispatchResult {
        profile: profile_ref(cfg, &cfg.routing.dispatch.default_profile),
        source: DispatchSource::Default,
    }
}


fn profile_ref<'a>(cfg: &'a Config, name: &str) -> &'a str {
    cfg.profiles
        .keys()
        .find(|k| k.as_str() == name)
        .map(|k| k.as_str())
        .unwrap_or("default")
}

fn rule_matches(cond: &crate::config::MatchCondition, signals: &DispatchSignals) -> bool {
    if let Some(ref pattern) = cond.model_pattern {
        let ci_pattern = format!("(?i){}", pattern);
        match Regex::new(&ci_pattern) {
            Ok(re) => {
                if !re.is_match(signals.model) {
                    return false;
                }
            }
            Err(_) => return false,
        }
    }

    if let Some(ref role_str) = cond.agent_role {
        let role_lower = role_str.to_lowercase();
        let role_family = signals.agent_role.family();
        let role_exact = signals.agent_role.to_string();
        if role_lower != role_exact && role_lower != role_family {
            return false;
        }
    }

    if let Some(ref sid) = cond.session_id {
        if sid != signals.session_id {
            return false;
        }
    }

    if let Some(ref suffix) = cond.cc_version_suffix {
        match signals.cc_version_suffix {
            Some(actual) if actual == suffix => {}
            _ => return false,
        }
    }

    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::*;
    use serde_json::json;

    fn test_config() -> Config {
        let json = json!({
            "providers": [
                {"name": "a", "type": "anthropic", "api_key": "k", "base_url": "u", "models": ["opus", "haiku", "sonnet"]},
                {"name": "d", "type": "openai", "api_key": "k", "base_url": "u", "models": ["deepseek-chat"]}
            ],
            "priority": [{"provider": "a", "model": "opus"}],
            "profiles": {
                "default": [{"provider": "a", "model": "opus"}],
                "premium": [{"provider": "a", "model": "opus"}],
                "cheap": [{"provider": "d", "model": "deepseek-chat"}],
                "balanced": [{"provider": "a", "model": "sonnet"}]
            },
            "routing": {
                "dispatch": {
                    "default_profile": "default",
                    "rules": [
                        {"match": {"model_pattern": "haiku"}, "profile": "cheap"},
                        {"match": {"agent_role": "subagent"}, "profile": "cheap"},
                        {"match": {"model_pattern": "opus"}, "profile": "premium"},
                        {"match": {"model_pattern": "sonnet"}, "profile": "balanced"}
                    ]
                }
            }
        });
        serde_json::from_value(json).unwrap()
    }

    fn signals<'a>(model: &'a str, role: AgentRole) -> DispatchSignals<'a> {
        DispatchSignals {
            model,
            session_id: "sess-1",
            agent_role: role,
            cc_version_suffix: None,
        }
    }

    #[test]
    fn test_opus_gets_premium() {
        let cfg = test_config();
        let s = signals("claude-opus-4-20250514", AgentRole::MainFirstTurn);
        assert_eq!(select_profile(&cfg, &s, &HashMap::new(), None, None).profile, "premium");
    }

    #[test]
    fn test_haiku_gets_cheap() {
        let cfg = test_config();
        let s = signals("claude-haiku-4-5-20251001", AgentRole::MainFirstTurn);
        assert_eq!(select_profile(&cfg, &s, &HashMap::new(), None, None).profile, "cheap");
    }

    #[test]
    fn test_sonnet_gets_balanced() {
        let cfg = test_config();
        let s = signals("claude-sonnet-4-20250514", AgentRole::MainFirstTurn);
        assert_eq!(select_profile(&cfg, &s, &HashMap::new(), None, None).profile, "balanced");
    }

    #[test]
    fn test_subagent_role_gets_cheap() {
        let cfg = test_config();
        let s = signals("claude-opus-4-20250514", AgentRole::SubAgentExplore);
        assert_eq!(select_profile(&cfg, &s, &HashMap::new(), None, None).profile, "cheap");
    }

    #[test]
    fn test_session_override_takes_priority() {
        let cfg = test_config();
        let s = signals("claude-opus-4-20250514", AgentRole::MainFirstTurn);
        let overrides: HashMap<String, String> =
            [("sess-1".into(), "balanced".into())].into_iter().collect();
        assert_eq!(select_profile(&cfg, &s, &overrides, None, None).profile, "balanced");
    }

    #[test]
    fn test_unknown_model_gets_default() {
        let cfg = test_config();
        let s = signals("some-unknown-model", AgentRole::RawApi);
        // raw_api routes to "balanced" when that profile exists
        assert_eq!(select_profile(&cfg, &s, &HashMap::new(), None, None).profile, "balanced");
    }

    #[test]
    fn test_invalid_override_profile_falls_through() {
        let cfg = test_config();
        let s = signals("claude-opus-4-20250514", AgentRole::MainFirstTurn);
        let overrides: HashMap<String, String> =
            [("sess-1".into(), "nonexistent".into())].into_iter().collect();
        assert_eq!(select_profile(&cfg, &s, &overrides, None, None).profile, "premium");
    }

    #[test]
    fn test_session_id_match() {
        let json = json!({
            "providers": [
                {"name": "a", "type": "anthropic", "api_key": "k", "base_url": "u", "models": ["m"]}
            ],
            "priority": [{"provider": "a", "model": "m"}],
            "profiles": {
                "default": [{"provider": "a", "model": "m"}],
                "special": [{"provider": "a", "model": "m"}]
            },
            "routing": {
                "dispatch": {
                    "default_profile": "default",
                    "rules": [
                        {"match": {"session_id": "sess-special"}, "profile": "special"}
                    ]
                }
            }
        });
        let cfg: Config = serde_json::from_value(json).unwrap();
        let s = DispatchSignals {
            model: "m",
            session_id: "sess-special",
            agent_role: AgentRole::RawApi,
            cc_version_suffix: None,
        };
        assert_eq!(select_profile(&cfg, &s, &HashMap::new(), None, None).profile, "special");

        let s2 = DispatchSignals {
            model: "m",
            session_id: "other",
            agent_role: AgentRole::RawApi,
            cc_version_suffix: None,
        };
        assert_eq!(select_profile(&cfg, &s2, &HashMap::new(), None, None).profile, "default");
    }

    #[test]
    fn test_cc_version_suffix_match() {
        let json = json!({
            "providers": [
                {"name": "a", "type": "anthropic", "api_key": "k", "base_url": "u", "models": ["m"]}
            ],
            "priority": [{"provider": "a", "model": "m"}],
            "profiles": {
                "default": [{"provider": "a", "model": "m"}],
                "sdk": [{"provider": "a", "model": "m"}]
            },
            "routing": {
                "dispatch": {
                    "default_profile": "default",
                    "rules": [
                        {"match": {"cc_version_suffix": "c50"}, "profile": "sdk"}
                    ]
                }
            }
        });
        let cfg: Config = serde_json::from_value(json).unwrap();
        let s = DispatchSignals {
            model: "m",
            session_id: "s",
            agent_role: AgentRole::SubAgentExplore,
            cc_version_suffix: Some("c50"),
        };
        assert_eq!(select_profile(&cfg, &s, &HashMap::new(), None, None).profile, "sdk");
    }

    #[test]
    fn test_and_semantics_multi_field() {
        let json = json!({
            "providers": [
                {"name": "a", "type": "anthropic", "api_key": "k", "base_url": "u", "models": ["opus"]}
            ],
            "priority": [{"provider": "a", "model": "opus"}],
            "profiles": {
                "default": [{"provider": "a", "model": "opus"}],
                "target": [{"provider": "a", "model": "opus"}]
            },
            "routing": {
                "dispatch": {
                    "default_profile": "default",
                    "rules": [
                        {"match": {"model_pattern": "opus", "agent_role": "main"}, "profile": "target"}
                    ]
                }
            }
        });
        let cfg: Config = serde_json::from_value(json).unwrap();

        let s_both = DispatchSignals {
            model: "opus",
            session_id: "s",
            agent_role: AgentRole::MainFirstTurn,
            cc_version_suffix: None,
        };
        assert_eq!(select_profile(&cfg, &s_both, &HashMap::new(), None, None).profile, "target");

        let s_model_only = DispatchSignals {
            model: "opus",
            session_id: "s",
            agent_role: AgentRole::SubAgentExplore,
            cc_version_suffix: None,
        };
        assert_eq!(select_profile(&cfg, &s_model_only, &HashMap::new(), None, None).profile, "default");
    }

    #[test]
    fn test_no_rules_gets_default() {
        let json = json!({
            "providers": [
                {"name": "a", "type": "anthropic", "api_key": "k", "base_url": "u", "models": ["m"]}
            ],
            "priority": [{"provider": "a", "model": "m"}],
            "profiles": {
                "default": [{"provider": "a", "model": "m"}]
            }
        });
        let cfg: Config = serde_json::from_value(json).unwrap();
        let s = signals("m", AgentRole::RawApi);
        assert_eq!(select_profile(&cfg, &s, &HashMap::new(), None, None).profile, "default");
    }

    #[test]
    fn test_granular_role_match() {
        let json = json!({
            "providers": [
                {"name": "a", "type": "anthropic", "api_key": "k", "base_url": "u", "models": ["m"]},
                {"name": "b", "type": "openai", "api_key": "k", "base_url": "u", "models": ["cheap"]}
            ],
            "priority": [{"provider": "a", "model": "m"}],
            "profiles": {
                "default": [{"provider": "a", "model": "m"}],
                "info_profile": [{"provider": "b", "model": "cheap"}]
            },
            "routing": {
                "dispatch": {
                    "default_profile": "default",
                    "rules": [
                        {"match": {"agent_role": "main:tool:info"}, "profile": "info_profile"}
                    ]
                }
            }
        });
        let cfg: Config = serde_json::from_value(json).unwrap();

        let s_info = DispatchSignals {
            model: "m",
            session_id: "s",
            agent_role: AgentRole::MainToolInfo,
            cc_version_suffix: None,
        };
        assert_eq!(select_profile(&cfg, &s_info, &HashMap::new(), None, None).profile, "info_profile");

        let s_exec = DispatchSignals {
            model: "m",
            session_id: "s",
            agent_role: AgentRole::MainToolExec,
            cc_version_suffix: None,
        };
        assert_eq!(select_profile(&cfg, &s_exec, &HashMap::new(), None, None).profile, "default");
    }

    #[test]
    fn test_family_match_catches_all_main() {
        let json = json!({
            "providers": [
                {"name": "a", "type": "anthropic", "api_key": "k", "base_url": "u", "models": ["m"]}
            ],
            "priority": [{"provider": "a", "model": "m"}],
            "profiles": {
                "default": [{"provider": "a", "model": "m"}],
                "main_profile": [{"provider": "a", "model": "m"}]
            },
            "routing": {
                "dispatch": {
                    "default_profile": "default",
                    "rules": [
                        {"match": {"agent_role": "main"}, "profile": "main_profile"}
                    ]
                }
            }
        });
        let cfg: Config = serde_json::from_value(json).unwrap();

        for role in [
            AgentRole::MainFirstTurn,
            AgentRole::MainUserTurn,
            AgentRole::MainToolInfo,
            AgentRole::MainToolExec,
        ] {
            let s = DispatchSignals {
                model: "m",
                session_id: "s",
                agent_role: role.clone(),
                cc_version_suffix: None,
            };
            assert_eq!(
                select_profile(&cfg, &s, &HashMap::new(), None, None).profile,
                "main_profile",
                "Failed for role: {:?}",
                role,
            );
        }
    }

    // ======== Strategy-Dispatch Integration Tests ========

    use crate::strategy::{StrategyCache, StrategyRule, StrategyMatch, StrategyAction, WeightedProfile};
    use std::sync::atomic::AtomicI64;
    use std::sync::Arc;
    use arc_swap::ArcSwap;

    fn make_request_signals(model: &str, role_str: &str, session_id: &str, msg_count: u64) -> RequestSignals {
        let role = AgentRole::from_str_loose(role_str);
        let family = role.family().to_string();
        let tool_cat = role.tool_category().map(String::from);
        let is_main = role.is_main();
        let is_subagent = role.is_subagent();
        let is_sidequery = role.is_sidequery();
        let is_ir = role.is_independently_routable();
        RequestSignals {
            model: model.to_string(),
            session_id: session_id.to_string(),
            agent_role: role,
            agent_role_str: role_str.to_string(),
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

    fn strategy_cache_with_rules(rules: Vec<StrategyRule>) -> StrategyCache {
        let version = rules.iter().map(|r| r.id).max().unwrap_or(0);
        let arc_rules: Vec<Arc<StrategyRule>> = rules.into_iter().map(Arc::new).collect();
        StrategyCache {
            rules: ArcSwap::new(Arc::new(arc_rules)),
            version: AtomicI64::new(version),
        }
    }

    #[test]
    fn test_strategy_overrides_local_rules() {
        let cfg = test_config();
        let cache = strategy_cache_with_rules(vec![StrategyRule {
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
            action: StrategyAction::Direct("balanced".into()),
            confidence: 0.9,
            source: "test".into(),
            is_exploration: false,
            exploration_budget: AtomicI64::new(0),
            enabled: true,
        }]);

        let dispatch_sig = signals("claude-opus-4-20250514", AgentRole::SubAgentExplore);
        let req_sig = make_request_signals("claude-opus-4-20250514", "subagent:explore", "sess-1", 5);

        let result = select_profile(&cfg, &dispatch_sig, &HashMap::new(), Some(&cache), Some(&req_sig));
        assert_eq!(result.profile, "balanced");
        assert_eq!(result.source.label(), "strategy");
    }

    #[test]
    fn test_strategy_source_contains_rule_id() {
        let cfg = test_config();
        let cache = strategy_cache_with_rules(vec![StrategyRule {
            id: 42,
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
            confidence: 0.85,
            source: "bayesian".into(),
            is_exploration: false,
            exploration_budget: AtomicI64::new(0),
            enabled: true,
        }]);

        let dispatch_sig = signals("opus", AgentRole::SubAgentExplore);
        let req_sig = make_request_signals("opus", "subagent:explore", "sess-1", 3);

        let result = select_profile(&cfg, &dispatch_sig, &HashMap::new(), Some(&cache), Some(&req_sig));
        match result.source {
            DispatchSource::Strategy { rule_id, confidence } => {
                assert_eq!(rule_id, 42);
                assert!((confidence - 0.85).abs() < 0.001);
            }
            _ => panic!("Expected Strategy source, got: {}", result.source.label()),
        }
    }

    #[test]
    fn test_strategy_session_id_matching() {
        let cfg = test_config();
        let cache = strategy_cache_with_rules(vec![StrategyRule {
            id: 10,
            match_cond: Some(StrategyMatch {
                cluster_id: None,
                agent_role: None,
                model_pattern: None,
                session_id: Some("target-session".into()),
                cc_entrypoint: None,
            }),
            cel_expr_src: None,
            cel_program: None,
            action: StrategyAction::Direct("balanced".into()),
            confidence: 1.0,
            source: "manual".into(),
            is_exploration: false,
            exploration_budget: AtomicI64::new(0),
            enabled: true,
        }]);

        let dispatch_sig = DispatchSignals {
            model: "opus",
            session_id: "target-session",
            agent_role: AgentRole::MainFirstTurn,
            cc_version_suffix: None,
        };
        let req_sig = make_request_signals("opus", "main:first_turn", "target-session", 1);

        let result = select_profile(&cfg, &dispatch_sig, &HashMap::new(), Some(&cache), Some(&req_sig));
        assert_eq!(result.profile, "balanced");
        assert_eq!(result.source.label(), "strategy");

        let dispatch_sig2 = DispatchSignals {
            model: "opus",
            session_id: "other-session",
            agent_role: AgentRole::MainFirstTurn,
            cc_version_suffix: None,
        };
        let req_sig2 = make_request_signals("opus", "main:first_turn", "other-session", 1);
        let result2 = select_profile(&cfg, &dispatch_sig2, &HashMap::new(), Some(&cache), Some(&req_sig2));
        assert_eq!(result2.source.label(), "local_rule");
    }

    #[test]
    fn test_strategy_invalid_profile_falls_through_to_local() {
        let cfg = test_config();
        let cache = strategy_cache_with_rules(vec![StrategyRule {
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
            action: StrategyAction::Direct("nonexistent_profile".into()),
            confidence: 1.0,
            source: "test".into(),
            is_exploration: false,
            exploration_budget: AtomicI64::new(0),
            enabled: true,
        }]);

        let dispatch_sig = signals("claude-opus-4-20250514", AgentRole::SubAgentExplore);
        let req_sig = make_request_signals("claude-opus-4-20250514", "subagent:explore", "sess-1", 5);

        let result = select_profile(&cfg, &dispatch_sig, &HashMap::new(), Some(&cache), Some(&req_sig));
        assert_eq!(result.profile, "cheap");
        assert_eq!(result.source.label(), "local_rule");
    }

    #[test]
    fn test_session_override_beats_strategy() {
        let cfg = test_config();
        let cache = strategy_cache_with_rules(vec![StrategyRule {
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
            action: StrategyAction::Direct("cheap".into()),
            confidence: 1.0,
            source: "test".into(),
            is_exploration: false,
            exploration_budget: AtomicI64::new(0),
            enabled: true,
        }]);

        let dispatch_sig = signals("claude-opus-4-20250514", AgentRole::MainFirstTurn);
        let req_sig = make_request_signals("claude-opus-4-20250514", "main:first_turn", "sess-1", 1);
        let overrides: HashMap<String, String> =
            [("sess-1".into(), "balanced".into())].into_iter().collect();

        let result = select_profile(&cfg, &dispatch_sig, &overrides, Some(&cache), Some(&req_sig));
        assert_eq!(result.profile, "balanced");
        assert_eq!(result.source.label(), "session_override");
    }

    #[test]
    fn test_strategy_cel_expression_in_dispatch() {
        let cfg = test_config();
        let prog = cel_interpreter::Program::compile("msg_count > 10 && is_subagent").unwrap();
        let cache = strategy_cache_with_rules(vec![StrategyRule {
            id: 5,
            match_cond: None,
            cel_expr_src: Some("msg_count > 10 && is_subagent".into()),
            cel_program: Some(prog),
            action: StrategyAction::Direct("premium".into()),
            confidence: 0.8,
            source: "ensemble".into(),
            is_exploration: false,
            exploration_budget: AtomicI64::new(0),
            enabled: true,
        }]);

        let dispatch_sig = signals("opus", AgentRole::SubAgentExplore);
        let req_sig = make_request_signals("opus", "subagent:explore", "sess-1", 15);

        let result = select_profile(&cfg, &dispatch_sig, &HashMap::new(), Some(&cache), Some(&req_sig));
        assert_eq!(result.profile, "premium");
        assert_eq!(result.source.label(), "strategy");

        let req_sig_low = make_request_signals("opus", "subagent:explore", "sess-1", 5);
        let result2 = select_profile(&cfg, &dispatch_sig, &HashMap::new(), Some(&cache), Some(&req_sig_low));
        assert_eq!(result2.source.label(), "local_rule");
    }

    #[test]
    fn test_strategy_exploration_budget_in_dispatch() {
        let cfg = test_config();
        let cache = strategy_cache_with_rules(vec![StrategyRule {
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
            action: StrategyAction::Direct("cheap".into()),
            confidence: 0.5,
            source: "thompson".into(),
            is_exploration: true,
            exploration_budget: AtomicI64::new(2),
            enabled: true,
        }]);

        let dispatch_sig = signals("opus", AgentRole::MainFirstTurn);
        let req_sig = make_request_signals("opus", "main:first_turn", "sess-1", 1);

        let r1 = select_profile(&cfg, &dispatch_sig, &HashMap::new(), Some(&cache), Some(&req_sig));
        assert_eq!(r1.profile, "cheap");
        assert_eq!(r1.source.label(), "strategy");

        let r2 = select_profile(&cfg, &dispatch_sig, &HashMap::new(), Some(&cache), Some(&req_sig));
        assert_eq!(r2.profile, "cheap");
        assert_eq!(r2.source.label(), "strategy");

        let r3 = select_profile(&cfg, &dispatch_sig, &HashMap::new(), Some(&cache), Some(&req_sig));
        assert_eq!(r3.profile, "premium");
        assert_eq!(r3.source.label(), "local_rule");
    }

    #[test]
    fn test_strategy_disabled_rule_falls_through() {
        let cfg = test_config();
        let cache = strategy_cache_with_rules(vec![StrategyRule {
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
            action: StrategyAction::Direct("balanced".into()),
            confidence: 1.0,
            source: "test".into(),
            is_exploration: false,
            exploration_budget: AtomicI64::new(0),
            enabled: false,
        }]);

        let dispatch_sig = signals("claude-opus-4-20250514", AgentRole::SubAgentExplore);
        let req_sig = make_request_signals("claude-opus-4-20250514", "subagent:explore", "sess-1", 5);

        let result = select_profile(&cfg, &dispatch_sig, &HashMap::new(), Some(&cache), Some(&req_sig));
        assert_eq!(result.profile, "cheap");
        assert_eq!(result.source.label(), "local_rule");
    }

    #[test]
    fn test_strategy_weighted_in_dispatch() {
        let cfg = test_config();
        let cache = strategy_cache_with_rules(vec![StrategyRule {
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
            action: StrategyAction::Weighted(vec![
                WeightedProfile { profile: "cheap".into(), weight: 100 },
                WeightedProfile { profile: "balanced".into(), weight: 0 },
            ]),
            confidence: 0.7,
            source: "test".into(),
            is_exploration: false,
            exploration_budget: AtomicI64::new(0),
            enabled: true,
        }]);

        let dispatch_sig = signals("opus", AgentRole::SubAgentExplore);
        let req_sig = make_request_signals("opus", "subagent:explore", "sess-1", 5);

        let result = select_profile(&cfg, &dispatch_sig, &HashMap::new(), Some(&cache), Some(&req_sig));
        assert_eq!(result.profile, "cheap");
        assert_eq!(result.source.label(), "strategy");
    }

    #[test]
    fn test_dispatch_priority_chain() {
        let cfg = test_config();
        let cache = strategy_cache_with_rules(vec![StrategyRule {
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
            action: StrategyAction::Direct("cheap".into()),
            confidence: 1.0,
            source: "test".into(),
            is_exploration: false,
            exploration_budget: AtomicI64::new(0),
            enabled: true,
        }]);

        let dispatch_sig = signals("opus", AgentRole::MainFirstTurn);
        let req_sig = make_request_signals("opus", "main:first_turn", "sess-1", 1);

        let r_with_override = select_profile(
            &cfg, &dispatch_sig,
            &[("sess-1".into(), "balanced".into())].into_iter().collect(),
            Some(&cache), Some(&req_sig),
        );
        assert_eq!(r_with_override.source.label(), "session_override");

        let r_with_strategy = select_profile(
            &cfg, &dispatch_sig, &HashMap::new(),
            Some(&cache), Some(&req_sig),
        );
        assert_eq!(r_with_strategy.source.label(), "strategy");

        let r_no_strategy = select_profile(
            &cfg, &dispatch_sig, &HashMap::new(),
            None, None,
        );
        assert_eq!(r_no_strategy.source.label(), "local_rule");
    }
}
