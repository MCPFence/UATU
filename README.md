[English](./README_EN.md) | 中文

# UATU

> 解决 Agent 落地的最后一公里

UATU 是 Claude Code 的可观测与稳定性平台。通过透明代理拦截 LLM 请求，提供**自动故障转移、成本优化、PII 脱敏、行为监控**能力，让 AI 编程助手在生产环境中稳定运行。

---

## Why UATU?

使用 Claude Code 进行真实业务开发时，你可能遇到过：

- 模型频繁报错 (400/429/502)，任务中断需要手动重来
- 安全策略拦截正常开发任务，工作流被迫中断
- 费用失控 — 所有请求都走最贵的模型
- 出了问题无法排查 — Claude Code 完全是黑盒

---

## Features

**稳定性**

- 多模型自动故障转移 — 一个模型挂了，无缝切到下一个
- 安全策略拒答自动回退 — 检测到拒答后切换备选模型
- HTTP/2 stream reset 自动重试

**降本**

- 按 Agent 角色智能路由 — 主任务用强模型，子任务用便宜模型
- 实测降本 60%+，质量基本无损
- 实时费用统计，按会话/模型/天/月聚合

**安全**

- PII 自动脱敏 — 邮箱、手机、身份证、银行卡、MAC 地址
- 高危行为实时告警 — `rm -rf`、数据外泄、异常操作
- 全量日志本地存储，支持审计

**可观测**

- Trace 瀑布图 — 可视化每次模型调用
- 会话回放 — 逐轮查看 Agent 行为
- 成本归因 — 知道钱花在了哪里

---

## Quick Start

```bash
# 下载对应平台安装包（从 Releases 页面）
unzip uatu-1.0.0-darwin-arm64.zip && cd agent-observe

# 安装 & 启动
npm install && npm start
```

打开浏览器，三步完成配置：

1. 填入 Provider API Key
2. 选择模型
3. 一键激活

```bash
# 或使用命令行管理
cco start            # 启动
cco stop             # 停止
eval $(cco activate) # 激活代理
```

---

## Architecture

```
Claude Code ──► cc-proxy (Rust) ──► LLM Providers
                     │
                     ▼
                observer (Node.js) ──► Web UI
```

| 组件           | 职责                         |
| ------------ | -------------------------- |
| **cc-proxy** | 透明代理 — 故障转移、PII 脱敏、路由策略、日志 |
| **observer** | 可观测 — Web UI、Trace、成本统计、告警 |

---

## Cost Optimization Results

针对 12000 行代码项目的架构分析任务：

| 方案                | 费用        | 节省       | 质量   |
| ----------------- | --------- | -------- | ---- |
| Opus 基线           | ¥14.05    | —        | 基准   |
| **GLM + Opus 混合** | **¥4.48** | **-68%** | 接近基准 |

> 子任务路由到国产模型，主任务保持 Opus，缓存命中不受影响。

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

| 环境变量               | 说明                    |
| ------------------ | --------------------- |
| `PORT`             | Observer 端口 (默认 4318) |
| `UATU_GITHUB_REPO` | 更新检查的 GitHub 仓库       |

模型和路由策略通过 Web UI 配置，无需手动编辑文件。

---

## License

MIT
