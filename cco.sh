#!/usr/bin/env bash
set -euo pipefail

# ── paths ────────────────────────────────────────────────────────────────
_resolve_link() {
    local f="$1"
    while [[ -L "$f" ]]; do
        local dir; dir=$(cd "$(dirname "$f")" && pwd)
        f="$(readlink "$f")"
        [[ "$f" != /* ]] && f="$dir/$f"
    done
    echo "$f"
}
SCRIPT_DIR="$(cd "$(dirname "$(_resolve_link "$0")")" && pwd)"
CCO_HOME="$HOME/.cc-proxy"
RUN_DIR="$CCO_HOME/run"
LOG_DIR="$CCO_HOME/logs"
CONFIG_FILE="$CCO_HOME/config.json"
PROXY_PORT=3456
WEB_PORT=4318

# 从 env.sh 加载 FRONTEND_DIR 等配置，回退到 SCRIPT_DIR 相对路径
[[ -f "$CCO_HOME/env.sh" ]] && source "$CCO_HOME/env.sh"
FRONTEND_DIR="${FRONTEND_DIR:-$SCRIPT_DIR/agent-observe-frontend}"

# ── colors ───────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; DIM='\033[2m'; RESET='\033[0m'

# ── helpers ──────────────────────────────────────────────────────────────
_info()  { echo -e "${CYAN}▸${RESET} $*"; }
_ok()    { echo -e "${GREEN}✓${RESET} $*"; }
_warn()  { echo -e "${YELLOW}!${RESET} $*"; }
_err()   { echo -e "${RED}✗${RESET} $*" >&2; }
_die()   { _err "$@"; exit 1; }

_ensure_run_dir() { mkdir -p "$RUN_DIR"; }

_find_proxy_bin() {
    local arch os
    arch="$(uname -m)"
    os="$(uname -s)"
    [[ "$arch" == "arm64" ]] && arch="aarch64"
    local bundled
    if [[ "$os" == "Darwin" ]]; then
        bundled="$FRONTEND_DIR/bin/cc-proxy-${arch}-apple-darwin"
    else
        bundled="$FRONTEND_DIR/bin/cc-proxy-${arch}-unknown-linux-musl"
    fi
    if [[ -x "$bundled" ]]; then
        echo "$bundled"
        return
    fi
    if command -v cc-proxy &>/dev/null; then
        command -v cc-proxy
        return
    fi
    return 1
}

_read_port_from_config() {
    if [[ -f "$CONFIG_FILE" ]]; then
        local p
        p=$(grep -o '"port"[[:space:]]*:[[:space:]]*[0-9]*' "$CONFIG_FILE" 2>/dev/null | head -1 | grep -o '[0-9]*$')
        [[ -n "$p" ]] && PROXY_PORT="$p"
    fi
}

_pid_alive() {
    local pid="$1"
    [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

_read_pid() {
    local pidfile="$RUN_DIR/$1.pid"
    [[ -f "$pidfile" ]] && cat "$pidfile" || echo ""
}

_write_pid() {
    echo "$2" > "$RUN_DIR/$1.pid"
}

_remove_pid() {
    rm -f "$RUN_DIR/$1.pid"
}

# Resolve PID for a service: PID file first, then port fallback
_resolve_pid() {
    local name="$1" port="$2"
    local pid; pid=$(_read_pid "$name")
    if _pid_alive "$pid"; then
        echo "$pid"
        return
    fi
    # fallback: detect from port
    local port_pid
    if command -v lsof &>/dev/null; then
        port_pid=$(lsof -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | head -1)
    elif command -v ss &>/dev/null; then
        port_pid=$(ss -tlnpH "sport = :$port" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | head -1)
    fi
    if [[ -n "$port_pid" ]]; then
        echo "$port_pid"
        return
    fi
    echo ""
}

_uptime_str() {
    local pid="$1"
    if [[ "$(uname)" == "Darwin" ]]; then
        local started
        started=$(ps -o lstart= -p "$pid" 2>/dev/null) || return
        local start_epoch
        start_epoch=$(date -j -f "%a %b %d %T %Y" "$started" "+%s" 2>/dev/null) || return
        local now_epoch
        now_epoch=$(date "+%s")
        local diff=$(( now_epoch - start_epoch ))
        local d=$(( diff / 86400 ))
        local h=$(( diff % 86400 / 3600 ))
        local m=$(( diff % 3600 / 60 ))
        if [ "$d" -gt 0 ]; then echo "${d}d${h}h"
        elif [ "$h" -gt 0 ]; then echo "${h}h${m}m"
        else echo "${m}m"; fi
    else
        local et
        et=$(ps -o etimes= -p "$pid" 2>/dev/null | tr -d ' ') || return
        local h=$(( et / 3600 ))
        local m=$(( et % 3600 / 60 ))
        if [ "$h" -gt 0 ]; then echo "${h}h${m}m"
        else echo "${m}m"; fi
    fi
}

_port_in_use() {
    if command -v lsof &>/dev/null; then
        lsof -iTCP:"$1" -sTCP:LISTEN -t &>/dev/null
    elif command -v ss &>/dev/null; then
        ss -tlnH "sport = :$1" 2>/dev/null | grep -q .
    else
        grep -q ":$(printf '%04X' "$1") " /proc/net/tcp /proc/net/tcp6 2>/dev/null
    fi
}

# ── start ────────────────────────────────────────────────────────────────
cmd_start() {
    _ensure_run_dir
    _read_port_from_config
    local pid; pid=$(_resolve_pid web "$WEB_PORT")
    if _pid_alive "$pid"; then
        _warn "agent-observe already running (PID $pid, port $WEB_PORT)"
        return 0
    fi

    if ! [[ -d "$FRONTEND_DIR" ]]; then
        _die "frontend not found at $FRONTEND_DIR"
    fi

    _info "starting agent-observe on :${WEB_PORT} (cc-proxy auto-managed)"
    (
        cd "$FRONTEND_DIR"
        CCO_NO_BROWSER=1 nohup node server.js \
            >> "$RUN_DIR/web.log" 2>&1 &
        echo $! > "$RUN_DIR/web.pid"
    )
    # wait for frontend to be ready (max 10s)
    local waited=0
    while [ "$waited" -lt 100 ] && ! _port_in_use "$WEB_PORT"; do
        sleep 0.1
        waited=$((waited+1))
    done
    local new_pid; new_pid=$(_read_pid web)
    if _pid_alive "$new_pid" && _port_in_use "$WEB_PORT"; then
        _ok "agent-observe started (PID $new_pid, port $WEB_PORT)"
        # wait for cc-proxy (max 5s)
        local pw=0
        while [ "$pw" -lt 50 ] && ! _port_in_use "$PROXY_PORT"; do
            sleep 0.1
            pw=$((pw+1))
        done
        if _port_in_use "$PROXY_PORT"; then
            _ok "cc-proxy running on :${PROXY_PORT}"
        else
            _warn "cc-proxy not detected on :${PROXY_PORT} (check config or cco logs web)"
        fi
        local url="http://localhost:$WEB_PORT"
        _info "opening $url"
        open "$url" 2>/dev/null || xdg-open "$url" 2>/dev/null || true
    else
        _remove_pid web
        _err "agent-observe failed to start, check $RUN_DIR/web.log"
        return 1
    fi
}

# ── stop ─────────────────────────────────────────────────────────────────
cmd_stop() {
    _read_port_from_config
    local pid; pid=$(_resolve_pid web "$WEB_PORT")
    if ! _pid_alive "$pid"; then
        _warn "agent-observe not running"
        _remove_pid web
        return 0
    fi
    _info "stopping agent-observe (PID $pid)"
    kill "$pid" 2>/dev/null || true
    local i=0
    while [ "$i" -lt 50 ] && _pid_alive "$pid"; do
        sleep 0.1
        i=$((i+1))
    done
    if _pid_alive "$pid"; then
        _warn "did not exit gracefully, sending SIGKILL"
        kill -9 "$pid" 2>/dev/null || true
    fi
    _remove_pid web
    _ok "agent-observe stopped"
    # ensure cc-proxy also went down
    sleep 0.5
    local proxy_pid
    proxy_pid=$(lsof -iTCP:"$PROXY_PORT" -sTCP:LISTEN -t 2>/dev/null | head -1 || true)
    if _pid_alive "$proxy_pid"; then
        _info "cc-proxy still running (PID $proxy_pid), stopping..."
        kill "$proxy_pid" 2>/dev/null || true
        local j=0
        while [ "$j" -lt 30 ] && _pid_alive "$proxy_pid"; do
            sleep 0.1
            j=$((j+1))
        done
        if _pid_alive "$proxy_pid"; then
            kill -9 "$proxy_pid" 2>/dev/null || true
        fi
        _ok "cc-proxy stopped"
    fi
}

# ── restart ──────────────────────────────────────────────────────────────
cmd_restart() {
    cmd_stop
    _read_port_from_config
    local w=0
    while [ "$w" -lt 50 ] && _port_in_use "$WEB_PORT"; do
        sleep 0.1
        w=$((w+1))
    done
    sleep 1
    cmd_start
}

# ── status ───────────────────────────────────────────────────────────────
_status_line() {
    local name="$1" label="$2" port="$3"
    local pid; pid=$(_resolve_pid "$name" "$port")

    if _pid_alive "$pid"; then
        local up; up=$(_uptime_str "$pid" 2>/dev/null || echo "?")
        printf "  %-12s " "$label"
        echo -e "${GREEN}●${RESET} running   PID $pid   port $port   uptime $up"
    else
        printf "  %-12s " "$label"
        echo -e "${RED}○${RESET} stopped"
    fi
}

cmd_status() {
    _read_port_from_config
    echo
    echo -e "  ${BOLD}Agent Observe Status${RESET}"
    echo "  ────────────────────────────────────────"
    _status_line proxy cc-proxy "$PROXY_PORT"
    _status_line web   frontend "$WEB_PORT"
    echo "  ────────────────────────────────────────"
    echo -e "  Config : ${DIM}$CONFIG_FILE${RESET}"
    echo -e "  Logs   : ${DIM}$LOG_DIR/${RESET}"
    echo -e "  UI     : ${DIM}http://localhost:$WEB_PORT${RESET}"
    echo
}

# ── logs ─────────────────────────────────────────────────────────────────
cmd_logs() {
    local target="${1:-proxy}"
    case "$target" in
        proxy)
            local today; today=$(date +%Y-%m-%d)
            local day_dir="$LOG_DIR/$today"
            if ! [[ -d "$day_dir" ]]; then
                local latest; latest=$(ls -1d "$LOG_DIR"/2* 2>/dev/null | sort -r | head -1)
                if [[ -z "$latest" ]]; then
                    _die "no log directories found in $LOG_DIR"
                fi
                day_dir="$latest"
                _info "no logs for today, showing $(basename "$day_dir")"
            fi
            _info "tailing cc-proxy logs from $(basename "$day_dir")"
            echo -e "${DIM}  (Ctrl+C to exit)${RESET}"
            echo
            exec tail -F "$day_dir"/*/*.json 2>/dev/null \
                || exec find "$day_dir" -name '*.json' -newer "$day_dir" -exec tail -f {} +
            ;;
        web)
            local logfile="$RUN_DIR/web.log"
            if ! [[ -f "$logfile" ]]; then
                _die "no web log found at $logfile"
            fi
            _info "tailing frontend log"
            echo -e "${DIM}  (Ctrl+C to exit)${RESET}"
            echo
            exec tail -f "$logfile"
            ;;
        *)
            _die "unknown target: $target (use proxy or web)"
            ;;
    esac
}

# ── install ──────────────────────────────────────────────────────────────
cmd_install() {
    echo
    echo -e "  ${BOLD}cco install — Agent Observe 一键安装${RESET}"
    echo "  ────────────────────────────────────────"
    echo

    local total=5 step=0

    # Step 1: check node
    step=$((step+1))
    if command -v node &>/dev/null; then
        _ok "[$step/$total] Node.js $(node -v)"
    else
        _die "[$step/$total] Node.js not found. Please install Node.js >= 18 first."
    fi

    # Step 2: npm install
    step=$((step+1))
    if [[ -d "$FRONTEND_DIR/node_modules" ]]; then
        _ok "[$step/$total] dependencies already installed"
    else
        _info "[$step/$total] installing frontend dependencies..."
        (cd "$FRONTEND_DIR" && npm install --prefer-offline 2>&1 | tail -3)
        _ok "[$step/$total] npm install complete"
    fi

    # Step 3: cc-proxy binary check + chmod
    step=$((step+1))
    if _find_proxy_bin &>/dev/null; then
        local bin; bin=$(_find_proxy_bin)
        chmod +x "$bin" 2>/dev/null || true
        _ok "[$step/$total] cc-proxy binary ready"
    else
        _warn "[$step/$total] cc-proxy binary not found (frontend will run without proxy)"
    fi

    # Step 4: init config
    step=$((step+1))
    mkdir -p "$CCO_HOME"
    if [[ -f "$CONFIG_FILE" ]]; then
        _ok "[$step/$total] config exists: $CONFIG_FILE"
    else
        _info "[$step/$total] creating default config..."
        _create_default_config
        _ok "[$step/$total] config created: $CONFIG_FILE"
        echo -e "    ${DIM}edit with: cco config${RESET}"
    fi

    # Step 5: first start → registers cco in shell profile
    step=$((step+1))
    _ensure_run_dir
    _info "[$step/$total] starting services (registers cco in shell profile)..."
    cmd_start
    echo
    echo "  ────────────────────────────────────────"
    echo -e "  ${GREEN}${BOLD}Installation complete!${RESET}"
    echo
    echo -e "  cco has been registered in your shell profile."
    echo -e "  Open a ${BOLD}new terminal${RESET} to use cco commands:"
    echo -e "    ${CYAN}cco status${RESET}      Check running status"
    echo -e "    ${CYAN}cco stop${RESET}        Stop services"
    echo -e "    ${CYAN}cco config${RESET}      Edit provider API keys"
    echo -e "    ${CYAN}cco logs${RESET}        Tail request logs"
    echo
}

_create_default_config() {
    local auth_enabled="true"
    [[ "$(uname -s)" == "Darwin" ]] && auth_enabled="false"
    cat > "$CONFIG_FILE" <<CONF
{
  "host": "127.0.0.1",
  "port": 3456,
  "log_level": "info",
  "timeout_secs": 300,
  "retry_codes": [429, 529],
  "auth": {
    "enabled": ${auth_enabled},
    "token": ""
  },
  "model_auth": {
    "enabled": ${auth_enabled},
    "key": ""
  },
  "providers": [],
  "priority": [],
  "profiles": {
    "default": []
  },
  "dispatch": {
    "default": "default"
  }
}
CONF
}

# ── init ─────────────────────────────────────────────────────────────────
cmd_init() {
    mkdir -p "$CCO_HOME"
    if [[ -f "$CONFIG_FILE" ]]; then
        _warn "config already exists: $CONFIG_FILE"
        echo -ne "  overwrite? [y/N] "
        read -r ans
        [[ "$ans" == "y" || "$ans" == "Y" ]] || return 0
    fi
    _create_default_config
    _ok "config created: $CONFIG_FILE"
    echo -e "  ${DIM}edit with: cco config${RESET}"
}

# ── activate ─────────────────────────────────────────────────────────────
cmd_activate() {
    _read_port_from_config
    local enabled="false" key=""
    if [[ -f "$CONFIG_FILE" ]] && command -v python3 &>/dev/null; then
        enabled=$(python3 -c "import json; c=json.load(open('$CONFIG_FILE')); a=c.get('model_auth') or {}; print('true' if a.get('enabled') else 'false')" 2>/dev/null)
        key=$(python3 -c "import json; c=json.load(open('$CONFIG_FILE')); a=c.get('model_auth') or {}; print(a.get('key') or '')" 2>/dev/null)
    fi
    # When model_auth is enabled, route through the frontend so the key is
    # enforced. Otherwise keep the legacy direct route to cc-proxy.
    if [[ "$enabled" == "true" && -n "$key" ]]; then
        echo "export ANTHROPIC_BASE_URL=http://127.0.0.1:${WEB_PORT}"
        echo "export ANTHROPIC_API_KEY=${key}"
    else
        echo "export ANTHROPIC_BASE_URL=http://127.0.0.1:${PROXY_PORT}"
        echo "export ANTHROPIC_API_KEY=cc-proxy-key"
    fi
    echo "unset ANTHROPIC_AUTH_TOKEN"
    echo ""
    echo "# Run: eval \$(cco activate)"
}

# ── config ───────────────────────────────────────────────────────────────
cmd_config() {
    if ! [[ -f "$CONFIG_FILE" ]]; then
        _die "config not found: $CONFIG_FILE\n  run 'cco init' first"
    fi
    local editor="${EDITOR:-vim}"
    exec "$editor" "$CONFIG_FILE"
}

# ── token ────────────────────────────────────────────────────────────────
cmd_token() {
    if ! [[ -f "$CONFIG_FILE" ]]; then
        _die "config not found: $CONFIG_FILE\n  run 'cco init' first"
    fi
    local enabled token
    enabled=$(python3 -c "import json; c=json.load(open('$CONFIG_FILE')); a=c.get('auth') or {}; print('true' if a.get('enabled') else 'false')" 2>/dev/null)
    token=$(python3 -c "import json; c=json.load(open('$CONFIG_FILE')); a=c.get('auth') or {}; print(a.get('token') or '')" 2>/dev/null)
    if [[ "$enabled" != "true" ]]; then
        _warn "API auth is disabled (auth.enabled=false in config.json)"
        return 0
    fi
    if [[ -z "$token" ]]; then
        _warn "API auth is enabled but token not yet generated — start the server once: cco start"
        return 0
    fi
    echo "$token"
}

# ── model-token ──────────────────────────────────────────────────────────
cmd_model_token() {
    if ! [[ -f "$CONFIG_FILE" ]]; then
        _die "config not found: $CONFIG_FILE\n  run 'cco init' first"
    fi
    local enabled key
    enabled=$(python3 -c "import json; c=json.load(open('$CONFIG_FILE')); a=c.get('model_auth') or {}; print('true' if a.get('enabled') else 'false')" 2>/dev/null)
    key=$(python3 -c "import json; c=json.load(open('$CONFIG_FILE')); a=c.get('model_auth') or {}; print(a.get('key') or '')" 2>/dev/null)
    if [[ "$enabled" != "true" ]]; then
        _warn "model API auth is disabled (model_auth.enabled=false in config.json)"
        return 0
    fi
    if [[ -z "$key" ]]; then
        _warn "model API auth is enabled but key not yet generated — start the server once: cco start"
        return 0
    fi
    echo "$key"
}

# ── doctor ───────────────────────────────────────────────────────────────
cmd_doctor() {
    _read_port_from_config
    echo
    echo -e "  ${BOLD}cco doctor${RESET}"
    echo "  ────────────────────────────────────────"
    local ok=0 fail=0

    # binary
    if _find_proxy_bin &>/dev/null; then
        local bin; bin=$(_find_proxy_bin)
        echo -e "  ${GREEN}✓${RESET} cc-proxy binary : $bin"
        ok=$((ok+1))
    else
        echo -e "  ${RED}✗${RESET} cc-proxy binary : not found"
        fail=$((fail+1))
    fi

    # frontend
    if [[ -f "$FRONTEND_DIR/server.js" ]]; then
        echo -e "  ${GREEN}✓${RESET} frontend        : $FRONTEND_DIR"
        ok=$((ok+1))
    else
        echo -e "  ${RED}✗${RESET} frontend        : not found at $FRONTEND_DIR"
        fail=$((fail+1))
    fi

    # config
    if [[ -f "$CONFIG_FILE" ]]; then
        local provider_count
        provider_count=$(grep -c '"name"' "$CONFIG_FILE" 2>/dev/null || echo 0)
        echo -e "  ${GREEN}✓${RESET} config          : $CONFIG_FILE ($provider_count providers)"
        ok=$((ok+1))
    else
        echo -e "  ${RED}✗${RESET} config          : not found ($CONFIG_FILE)"
        echo -e "    ${DIM}run 'cco init' to create${RESET}"
        fail=$((fail+1))
    fi

    # node
    if command -v node &>/dev/null; then
        echo -e "  ${GREEN}✓${RESET} node            : $(node -v)"
        ok=$((ok+1))
    else
        echo -e "  ${RED}✗${RESET} node            : not found"
        fail=$((fail+1))
    fi

    # services
    for triple in "proxy:cc-proxy:$PROXY_PORT" "web:frontend:$WEB_PORT"; do
        local name="${triple%%:*}" rest="${triple#*:}"
        local label="${rest%%:*}" port="${rest#*:}"
        local pid; pid=$(_resolve_pid "$name" "$port")
        if _pid_alive "$pid"; then
            local up; up=$(_uptime_str "$pid" 2>/dev/null || echo "?")
            echo -e "  ${GREEN}✓${RESET} $label:$port   : running (PID $pid, uptime $up)"
            ok=$((ok+1))
        else
            echo -e "  ${DIM}○${RESET} $label:$port   : stopped"
            ok=$((ok+1))
        fi
    done

    # log dir
    if [[ -d "$LOG_DIR" ]]; then
        local day_count; day_count=$(ls -1d "$LOG_DIR"/2* 2>/dev/null | wc -l | tr -d ' ')
        echo -e "  ${GREEN}✓${RESET} logs            : $LOG_DIR ($day_count days)"
        ok=$((ok+1))
    else
        echo -e "  ${DIM}○${RESET} logs            : no logs yet"
        ok=$((ok+1))
    fi

    # cco in PATH
    if command -v cco &>/dev/null; then
        echo -e "  ${GREEN}✓${RESET} cco in PATH     : $(command -v cco)"
        ok=$((ok+1))
    else
        echo -e "  ${RED}✗${RESET} cco in PATH     : not found (run: source ~/.zshrc)"
        fail=$((fail+1))
    fi

    # env vars — 检查认证配置冲突
    if [[ -n "${ANTHROPIC_AUTH_TOKEN:-}" && -n "${ANTHROPIC_API_KEY:-}" ]]; then
        echo -e "  ${RED}✗${RESET} env conflict    : ANTHROPIC_AUTH_TOKEN and ANTHROPIC_API_KEY are both set"
        echo -e "    ${DIM}fix: eval \$(cco activate)   (uses API key, unsets auth token)${RESET}"
        fail=$((fail+1))
    elif [[ -n "${ANTHROPIC_API_KEY:-}" && "${ANTHROPIC_BASE_URL:-}" == *"127.0.0.1"* ]]; then
        echo -e "  ${GREEN}✓${RESET} env             : ANTHROPIC_API_KEY set, routing via proxy"
        ok=$((ok+1))
    elif [[ -n "${ANTHROPIC_AUTH_TOKEN:-}" && "${ANTHROPIC_BASE_URL:-}" == *"127.0.0.1"* ]]; then
        echo -e "  ${YELLOW}⚠${RESET} env             : using ANTHROPIC_AUTH_TOKEN (legacy); run: eval \$(cco activate)"
        ok=$((ok+1))
    fi

    echo "  ────────────────────────────────────────"
    if [ "$fail" -gt 0 ]; then
        echo -e "  ${RED}$fail issue(s)${RESET}, $ok ok"
    else
        echo -e "  ${GREEN}all $ok checks passed${RESET}"
    fi
    echo
    return $fail
}

# ── open ─────────────────────────────────────────────────────────────────
cmd_open() {
    local url="http://localhost:$WEB_PORT"
    _info "opening $url"
    open "$url" 2>/dev/null || xdg-open "$url" 2>/dev/null || _die "cannot open browser"
}

# ── help ─────────────────────────────────────────────────────────────────
cmd_help() {
    cat <<'HELP'

  cco — Agent Observe CLI

  Usage:  cco <command>

  Setup:
    install               One-step install (deps, config, PATH)
    init                  Generate default config
    doctor                Run self-diagnostics

  Service Management:
    start                 Start agent-observe (frontend + cc-proxy)
    stop                  Stop agent-observe
    restart               Restart agent-observe
    status                Show service status

  Observability:
    logs [proxy|web]      Tail cc-proxy request logs (default) or frontend log
    open                  Open Observer UI in browser

  Configuration:
    activate              Print shell exports for CC proxy
    config                Edit config in $EDITOR
    token                 Print frontend API auth token (if enabled)
    model-token           Print model API key (if enabled)

HELP
}

# ── main ─────────────────────────────────────────────────────────────────
main() {
    local cmd="${1:-help}"
    shift 2>/dev/null || true

    case "$cmd" in
        install)  cmd_install ;;
        start)    cmd_start ;;
        stop)     cmd_stop ;;
        restart)  cmd_restart ;;
        status)   cmd_status ;;
        logs|log) cmd_logs "$@" ;;
        init)     cmd_init ;;
        activate) cmd_activate ;;
        config)   cmd_config ;;
        token)    cmd_token ;;
        model-token) cmd_model_token ;;
        doctor)   cmd_doctor ;;
        open)     cmd_open ;;
        help|-h|--help) cmd_help ;;
        *)        _err "unknown command: $cmd"; cmd_help; exit 1 ;;
    esac
}

main "$@"
