use cc_proxy::{cli, config, server};
use clap::{Parser, Subcommand};
use colored::Colorize;
use std::sync::Arc;
use tokio::sync::Notify;

static SHUTDOWN: std::sync::OnceLock<Arc<Notify>> = std::sync::OnceLock::new();

fn shutdown_notify() -> Arc<Notify> {
    SHUTDOWN.get_or_init(|| Arc::new(Notify::new())).clone()
}

async fn shutdown_signal() {
    let ctrl_c = tokio::signal::ctrl_c();
    #[cfg(unix)]
    {
        let mut sigterm = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("failed to install SIGTERM handler");
        tokio::select! {
            _ = ctrl_c => { eprintln!("\n  Received SIGINT, shutting down..."); }
            _ = sigterm.recv() => { eprintln!("\n  Received SIGTERM, shutting down..."); }
        }
    }
    #[cfg(not(unix))]
    {
        ctrl_c.await.ok();
        eprintln!("\n  Received SIGINT, shutting down...");
    }
    shutdown_notify().notify_waiters();
}

async fn shutdown_signal_fence() {
    shutdown_notify().notified().await;
}

#[derive(Parser)]
#[command(name = "cc-proxy", version, about = "Claude Code model switch proxy with failover")]
struct Cli {
    #[arg(short, long, help = "Path to config file")]
    config: Option<String>,

    #[command(subcommand)]
    command: Option<Commands>,
}

#[derive(Subcommand)]
enum Commands {
    /// Start the proxy server (default)
    Serve,
    /// Print shell export commands for Claude Code integration
    Activate,
    /// Generate a default config file
    Init,
    /// Show daemon status
    Status,
    /// Hot-reload configuration
    Reload,
    /// Immediately refresh strategies from DuckDB
    StrategyRefresh,
    /// Session management
    Session {
        #[command(subcommand)]
        action: SessionCmd,
    },
    /// Profile management
    Profile {
        #[command(subcommand)]
        action: ProfileCmd,
    },
    /// Statistics from routing log
    Stats {
        #[command(subcommand)]
        action: StatsCmd,
    },
    /// Print log directory path for a session
    Logs {
        /// Session ID
        session_id: String,
    },
    /// Run self-diagnostics
    Doctor,

    #[command(hide = true)]
    /// Shadow mode (Phase 2)
    Shadow,
    #[command(hide = true)]
    /// Canary mode (Phase 3)
    Canary,
    #[command(hide = true)]
    /// Auto-evolve (Phase 4)
    Evolve,
}

#[derive(Subcommand)]
enum SessionCmd {
    /// List session bindings
    List,
    /// Show session details
    Show { session_id: String },
    /// Bind session to a profile
    Bind {
        session_id: String,
        profile: String,
    },
    /// Unbind session from profile
    Unbind { session_id: String },
    /// Tail session logs
    Tail { session_id: String },
}

#[derive(Subcommand)]
enum ProfileCmd {
    /// List all profiles and dispatch rules
    List,
    /// Show profile priority chain
    Show { name: String },
    /// Dry-run dispatch for a model
    Test {
        name: String,
        #[arg(long)]
        model: Option<String>,
    },
}

#[derive(Subcommand)]
enum StatsCmd {
    /// Overall statistics
    Overview,
    /// Statistics grouped by profile
    ByProfile,
    /// Statistics grouped by model
    ByModel,
    /// Statistics grouped by cluster
    ByCluster {
        #[arg(long, default_value = "10")]
        top: usize,
    },
    /// Most hesitant responses (low HVR)
    Hesitant {
        #[arg(long, default_value = "20")]
        limit: usize,
    },
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let cli_args = Cli::parse();
    let config_path = cli_args.config.as_deref();

    match cli_args.command.unwrap_or(Commands::Serve) {
        Commands::Init => cmd_init()?,
        Commands::Activate => cmd_activate(config_path)?,
        Commands::Serve => cmd_serve(config_path).await?,
        Commands::Status => cli::cmd_status(config_path).await?,
        Commands::Reload => cli::cmd_reload(config_path).await?,
        Commands::StrategyRefresh => cli::cmd_strategy_refresh(config_path).await?,
        Commands::Session { action } => match action {
            SessionCmd::List => cli::cmd_session_list(config_path).await?,
            SessionCmd::Show { session_id } => cli::cmd_session_show(config_path, &session_id)?,
            SessionCmd::Bind { session_id, profile } => cli::cmd_session_bind(config_path, &session_id, &profile).await?,
            SessionCmd::Unbind { session_id } => cli::cmd_session_unbind(config_path, &session_id).await?,
            SessionCmd::Tail { session_id } => cli::cmd_session_tail(config_path, &session_id)?,
        },
        Commands::Profile { action } => match action {
            ProfileCmd::List => cli::cmd_profile_list(config_path).await?,
            ProfileCmd::Show { name } => cli::cmd_profile_show(config_path, &name).await?,
            ProfileCmd::Test { name, model } => cli::cmd_profile_test(config_path, &name, model.as_deref()).await?,
        },
        Commands::Stats { action } => match action {
            StatsCmd::Overview => cli::cmd_stats_overview(config_path)?,
            StatsCmd::ByProfile => cli::cmd_stats_by_profile(config_path)?,
            StatsCmd::ByModel => cli::cmd_stats_by_model(config_path)?,
            StatsCmd::ByCluster { top } => cli::cmd_stats_by_cluster(config_path, top)?,
            StatsCmd::Hesitant { limit } => cli::cmd_stats_hesitant(config_path, limit)?,
        },
        Commands::Logs { session_id } => cli::cmd_logs(config_path, &session_id)?,
        Commands::Doctor => cli::cmd_doctor(config_path)?,
        Commands::Shadow | Commands::Canary | Commands::Evolve => {
            println!("{}", "This feature is not yet available.".dimmed());
        }
    }

    Ok(())
}

fn cmd_init() -> anyhow::Result<()> {
    let config_path = config::Config::default_path()?;
    if config_path.exists() {
        println!("Config already exists at {}", config_path.display());
        return Ok(());
    }

    let parent = config_path.parent().unwrap();
    std::fs::create_dir_all(parent)?;

    let default_config = serde_json::json!({
        "host": "127.0.0.1",
        "port": 3456,
        "log_level": "info",
        "timeout_secs": 300,
        "providers": [
            {
                "name": "anthropic",
                "type": "anthropic",
                "api_key": "$ANTHROPIC_API_KEY",
                "base_url": "https://api.anthropic.com",
                "models": ["claude-opus-4-20250514", "claude-sonnet-4-20250514", "claude-haiku-4-5-20251001"]
            },
            {
                "name": "openrouter",
                "type": "openai",
                "api_key": "$OPENROUTER_API_KEY",
                "base_url": "https://openrouter.ai/api/v1",
                "models": ["anthropic/claude-opus-4", "anthropic/claude-sonnet-4", "anthropic/claude-haiku-4"]
            }
        ],
        "priority": [
            {"provider": "anthropic", "model": "claude-opus-4-20250514"},
            {"provider": "openrouter", "model": "anthropic/claude-opus-4"}
        ],
        "profiles": {
            "premium": [
                {"provider": "anthropic", "model": "claude-opus-4-20250514"},
                {"provider": "openrouter", "model": "anthropic/claude-opus-4"}
            ],
            "balanced": [
                {"provider": "anthropic", "model": "claude-sonnet-4-20250514"},
                {"provider": "openrouter", "model": "anthropic/claude-sonnet-4"}
            ],
            "cheap": [
                {"provider": "anthropic", "model": "claude-haiku-4-5-20251001"},
                {"provider": "openrouter", "model": "anthropic/claude-haiku-4"}
            ]
        },
        "routing": {
            "hvr_enabled": true,
            "memory_enabled": true,
            "memory_db_path": "~/.cc-proxy/memory.duckdb",
            "dispatch": {
                "default_profile": "default",
                "rules": [
                    {"match": {"model_pattern": "opus"},   "profile": "premium"},
                    {"match": {"model_pattern": "sonnet"}, "profile": "balanced"},
                    {"match": {"model_pattern": "haiku"},  "profile": "cheap"}
                ]
            }
        },
        "retry_codes": [429, 500, 502, 503, 529],
        "log_dir": "~/.cc-proxy/logs"
    });

    let content = serde_json::to_string_pretty(&default_config)?;
    std::fs::write(&config_path, content)?;
    println!("Config created at {}", config_path.display());
    println!("Edit it to add your API keys and providers.");
    Ok(())
}

fn cmd_activate(config_path: Option<&str>) -> anyhow::Result<()> {
    let cfg = config::Config::load(config_path)?;
    let addr = format!("http://{}:{}", cfg.host, cfg.port);
    println!("export ANTHROPIC_BASE_URL=\"{addr}\"");
    println!("export ANTHROPIC_API_KEY=\"cc-proxy-proxy\"");
    println!("export DISABLE_COST_WARNINGS=\"1\"");
    println!("export NO_PROXY=\"127.0.0.1\"");
    Ok(())
}

async fn cmd_serve(config_path: Option<&str>) -> anyhow::Result<()> {
    let cfg = config::Config::load(config_path)?;

    // Install panic hook to write crash info to log_dir before dying
    let log_dir = cfg.log_dir.replace('~', &std::env::var("HOME").unwrap_or_default());
    let crash_log = std::path::PathBuf::from(&log_dir).join("crash.log");
    std::panic::set_hook(Box::new(move |info| {
        let msg = if let Some(s) = info.payload().downcast_ref::<&str>() {
            s.to_string()
        } else if let Some(s) = info.payload().downcast_ref::<String>() {
            s.clone()
        } else {
            "unknown panic payload".to_string()
        };
        let location = info.location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "unknown location".to_string());
        let timestamp = chrono::Local::now().to_rfc3339();
        let record = serde_json::json!({
            "timestamp": timestamp,
            "type": "crash",
            "message": msg,
            "location": location,
        });
        let line = serde_json::to_string(&record).unwrap_or_default();
        // Write to crash.log (append)
        use std::io::Write;
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&crash_log) {
            let _ = writeln!(f, "{}", line);
        }
        // Also print to stderr so watchdog/parent process can capture it
        eprintln!("\n[cc-proxy CRASH] {} at {}\n{}", msg, location, line);
    }));

    let addr = format!("{}:{}", cfg.host, cfg.port);

    eprintln!();
    eprintln!("  {} {}", "cc-proxy".bold(), "v0.1.0".dimmed());
    eprintln!("  {} http://{}", "Listening:".green().bold(), addr.cyan());
    eprintln!();

    if !cfg.profiles.is_empty() {
        eprintln!("  {}:", "Profiles".yellow().bold());
        for (name, chain) in &cfg.profiles {
            let entries: Vec<String> = chain.iter().map(|e| format!("{}/{}", e.provider, e.model)).collect();
            eprintln!("    {}: {}", name.cyan(), entries.join(" -> ").dimmed());
        }
    } else {
        eprintln!("  {}:", "Priority Chain".yellow().bold());
        for (i, entry) in cfg.priority.iter().enumerate() {
            let marker = if i == 0 {
                "PRIMARY".green().bold().to_string()
            } else {
                format!("{}", format!("FALLBACK#{i}").yellow().bold())
            };
            eprintln!("    {} {}/{}", marker, entry.provider.cyan(), entry.model);
        }
    }

    let dispatch_rules = cfg.routing.dispatch.rules.len();
    let default_profile = &cfg.routing.dispatch.default_profile;
    eprintln!();
    eprintln!("  {}:", "Dispatch".yellow().bold());
    eprintln!("    {} {}", "default:".dimmed(), default_profile.cyan());
    eprintln!("    {} {}", "rules:".dimmed(), dispatch_rules);
    eprintln!();
    eprintln!("  {} {}", "Log Dir:".yellow().bold(), cfg.log_dir.cyan());
    eprintln!();
    eprintln!("  {}:", "Routing".yellow().bold());
    eprintln!("    {} {}", "HVR:".dimmed(), if cfg.routing.hvr_enabled { "ON".green().bold() } else { "OFF".red().bold() });
    if cfg.routing.memory_enabled {
        eprintln!("    {} {}", "Memory:".dimmed(), cfg.routing.memory_db_path.cyan());
    } else {
        eprintln!("    {} {}", "Memory:".dimmed(), "OFF".red().bold());
    }
    eprintln!("    {} {}", "Shadow:".dimmed(), if cfg.routing.shadow.enabled { "ON".green().bold() } else { "OFF (Phase 2)".dimmed() });
    eprintln!("    {} {}", "Canary:".dimmed(), format!("{}%", cfg.routing.canary_pct).dimmed());
    eprintln!();
    eprintln!("  {} eval \"$(cc-proxy activate)\"", "Activate:".dimmed());
    eprintln!();

    let (router, memory_handle) = server::create_router(cfg);
    let listener = tokio::net::TcpListener::bind(&addr).await?;

    let server = axum::serve(listener, router)
        .with_graceful_shutdown(shutdown_signal());

    tokio::select! {
        result = server => { result?; }
        _ = async {
            shutdown_signal_fence().await;
            tokio::time::sleep(std::time::Duration::from_secs(3)).await;
            eprintln!("  {} (force after 3s)", "Timeout waiting for connections".yellow());
        } => {}
    }

    if let Some(mem) = memory_handle {
        eprint!("  Checkpointing DuckDB... ");
        match mem.checkpoint() {
            Ok(_) => eprintln!("{}", "done".green()),
            Err(e) => eprintln!("{} {e}", "failed:".red()),
        }
    }

    eprintln!("  {} gracefully", "Shutdown".yellow().bold());
    Ok(())
}
