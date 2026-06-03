'use strict';

const MAX_LINES = 500;

class LogBuffer {
  constructor() {
    this._lines = [];
    this._listeners = [];
    this._installed = false;
  }

  install() {
    if (this._installed) return;
    this._installed = true;

    const origLog = console.log.bind(console);
    const origWarn = console.warn.bind(console);
    const origError = console.error.bind(console);

    console.log = (...args) => {
      origLog(...args);
      this._push('info', args);
    };
    console.warn = (...args) => {
      origWarn(...args);
      this._push('warn', args);
    };
    console.error = (...args) => {
      origError(...args);
      this._push('error', args);
    };
  }

  _push(level, args) {
    const text = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')
      .replace(/\x1b\[[0-9;]*m/g, '');
    const entry = { ts: Date.now(), level, text };
    this._lines.push(entry);
    if (this._lines.length > MAX_LINES) this._lines.shift();
    for (const fn of this._listeners) {
      try { fn(entry); } catch (_) {}
    }
  }

  getRecent(n) {
    return this._lines.slice(-(n || 200));
  }

  onLine(fn) {
    this._listeners.push(fn);
    return () => {
      this._listeners = this._listeners.filter(f => f !== fn);
    };
  }
}

const logBuffer = new LogBuffer();
module.exports = { logBuffer };
