'use strict';

const { spawn, execFileSync, execFile } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function getBinaryName() {
  const platform = process.platform;
  const arch = process.arch;
  if (platform === 'darwin' && arch === 'arm64') return 'cc-proxy-aarch64-apple-darwin';
  if (platform === 'darwin' && arch === 'x64') return 'cc-proxy-x86_64-apple-darwin';
  if (platform === 'win32') return 'cc-proxy-x86_64-windows.exe';
  if (platform === 'linux' && arch === 'x64') return 'cc-proxy-x86_64-unknown-linux-musl';
  if (platform === 'linux' && arch === 'arm64') return 'cc-proxy-aarch64-unknown-linux-musl';
  return null;
}

const DEFAULT_CONFIG = {
  host: '127.0.0.1',
  port: 3456,
  log_level: 'info',
  timeout_secs: 300,
  providers: [],
  priority: [],
  profiles: {},
  dispatch: { default: 'premium' },
};

class CcProxyManager {
  constructor(binDir) {
    this.binDir = binDir || path.join(__dirname, '..', 'bin');
    this.child = null;
    this._restartCount = 0;
    this._maxBackoff = 30000;
    this._stopping = false;
    this._exited = false;
    this._preflightStatus = null;
    this._preflightError = null;
    this._healthTimer = null;
    this._expectedVersion = null;
    this._restarting = false;
  }

  ensureConfig() {
    const configDir = path.join(os.homedir(), '.cc-proxy');
    const configFile = path.join(configDir, 'config.json');
    if (!fs.existsSync(configFile)) {
      console.log(`[cc-proxy] creating default config: ${configFile}`);
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(configFile, JSON.stringify(DEFAULT_CONFIG, null, 2));
    }
    return configFile;
  }

  preflight(callback) {
    const binaryName = getBinaryName();
    if (!binaryName) {
      this._preflightStatus = 'unsupported';
      this._preflightError = `unsupported platform: ${process.platform}/${process.arch}`;
      console.warn(`[cc-proxy] ${this._preflightError}`);
      if (callback) callback(this._preflightStatus);
      return this._preflightStatus;
    }

    const binaryPath = path.join(this.binDir, binaryName);
    if (!fs.existsSync(binaryPath)) {
      this._preflightStatus = 'not_found';
      this._preflightError = `binary not found: ${binaryPath}`;
      console.warn(`[cc-proxy] ${this._preflightError}`);
      if (callback) callback(this._preflightStatus);
      return this._preflightStatus;
    }

    try { fs.chmodSync(binaryPath, 0o755); } catch {}
    if (process.platform === 'darwin') {
      try { execFileSync('xattr', ['-cr', binaryPath]); } catch {}
    }

    this.ensureConfig();
    execFile(binaryPath, ['activate'], { encoding: 'utf8', timeout: 5000 }, (err) => {
      if (err) {
        const msg = (err.message || '').toLowerCase();
        if (msg.includes('eperm') || msg.includes('eacces') || msg.includes('killed') ||
            msg.includes('operation not permitted') || msg.includes('code signature')) {
          this._preflightStatus = 'blocked';
          if (process.platform === 'darwin') {
            this._preflightError = 'macOS 安全策略阻止了 cc-proxy 运行，请在 系统设置 → 隐私与安全性 中允许运行';
            console.warn(`[cc-proxy] blocked by macOS Gatekeeper`);
          } else {
            this._preflightError = `cc-proxy 无执行权限: ${err.message}`;
            console.warn(`[cc-proxy] permission denied`);
          }
        } else {
          this._preflightStatus = 'ok';
          console.log('[cc-proxy] preflight passed (activate returned non-zero but executable)');
        }
      } else {
        this._preflightStatus = 'ok';
        console.log('[cc-proxy] preflight passed');
      }
      if (callback) callback(this._preflightStatus);
    });

    return 'pending';
  }

  get preflightResult() {
    return { status: this._preflightStatus, error: this._preflightError };
  }

  start() {
    if (this.running) return true;

    const binaryName = getBinaryName();
    if (!binaryName) return false;
    const binaryPath = path.join(this.binDir, binaryName);
    if (!fs.existsSync(binaryPath)) return false;

    // Async start to allow _killExisting to be awaited properly
    this._doStart(binaryPath).catch(err => {
      console.error(`[cc-proxy] start failed: ${err.message}`);
    });
    return true;
  }

  async _doStart(binaryPath) {
    await this._killExisting();

    // Final guard: if port is still occupied, abort
    if (this._isPortInUse()) {
      console.error('[cc-proxy] 端口 3456 仍被占用，无法启动，将在 5s 后重试');
      setTimeout(() => { if (!this.running) this.start(); }, 5000);
      return;
    }

    const configFile = this.ensureConfig();

    try { fs.chmodSync(binaryPath, 0o755); } catch {}
    if (process.platform === 'darwin') {
      try { execFileSync('xattr', ['-cr', binaryPath]); } catch {}
    }

    this._stopping = false;
    this._exited = false;
    console.log(`[cc-proxy] starting: ${binaryPath}`);
    this.child = spawn(binaryPath, [], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CC_PROXY_CONFIG: configFile },
    });

    this.child.stdout.on('data', (data) => {
      const line = data.toString().trim();
      if (line) console.log(`[cc-proxy] ${line}`);
    });

    this.child.stderr.on('data', (data) => {
      const line = data.toString().trim();
      if (!line) return;
      if (/\b(ERROR|FATAL|panic)\b/.test(line)) {
        console.error(`[cc-proxy] ${line}`);
      } else if (/\bWARN\b/.test(line)) {
        console.warn(`[cc-proxy] ${line}`);
      } else {
        console.log(`[cc-proxy] ${line}`);
      }
    });

    this.child.on('exit', (code) => {
      this._exited = true;
      if (this._stopping) return;
      this._restartCount++;
      const delay = Math.min(1000 * Math.pow(2, this._restartCount - 1), this._maxBackoff);
      console.warn(`[cc-proxy] exited with code ${code}, restarting in ${delay}ms (attempt ${this._restartCount})`);
      setTimeout(() => this.start(), delay);
    });

    this._restartCount = 0;
  }

  stop() {
    this._stopping = true;
    if (this.child) {
      this.child.kill('SIGTERM');
      setTimeout(() => {
        if (this.child && !this.child.killed) this.child.kill('SIGKILL');
      }, 500);
    }
  }

  get running() {
    return this.child && !this._exited && !this._stopping;
  }

  getBundledVersion() {
    if (this._expectedVersion) return this._expectedVersion;
    const binaryName = getBinaryName();
    if (!binaryName) return null;
    const binaryPath = path.join(this.binDir, binaryName);
    if (!fs.existsSync(binaryPath)) return null;
    try {
      const out = execFileSync(binaryPath, ['--version'], { encoding: 'utf8', timeout: 3000 }).trim();
      const match = out.match(/(\d+\.\d+\.\d+)/);
      this._expectedVersion = match ? match[1] : null;
      return this._expectedVersion;
    } catch {
      return null;
    }
  }

  async getRunningVersion() {
    try {
      const resp = await fetch('http://127.0.0.1:3456/_admin/status', { signal: AbortSignal.timeout(3000) });
      const data = await resp.json();
      return data.version || null;
    } catch {
      return null;
    }
  }

  async isOnline() {
    try {
      const resp = await fetch('http://127.0.0.1:3456/_admin/status', { signal: AbortSignal.timeout(3000) });
      const data = await resp.json();
      return data.status === 'running';
    } catch {
      return false;
    }
  }

  async restart() {
    // Prevent concurrent restarts
    if (this._restarting) return;
    this._restarting = true;
    console.log('[cc-proxy] 正在重启...');

    this._stopping = true;
    const child = this.child;
    this.child = null;

    if (child) {
      try { child.kill('SIGTERM'); } catch {}
      // Wait up to 3s for graceful exit (non-blocking — event loop stays alive)
      for (let i = 0; i < 30; i++) {
        await sleep(100);
        if (this._exited) break;
      }
      // Force kill if still alive
      try { child.kill('SIGKILL'); } catch {}
      await sleep(300);
    }

    this._stopping = false;
    this._exited = true;
    this._restarting = false;
    this.start();
  }

  _isPortInUse() {
    try {
      const out = execFileSync('lsof', ['-iTCP:3456', '-sTCP:LISTEN', '-t'], { encoding: 'utf8', timeout: 2000 }).trim();
      return out.length > 0;
    } catch {
      return false;
    }
  }

  async _killExisting() {
    const myPid = process.pid;
    let pids;
    try {
      const out = execFileSync('lsof', ['-iTCP:3456', '-sTCP:LISTEN', '-t'], { encoding: 'utf8', timeout: 3000 }).trim();
      if (!out) return;
      pids = out.split('\n').map(p => parseInt(p)).filter(p => p > 0 && p !== myPid);
      if (!pids.length) return;
    } catch {
      return;
    }

    console.log(`[cc-proxy] 正在关闭占用端口 3456 的旧进程 (PID: ${pids.join(', ')})...`);
    for (const pid of pids) {
      try { process.kill(pid, 'SIGTERM'); } catch {}
    }

    // Wait up to 5s for SIGTERM (non-blocking)
    for (let i = 0; i < 25; i++) {
      await sleep(200);
      const alive = pids.some(pid => { try { process.kill(pid, 0); return true; } catch { return false; } });
      if (!alive) break;
    }

    // Force kill survivors
    for (const pid of pids) {
      try { process.kill(pid, 0); process.kill(pid, 'SIGKILL'); } catch {}
    }
    await sleep(500);

    console.log('[cc-proxy] 旧进程已关闭，端口 3456 已释放');
  }

  startHealthCheck(intervalMs = 30000) {
    if (this._healthTimer) return;
    this._healthTimer = setInterval(() => this._healthTick(), intervalMs);
    setTimeout(() => this._healthTick(), 5000);
  }

  stopHealthCheck() {
    if (this._healthTimer) {
      clearInterval(this._healthTimer);
      this._healthTimer = null;
    }
  }

  async _healthTick() {
    if (this._preflightStatus !== 'ok') return;
    if (this._restarting) return;

    const online = await this.isOnline();
    if (!online) {
      console.warn('[cc-proxy] 检测到 cc-proxy 离线（端口 3456 无响应），正在启动...');
      await this.restart();
      return;
    }

    const bundled = this.getBundledVersion();
    if (!bundled) return;

    const running = await this.getRunningVersion();
    if (running && running !== bundled) {
      console.warn(`[cc-proxy] 版本不匹配: 运行中=${running}, 期望=${bundled}，正在重启以更新...`);
      await this.restart();
    }
  }
}

module.exports = { CcProxyManager, getBinaryName };
