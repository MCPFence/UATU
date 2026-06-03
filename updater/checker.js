'use strict';

const os = require('os');
const path = require('path');
const ccProxyClient = require('../ingest/cc-proxy-client');
const { alertManager } = require('../lib/websocket');

const GITHUB_REPO = process.env.UATU_GITHUB_REPO || 'anthropics/uatu';
const VERSION_FILE = path.join(__dirname, '..', 'version.json');

class UpdateChecker {
  constructor(updateSite, intervalMs = 3600000) {
    this.repo = process.env.UATU_GITHUB_REPO || GITHUB_REPO;
    this.updateSite = updateSite || process.env.UPDATE_SITE || '';
    this.intervalMs = intervalMs;
    this._timer = null;
    this._status = {
      observer_current: '',
      observer_latest: '',
      cc_proxy_current: '',
      cc_proxy_latest: '',
      last_check: null,
      update_available: false,
    };
  }

  start() {
    this._status.observer_current = this._readLocalVersion();
    this._check();
    this._timer = setInterval(() => this._check(), this.intervalMs);
    this._timer.unref();
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
  }

  async checkNow() {
    await this._check();
    return this.getStatus();
  }

  getStatus() {
    return { ...this._status };
  }

  async _check() {
    const current = {
      observer: this._readLocalVersion(),
      cc_proxy: '',
    };
    try {
      current.cc_proxy = await ccProxyClient.getVersion();
      if (current.cc_proxy === 'unknown') current.cc_proxy = '';
    } catch (e) {
      console.warn(`[UpdateChecker] cc_proxy version: ${e.message}`);
    }

    let obsLatest = '';
    let notes = '';
    try {
      const resp = await fetch(
        `https://api.github.com/repos/${this.repo}/releases/latest`,
        { signal: AbortSignal.timeout(15000), headers: { 'Accept': 'application/vnd.github+json' } }
      );
      if (resp.ok) {
        const release = await resp.json();
        obsLatest = (release.tag_name || '').replace(/^v/, '');
        notes = release.body || release.name || '';
      }
    } catch (e) {
      console.warn(`[UpdateChecker] failed to fetch GitHub release: ${e.message}`);
      return;
    }

    const obsCurrent = current.observer;
    const ccCurrent = current.cc_proxy;

    const available = !!(obsLatest && obsCurrent && this._isNewer(obsLatest, obsCurrent));

    this._status = {
      observer_current: obsCurrent,
      observer_latest: obsLatest,
      cc_proxy_current: ccCurrent,
      cc_proxy_latest: '',
      last_check: Date.now(),
      update_available: available,
    };

    if (available) {
      alertManager.broadcast({
        type: 'update_available',
        data: { component: 'observer', current: obsCurrent, latest: obsLatest, notes },
      });
    }
  }

  _isNewer(latest, current) {
    const parse = v => (v || '').split('.').map(n => parseInt(n, 10) || 0);
    const a = parse(latest), b = parse(current);
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if ((a[i] || 0) > (b[i] || 0)) return true;
      if ((a[i] || 0) < (b[i] || 0)) return false;
    }
    return false;
  }

  _readLocalVersion() {
    try {
      delete require.cache[require.resolve(VERSION_FILE)];
      const vj = require(VERSION_FILE);
      return vj.observer || '0.0.0';
    } catch {
      return '0.0.0';
    }
  }
}

module.exports = { UpdateChecker };
