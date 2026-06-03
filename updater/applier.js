'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, execSync } = require('child_process');
const ccProxyClient = require('../ingest/cc-proxy-client');
const { alertManager } = require('../lib/websocket');

const APP_ROOT = path.join(__dirname, '..');
const VERSION_FILE = path.join(APP_ROOT, 'version.json');
const DATA_DIR = path.join(APP_ROOT, 'data');
const BACKUP_DIR = path.join(DATA_DIR, '.backup');
const SKIP_DIRS = new Set(['data', 'node_modules', '.git']);
const CC_PROXY_PORT = 3456;

class UpdateApplier {
  constructor(updateSite) {
    this.updateSite = (updateSite || process.env.UPDATE_SITE || '').replace(/\/+$/, '');
    this._progress = { status: 'idle', message: '', component: '' };
  }

  getProgress() { return { ...this._progress }; }

  async applyObserverUpdate(downloadPath, newVersion, sha256) {
    this._setProgress('downloading', 'Downloading observer update...', 'observer');
    const fullUrl = downloadPath.startsWith('http') ? downloadPath : `${this.updateSite}${downloadPath}`;
    const tmpDir = path.join(os.tmpdir(), `observer-update-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    try {
      const ext = fullUrl.endsWith('.zip') ? '.zip' : '.tar.gz';
      const archivePath = path.join(tmpDir, 'update' + ext);
      await this._download(fullUrl, archivePath, sha256);

      this._setProgress('extracting', 'Extracting update...', 'observer');
      if (ext === '.zip') {
        try {
          execSync(`unzip -qo "${archivePath}" -d "${tmpDir}"`, { shell: '/bin/bash' });
        } catch {
          try {
            execSync(`ditto -xk "${archivePath}" "${tmpDir}"`, { shell: '/bin/bash' });
          } catch {
            execSync(`python3 -m zipfile -e "${archivePath}" "${tmpDir}"`, { shell: '/bin/bash' });
          }
        }
      } else {
        const tar = require('tar');
        await tar.x({ file: archivePath, cwd: tmpDir });
      }

      this._setProgress('backup', 'Backing up current version...', 'observer');
      this._backup(newVersion);

      this._setProgress('applying', 'Applying update files...', 'observer');
      const extractedDir = this._findExtractedDir(tmpDir);
      this._copySkipDirs(extractedDir, APP_ROOT);

      this._updateVersionFile('observer', newVersion);

      this._setProgress('restarting', 'Restarting application...', 'observer');
      alertManager.broadcast({
        type: 'update_applied',
        data: { component: 'observer', version: newVersion, restarting: true },
      });

      await this._sleep(500);
      this._restartObserver();

      return { ok: true, version: newVersion };
    } catch (e) {
      this._setProgress('error', e.message, 'observer');
      console.error(`[UpdateApplier] observer update failed: ${e.message}`);
      this._restore(newVersion);
      throw e;
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  }

  async applyCcProxyUpdate(downloadPath, newVersion, sha256) {
    this._setProgress('downloading', 'Downloading cc-proxy update...', 'cc_proxy');
    const fullUrl = downloadPath.startsWith('http') ? downloadPath : `${this.updateSite}${downloadPath}`;
    const tmpDir = path.join(os.tmpdir(), `cc-proxy-update-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    try {
      const ext = downloadPath.endsWith('.tar.gz') ? '.tar.gz' : path.extname(downloadPath);
      const destName = `cc-proxy-${newVersion}${ext || ''}`;
      const destPath = path.join(tmpDir, destName);
      await this._download(fullUrl, destPath, sha256);

      this._setProgress('stopping', 'Stopping cc-proxy...', 'cc_proxy');
      const oldBinary = this._findCcProxyBinary();
      if (!oldBinary) throw new Error('Cannot find cc-proxy binary');

      const oldPid = this._findCcProxyPid();
      if (oldPid) {
        try {
          process.kill(oldPid, 'SIGTERM');
          await this._waitProcessExit(oldPid, 15000);
        } catch {}
      }

      this._setProgress('applying', 'Replacing cc-proxy binary...', 'cc_proxy');
      let newBinary = destPath;
      if (destName.endsWith('.tar.gz')) {
        const tar = require('tar');
        await tar.x({ file: destPath, cwd: tmpDir });
        const found = this._findFileRecursive(tmpDir, 'cc-proxy');
        if (found) newBinary = found;
      }

      fs.chmodSync(newBinary, 0o755);
      fs.copyFileSync(newBinary, oldBinary);
      fs.chmodSync(oldBinary, 0o755);

      this._setProgress('starting', 'Starting new cc-proxy...', 'cc_proxy');
      const configFile = path.join(os.homedir(), '.cc-proxy', 'config.json');
      spawn(oldBinary, [], {
        stdio: 'ignore',
        detached: true,
        env: { ...process.env, CC_PROXY_CONFIG: configFile },
      }).unref();

      const ready = await this._waitCcProxyReady(newVersion, 30000);
      if (!ready) throw new Error('cc-proxy did not start with expected version within 30s');

      this._updateVersionFile('cc_proxy', newVersion);
      this._setProgress('done', `cc-proxy updated to v${newVersion}`, 'cc_proxy');
      console.log(`[UpdateApplier] cc-proxy updated to v${newVersion}`);

      alertManager.broadcast({
        type: 'update_applied',
        data: { component: 'cc_proxy', version: newVersion },
      });

      return { ok: true, version: newVersion };
    } catch (e) {
      this._setProgress('error', e.message, 'cc_proxy');
      console.error(`[UpdateApplier] cc-proxy update failed: ${e.message}`);
      throw e;
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  }

  async _download(url, dest, expectedSha256) {
    console.log(`[UpdateApplier] downloading ${url}`);
    const resp = await fetch(url, { signal: AbortSignal.timeout(300000) });
    if (!resp.ok) throw new Error(`Download failed: HTTP ${resp.status}`);

    const totalBytes = parseInt(resp.headers.get('content-length') || '0', 10);
    const chunks = [];
    let receivedBytes = 0;
    let lastBroadcast = 0;

    for await (const chunk of resp.body) {
      chunks.push(chunk);
      receivedBytes += chunk.length;
      const now = Date.now();
      if (now - lastBroadcast > 500) {
        lastBroadcast = now;
        const pct = totalBytes ? Math.round(receivedBytes / totalBytes * 100) : 0;
        const mb = (receivedBytes / 1048576).toFixed(1);
        const totalMb = totalBytes ? (totalBytes / 1048576).toFixed(1) : '?';
        this._setProgress('downloading', `下载中 ${mb}MB / ${totalMb}MB (${pct}%)`, this._progress.component);
      }
    }

    const buffer = Buffer.concat(chunks);

    if (expectedSha256) {
      this._setProgress('verifying', '校验文件完整性...', this._progress.component);
      const actual = crypto.createHash('sha256').update(buffer).digest('hex');
      if (actual !== expectedSha256) {
        throw new Error(`SHA256 mismatch: expected ${expectedSha256}, got ${actual}`);
      }
    }

    fs.writeFileSync(dest, buffer);
  }

  _backup(newVersion) {
    const verDir = path.join(BACKUP_DIR, `v${newVersion}`);
    if (fs.existsSync(verDir)) fs.rmSync(verDir, { recursive: true, force: true });
    fs.mkdirSync(verDir, { recursive: true });

    for (const name of fs.readdirSync(APP_ROOT)) {
      if (SKIP_DIRS.has(name)) continue;
      const src = path.join(APP_ROOT, name);
      const dst = path.join(verDir, name);
      fs.cpSync(src, dst, { recursive: true, force: true });
    }
    console.log(`[UpdateApplier] backed up to ${verDir}`);
  }

  _restore(version) {
    const verDir = path.join(BACKUP_DIR, `v${version}`);
    if (!fs.existsSync(verDir)) {
      console.warn(`[UpdateApplier] no backup found for v${version}, cannot restore`);
      return;
    }
    console.log(`[UpdateApplier] restoring backup from ${verDir}`);
    this._copySkipDirs(verDir, APP_ROOT);
  }

  _copySkipDirs(src, dst) {
    for (const name of fs.readdirSync(src)) {
      if (SKIP_DIRS.has(name)) continue;
      const s = path.join(src, name);
      const d = path.join(dst, name);
      const stat = fs.statSync(s);
      if (stat.isDirectory()) {
        if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
        fs.cpSync(s, d, { recursive: true, force: true });
      } else {
        fs.copyFileSync(s, d);
      }
    }
  }

  _findExtractedDir(tmpDir) {
    const candidates = ['agent-observe', 'agent-observe-frontend', 'all_in_one', 'agent-observer', 'observer'];
    for (const name of candidates) {
      const p = path.join(tmpDir, name);
      if (fs.existsSync(p) && fs.statSync(p).isDirectory()) return p;
    }
    const dirs = fs.readdirSync(tmpDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && d.name !== '.' && d.name !== '..')
      .map(d => d.name);
    if (dirs.length === 1) return path.join(tmpDir, dirs[0]);
    return tmpDir;
  }

  _updateVersionFile(component, version) {
    let data = {};
    try { data = JSON.parse(fs.readFileSync(VERSION_FILE, 'utf8')); } catch {}
    data[component] = version;
    fs.writeFileSync(VERSION_FILE, JSON.stringify(data, null, 2));
  }

  _restartObserver() {
    this._syncCcoScript();
    const serverJs = path.join(APP_ROOT, 'server.js');
    console.log('[UpdateApplier] restarting observer...');
    const child = spawn(process.execPath, [serverJs], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env },
      cwd: APP_ROOT,
    });
    child.unref();
    setTimeout(() => process.exit(0), 200);
  }

  _syncCcoScript() {
    const src = path.join(APP_ROOT, 'cco.sh');
    const dst = path.join(os.homedir(), '.cc-proxy', 'cco.sh');
    try {
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, dst);
        fs.chmodSync(dst, 0o755);
        const link = path.join(os.homedir(), '.cc-proxy', 'cco');
        if (!fs.existsSync(link)) {
          fs.symlinkSync('cco.sh', link);
        }
        console.log('[UpdateApplier] synced cco.sh to ~/.cc-proxy/');
      }
    } catch (e) {
      console.warn(`[UpdateApplier] failed to sync cco.sh: ${e.message}`);
    }
  }

  _findCcProxyBinary() {
    const envPath = process.env.CC_PROXY_BINARY;
    if (envPath && fs.existsSync(envPath)) return envPath;

    const candidates = [
      path.join(os.homedir(), '.cc-proxy', 'cc-proxy'),
      '/usr/local/bin/cc-proxy',
    ];

    const binDir = path.join(APP_ROOT, 'bin');
    if (fs.existsSync(binDir)) {
      try {
        for (const f of fs.readdirSync(binDir)) {
          if (f.startsWith('cc-proxy')) candidates.unshift(path.join(binDir, f));
        }
      } catch {}
    }

    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }

    try {
      const result = execSync('which cc-proxy 2>/dev/null', { encoding: 'utf8', shell: '/bin/bash' }).trim();
      if (result) return result;
    } catch {}

    return null;
  }

  _findCcProxyPid() {
    try {
      const result = execSync(`lsof -ti :${CC_PROXY_PORT} 2>/dev/null`, { encoding: 'utf8', shell: '/bin/bash' }).trim();
      if (result) return parseInt(result.split('\n')[0], 10);
    } catch {}
    return null;
  }

  async _waitProcessExit(pid, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try { process.kill(pid, 0); } catch { return true; }
      await this._sleep(500);
    }
    return false;
  }

  async _waitCcProxyReady(expectedVersion, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const v = await ccProxyClient.getVersion();
        if (v === expectedVersion) return true;
      } catch {}
      await this._sleep(2000);
    }
    return false;
  }

  _findFileRecursive(dir, name) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const found = this._findFileRecursive(full, name);
        if (found) return found;
      } else if (entry.name === name || entry.name.startsWith(name + '-')) {
        return full;
      }
    }
    return null;
  }

  _setProgress(status, message, component) {
    this._progress = { status, message, component };
    alertManager.broadcast({ type: 'update_progress', data: this._progress });
  }

  _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
}

module.exports = { UpdateApplier };
