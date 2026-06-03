use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    #[serde(default = "default_host")]
    pub host: String,
    #[serde(default = "default_port")]
    pub port: u16,
    #[serde(default = "default_log_level")]
    pub log_level: String,
    #[serde(default = "default_timeout")]
    pub timeout_secs: u64,
    pub providers: Vec<ProviderConfig>,
    pub priority: Vec<PriorityEntry>,
    #[serde(default = "default_retry_codes")]
    pub retry_codes: Vec<u16>,
    #[serde(default = "default_log_dir")]
    pub log_dir: String,
    #[serde(default)]
    pub routing: RoutingConfig,
    #[serde(default)]
    pub profiles: HashMap<String, Vec<PriorityEntry>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderConfig {
    pub name: String,
    #[serde(rename = "type")]
    pub provider_type: ProviderType,
    pub api_key: String,
    pub base_url: String,
    pub models: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ProviderType {
    Anthropic,
    #[serde(rename = "openai")]
    OpenAI,
    #[serde(rename = "openai_responses")]
    OpenAIResponses,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PriorityEntry {
    pub provider: String,
    pub model: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoutingConfig {
    #[serde(default = "default_true")]
    pub hvr_enabled: bool,
    #[serde(default = "default_true")]
    pub memory_enabled: bool,
    #[serde(default = "default_memory_db_path")]
    pub memory_db_path: String,
    #[serde(default)]
    pub shadow: ShadowConfig,
    #[serde(default)]
    pub canary_pct: u8,
    #[serde(default)]
    pub tiers: Vec<TierConfig>,
    #[serde(default)]
    pub dispatch: DispatchConfig,
    #[serde(default = "default_strategy_refresh_secs")]
    pub strategy_refresh_secs: u64,
    #[serde(default = "default_retrial_window_secs")]
    pub retrial_window_secs: u64,
    #[serde(default, skip_serializing)]
    pub policy_fallback_profiles: Vec<String>,  // deprecated: fallback order is now auto-managed by cc-proxy
    #[serde(default = "default_session_binding_ttl_secs")]
    pub session_binding_ttl_secs: u64,
    #[serde(default)]
    pub role_hooks: HashMap<String, RoleHookConfig>,
    #[serde(default)]
    pub ext_proc: Option<ExtProcConfig>,
    #[serde(default)]
    pub pii: PiiConfig,
}

impl Default for RoutingConfig {
    fn default() -> Self {
        Self {
            hvr_enabled: true,
            memory_enabled: true,
            memory_db_path: default_memory_db_path(),
            shadow: ShadowConfig::default(),
            canary_pct: 0,
            tiers: Vec::new(),
            dispatch: DispatchConfig::default(),
            strategy_refresh_secs: default_strategy_refresh_secs(),
            retrial_window_secs: default_retrial_window_secs(),
            policy_fallback_profiles: Vec::new(),
            session_binding_ttl_secs: default_session_binding_ttl_secs(),
            role_hooks: HashMap::new(),
            ext_proc: None,
            pii: PiiConfig::default(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExtProcConfig {
    pub socket_path: String,
    #[serde(default = "default_ext_proc_timeout_ms")]
    pub timeout_ms: u64,
    #[serde(default = "default_ext_proc_on_timeout")]
    pub on_timeout: String,   // "passthrough" | "block"
    #[serde(default)]
    pub hooks: ExtProcHooks,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ExtProcHooks {
    #[serde(default)]
    pub pre_request: ExtProcHookConfig,
    #[serde(default)]
    pub post_response: ExtProcHookConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExtProcHookConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub roles: Vec<String>,   // empty = all roles
    #[serde(default)]
    pub cel_condition: Option<String>,
}

impl Default for ExtProcHookConfig {
    fn default() -> Self {
        Self { enabled: false, roles: Vec::new(), cel_condition: None }
    }
}

fn default_ext_proc_timeout_ms() -> u64 { 100 }
fn default_ext_proc_on_timeout() -> String { "passthrough".to_string() }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PiiConfig {
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default = "default_true")]
    pub inject_system_rules: bool,
}

impl Default for PiiConfig {
    fn default() -> Self {
        Self { enabled: true, inject_system_rules: true }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShadowConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_sample_rate")]
    pub sample_rate: f64,
    #[serde(default = "default_daily_budget")]
    pub daily_budget_usd: f64,
    #[serde(default)]
    pub providers: Vec<PriorityEntry>,
}

impl Default for ShadowConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            sample_rate: 0.001,
            daily_budget_usd: 1.0,
            providers: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TierConfig {
    pub name: String,
    pub priority_start: usize,
    #[serde(default)]
    pub max_cost_per_1k_tokens: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DispatchConfig {
    #[serde(default = "default_profile_name")]
    pub default_profile: String,
    #[serde(default)]
    pub rules: Vec<DispatchRule>,
}

impl Default for DispatchConfig {
    fn default() -> Self {
        Self {
            default_profile: default_profile_name(),
            rules: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DispatchRule {
    #[serde(rename = "match")]
    pub match_cond: MatchCondition,
    pub profile: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct MatchCondition {
    #[serde(default)]
    pub model_pattern: Option<String>,
    #[serde(default)]
    pub agent_role: Option<String>,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub cc_version_suffix: Option<String>,
}

/// Per-role hooks for pre-request and post-response transformations.
/// Keys in `role_hooks` match agent_role strings (e.g. "main:tool:info", "subagent:explore")
/// or family names ("main", "subagent", "sidequery") for broad matching.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct RoleHookConfig {
    #[serde(default)]
    pub pre_request: Option<PreRequestHook>,
    #[serde(default)]
    pub post_response: Option<PostResponseHook>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PreRequestHook {
    #[serde(default)]
    pub override_profile: Option<String>,
    #[serde(default)]
    pub override_max_tokens: Option<u64>,
    #[serde(default)]
    pub override_temperature: Option<f64>,
    #[serde(default)]
    pub inject_system_suffix: Option<String>,
    #[serde(default)]
    pub strip_tools: Option<Vec<String>>,
    #[serde(default)]
    pub cel_condition: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PostResponseHook {
    #[serde(default)]
    pub log_level: Option<String>,
    #[serde(default)]
    pub alert_on_stop_reason: Option<Vec<String>>,
    #[serde(default)]
    pub cel_condition: Option<String>,
}

fn default_profile_name() -> String {
    "default".to_string()
}

fn default_host() -> String {
    "127.0.0.1".to_string()
}
fn default_port() -> u16 {
    3456
}
fn default_log_level() -> String {
    "info".to_string()
}
fn default_timeout() -> u64 {
    600
}
fn default_retry_codes() -> Vec<u16> {
    vec![429, 500, 502, 503, 529]
}
fn default_log_dir() -> String {
    let home = dirs::home_dir().unwrap_or_else(|| std::path::PathBuf::from("."));
    home.join(".cc-proxy").join("logs").to_string_lossy().to_string()
}

fn default_true() -> bool {
    true
}

fn default_memory_db_path() -> String {
    let home = dirs::home_dir().unwrap_or_else(|| std::path::PathBuf::from("."));
    home.join(".cc-proxy").join("memory.duckdb").to_string_lossy().to_string()
}

fn default_sample_rate() -> f64 {
    0.001
}

fn default_daily_budget() -> f64 {
    1.0
}

fn default_strategy_refresh_secs() -> u64 {
    60
}

fn default_retrial_window_secs() -> u64 {
    120
}

fn default_session_binding_ttl_secs() -> u64 {
    7200
}

impl Config {
    pub fn load(path: Option<&str>) -> anyhow::Result<Self> {
        let config_path = match path {
            Some(p) => PathBuf::from(p),
            None => Self::default_path()?,
        };

        if !config_path.exists() {
            anyhow::bail!(
                "Config file not found at {}. Create one or use --config to specify the path.",
                config_path.display()
            );
        }

        let content = std::fs::read_to_string(&config_path)?;
        let mut config: Config = serde_json::from_str(&content)?;
        config.resolve_env_vars();
        config.resolve_profiles();
        config.validate()?;
        Ok(config)
    }

    pub fn default_path() -> anyhow::Result<PathBuf> {
        let home = dirs::home_dir().ok_or_else(|| anyhow::anyhow!("Cannot determine home directory"))?;
        Ok(home.join(".cc-proxy").join("config.json"))
    }

    fn resolve_env_vars(&mut self) {
        for provider in &mut self.providers {
            provider.api_key = resolve_env(&provider.api_key);
            provider.base_url = resolve_env(&provider.base_url);
        }
        self.log_dir = expand_tilde(&resolve_env(&self.log_dir));
        self.routing.memory_db_path = expand_tilde(&resolve_env(&self.routing.memory_db_path));
    }

    fn resolve_profiles(&mut self) {
        if !self.profiles.contains_key("default") {
            self.profiles.insert("default".to_string(), self.priority.clone());
        }
    }

    pub fn get_profile_chain(&self, profile_name: &str) -> Option<&Vec<PriorityEntry>> {
        self.profiles.get(profile_name).filter(|chain| !chain.is_empty())
    }

    /// Returns the chain for `profile_name`, falling back to the default profile if empty/missing,
    /// then to `priority` as a last resort.
    pub fn get_effective_chain(&self, profile_name: &str) -> &Vec<PriorityEntry> {
        if let Some(chain) = self.get_profile_chain(profile_name) {
            return chain;
        }
        let default = &self.routing.dispatch.default_profile;
        if let Some(chain) = self.get_profile_chain(default) {
            return chain;
        }
        &self.priority
    }

    fn validate(&self) -> anyhow::Result<()> {
        if self.providers.is_empty() {
            anyhow::bail!("At least one provider must be configured");
        }
        if self.priority.is_empty() {
            anyhow::bail!("At least one priority entry must be configured");
        }
        for entry in &self.priority {
            self.validate_priority_entry(entry)?;
        }
        for (name, chain) in &self.profiles {
            for entry in chain {
                self.validate_priority_entry(entry)
                    .map_err(|e| anyhow::anyhow!("Profile '{}': {}", name, e))?;
            }
        }
        let default_profile = &self.routing.dispatch.default_profile;
        if !self.profiles.contains_key(default_profile) {
            anyhow::bail!(
                "dispatch.default_profile '{}' not found in profiles",
                default_profile
            );
        }
        for rule in &self.routing.dispatch.rules {
            if !self.profiles.contains_key(&rule.profile) {
                anyhow::bail!(
                    "Dispatch rule references unknown profile: '{}'",
                    rule.profile
                );
            }
        }
        Ok(())
    }

    fn validate_priority_entry(&self, entry: &PriorityEntry) -> anyhow::Result<()> {
        let provider = self.providers.iter().find(|p| p.name == entry.provider);
        match provider {
            None => anyhow::bail!(
                "Priority entry references unknown provider: {}",
                entry.provider
            ),
            Some(p) => {
                if !p.models.contains(&entry.model) {
                    anyhow::bail!(
                        "Priority entry references model '{}' not in provider '{}' models list",
                        entry.model,
                        entry.provider
                    );
                }
            }
        }
        Ok(())
    }

    pub fn find_provider(&self, name: &str) -> Option<&ProviderConfig> {
        self.providers.iter().find(|p| p.name == name)
    }

    /// Look up role hooks: first by exact role string, then by family.
    pub fn get_role_hook(&self, agent_role_str: &str, family: &str) -> Option<&RoleHookConfig> {
        self.routing.role_hooks.get(agent_role_str)
            .or_else(|| self.routing.role_hooks.get(family))
    }
}

fn expand_tilde(path: &str) -> String {
    if let Some(rest) = path.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest).to_string_lossy().to_string();
        }
    }
    path.to_string()
}

fn resolve_env(value: &str) -> String {
    if let Some(var_name) = value.strip_prefix('$') {
        let var_name = var_name.trim_start_matches('{').trim_end_matches('}');
        std::env::var(var_name).unwrap_or_else(|_| value.to_string())
    } else {
        value.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn make_valid_json() -> String {
        serde_json::json!({
            "providers": [{
                "name": "anthropic",
                "type": "anthropic",
                "api_key": "sk-test",
                "base_url": "https://api.anthropic.com",
                "models": ["claude-opus-4-20250514"]
            }],
            "priority": [
                {"provider": "anthropic", "model": "claude-opus-4-20250514"}
            ]
        }).to_string()
    }

    #[test]
    fn test_deserialize_defaults() {
        let config: Config = serde_json::from_str(&make_valid_json()).unwrap();
        assert_eq!(config.host, "127.0.0.1");
        assert_eq!(config.port, 3456);
        assert_eq!(config.log_level, "info");
        assert_eq!(config.timeout_secs, 600);
        assert_eq!(config.retry_codes, vec![429, 500, 502, 503, 529]);
    }

    #[test]
    fn test_deserialize_custom_values() {
        let json = serde_json::json!({
            "host": "0.0.0.0",
            "port": 8080,
            "log_level": "debug",
            "timeout_secs": 60,
            "retry_codes": [429, 503],
            "providers": [{
                "name": "p1", "type": "openai",
                "api_key": "k", "base_url": "http://localhost",
                "models": ["m1"]
            }],
            "priority": [{"provider": "p1", "model": "m1"}]
        });
        let config: Config = serde_json::from_str(&json.to_string()).unwrap();
        assert_eq!(config.host, "0.0.0.0");
        assert_eq!(config.port, 8080);
        assert_eq!(config.log_level, "debug");
        assert_eq!(config.timeout_secs, 60);
        assert_eq!(config.retry_codes, vec![429, 503]);
        assert_eq!(config.providers[0].provider_type, ProviderType::OpenAI);
    }

    #[test]
    fn test_provider_type_serde() {
        let json = r#"{"name":"a","type":"anthropic","api_key":"k","base_url":"u","models":[]}"#;
        let p: ProviderConfig = serde_json::from_str(json).unwrap();
        assert_eq!(p.provider_type, ProviderType::Anthropic);

        let json = r#"{"name":"b","type":"openai","api_key":"k","base_url":"u","models":[]}"#;
        let p: ProviderConfig = serde_json::from_str(json).unwrap();
        assert_eq!(p.provider_type, ProviderType::OpenAI);
    }

    #[test]
    fn test_validate_empty_providers() {
        let config = Config {
            host: "127.0.0.1".into(), port: 3456, log_level: "info".into(),
            timeout_secs: 300, providers: vec![], retry_codes: vec![],
            priority: vec![PriorityEntry { provider: "x".into(), model: "m".into() }],
            log_dir: "/tmp/test-logs".into(),
            routing: RoutingConfig::default(),
            profiles: HashMap::new(),
        };
        let err = config.validate().unwrap_err();
        assert!(err.to_string().contains("At least one provider"));
    }

    #[test]
    fn test_validate_empty_priority() {
        let config = Config {
            host: "127.0.0.1".into(), port: 3456, log_level: "info".into(),
            timeout_secs: 300, retry_codes: vec![],
            providers: vec![ProviderConfig {
                name: "a".into(), provider_type: ProviderType::Anthropic,
                api_key: "k".into(), base_url: "u".into(), models: vec!["m".into()],
            }],
            priority: vec![],
            log_dir: "/tmp/test-logs".into(),
            routing: RoutingConfig::default(),
            profiles: HashMap::new(),
        };
        let err = config.validate().unwrap_err();
        assert!(err.to_string().contains("At least one priority entry"));
    }

    #[test]
    fn test_validate_unknown_provider_in_priority() {
        let priority = vec![PriorityEntry { provider: "nonexistent".into(), model: "m".into() }];
        let config = Config {
            host: "127.0.0.1".into(), port: 3456, log_level: "info".into(),
            timeout_secs: 300, retry_codes: vec![],
            providers: vec![ProviderConfig {
                name: "a".into(), provider_type: ProviderType::Anthropic,
                api_key: "k".into(), base_url: "u".into(), models: vec!["m".into()],
            }],
            priority: priority.clone(),
            log_dir: "/tmp/test-logs".into(),
            routing: RoutingConfig::default(),
            profiles: [("default".into(), priority)].into_iter().collect(),
        };
        let err = config.validate().unwrap_err();
        assert!(err.to_string().contains("unknown provider"));
    }

    #[test]
    fn test_validate_unknown_model_in_priority() {
        let priority = vec![PriorityEntry { provider: "a".into(), model: "wrong_model".into() }];
        let config = Config {
            host: "127.0.0.1".into(), port: 3456, log_level: "info".into(),
            timeout_secs: 300, retry_codes: vec![],
            providers: vec![ProviderConfig {
                name: "a".into(), provider_type: ProviderType::Anthropic,
                api_key: "k".into(), base_url: "u".into(), models: vec!["m1".into()],
            }],
            priority: priority.clone(),
            log_dir: "/tmp/test-logs".into(),
            routing: RoutingConfig::default(),
            profiles: [("default".into(), priority)].into_iter().collect(),
        };
        let err = config.validate().unwrap_err();
        assert!(err.to_string().contains("not in provider"));
    }

    #[test]
    fn test_find_provider() {
        let config: Config = serde_json::from_str(&make_valid_json()).unwrap();
        assert!(config.find_provider("anthropic").is_some());
        assert!(config.find_provider("nonexistent").is_none());
    }

    #[test]
    fn test_resolve_env_plain() {
        assert_eq!(resolve_env("plain_value"), "plain_value");
    }

    #[test]
    fn test_resolve_env_dollar() {
        unsafe { std::env::set_var("CC_PROXY_TEST_KEY", "resolved_value"); }
        assert_eq!(resolve_env("$CC_PROXY_TEST_KEY"), "resolved_value");
        assert_eq!(resolve_env("${CC_PROXY_TEST_KEY}"), "resolved_value");
        unsafe { std::env::remove_var("CC_PROXY_TEST_KEY"); }
    }

    #[test]
    fn test_resolve_env_missing_var() {
        let result = resolve_env("$DEFINITELY_NOT_SET_12345");
        assert_eq!(result, "$DEFINITELY_NOT_SET_12345");
    }

    #[test]
    fn test_load_from_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        let mut f = std::fs::File::create(&path).unwrap();
        f.write_all(make_valid_json().as_bytes()).unwrap();

        let config = Config::load(Some(path.to_str().unwrap())).unwrap();
        assert_eq!(config.providers.len(), 1);
        assert_eq!(config.providers[0].name, "anthropic");
    }

    #[test]
    fn test_load_missing_file() {
        let err = Config::load(Some("/tmp/cc_proxy_nonexistent_12345.json")).unwrap_err();
        assert!(err.to_string().contains("not found"));
    }

    #[test]
    fn test_load_invalid_json() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("bad.json");
        std::fs::write(&path, "not json").unwrap();
        let err = Config::load(Some(path.to_str().unwrap())).unwrap_err();
        assert!(err.to_string().contains("expected"));
    }

    #[test]
    fn test_load_resolves_env_vars() {
        unsafe { std::env::set_var("CC_PROXY_TEST_API_KEY", "sk-from-env"); }
        let json = serde_json::json!({
            "providers": [{
                "name": "a", "type": "anthropic",
                "api_key": "$CC_PROXY_TEST_API_KEY",
                "base_url": "https://api.anthropic.com",
                "models": ["m1"]
            }],
            "priority": [{"provider": "a", "model": "m1"}]
        });
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        std::fs::write(&path, json.to_string()).unwrap();

        let config = Config::load(Some(path.to_str().unwrap())).unwrap();
        assert_eq!(config.providers[0].api_key, "sk-from-env");
        unsafe { std::env::remove_var("CC_PROXY_TEST_API_KEY"); }
    }
}
