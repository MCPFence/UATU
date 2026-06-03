English | [中文](./README.md)

# UATU

> The last mile of putting AI agents into production

UATU is an observability and reliability platform for Claude Code. It acts as a transparent proxy that intercepts LLM requests, providing **automatic failover, cost optimization, PII masking, and behavior monitoring** — making AI coding assistants production-ready.

---

## Why UATU?

When using Claude Code for real-world development, you've probably hit:

- Frequent model errors (400/429/502) that kill your task mid-flight
- Safety policy blocks on perfectly normal dev work
- Runaway costs — every request hits the most expensive model
- Zero visibility — Claude Code is a total black box when things go wrong

**UATU fixes all of this.**

---

## Features

**Reliability**
- Multi-model automatic failover — one model goes down, seamlessly switch to the next
- Safety policy refusal detection — auto-fallback when the model refuses
- HTTP/2 stream reset auto-retry

**Cost Reduction**
- Role-based smart routing — strong models for main tasks, cheap models for subtasks
- 60%+ cost savings in practice, with near-zero quality loss
- Real-time cost tracking by session / model / day / month

**Security**
- Automatic PII masking — emails, phones, IDs, bank cards, MAC addresses
- Real-time alerts on dangerous actions — `rm -rf`, data exfiltration, abnormal ops
- All logs stored locally for audit

**Observability**
- Trace waterfall — visualize every model call
- Session replay — step through agent behavior turn by turn
- Cost attribution — know exactly where money is going

---

## Quick Start

```bash
# Download the release for your platform
unzip uatu-1.0.0-darwin-arm64.zip && cd agent-observe

# Install & start
npm install && npm start
```

Open your browser and complete setup in 3 steps:

1. Enter your Provider API Key
2. Select models
3. One-click activate

```bash
# Or use the CLI
cco start            # Start services
cco stop             # Stop services
eval $(cco activate) # Activate proxy for Claude Code
```

---

## Architecture

```
Claude Code ──► cc-proxy (Rust) ──► LLM Providers
                     │
                     ▼
                observer (Node.js) ──► Web UI
```

| Component | Role |
|-----------|------|
| **cc-proxy** | Transparent proxy — failover, PII masking, routing, logging |
| **observer** | Observability — Web UI, traces, cost stats, alerts |

---

## Cost Optimization Results

Architecture analysis task on a 12,000-line codebase:

| Strategy | Cost | Savings | Quality |
|----------|------|---------|---------|
| Opus baseline | ¥14.05 | — | Baseline |
| **GLM + Opus hybrid** | **¥4.48** | **-68%** | Near baseline |

> Subtasks routed to domestic models; main tasks stay on Opus. Cache hit rate unaffected.

---

## Build from Source

```bash
# cc-proxy (Rust)
cd cc-proxy && cargo build --release

# observer (Node.js)
npm install
```

---

## Configuration

| Env Variable | Description |
|-------------|-------------|
| `PORT` | Observer port (default 4318) |
| `UATU_GITHUB_REPO` | GitHub repo for update checks |

Models and routing strategies are configured through the Web UI — no manual file editing needed.

---

## License

MIT
