'use strict';

/**
 * Token-based auth for two distinct concerns:
 *
 *   1. Frontend API auth (`auth` block in config.json)
 *      - Protects /api/* on the observer UI.
 *      - Source order: CCO_AUTH_TOKEN env > config.json `auth` > platform default.
 *
 *   2. Model proxy auth (`model_auth` block in config.json)
 *      - Protects the upstream LLM endpoint (/v1/*) handled by proxy-guard.
 *      - Source order: CCO_MODEL_API_KEY env > config.json `model_auth` > platform default.
 *
 * Platform default for both: enabled on linux/windows, disabled on macOS.
 * Tokens are auto-generated and persisted back to config.json on first run.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const CONFIG_FILE = path.join(os.homedir(), '.cc-proxy', 'config.json');
const PUBLIC_API_PATHS = new Set(['/api/health']);

let _enabled = false;
let _token = '';
let _modelEnabled = false;
let _modelKey = '';

function _generateToken() {
  return crypto.randomBytes(24).toString('hex');
}

function _generateModelKey() {
  return 'cco-' + crypto.randomBytes(20).toString('hex');
}

function _readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
  catch { return null; }
}

function _writeConfigPatch(patch) {
  let cfg = _readConfig();
  if (!cfg) return;
  Object.assign(cfg, patch);
  try {
    fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
  } catch (e) {
    console.warn(`[auth] failed to persist to config.json: ${e.message}`);
  }
}

function _initFrontendAuth() {
  const envToken = (process.env.CCO_AUTH_TOKEN || '').trim();
  if (envToken) {
    _enabled = true;
    _token = envToken;
    console.log('[auth] frontend enabled (token from CCO_AUTH_TOKEN env)');
    return;
  }

  const cfg = _readConfig();
  const auth = cfg && typeof cfg.auth === 'object' ? cfg.auth : null;
  if (auth && typeof auth.enabled === 'boolean') {
    _enabled = auth.enabled;
    _token = auth.token || '';
    if (_enabled && !_token) {
      _token = _generateToken();
      _writeConfigPatch({ auth: { enabled: true, token: _token } });
    }
    console.log(`[auth] frontend ${_enabled ? 'enabled (token from config.json)' : 'disabled (config.json)'}`);
    return;
  }

  const platformDefault = process.platform !== 'darwin';
  if (platformDefault) {
    _enabled = true;
    _token = _generateToken();
    _writeConfigPatch({ auth: { enabled: true, token: _token } });
    console.log('[auth] frontend enabled (platform default: linux/windows, token auto-generated)');
  } else {
    _enabled = false;
    _writeConfigPatch({ auth: { enabled: false, token: '' } });
    console.log('[auth] frontend disabled (platform default: macOS)');
  }
}

function _initModelAuth() {
  const envKey = (process.env.CCO_MODEL_API_KEY || '').trim();
  if (envKey) {
    _modelEnabled = true;
    _modelKey = envKey;
    console.log('[auth] model enabled (key from CCO_MODEL_API_KEY env)');
    return;
  }

  const cfg = _readConfig();
  const ma = cfg && typeof cfg.model_auth === 'object' ? cfg.model_auth : null;
  if (ma && typeof ma.enabled === 'boolean') {
    _modelEnabled = ma.enabled;
    _modelKey = ma.key || '';
    if (_modelEnabled && !_modelKey) {
      _modelKey = _generateModelKey();
      _writeConfigPatch({ model_auth: { enabled: true, key: _modelKey } });
    }
    console.log(`[auth] model ${_modelEnabled ? 'enabled (key from config.json)' : 'disabled (config.json)'}`);
    return;
  }

  const platformDefault = process.platform !== 'darwin';
  if (platformDefault) {
    _modelEnabled = true;
    _modelKey = _generateModelKey();
    _writeConfigPatch({ model_auth: { enabled: true, key: _modelKey } });
    console.log('[auth] model enabled (platform default: linux/windows, key auto-generated)');
  } else {
    _modelEnabled = false;
    _writeConfigPatch({ model_auth: { enabled: false, key: '' } });
    console.log('[auth] model disabled (platform default: macOS)');
  }
}

function init() {
  _initFrontendAuth();
  _initModelAuth();
}

function getToken() { return _token; }
function isEnabled() { return _enabled; }
function getModelKey() { return _modelKey; }
function isModelEnabled() { return _modelEnabled; }

function _extractToken(req) {
  const h = req.headers['authorization'] || '';
  if (h.startsWith('Bearer ')) return h.slice(7).trim();
  const x = req.headers['x-auth-token'];
  if (x) return String(x).trim();
  if (req.query && req.query._token) return String(req.query._token).trim();
  return '';
}

function _extractModelKey(req) {
  const xk = req.headers['x-api-key'];
  if (xk) return String(xk).trim();
  const h = req.headers['authorization'] || '';
  if (h.startsWith('Bearer ')) return h.slice(7).trim();
  return '';
}

function middleware(req, res, next) {
  if (!_enabled) return next();
  if (!req.path.startsWith('/api/')) return next();
  if (PUBLIC_API_PATHS.has(req.path)) return next();

  const provided = _extractToken(req);
  if (provided && provided === _token) return next();
  res.status(401).json({ error: 'unauthorized', message: 'missing or invalid token' });
}

function modelMiddleware(req, res, next) {
  if (!_modelEnabled) return next();
  const provided = _extractModelKey(req);
  if (provided && provided === _modelKey) return next();
  res.status(401).json({
    type: 'error',
    error: { type: 'authentication_error', message: 'missing or invalid x-api-key' },
  });
}

module.exports = {
  init,
  middleware,
  modelMiddleware,
  getToken,
  isEnabled,
  getModelKey,
  isModelEnabled,
};
