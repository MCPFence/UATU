'use strict';

const CC_PROXY_BASE = 'http://127.0.0.1:3456';

async function _request(method, path, body = null, params = null) {
  let url = `${CC_PROXY_BASE}${path}`;
  if (params) {
    const qs = Object.entries(params).map(([k, v]) => `${k}=${v}`).join('&');
    url = `${url}?${qs}`;
  }
  const opts = { method, headers: {}, signal: AbortSignal.timeout(5000) };
  if (body !== null) {
    opts.body = JSON.stringify(body);
    opts.headers['Content-Type'] = 'application/json';
  }
  try {
    const resp = await fetch(url, opts);
    return await resp.json();
  } catch {
    return { error: 'cc-proxy unreachable' };
  }
}

const status = () => _request('GET', '/_admin/status');
const profiles = () => _request('GET', '/_admin/profiles');
const listStrategies = () => _request('GET', '/_admin/strategies');
const getStrategy = (id) => _request('GET', `/_admin/strategies/${id}`);

async function createStrategy(fields) {
  const r = await _request('POST', '/_admin/strategies', fields);
  if (!r.error) await refreshStrategy();
  return r;
}

async function updateStrategy(id, fields) {
  const r = await _request('PUT', `/_admin/strategies/${id}`, fields);
  if (!r.error) await refreshStrategy();
  return r;
}

async function deleteStrategy(id) {
  const r = await _request('DELETE', `/_admin/strategies/${id}`);
  if (!r.error) await refreshStrategy();
  return r;
}

const refreshStrategy = () => _request('POST', '/_admin/strategies/refresh');
const routingLog = (limit = 50, offset = 0) => _request('GET', '/_admin/routing-log', null, { limit, offset });
const reputation = () => _request('GET', '/_admin/reputation');
const checkpoint = () => _request('POST', '/_admin/checkpoint', {});
const sessions = () => _request('GET', '/_admin/sessions');
const bindSession = (sessionId, profile) => _request('POST', '/_admin/session/bind', { session_id: sessionId, profile });
const unbindSession = (sessionId) => _request('POST', '/_admin/session/unbind', { session_id: sessionId });
const reloadConfig = () => _request('POST', '/_admin/reload', {});

function updateProfileOrder(profileName, models) {
  const os = require('os');
  const fs = require('fs');
  const path = require('path');
  const configPath = path.join(os.homedir(), '.cc-proxy', 'config.json');
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (!(profileName in (config.profiles || {}))) {
      return { error: `profile '${profileName}' not found in config` };
    }
    config.profiles[profileName] = models;
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    return reloadConfig();
  } catch (e) {
    return { error: e.message };
  }
}

async function getVersion() {
  const r = await status();
  return r.version || 'unknown';
}

module.exports = {
  status, profiles, listStrategies, getStrategy, createStrategy, updateStrategy,
  deleteStrategy, refreshStrategy, routingLog, reputation, checkpoint, sessions,
  bindSession, unbindSession, reloadConfig, updateProfileOrder, getVersion,
};
