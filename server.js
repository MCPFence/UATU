'use strict';

process.on('uncaughtException', (err) => {
  console.error('[FATAL] uncaughtException:', err.message, err.stack);
});
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] unhandledRejection:', reason);
});

const { logBuffer } = require('./lib/log-buffer');
logBuffer.install();

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WebSocketServer } = require('ws');

const { app } = require('./app');
const { store } = require('./lib/store');
const { alertManager } = require('./lib/websocket');
const auth = require('./lib/auth');
const { LogFileIngester } = require('./ingest/log-watcher');
const { UpdateChecker } = require('./updater/checker');
const { CcProxyManager } = require('./process/cc-proxy-manager');

// ── first-run: register cco into user's shell ──────────────────────────
// 只在首次安装时执行（env.sh 不存在 或 shell rc 没有 cco block）
function isFirstRun() {
  const ccProxyDir = path.join(os.homedir(), '.cc-proxy');
  const envFile = path.join(ccProxyDir, 'env.sh');
  if (!fs.existsSync(envFile)) return true;

  const shell = path.basename(process.env.SHELL || '/bin/zsh');
  let rcFile;
  if (shell === 'zsh') rcFile = path.join(os.homedir(), '.zshrc');
  else if (shell === 'bash') rcFile = fs.existsSync(path.join(os.homedir(), '.bash_profile'))
    ? path.join(os.homedir(), '.bash_profile') : path.join(os.homedir(), '.bashrc');
  else rcFile = path.join(os.homedir(), '.profile');
  try {
    const rc = fs.readFileSync(rcFile, 'utf8');
    if (!rc.includes('# ── cco (Agent Observe)')) return true;
  } catch { return true; }
  return false;
}

function setupCco() {
  const ccProxyDir = path.join(os.homedir(), '.cc-proxy');
  const ccoTarget = path.join(ccProxyDir, 'cco.sh');

  // 查找 cco.sh 源文件：先看自身目录（更新包携带），再看项目根目录（首次安装）
  const bundledCco = path.join(__dirname, 'cco.sh');
  const rootCco = path.join(path.resolve(__dirname, '..'), 'cco.sh');
  const ccoSource = fs.existsSync(bundledCco) ? bundledCco
    : fs.existsSync(rootCco) ? rootCco : null;

  if (!ccoSource) return;

  // 确保 ~/.cc-proxy 目录存在
  fs.mkdirSync(ccProxyDir, { recursive: true });

  // 复制 cco.sh 到 ~/.cc-proxy/
  try {
    fs.copyFileSync(ccoSource, ccoTarget);
    fs.chmodSync(ccoTarget, 0o755);
  } catch { return; }

  // 清理内部副本（更新包携带的）
  if (ccoSource === bundledCco) {
    try { fs.unlinkSync(bundledCco); } catch {}
  }

  // Write env.sh, preserve unrelated vars but always refresh routing-related ones.
  const envFile = path.join(ccProxyDir, 'env.sh');
  try {
    let existing = '';
    try { existing = fs.readFileSync(envFile, 'utf8'); } catch {}
    const dropPrefixes = [
      'FRONTEND_DIR=',
      'export ANTHROPIC_BASE_URL=',
      'export ANTHROPIC_API_KEY=',
      'export DISABLE_COST_WARNINGS=',
      'export NO_PROXY=',
    ];
    const lines = existing.split('\n').filter(l =>
      !dropPrefixes.some(p => l.startsWith(p)) &&
      !l.match(/^export PATH=.*\.cc-proxy/) &&
      l !== 'unset ANTHROPIC_AUTH_TOKEN'
    ).filter(Boolean);
    lines.unshift(`FRONTEND_DIR="${__dirname}"`);
    lines.push(`export PATH="${ccProxyDir}:$PATH"`);

    // When model_auth is enabled, route Claude Code through the frontend port so
    // the key is enforced. When disabled (macOS default), keep the legacy direct
    // route to cc-proxy so existing users' setups keep working unchanged.
    const webPort = parseInt(process.env.PORT || '4318', 10);
    const proxyPort = 3456;
    const baseUrl = auth.isModelEnabled()
      ? `http://127.0.0.1:${webPort}`
      : `http://127.0.0.1:${proxyPort}`;
    const apiKey = auth.isModelEnabled() ? auth.getModelKey() : 'cc-proxy-proxy';
    lines.push(`export ANTHROPIC_BASE_URL="${baseUrl}"`);
    lines.push(`export ANTHROPIC_API_KEY="${apiKey}"`);
    lines.push(`export DISABLE_COST_WARNINGS="1"`);
    lines.push(`export NO_PROXY="127.0.0.1"`);
    lines.push('unset ANTHROPIC_AUTH_TOKEN');
    fs.writeFileSync(envFile, lines.join('\n') + '\n', { mode: 0o600 });
  } catch {}

  // ensure "cco" symlink
  const ccoLink = path.join(ccProxyDir, 'cco');
  try { fs.unlinkSync(ccoLink); } catch {}
  try { fs.symlinkSync('cco.sh', ccoLink); } catch {}

  const shell = path.basename(process.env.SHELL || '/bin/zsh');
  let rcFile;
  if (shell === 'zsh') rcFile = path.join(os.homedir(), '.zshrc');
  else if (shell === 'bash') rcFile = fs.existsSync(path.join(os.homedir(), '.bash_profile'))
    ? path.join(os.homedir(), '.bash_profile')
    : path.join(os.homedir(), '.bashrc');
  else rcFile = path.join(os.homedir(), '.profile');

  const startMarker = '# ── cco (Agent Observe)';
  const endMarker = '# ── end cco ──';

  const block = [
    '# ── cco (Agent Observe) ──────────────────────────',
    `[ -f "${ccProxyDir}/env.sh" ] && . "${ccProxyDir}/env.sh"`,
    '# ── end cco ──────────────────────────────────────',
  ].join('\n');

  let rcContent = '';
  try { rcContent = fs.readFileSync(rcFile, 'utf8'); } catch {}

  if (rcContent.includes(startMarker)) {
    const lines = rcContent.split('\n');
    const out = [];
    let skip = false;
    for (const line of lines) {
      if (line.includes(startMarker)) { skip = true; continue; }
      if (line.includes(endMarker)) { skip = false; continue; }
      if (!skip) out.push(line);
    }
    out.push('', block, '');
    fs.writeFileSync(rcFile, out.join('\n'));
    return 'updated';
  }

  fs.appendFileSync(rcFile, '\n' + block + '\n');
  return 'installed';
}

// Always re-run setupCco so env.sh tracks the current generated model key.
// The rc-file block is idempotent (updates in place if already present).
const ccoResult = setupCco();

const server = http.createServer(app);

const wss = new WebSocketServer({ server, path: '/ws/alerts' });
wss.on('connection', (ws, req) => {
  if (auth.isEnabled()) {
    const params = new URL(req.url, 'http://localhost').searchParams;
    if (params.get('token') !== auth.getToken()) {
      ws.close(4001, 'Unauthorized');
      return;
    }
  }
  alertManager.register(ws);
  ws.on('close', () => alertManager.unregister(ws));
  ws.on('error', () => alertManager.unregister(ws));

  const history = logBuffer.getRecent(200);
  if (history.length && ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify({ type: 'log_init', lines: history }));
  }

  const keepAlive = setInterval(() => {
    if (ws.readyState === ws.OPEN) ws.ping();
  }, 25000);
  ws.on('close', () => clearInterval(keepAlive));
});

logBuffer.onLine((entry) => {
  alertManager.broadcast({ type: 'log_line', ...entry });
});

const ingester = new LogFileIngester();
alertManager.setStore(store);
const _respCount = store._db.prepare('SELECT COUNT(*) as c FROM cc_proxy_responses').get().c;
if (_respCount > 0) {
  ingester.warmup(store);
}
ingester.startBackgroundLoop(store, alertManager);

const updater = new UpdateChecker(process.env.UPDATE_SITE);
updater.start();

app.locals.updater = updater;

const ccProxyManager = new CcProxyManager();
app.locals.ccProxyManager = ccProxyManager;

// Async preflight + auto-start cc-proxy
const _configFile = path.join(os.homedir(), '.cc-proxy', 'config.json');
let _configReady = false;
try {
  const _cfg = JSON.parse(fs.readFileSync(_configFile, 'utf8'));
  _configReady = (_cfg.providers || []).some(p => p.api_key && !p.api_key.startsWith('YOUR_'));
} catch (_) {}

ccProxyManager.preflight((status) => {
  if (status === 'ok' && _configReady) {
    ccProxyManager.start();
    ccProxyManager.startHealthCheck(30000);
  }
});

// Watch config.json for external edits → validate, reload cc-proxy, notify UI
const chokidar = require('chokidar');
const ccProxyClient = require('./ingest/cc-proxy-client');
let _configReloadTimer = null;
if (fs.existsSync(_configFile)) {
  chokidar.watch(_configFile, { ignoreInitial: true, awaitWriteFinish: { stabilityThreshold: 500 } })
    .on('change', () => {
      if (_configReloadTimer) return;
      _configReloadTimer = setTimeout(async () => {
        _configReloadTimer = null;
        let cfg;
        try {
          cfg = JSON.parse(fs.readFileSync(_configFile, 'utf8'));
        } catch (e) {
          console.error(`[ConfigWatch] config.json 解析失败: ${e.message}`);
          alertManager.broadcast({
            type: 'config_error',
            severity: 'warning',
            title: '配置文件格式错误',
            detail: `config.json 解析失败: ${e.message}`,
          });
          return;
        }
        const problems = [];
        if (!Array.isArray(cfg.providers) || !cfg.providers.length) problems.push('providers 为空');
        if (cfg.providers) {
          for (const p of cfg.providers) {
            if (!p.name) problems.push('存在未命名的 provider');
            if (!p.api_key || p.api_key.startsWith('YOUR_')) problems.push(`${p.name || '?'} 缺少有效 api_key`);
          }
        }
        if (problems.length) {
          console.warn(`[ConfigWatch] config.json 校验警告: ${problems.join('; ')}`);
        }
        try {
          await ccProxyClient.reloadConfig();
          console.log('[ConfigWatch] config.json changed, cc-proxy reloaded');
          alertManager.broadcast({ type: 'config_changed' });
        } catch (e) {
          console.warn('[ConfigWatch] cc-proxy reload failed:', e.message);
          alertManager.broadcast({
            type: 'config_error',
            severity: 'warning',
            title: '配置重载失败',
            detail: e.message,
          });
        }
      }, 300);
    });
}

setInterval(() => store.enforceRetention(), 300000);

const PORT = parseInt(process.env.PORT || '4318', 10);
const BIND_HOST = process.env.BIND_HOST || '127.0.0.1';
server.listen(PORT, BIND_HOST, () => {
  const url = `http://${BIND_HOST === '0.0.0.0' ? '127.0.0.1' : BIND_HOST}:${PORT}`;
  console.log();
  console.log('  \x1b[1mClaude Code Observer (Node.js)\x1b[0m');
  console.log('  ' + '-'.repeat(40));
  console.log(`  OTLP Endpoint : ${url}`);
  console.log(`  Web UI        : ${url}`);
  console.log(`  WebSocket     : ws://${BIND_HOST === '0.0.0.0' ? '127.0.0.1' : BIND_HOST}:${PORT}/ws/alerts`);
  console.log(`  Bind          : ${BIND_HOST}:${PORT}`);
  console.log(`  Background    : log + routing scan (first 30s: 5s, then 60s)`);
  if (auth.isEnabled()) {
    const t = auth.getToken();
    const masked = t.slice(0, 6) + '****' + t.slice(-4);
    console.log(`  API Auth      : \x1b[33mENABLED\x1b[0m  token=${masked}`);
  } else {
    console.log(`  API Auth      : \x1b[2mdisabled\x1b[0m`);
  }

  if (ccoResult === 'installed') {
    console.log();
    console.log('  \x1b[32m✓ cco CLI registered\x1b[0m');
    console.log('  \x1b[2mOpen a new terminal and run:\x1b[0m');
    console.log('    \x1b[36mcco status\x1b[0m      View service status');
    console.log('    \x1b[36mcco start\x1b[0m       Start services in background');
    console.log('    \x1b[36mcco stop\x1b[0m        Stop services');
    console.log('    \x1b[36mcco help\x1b[0m        All commands');
  }
  console.log();

  const { exec } = require('child_process');
  if (!process.env.CCO_NO_BROWSER) {
    const cmd = process.platform === 'darwin' ? 'open'
      : process.platform === 'win32' ? 'start' : 'xdg-open';
    exec(`${cmd} ${url}`);
  }
});

process.on('SIGTERM', () => {
  console.log('[Server] shutting down...');
  ccProxyManager.stopHealthCheck();
  ccProxyManager.stop();
  ingester.stop();
  updater.stop();
  store.stop();
  server.close(() => {});
  setTimeout(() => process.exit(0), 800);
});
process.on('SIGINT', () => process.emit('SIGTERM'));
