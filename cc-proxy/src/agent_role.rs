use serde_json::Value;
use std::fmt;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum AgentRole {
    MainFirstTurn,
    MainUserTurn,
    MainToolInfo,
    MainToolExec,
    MainToolMutation,
    MainToolCoord,
    MainToolFlow,
    MainToolUnknown,
    MainSdk,
    SubAgentExplore,
    SubAgentGeneralPurpose,
    SubAgentPlan,
    SubAgentGuide,
    SubAgentStatusline,
    SubAgentVerification,
    SubAgentFork,
    SideQueryTitle,
    SideQueryNaming,
    SideQueryWebSearch,
    SideQueryWebFetch,
    SideQueryOther,
    Compaction,
    RawApi,
    CodexAgent,  // Codex CLI main agent (Responses API format)
}

const INFO_TOOLS: &[&str] = &[
    "Read", "Grep", "Glob", "LSP", "WebSearch", "WebFetch",
    "Explore", "ListFiles", "SearchFiles", "ReadFile",
];

const MUTATION_TOOLS: &[&str] = &[
    "Edit", "Write", "NotebookEdit", "MultiEdit",
];

const EXEC_TOOLS: &[&str] = &[
    "Bash", "Monitor", "TaskStop", "TaskOutput",
];

const COORD_TOOLS: &[&str] = &[
    "Agent", "SendMessage", "TaskCreate", "TaskGet", "TaskList", "TaskUpdate",
];

const FLOW_TOOLS: &[&str] = &[
    "EnterPlanMode", "ExitPlanMode", "AskUserQuestion",
    "CronCreate", "CronDelete", "CronList",
    "Skill", "EnterWorktree", "ExitWorktree",
    "ScheduleWakeup", "PushNotification", "RemoteTrigger",
];

impl fmt::Display for AgentRole {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MainFirstTurn => write!(f, "main:first_turn"),
            Self::MainUserTurn => write!(f, "main:user_turn"),
            Self::MainToolInfo => write!(f, "main:tool:info"),
            Self::MainToolExec => write!(f, "main:tool:exec"),
            Self::MainToolMutation => write!(f, "main:tool:mutation"),
            Self::MainToolCoord => write!(f, "main:tool:coord"),
            Self::MainToolFlow => write!(f, "main:tool:flow"),
            Self::MainToolUnknown => write!(f, "main:tool:unknown"),
            Self::MainSdk => write!(f, "main:sdk"),
            Self::SubAgentExplore => write!(f, "subagent:explore"),
            Self::SubAgentGeneralPurpose => write!(f, "subagent:general"),
            Self::SubAgentPlan => write!(f, "subagent:plan"),
            Self::SubAgentGuide => write!(f, "subagent:guide"),
            Self::SubAgentStatusline => write!(f, "subagent:statusline"),
            Self::SubAgentVerification => write!(f, "subagent:verification"),
            Self::SubAgentFork => write!(f, "subagent:fork"),
            Self::SideQueryTitle => write!(f, "sidequery:title"),
            Self::SideQueryNaming => write!(f, "sidequery:naming"),
            Self::SideQueryWebSearch => write!(f, "sidequery:web_search"),
            Self::SideQueryWebFetch => write!(f, "sidequery:web_fetch"),
            Self::SideQueryOther => write!(f, "sidequery:other"),
            Self::Compaction => write!(f, "compaction"),
            Self::RawApi => write!(f, "raw_api"),
            Self::CodexAgent => write!(f, "codex"),
        }
    }
}

impl AgentRole {
    pub fn from_str_loose(s: &str) -> Self {
        match s.to_lowercase().as_str() {
            "main" | "main:first_turn" => Self::MainFirstTurn,
            "main:user_turn" => Self::MainUserTurn,
            "main:tool:info" => Self::MainToolInfo,
            "main:tool:exec" => Self::MainToolExec,
            "main:tool:mutation" => Self::MainToolMutation,
            "main:tool:coord" => Self::MainToolCoord,
            "main:tool:flow" => Self::MainToolFlow,
            "main:tool:unknown" => Self::MainToolUnknown,
            "main:sdk" => Self::MainSdk,
            "subagent" | "subagent:explore" => Self::SubAgentExplore,
            "subagent:general" | "subagent:general-purpose" => Self::SubAgentGeneralPurpose,
            "subagent:plan" => Self::SubAgentPlan,
            "subagent:guide" => Self::SubAgentGuide,
            "subagent:statusline" => Self::SubAgentStatusline,
            "subagent:verification" => Self::SubAgentVerification,
            "subagent:fork" => Self::SubAgentFork,
            "sidequery:title" => Self::SideQueryTitle,
            "sidequery:naming" => Self::SideQueryNaming,
            "sidequery:web_search" => Self::SideQueryWebSearch,
            "sidequery:web_fetch" => Self::SideQueryWebFetch,
            "sidequery:other" | "sidequery" => Self::SideQueryOther,
            "compaction" => Self::Compaction,
            "raw_api" => Self::RawApi,
            _ => Self::MainFirstTurn,
        }
    }

    pub fn is_main(&self) -> bool {
        matches!(
            self,
            Self::MainFirstTurn
                | Self::MainUserTurn
                | Self::MainToolInfo
                | Self::MainToolExec
                | Self::MainToolMutation
                | Self::MainToolCoord
                | Self::MainToolFlow
                | Self::MainToolUnknown
                | Self::MainSdk
                | Self::CodexAgent
        )
    }

    pub fn is_subagent(&self) -> bool {
        matches!(
            self,
            Self::SubAgentExplore
                | Self::SubAgentGeneralPurpose
                | Self::SubAgentPlan
                | Self::SubAgentGuide
                | Self::SubAgentStatusline
                | Self::SubAgentVerification
                | Self::SubAgentFork
        )
    }

    pub fn is_sidequery(&self) -> bool {
        matches!(
            self,
            Self::SideQueryTitle
                | Self::SideQueryNaming
                | Self::SideQueryWebSearch
                | Self::SideQueryWebFetch
                | Self::SideQueryOther
        )
    }

    /// Whether this role can be freely routed per-request without cache concerns.
    pub fn is_independently_routable(&self) -> bool {
        !self.is_main()
    }

    pub fn tool_category(&self) -> Option<&'static str> {
        match self {
            Self::MainToolInfo => Some("info"),
            Self::MainToolExec => Some("exec"),
            Self::MainToolMutation => Some("mutation"),
            Self::MainToolCoord => Some("coord"),
            Self::MainToolFlow => Some("flow"),
            Self::MainToolUnknown => Some("unknown"),
            _ => None,
        }
    }

    /// Coarse role family for backward-compatible matching.
    pub fn family(&self) -> &'static str {
        if self.is_main() {
            "main"
        } else if self.is_subagent() {
            "subagent"
        } else if self.is_sidequery() {
            "sidequery"
        } else if *self == Self::Compaction {
            "compaction"
        } else {
            "raw_api"
        }
    }
}

const SUBAGENT_MARKER: &str = "Agent threads always have their cwd reset";

pub fn extract_cc_entrypoint(body: &Value) -> Option<String> {
    let system = body.get("system")?.as_array()?;
    let first = system.first()?;
    let text = first.get("text").and_then(|t| t.as_str())?;
    if !text.contains("cc_entrypoint=") {
        return None;
    }
    let part = text.split("cc_entrypoint=").nth(1)?;
    let entrypoint = part.split(';').next()?.trim();
    Some(entrypoint.to_string())
}

pub fn extract_cc_version_suffix(body: &Value) -> Option<String> {
    let system = body.get("system")?.as_array()?;
    let first = system.first()?;
    let text = first.get("text").and_then(|t| t.as_str())?;
    if !text.contains("cc_version=") {
        return None;
    }
    let part = text.split("cc_version=").nth(1)?;
    let version_str = part.split(';').next()?.trim();
    let suffix = version_str.rsplit('.').next()?;
    Some(suffix.to_string())
}

pub fn detect(body: &Value) -> AgentRole {
    // Codex Responses API format: uses `instructions` + `input` instead of `system` + `messages`
    if body.get("prompt_cache_key").is_some() || body.get("client_metadata").is_some() {
        return AgentRole::CodexAgent;
    }

    let system = match body.get("system") {
        Some(Value::Array(arr)) => arr,
        _ => return AgentRole::RawApi,
    };

    if system.is_empty() {
        return AgentRole::RawApi;
    }

    let full_text = system
        .iter()
        .filter_map(|block| block.get("text").and_then(|t| t.as_str()))
        .collect::<Vec<_>>()
        .join(" ");

    if full_text.is_empty() {
        return AgentRole::RawApi;
    }

    if full_text.contains(SUBAGENT_MARKER) {
        return classify_subagent(&full_text);
    }

    if is_compaction(&full_text) {
        return AgentRole::Compaction;
    }

    if full_text.contains("Generate a concise, sentence-case title") {
        return AgentRole::SideQueryTitle;
    }

    if is_sidequery_web_search(&full_text, body) {
        return AgentRole::SideQueryWebSearch;
    }

    if is_sidequery_web_fetch(&full_text, body) {
        return AgentRole::SideQueryWebFetch;
    }

    if is_sidequery_naming(&full_text) {
        return AgentRole::SideQueryNaming;
    }

    if let Some(entrypoint) = extract_cc_entrypoint(body) {
        if entrypoint.starts_with("sdk") {
            return AgentRole::MainSdk;
        }
    }

    if !full_text.contains("You are") && full_text.len() < 2000 {
        return AgentRole::SideQueryOther;
    }

    classify_main_turn(body)
}

fn is_compaction(text: &str) -> bool {
    (text.contains("summarize") || text.contains("compress") || text.contains("compaction"))
        && (text.contains("conversation") || text.contains("context"))
        && text.len() < 3000
        && !text.contains("You are Claude Code")
}

fn is_sidequery_web_search(text: &str, body: &Value) -> bool {
    if text.len() > 3000 || text.contains("You are Claude Code") {
        return false;
    }
    let msgs = body.get("messages").and_then(|m| m.as_array());
    let msg_count = msgs.map(|a| a.len()).unwrap_or(0);
    if msg_count > 3 {
        return false;
    }
    text.contains("search") && (text.contains("web") || text.contains("query"))
        && !text.contains(SUBAGENT_MARKER)
}

fn is_sidequery_web_fetch(text: &str, body: &Value) -> bool {
    if text.len() > 3000 || text.contains("You are Claude Code") {
        return false;
    }
    let msgs = body.get("messages").and_then(|m| m.as_array());
    let msg_count = msgs.map(|a| a.len()).unwrap_or(0);
    if msg_count > 3 {
        return false;
    }
    (text.contains("fetch") || text.contains("URL") || text.contains("url"))
        && !text.contains(SUBAGENT_MARKER)
}

fn is_sidequery_naming(text: &str) -> bool {
    if text.len() > 2000 || text.contains("You are Claude Code") {
        return false;
    }
    (text.contains("name") || text.contains("label"))
        && (text.contains("generate") || text.contains("suggest"))
        && !text.contains(SUBAGENT_MARKER)
}

fn classify_main_turn(body: &Value) -> AgentRole {
    let messages = match body.get("messages").and_then(|m| m.as_array()) {
        Some(m) if !m.is_empty() => m,
        _ => return AgentRole::MainFirstTurn,
    };

    let last_msg = &messages[messages.len() - 1];

    if has_tool_result(last_msg) {
        let tool_names = extract_tool_names_from_preceding(messages);
        return classify_by_tool_category(&tool_names);
    }

    let user_count = messages
        .iter()
        .filter(|m| m.get("role").and_then(|r| r.as_str()) == Some("user"))
        .count();

    if user_count <= 1 {
        AgentRole::MainFirstTurn
    } else {
        AgentRole::MainUserTurn
    }
}

fn has_tool_result(msg: &Value) -> bool {
    if msg.get("role").and_then(|r| r.as_str()) != Some("user") {
        return false;
    }
    match msg.get("content") {
        Some(Value::Array(arr)) => arr.iter().any(|block| {
            block.get("type").and_then(|t| t.as_str()) == Some("tool_result")
        }),
        _ => false,
    }
}

fn extract_tool_names_from_preceding(messages: &[Value]) -> Vec<String> {
    if messages.len() < 2 {
        return Vec::new();
    }
    let preceding = &messages[messages.len() - 2];
    if preceding.get("role").and_then(|r| r.as_str()) != Some("assistant") {
        return Vec::new();
    }
    match preceding.get("content") {
        Some(Value::Array(arr)) => arr
            .iter()
            .filter(|block| {
                block.get("type").and_then(|t| t.as_str()) == Some("tool_use")
            })
            .filter_map(|block| {
                block.get("name").and_then(|n| n.as_str()).map(String::from)
            })
            .collect(),
        _ => Vec::new(),
    }
}

fn classify_by_tool_category(tool_names: &[String]) -> AgentRole {
    if tool_names.is_empty() {
        return AgentRole::MainToolUnknown;
    }

    let mut info = 0u32;
    let mut mutation = 0u32;
    let mut exec = 0u32;
    let mut coord = 0u32;
    let mut flow = 0u32;
    let mut unknown = 0u32;

    for name in tool_names {
        let n = name.as_str();
        if INFO_TOOLS.contains(&n) {
            info += 1;
        } else if MUTATION_TOOLS.contains(&n) {
            mutation += 1;
        } else if EXEC_TOOLS.contains(&n) {
            exec += 1;
        } else if COORD_TOOLS.contains(&n) {
            coord += 1;
        } else if FLOW_TOOLS.contains(&n) {
            flow += 1;
        } else {
            unknown += 1;
        }
    }

    let max = *[info, mutation, exec, coord, flow, unknown]
        .iter()
        .max()
        .unwrap();

    if max == 0 {
        return AgentRole::MainToolUnknown;
    }

    if info == max {
        AgentRole::MainToolInfo
    } else if exec == max {
        AgentRole::MainToolExec
    } else if mutation == max {
        AgentRole::MainToolMutation
    } else if coord == max {
        AgentRole::MainToolCoord
    } else if flow == max {
        AgentRole::MainToolFlow
    } else {
        AgentRole::MainToolUnknown
    }
}

fn classify_subagent(text: &str) -> AgentRole {
    if text.contains("file search specialist") {
        return AgentRole::SubAgentExplore;
    }
    if text.contains("software architect and planning specialist")
        || text.contains("Software architect")
    {
        return AgentRole::SubAgentPlan;
    }
    if text.contains("Claude guide agent")
        || (text.contains("Claude Code")
            && text.contains("Claude Agent SDK")
            && text.contains("Claude API"))
    {
        return AgentRole::SubAgentGuide;
    }
    if text.contains("configure the user") && text.contains("status line") {
        return AgentRole::SubAgentStatusline;
    }
    if text.contains("verification") && text.contains("test") && text.contains("validate") {
        return AgentRole::SubAgentVerification;
    }
    if text.contains("complete the task fully")
        || (text.contains("Given the user") && text.contains("complete the task"))
    {
        return AgentRole::SubAgentGeneralPurpose;
    }
    if text.contains("You are an interactive agent") {
        return AgentRole::SubAgentFork;
    }
    AgentRole::SubAgentGeneralPurpose
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_detect_main_first_turn() {
        let body = json!({
            "system": [
                {"type": "text", "text": "x-anthropic-billing-header: cc_version=2.1.112.abc; cc_entrypoint=cli;"},
                {"type": "text", "text": "You are Claude Code, Anthropic's official CLI for Claude."},
                {"type": "text", "text": "\nYou are an interactive agent that helps users with software engineering tasks."}
            ],
            "model": "Claude-Opus-4.6",
            "messages": [
                {"role": "user", "content": "Hello"}
            ]
        });
        assert_eq!(detect(&body), AgentRole::MainFirstTurn);
    }

    #[test]
    fn test_detect_main_user_turn() {
        let body = json!({
            "system": [
                {"type": "text", "text": "x-anthropic-billing-header: cc_version=2.1.112.abc; cc_entrypoint=cli;"},
                {"type": "text", "text": "You are Claude Code, Anthropic's official CLI for Claude."}
            ],
            "messages": [
                {"role": "user", "content": "first question"},
                {"role": "assistant", "content": "answer"},
                {"role": "user", "content": "second question"}
            ]
        });
        assert_eq!(detect(&body), AgentRole::MainUserTurn);
    }

    #[test]
    fn test_detect_main_tool_info() {
        let body = json!({
            "system": [
                {"type": "text", "text": "You are Claude Code, Anthropic's official CLI for Claude."}
            ],
            "messages": [
                {"role": "user", "content": "read a file"},
                {"role": "assistant", "content": [
                    {"type": "tool_use", "id": "t1", "name": "Read", "input": {"file_path": "/tmp/x"}}
                ]},
                {"role": "user", "content": [
                    {"type": "tool_result", "tool_use_id": "t1", "content": "file contents"}
                ]}
            ]
        });
        assert_eq!(detect(&body), AgentRole::MainToolInfo);
    }

    #[test]
    fn test_detect_main_tool_exec() {
        let body = json!({
            "system": [
                {"type": "text", "text": "You are Claude Code, Anthropic's official CLI for Claude."}
            ],
            "messages": [
                {"role": "user", "content": "run tests"},
                {"role": "assistant", "content": [
                    {"type": "tool_use", "id": "t1", "name": "Bash", "input": {"command": "cargo test"}}
                ]},
                {"role": "user", "content": [
                    {"type": "tool_result", "tool_use_id": "t1", "content": "tests passed"}
                ]}
            ]
        });
        assert_eq!(detect(&body), AgentRole::MainToolExec);
    }

    #[test]
    fn test_detect_main_tool_mutation() {
        let body = json!({
            "system": [
                {"type": "text", "text": "You are Claude Code, Anthropic's official CLI for Claude."}
            ],
            "messages": [
                {"role": "user", "content": "edit file"},
                {"role": "assistant", "content": [
                    {"type": "tool_use", "id": "t1", "name": "Edit", "input": {}}
                ]},
                {"role": "user", "content": [
                    {"type": "tool_result", "tool_use_id": "t1", "content": "done"}
                ]}
            ]
        });
        assert_eq!(detect(&body), AgentRole::MainToolMutation);
    }

    #[test]
    fn test_detect_main_tool_coord() {
        let body = json!({
            "system": [
                {"type": "text", "text": "You are Claude Code, Anthropic's official CLI for Claude."}
            ],
            "messages": [
                {"role": "user", "content": "spawn agent"},
                {"role": "assistant", "content": [
                    {"type": "tool_use", "id": "t1", "name": "Agent", "input": {}}
                ]},
                {"role": "user", "content": [
                    {"type": "tool_result", "tool_use_id": "t1", "content": "done"}
                ]}
            ]
        });
        assert_eq!(detect(&body), AgentRole::MainToolCoord);
    }

    #[test]
    fn test_detect_main_tool_flow() {
        let body = json!({
            "system": [
                {"type": "text", "text": "You are Claude Code, Anthropic's official CLI for Claude."}
            ],
            "messages": [
                {"role": "user", "content": "ask user"},
                {"role": "assistant", "content": [
                    {"type": "tool_use", "id": "t1", "name": "AskUserQuestion", "input": {}}
                ]},
                {"role": "user", "content": [
                    {"type": "tool_result", "tool_use_id": "t1", "content": "answer"}
                ]}
            ]
        });
        assert_eq!(detect(&body), AgentRole::MainToolFlow);
    }

    #[test]
    fn test_detect_main_tool_mixed_favors_dominant() {
        let body = json!({
            "system": [
                {"type": "text", "text": "You are Claude Code, Anthropic's official CLI for Claude."}
            ],
            "messages": [
                {"role": "user", "content": "do stuff"},
                {"role": "assistant", "content": [
                    {"type": "tool_use", "id": "t1", "name": "Read", "input": {}},
                    {"type": "tool_use", "id": "t2", "name": "Grep", "input": {}},
                    {"type": "tool_use", "id": "t3", "name": "Bash", "input": {}}
                ]},
                {"role": "user", "content": [
                    {"type": "tool_result", "tool_use_id": "t1", "content": ""},
                    {"type": "tool_result", "tool_use_id": "t2", "content": ""},
                    {"type": "tool_result", "tool_use_id": "t3", "content": ""}
                ]}
            ]
        });
        assert_eq!(detect(&body), AgentRole::MainToolInfo);
    }

    #[test]
    fn test_detect_main_sdk() {
        let body = json!({
            "system": [
                {"type": "text", "text": "x-anthropic-billing-header: cc_version=2.1.112.abc; cc_entrypoint=sdk-ts;"},
                {"type": "text", "text": "You are Claude Code, Anthropic's official CLI for Claude."}
            ],
            "messages": [{"role": "user", "content": "hi"}]
        });
        assert_eq!(detect(&body), AgentRole::MainSdk);
    }

    #[test]
    fn test_detect_subagent_explore() {
        let body = json!({
            "system": [
                {"type": "text", "text": "You are a file search specialist for Claude Code."},
                {"type": "text", "text": "Notes:\n- Agent threads always have their cwd reset between bash calls"}
            ],
            "messages": []
        });
        assert_eq!(detect(&body), AgentRole::SubAgentExplore);
    }

    #[test]
    fn test_detect_subagent_plan() {
        let body = json!({
            "system": [
                {"type": "text", "text": "You are a software architect and planning specialist for Claude Code."},
                {"type": "text", "text": "Notes:\n- Agent threads always have their cwd reset between bash calls"}
            ],
            "messages": []
        });
        assert_eq!(detect(&body), AgentRole::SubAgentPlan);
    }

    #[test]
    fn test_detect_subagent_general_purpose() {
        let body = json!({
            "system": [
                {"type": "text", "text": "You are an agent for Claude Code. Given the user's message, you should use the tools available to complete the task. Complete the task fully."},
                {"type": "text", "text": "Notes:\n- Agent threads always have their cwd reset between bash calls"}
            ],
            "messages": []
        });
        assert_eq!(detect(&body), AgentRole::SubAgentGeneralPurpose);
    }

    #[test]
    fn test_detect_subagent_guide() {
        let body = json!({
            "system": [
                {"type": "text", "text": "You are the Claude guide agent. Your primary responsibility is helping users understand and use Claude Code, the Claude Agent SDK, and the Claude API effectively."},
                {"type": "text", "text": "Notes:\n- Agent threads always have their cwd reset between bash calls"}
            ],
            "messages": []
        });
        assert_eq!(detect(&body), AgentRole::SubAgentGuide);
    }

    #[test]
    fn test_detect_subagent_fork() {
        let body = json!({
            "system": [
                {"type": "text", "text": "You are Claude Code, Anthropic's official CLI for Claude."},
                {"type": "text", "text": "You are an interactive agent that helps users with software engineering tasks."},
                {"type": "text", "text": "Notes:\n- Agent threads always have their cwd reset between bash calls"}
            ],
            "messages": []
        });
        assert_eq!(detect(&body), AgentRole::SubAgentFork);
    }

    #[test]
    fn test_detect_sidequery_title() {
        let body = json!({
            "system": [
                {"type": "text", "text": "Generate a concise, sentence-case title (3-7 words) that captures the main topic."}
            ],
            "messages": []
        });
        assert_eq!(detect(&body), AgentRole::SideQueryTitle);
    }

    #[test]
    fn test_detect_raw_api() {
        let body = json!({
            "model": "claude-opus-4-20250514",
            "messages": [{"role": "user", "content": "hello"}]
        });
        assert_eq!(detect(&body), AgentRole::RawApi);
    }

    #[test]
    fn test_detect_no_system_array() {
        let body = json!({
            "system": "just a string",
            "messages": []
        });
        assert_eq!(detect(&body), AgentRole::RawApi);
    }

    #[test]
    fn test_extract_cc_entrypoint() {
        let body = json!({
            "system": [
                {"type": "text", "text": "x-anthropic-billing-header: cc_version=2.1.112.abc; cc_entrypoint=cli; cch=12345;"}
            ]
        });
        assert_eq!(extract_cc_entrypoint(&body), Some("cli".to_string()));
    }

    #[test]
    fn test_extract_cc_entrypoint_sdk() {
        let body = json!({
            "system": [
                {"type": "text", "text": "x-anthropic-billing-header: cc_version=2.1.112.abc; cc_entrypoint=sdk-ts; cch=12345;"}
            ]
        });
        assert_eq!(extract_cc_entrypoint(&body), Some("sdk-ts".to_string()));
    }

    #[test]
    fn test_display() {
        assert_eq!(AgentRole::MainFirstTurn.to_string(), "main:first_turn");
        assert_eq!(AgentRole::MainUserTurn.to_string(), "main:user_turn");
        assert_eq!(AgentRole::MainToolInfo.to_string(), "main:tool:info");
        assert_eq!(AgentRole::MainToolExec.to_string(), "main:tool:exec");
        assert_eq!(AgentRole::MainToolMutation.to_string(), "main:tool:mutation");
        assert_eq!(AgentRole::MainToolCoord.to_string(), "main:tool:coord");
        assert_eq!(AgentRole::MainToolFlow.to_string(), "main:tool:flow");
        assert_eq!(AgentRole::MainToolUnknown.to_string(), "main:tool:unknown");
        assert_eq!(AgentRole::MainSdk.to_string(), "main:sdk");
        assert_eq!(AgentRole::SubAgentExplore.to_string(), "subagent:explore");
        assert_eq!(AgentRole::SubAgentGeneralPurpose.to_string(), "subagent:general");
        assert_eq!(AgentRole::SubAgentPlan.to_string(), "subagent:plan");
        assert_eq!(AgentRole::SubAgentGuide.to_string(), "subagent:guide");
        assert_eq!(AgentRole::SubAgentFork.to_string(), "subagent:fork");
        assert_eq!(AgentRole::SideQueryTitle.to_string(), "sidequery:title");
        assert_eq!(AgentRole::SideQueryNaming.to_string(), "sidequery:naming");
        assert_eq!(AgentRole::SideQueryWebSearch.to_string(), "sidequery:web_search");
        assert_eq!(AgentRole::SideQueryWebFetch.to_string(), "sidequery:web_fetch");
        assert_eq!(AgentRole::Compaction.to_string(), "compaction");
        assert_eq!(AgentRole::RawApi.to_string(), "raw_api");
    }

    #[test]
    fn test_from_str_loose() {
        assert_eq!(AgentRole::from_str_loose("main"), AgentRole::MainFirstTurn);
        assert_eq!(AgentRole::from_str_loose("main:first_turn"), AgentRole::MainFirstTurn);
        assert_eq!(AgentRole::from_str_loose("main:user_turn"), AgentRole::MainUserTurn);
        assert_eq!(AgentRole::from_str_loose("main:tool:info"), AgentRole::MainToolInfo);
        assert_eq!(AgentRole::from_str_loose("main:tool:exec"), AgentRole::MainToolExec);
        assert_eq!(AgentRole::from_str_loose("main:tool:mutation"), AgentRole::MainToolMutation);
        assert_eq!(AgentRole::from_str_loose("main:tool:coord"), AgentRole::MainToolCoord);
        assert_eq!(AgentRole::from_str_loose("main:tool:flow"), AgentRole::MainToolFlow);
        assert_eq!(AgentRole::from_str_loose("main:sdk"), AgentRole::MainSdk);
        assert_eq!(AgentRole::from_str_loose("subagent:explore"), AgentRole::SubAgentExplore);
        assert_eq!(AgentRole::from_str_loose("subagent"), AgentRole::SubAgentExplore);
        assert_eq!(AgentRole::from_str_loose("subagent:general"), AgentRole::SubAgentGeneralPurpose);
        assert_eq!(AgentRole::from_str_loose("subagent:plan"), AgentRole::SubAgentPlan);
        assert_eq!(AgentRole::from_str_loose("sidequery:title"), AgentRole::SideQueryTitle);
        assert_eq!(AgentRole::from_str_loose("sidequery:naming"), AgentRole::SideQueryNaming);
        assert_eq!(AgentRole::from_str_loose("sidequery:web_search"), AgentRole::SideQueryWebSearch);
        assert_eq!(AgentRole::from_str_loose("compaction"), AgentRole::Compaction);
        assert_eq!(AgentRole::from_str_loose("raw_api"), AgentRole::RawApi);
    }

    #[test]
    fn test_is_main() {
        assert!(AgentRole::MainFirstTurn.is_main());
        assert!(AgentRole::MainUserTurn.is_main());
        assert!(AgentRole::MainToolInfo.is_main());
        assert!(AgentRole::MainToolExec.is_main());
        assert!(AgentRole::MainToolMutation.is_main());
        assert!(AgentRole::MainToolCoord.is_main());
        assert!(AgentRole::MainToolFlow.is_main());
        assert!(AgentRole::MainToolUnknown.is_main());
        assert!(AgentRole::MainSdk.is_main());
        assert!(!AgentRole::SubAgentExplore.is_main());
        assert!(!AgentRole::SideQueryTitle.is_main());
        assert!(!AgentRole::Compaction.is_main());
        assert!(!AgentRole::RawApi.is_main());
    }

    #[test]
    fn test_is_subagent() {
        assert!(!AgentRole::MainFirstTurn.is_subagent());
        assert!(AgentRole::SubAgentExplore.is_subagent());
        assert!(AgentRole::SubAgentGeneralPurpose.is_subagent());
        assert!(AgentRole::SubAgentPlan.is_subagent());
        assert!(AgentRole::SubAgentGuide.is_subagent());
        assert!(AgentRole::SubAgentFork.is_subagent());
        assert!(!AgentRole::SideQueryTitle.is_subagent());
        assert!(!AgentRole::RawApi.is_subagent());
    }

    #[test]
    fn test_is_sidequery() {
        assert!(!AgentRole::MainFirstTurn.is_sidequery());
        assert!(!AgentRole::SubAgentExplore.is_sidequery());
        assert!(AgentRole::SideQueryTitle.is_sidequery());
        assert!(AgentRole::SideQueryOther.is_sidequery());
        assert!(AgentRole::SideQueryWebSearch.is_sidequery());
        assert!(AgentRole::SideQueryWebFetch.is_sidequery());
        assert!(AgentRole::SideQueryNaming.is_sidequery());
    }

    #[test]
    fn test_is_independently_routable() {
        assert!(!AgentRole::MainFirstTurn.is_independently_routable());
        assert!(!AgentRole::MainToolInfo.is_independently_routable());
        assert!(AgentRole::SubAgentExplore.is_independently_routable());
        assert!(AgentRole::SideQueryTitle.is_independently_routable());
        assert!(AgentRole::Compaction.is_independently_routable());
        assert!(AgentRole::RawApi.is_independently_routable());
    }

    #[test]
    fn test_tool_category() {
        assert_eq!(AgentRole::MainToolInfo.tool_category(), Some("info"));
        assert_eq!(AgentRole::MainToolExec.tool_category(), Some("exec"));
        assert_eq!(AgentRole::MainToolMutation.tool_category(), Some("mutation"));
        assert_eq!(AgentRole::MainToolCoord.tool_category(), Some("coord"));
        assert_eq!(AgentRole::MainToolFlow.tool_category(), Some("flow"));
        assert_eq!(AgentRole::MainToolUnknown.tool_category(), Some("unknown"));
        assert_eq!(AgentRole::MainFirstTurn.tool_category(), None);
        assert_eq!(AgentRole::SubAgentExplore.tool_category(), None);
    }

    #[test]
    fn test_family() {
        assert_eq!(AgentRole::MainFirstTurn.family(), "main");
        assert_eq!(AgentRole::MainToolInfo.family(), "main");
        assert_eq!(AgentRole::SubAgentExplore.family(), "subagent");
        assert_eq!(AgentRole::SideQueryTitle.family(), "sidequery");
        assert_eq!(AgentRole::Compaction.family(), "compaction");
        assert_eq!(AgentRole::RawApi.family(), "raw_api");
    }

    #[test]
    fn test_extract_cc_version_suffix() {
        let body = json!({
            "system": [
                {"type": "text", "text": "x-anthropic-billing-header: cc_version=2.1.112.abc; cc_entrypoint=cli;"}
            ]
        });
        assert_eq!(extract_cc_version_suffix(&body), Some("abc".to_string()));
    }

    #[test]
    fn test_classify_tool_info_multiple() {
        let names = vec!["Read".into(), "Grep".into(), "Glob".into()];
        assert_eq!(classify_by_tool_category(&names), AgentRole::MainToolInfo);
    }

    #[test]
    fn test_classify_tool_empty() {
        let names: Vec<String> = vec![];
        assert_eq!(classify_by_tool_category(&names), AgentRole::MainToolUnknown);
    }

    #[test]
    fn test_classify_tool_unknown_name() {
        let names = vec!["SomeFutureTool".into()];
        assert_eq!(classify_by_tool_category(&names), AgentRole::MainToolUnknown);
    }
}
