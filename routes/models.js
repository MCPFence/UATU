'use strict';

const router = require('express').Router();
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { store } = require('../lib/store');
const ccProxyClient = require('../ingest/cc-proxy-client');
const { estimateCost } = require('../analytics/cost-aggregator');
const { getBinaryName } = require('../process/cc-proxy-manager');

router.get('/api/system-status', async (req, res) => {
  const configPath = path.join(os.homedir(), '.cc-proxy', 'config.json');
  let configured = false;
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    configured = (config.providers || []).some(p => p.api_key && !p.api_key.startsWith('YOUR_'));
  } catch (_) {}

  let proxyOnline = false;
  try {
    const s = await ccProxyClient.status();
    proxyOnline = !s.error;
  } catch (_) {}

  let state = 'online';
  let label = '在线';
  if (!configured) { state = 'unconfigured'; label = '待配置'; }
  else if (!proxyOnline) { state = 'offline'; label = '离线'; }

  res.json({ state, label, configured, proxy_online: proxyOnline });
});

router.get('/api/models/config-status', (req, res) => {
  const configPath = path.join(os.homedir(), '.cc-proxy', 'config.json');
  if (!fs.existsSync(configPath)) {
    return res.json({ configured: false, path: configPath, message: '配置文件不存在', provider_list: [] });
  }
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const providers = config.providers || [];
    const hasValidKey = providers.some(p => p.api_key && !p.api_key.startsWith('YOUR_'));
    const profileCount = Object.keys(config.profiles || {}).length;
    const modelCount = providers.reduce((s, p) => s + (p.models || []).length, 0);
    const providerList = providers.map(p => {
      const key = p.api_key || '';
      let maskedKey = '';
      if (key && !key.startsWith('YOUR_')) {
        maskedKey = key.length > 8 ? key.slice(0, 4) + '****' + key.slice(-4) : '****';
      }
      return {
        name: p.name,
        type: p.type || 'openai',
        base_url: p.base_url || '',
        models: p.models || [],
        has_key: !!(key && !key.startsWith('YOUR_')),
        api_key_masked: maskedKey,
      };
    });
    res.json({
      configured: hasValidKey,
      path: configPath,
      providers: providers.length,
      models: modelCount,
      profiles: profileCount,
      has_valid_key: hasValidKey,
      provider_list: providerList,
      message: hasValidKey ? '' : '请配置有效的 API Key',
    });
  } catch (e) {
    res.json({ configured: false, path: configPath, message: `配置文件解析失败: ${e.message}`, provider_list: [] });
  }
});

router.post('/api/models/save-config', async (req, res) => {
  const { providers: providerData } = req.body || {};
  if (!providerData) {
    return res.status(400).json({ error: 'providers required' });
  }

  const configPath = path.join(os.homedir(), '.cc-proxy', 'config.json');
  let config;
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (e) {
    return res.status(500).json({ error: `Failed to read config: ${e.message}` });
  }

  if (!config.providers) config.providers = [];
  const updated = [];

  if (Array.isArray(providerData)) {
    for (const entry of providerData) {
      const name = (entry.name || '').trim();
      const key = (entry.api_key || '').trim();
      const base = (entry.base_url || '').trim();
      if (!name || !key) continue;

      let existing = config.providers.find(p => p.name.toLowerCase() === name.toLowerCase());
      if (existing) {
        existing.api_key = key;
        if (base) existing.base_url = base;
        if (entry.type) existing.type = entry.type;
      } else {
        const ptype = entry.type || (name.toLowerCase().includes('anthropic') ? 'anthropic' : 'openai');
        config.providers.push({ name, type: ptype, api_key: key, base_url: base || '', models: [] });
      }
      updated.push(name);
    }
  } else if (typeof providerData === 'object') {
    for (const p of config.providers) {
      if (providerData[p.name] !== undefined) {
        const key = (typeof providerData[p.name] === 'string' ? providerData[p.name] : '').trim();
        if (key) { p.api_key = key; updated.push(p.name); }
      }
    }
  }

  if (!updated.length) {
    return res.status(400).json({ error: '未提供任何有效的 API Key' });
  }

  config.providers = config.providers.filter(p =>
    p.api_key && !p.api_key.startsWith('YOUR_')
  );

  const activeProviders = new Set(config.providers.map(p => p.name));
  for (const [pName, entries] of Object.entries(config.profiles || {})) {
    config.profiles[pName] = entries.filter(e => activeProviders.has(e.provider));
  }

  try {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  } catch (e) {
    return res.status(500).json({ error: `Failed to write config: ${e.message}` });
  }

  const reload = await ccProxyClient.reloadConfig();
  const proxyOk = !reload || !reload.error;

  res.json({ ok: true, updated, proxy_reloaded: proxyOk });
});

router.get('/api/proxy/status', (req, res) => {
  const mgr = req.app.locals.ccProxyManager;
  if (!mgr) return res.json({ preflight: null, running: false, error: 'manager not initialized' });
  const pf = mgr.preflightResult;
  res.json({ preflight: pf.status, running: mgr.running, error: pf.error || null });
});

router.post('/api/proxy/activate', (req, res) => {
  const binDir = path.join(__dirname, '..', 'bin');
  const binName = getBinaryName();
  if (!binName) {
    return res.status(500).json({ error: `Unsupported platform: ${process.platform}/${process.arch}` });
  }

  const binPath = path.join(binDir, binName);
  if (!fs.existsSync(binPath)) {
    return res.status(500).json({ error: `cc-proxy binary not found: ${binPath}` });
  }

  // env.sh is already maintained by setupCco() on every server startup and is
  // model_auth-aware (correct ANTHROPIC_BASE_URL / ANTHROPIC_API_KEY). Read it
  // here; do NOT regenerate from `cc-proxy activate`, which would clobber the
  // model_auth routing.
  const envFile = path.join(os.homedir(), '.cc-proxy', 'env.sh');
  let envLines = '';
  try {
    envLines = fs.readFileSync(envFile, 'utf8').trim();
  } catch (e) {
    return res.status(500).json({ error: `env.sh missing — restart the server: ${e.message}` });
  }
  // Parse env vars from env.sh
  const envVars = {};
  for (const line of envLines.split('\n')) {
    const m = line.match(/^export\s+(\w+)=["']?(.+?)["']?\s*$/);
    if (m) envVars[m[1]] = m[2];
  }

  // Merge env vars into ~/.claude/settings.json. Idempotent: same values → no-op.
  // Always run on activate so the file reflects current model_auth state even
  // when the user re-activates after a key rotation.
  const claudeSettingsPath = path.join(os.homedir(), '.claude', 'settings.json');
  try {
    let settings = {};
    try { settings = JSON.parse(fs.readFileSync(claudeSettingsPath, 'utf8')); } catch {}
    const currentEnv = settings.env || {};
    const drift = Object.entries(envVars).some(([k, v]) => currentEnv[k] !== v);
    if (drift) {
      try { fs.copyFileSync(claudeSettingsPath, claudeSettingsPath.replace('settings.json', 'settings1.json')); } catch {}
      settings.env = { ...currentEnv, ...envVars };
      fs.mkdirSync(path.dirname(claudeSettingsPath), { recursive: true });
      fs.writeFileSync(claudeSettingsPath, JSON.stringify(settings, null, 2) + '\n');
    }
  } catch (e) {
    console.warn('[activate] could not write ~/.claude/settings.json:', e.message);
  }

  // Apply env vars to current process
  for (const [k, v] of Object.entries(envVars)) process.env[k] = v;

  // Detect shell profile
  const shell = process.env.SHELL || '/bin/zsh';
  const rcFile = shell.includes('zsh')
    ? path.join(os.homedir(), '.zshrc')
    : path.join(os.homedir(), '.bashrc');

  const sourceLine = `source "${envFile}"`;
  let alreadyInRc = false;
  try {
    const rcContent = fs.readFileSync(rcFile, 'utf8');
    alreadyInRc = rcContent.includes('.cc-proxy/env.sh') || rcContent.includes(sourceLine);
  } catch (_) {}

  // Append to shell rc only if not already present (first-time setup)
  if (!alreadyInRc) {
    try {
      fs.appendFileSync(rcFile, `\n# cc-proxy activation\n${sourceLine}\n`);
    } catch (e) {
      return res.json({ ok: true, env_file: envFile, rc_file: rcFile, rc_updated: false, warning: e.message, env: envLines });
    }
  }

  // Start cc-proxy if preflight was ok
  let proxyStarted = false;
  const mgr = req.app.locals.ccProxyManager;
  if (mgr && mgr.preflightResult.status === 'ok') {
    proxyStarted = mgr.start();
    mgr.startHealthCheck(30000);
  }

  res.json({ ok: true, env_file: envFile, rc_file: rcFile, rc_updated: !alreadyInRc, env: envLines, proxy_started: proxyStarted });
});

router.post('/api/models/batch', async (req, res) => {
  const { models } = req.body || {};
  if (!Array.isArray(models) || !models.length) {
    return res.status(400).json({ error: 'models[] required' });
  }
  const results = [];
  for (const m of models) {
    if (!m.model_name || !m.provider) continue;
    if (Array.isArray(m.group_names)) {
      m.group_name = m.group_names.join(',');
    }
    try {
      const rowId = store.createModel(m);
      results.push({ model_name: m.model_name, provider: m.provider, group_name: m.group_name || '', group_names: m.group_names || [], id: rowId, ok: true });
    } catch (e) {
      results.push({ model_name: m.model_name, provider: m.provider, error: e.message });
    }
  }

  const configPath = path.join(os.homedir(), '.cc-proxy', 'config.json');
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const added = results.filter(r => r.ok);
    if (!config.profiles) config.profiles = {};
    if (!config.profiles['default']) config.profiles['default'] = [];
    for (const m of added) {
      const prov = (config.providers || []).find(p => p.name.toLowerCase() === m.provider.toLowerCase());
      if (prov) {
        if (!prov.models) prov.models = [];
        if (!prov.models.includes(m.model_name)) prov.models.push(m.model_name);
      }
      const canonicalProv = prov ? prov.name : m.provider;
      // Add to default profile
      const inDefault = config.profiles['default'].some(e =>
        e.provider.toLowerCase() === canonicalProv.toLowerCase() && e.model === m.model_name
      );
      if (!inDefault) config.profiles['default'].push({ provider: canonicalProv, model: m.model_name });
      // Add to specific group profile(s)
      const groups = (m.group_name || '').split(',').filter(Boolean);
      for (const group of groups) {
        if (group === 'default') continue;
        if (!config.profiles[group]) config.profiles[group] = [];
        const exists = config.profiles[group].some(e =>
          e.provider.toLowerCase() === m.provider.toLowerCase() && e.model === m.model_name
        );
        if (!exists) config.profiles[group].push({ provider: prov ? prov.name : m.provider, model: m.model_name });
      }
    }
    if ((!config.priority || !config.priority.length) && added.length) {
      const first = added[0];
      const firstProv = (config.providers || []).find(p => p.name.toLowerCase() === first.provider.toLowerCase());
      config.priority = [{ provider: firstProv ? firstProv.name : first.provider, model: first.model_name }];
    }
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    await ccProxyClient.reloadConfig();
  } catch (_) {}

  res.json({ ok: true, added: results.filter(r => r.ok).length, total: models.length, results });
});

router.get('/api/models', (req, res) => {
  const models = store.listModels();
  for (const m of models) {
    const key = m.api_key || '';
    if (key && key.length > 8) m.api_key = key.slice(0, 8) + '****';
    else if (key) m.api_key = '****';
  }
  res.json({ models });
});

router.get('/api/models/in-use', (req, res) => {
  const models = store.listAllModels();
  res.json({ models });
});

router.get('/api/models/config-models', (req, res) => {
  const configPath = path.join(os.homedir(), '.cc-proxy', 'config.json');
  let config;
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (e) {
    return res.json({ models: [] });
  }

  const usageRows = store.listModelsInUse();
  const usageMap = {};
  for (const r of usageRows) {
    const key = `${r.actual_model}||${r.actual_provider.toLowerCase()}`;
    if (!usageMap[key]) usageMap[key] = { request_count: 0, total_input_tokens: 0, total_output_tokens: 0, avg_latency_ms: 0, last_seen: null, _count: 0 };
    usageMap[key].request_count += r.request_count || 0;
    usageMap[key].total_input_tokens += r.total_input_tokens || 0;
    usageMap[key].total_output_tokens += r.total_output_tokens || 0;
    usageMap[key].avg_latency_ms += (r.avg_latency_ms || 0) * (r.request_count || 0);
    usageMap[key]._count += r.request_count || 0;
    if (!usageMap[key].last_seen || (r.last_seen && r.last_seen > usageMap[key].last_seen)) {
      usageMap[key].last_seen = r.last_seen;
    }
  }
  for (const v of Object.values(usageMap)) {
    v.avg_latency_ms = v._count > 0 ? Math.round(v.avg_latency_ms / v._count) : 0;
    delete v._count;
  }

  const registryRows = store.listModels();
  const groupMap = {};
  for (const r of registryRows) {
    const rKey = `${r.model_name}||${(r.provider || '').toLowerCase()}`;
    groupMap[rKey] = r.group_name || '';
  }

  const models = [];
  const providers = config.providers || [];
  for (const p of providers) {
    const provName = p.name;
    const provType = p.type === 'anthropic' ? 'Anthropic' : 'OpenAI';
    for (const modelName of (p.models || [])) {
      const key = `${modelName}||${provName.toLowerCase()}`;
      const stats = usageMap[key] || {};
      const apiKey = p.api_key || '';
      const maskedKey = apiKey.length > 8 ? apiKey.slice(0, 4) + '****' + apiKey.slice(-4) : (apiKey ? '****' : '');
      models.push({
        model_name: modelName,
        provider: provName,
        model_type: provType,
        group_name: groupMap[key] || '',
        api_base: p.base_url || '',
        api_key_masked: maskedKey,
        request_count: stats.request_count || 0,
        total_input_tokens: stats.total_input_tokens || 0,
        total_output_tokens: stats.total_output_tokens || 0,
        avg_latency_ms: stats.avg_latency_ms || 0,
        last_seen: stats.last_seen || null,
      });
    }
  }

  // Auto-sync: all enabled models must be in profiles.default
  if (!config.profiles) config.profiles = {};
  const existingDefault = new Set(
    (config.profiles['default'] || []).map(e => `${e.model}||${(e.provider || '').toLowerCase()}`)
  );
  const newDefault = [];
  let configDirty = false;
  for (const p of providers) {
    for (const modelName of (p.models || [])) {
      const key = `${modelName}||${p.name.toLowerCase()}`;
      if (!existingDefault.has(key)) {
        newDefault.push({ provider: p.name, model: modelName });
        configDirty = true;
      }
    }
  }
  if (configDirty) {
    config.profiles['default'] = [...(config.profiles['default'] || []), ...newDefault];
    try {
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
      ccProxyClient.reloadConfig().catch(() => {});
    } catch (_) {}
  }

  res.json({ models });
});

router.get('/api/models/available', (req, res) => {
  const models = store.listAvailableModels();
  res.json({ models });
});

router.post('/api/models', (req, res) => {
  const data = req.body || {};
  if (!data.model_name || !data.provider) {
    return res.status(400).json({ error: 'model_name and provider are required' });
  }
  if (Array.isArray(data.group_names)) {
    data.group_name = data.group_names.join(',');
  }
  try {
    const rowId = store.createModel(data);
    const syncErr = _syncModelToCcProxy(data);
    const result = { id: rowId, ok: true };
    if (syncErr) result.sync_warning = syncErr;
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.put('/api/models/:modelId', async (req, res) => {
  const modelId = parseInt(req.params.modelId);
  const data = req.body || {};
  const row = store.getModel(modelId);
  if (!row) {
    return res.status(404).json({ error: 'not found' });
  }
  if (Array.isArray(data.group_names)) {
    data.group_name = data.group_names.join(',');
  }
  store.updateModel(modelId, data);

  if (data.group_name || data.group_names || data.model_type || data.enabled !== undefined) {
    const configPath = path.join(os.homedir(), '.cc-proxy', 'config.json');
    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      const provName = row.provider || '';
      const modelName = row.model_name;
      const prov = (config.providers || []).find(p => p.name.toLowerCase() === provName.toLowerCase());
      const canonicalProvider = prov ? prov.name : provName;

      if (!config.profiles) config.profiles = {};

      const newGroups = Array.isArray(data.group_names) ? data.group_names
        : (data.group_name ? data.group_name.split(',').filter(Boolean) : null);
      if (newGroups) {
        for (const profKey of ['premium', 'balanced', 'cheap']) {
          if (!config.profiles[profKey]) continue;
          config.profiles[profKey] = config.profiles[profKey].filter(e =>
            !(e.model === modelName && e.provider.toLowerCase() === canonicalProvider.toLowerCase())
          );
        }
        for (const gn of newGroups) {
          if (!gn || gn === 'default') continue;
          if (!config.profiles[gn]) config.profiles[gn] = [];
          const exists = config.profiles[gn].some(e =>
            e.model === modelName && e.provider.toLowerCase() === canonicalProvider.toLowerCase()
          );
          if (!exists) config.profiles[gn].push({ provider: canonicalProvider, model: modelName });
        }
      }

      if (!config.profiles['default']) config.profiles['default'] = [];
      const inDefault = config.profiles['default'].some(e =>
        e.model === modelName && e.provider.toLowerCase() === canonicalProvider.toLowerCase()
      );
      if (!inDefault) config.profiles['default'].push({ provider: canonicalProvider, model: modelName });

      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
      await ccProxyClient.reloadConfig();
    } catch (_) {}
  }

  res.json({ ok: true });
});

router.delete('/api/models/:modelId', async (req, res) => {
  const modelId = parseInt(req.params.modelId);
  const row = store.getModel(modelId);
  if (!row) {
    return res.status(404).json({ error: 'not found' });
  }
  store.deleteModel(modelId);

  const configPath = path.join(os.homedir(), '.cc-proxy', 'config.json');
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const prov = (config.providers || []).find(p => p.name.toLowerCase() === (row.provider || '').toLowerCase());
    if (prov && prov.models) {
      prov.models = prov.models.filter(m => m !== row.model_name);
    }
    for (const [pName, entries] of Object.entries(config.profiles || {})) {
      config.profiles[pName] = entries.filter(e =>
        !(e.model === row.model_name && e.provider.toLowerCase() === (row.provider || '').toLowerCase())
      );
    }
    if (Array.isArray(config.priority)) {
      config.priority = config.priority.filter(e =>
        !(e.model === row.model_name && e.provider.toLowerCase() === (row.provider || '').toLowerCase())
      );
    }
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    await ccProxyClient.reloadConfig();
  } catch (_) {}

  res.json({ ok: true });
});

router.post('/api/models/profile-order', async (req, res) => {
  const data = req.body || {};
  const profile = data.profile;
  const models = data.models;
  if (!profile || !Array.isArray(models)) {
    return res.status(400).json({ error: 'profile and models[] required' });
  }
  const result = await ccProxyClient.updateProfileOrder(profile, models);
  if (result && result.error) {
    return res.status(500).json(result);
  }
  res.json({ ok: true });
});

router.get('/api/models/groups', (req, res) => {
  const groups = store.listModelGroups();
  res.json({ groups });
});

router.post('/api/models/change-profile', async (req, res) => {
  const { provider, model, from, to } = req.body || {};
  if (!provider || !model || !to) {
    return res.status(400).json({ error: 'provider, model, and to are required' });
  }

  const configPath = path.join(os.homedir(), '.cc-proxy', 'config.json');
  let config;
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (e) {
    return res.status(500).json({ error: `Failed to read config: ${e.message}` });
  }

  if (!config.profiles) config.profiles = {};

  const providerEntry = (config.providers || []).find(p => p.name.toLowerCase() === provider.toLowerCase());
  if (!providerEntry) {
    return res.status(400).json({ error: `Provider "${provider}" 不在 cc-proxy 配置中` });
  }
  if (!providerEntry.models) providerEntry.models = [];
  if (!providerEntry.models.includes(model)) {
    providerEntry.models.push(model);
  }

  const canonicalProvider = providerEntry.name;

  if (from && from !== 'default' && config.profiles[from]) {
    config.profiles[from] = config.profiles[from].filter(e =>
      !(e.model === model && e.provider.toLowerCase() === canonicalProvider.toLowerCase())
    );
  }

  if (!config.profiles[to]) config.profiles[to] = [];
  const exists = config.profiles[to].some(e =>
    e.model === model && e.provider.toLowerCase() === canonicalProvider.toLowerCase()
  );
  if (!exists) {
    config.profiles[to].push({ provider: canonicalProvider, model });
  }

  // Ensure model stays in default profile
  if (!config.profiles['default']) config.profiles['default'] = [];
  const inDefault = config.profiles['default'].some(e =>
    e.model === model && e.provider.toLowerCase() === canonicalProvider.toLowerCase()
  );
  if (!inDefault) {
    config.profiles['default'].push({ provider: canonicalProvider, model });
  }

  try {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  } catch (e) {
    return res.status(500).json({ error: `Failed to write config: ${e.message}` });
  }

  try { store.updateModelGroup(model, provider, to); } catch (_) {}

  const reload = await ccProxyClient.reloadConfig();
  if (reload && reload.error) {
    return res.json({ ok: true, warning: `Config saved but reload failed: ${reload.error}` });
  }

  res.json({ ok: true, model, provider, from: from || '', to });
});

router.post('/api/models/toggle-profile', async (req, res) => {
  const { provider, model, profile, action } = req.body || {};
  if (!provider || !model || !profile || !['add', 'remove'].includes(action)) {
    return res.status(400).json({ error: 'provider, model, profile, and action (add/remove) required' });
  }

  const configPath = path.join(os.homedir(), '.cc-proxy', 'config.json');
  let config;
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (e) {
    return res.status(500).json({ error: `Failed to read config: ${e.message}` });
  }

  if (!config.profiles) config.profiles = {};
  const providerEntry = (config.providers || []).find(p => p.name.toLowerCase() === provider.toLowerCase());
  if (!providerEntry) {
    return res.status(400).json({ error: `Provider "${provider}" not in cc-proxy config` });
  }
  const canonicalProvider = providerEntry.name;

  if (action === 'add') {
    if (!config.profiles[profile]) config.profiles[profile] = [];
    const exists = config.profiles[profile].some(e =>
      e.model === model && e.provider.toLowerCase() === canonicalProvider.toLowerCase()
    );
    if (!exists) config.profiles[profile].push({ provider: canonicalProvider, model });
  } else {
    if (config.profiles[profile]) {
      config.profiles[profile] = config.profiles[profile].filter(e =>
        !(e.model === model && e.provider.toLowerCase() === canonicalProvider.toLowerCase())
      );
    }
  }

  if (!config.profiles['default']) config.profiles['default'] = [];
  const inDefault = config.profiles['default'].some(e =>
    e.model === model && e.provider.toLowerCase() === canonicalProvider.toLowerCase()
  );
  if (!inDefault) config.profiles['default'].push({ provider: canonicalProvider, model });

  try {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  } catch (e) {
    return res.status(500).json({ error: `Failed to write config: ${e.message}` });
  }

  const currentGroups = ['premium', 'balanced', 'cheap'].filter(p =>
    (config.profiles[p] || []).some(e => e.model === model && e.provider.toLowerCase() === canonicalProvider.toLowerCase())
  );
  try { store.updateModelGroup(model, provider, currentGroups.join(',')); } catch (_) {}

  const reload = await ccProxyClient.reloadConfig();
  if (reload && reload.error) {
    return res.json({ ok: true, warning: `Config saved but reload failed: ${reload.error}` });
  }

  res.json({ ok: true, model, provider, profile, action, current_groups: currentGroups });
});

router.post('/api/models/delete', async (req, res) => {
  const { model_name, provider } = req.body || {};
  if (!model_name || !provider) {
    return res.status(400).json({ error: 'model_name, provider required' });
  }

  const row = store.getModelByNameProvider(model_name, provider);
  if (row) {
    store.deleteModel(row.id);
  }

  const configPath = path.join(os.homedir(), '.cc-proxy', 'config.json');
  let config;
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (e) {
    return res.json({ ok: true, warning: `DB updated but config read failed: ${e.message}` });
  }

  const prov = (config.providers || []).find(p => p.name.toLowerCase() === provider.toLowerCase());
  if (prov) {
    if (prov.models) {
      prov.models = prov.models.filter(m => m !== model_name);
    }
    for (const [pName, entries] of Object.entries(config.profiles || {})) {
      config.profiles[pName] = entries.filter(e =>
        !(e.model === model_name && e.provider.toLowerCase() === prov.name.toLowerCase())
      );
    }
    if (Array.isArray(config.priority)) {
      config.priority = config.priority.filter(e =>
        !(e.model === model_name && e.provider.toLowerCase() === prov.name.toLowerCase())
      );
    }
  }

  try {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  } catch (e) {
    return res.json({ ok: true, warning: `DB updated but config write failed: ${e.message}` });
  }

  const reload = await ccProxyClient.reloadConfig();
  const proxyOk = !reload || !reload.error;

  res.json({ ok: true, model_name, provider, proxy_reloaded: proxyOk });
});

router.post('/api/models/edit', async (req, res) => {
  const { model_name, provider, updates } = req.body || {};
  if (!model_name || !provider || !updates) {
    return res.status(400).json({ error: 'model_name, provider, updates required' });
  }

  const row = store.getModelByNameProvider(model_name, provider);
  if (!row) {
    return res.status(404).json({ error: '模型未找到' });
  }

  const allowed = {};
  for (const k of ['model_name', 'model_type', 'group_name', 'group_names']) {
    if (k in updates && updates[k] !== undefined) allowed[k] = updates[k];
  }

  if (Array.isArray(allowed.group_names)) {
    allowed.group_name = allowed.group_names.join(',');
    delete allowed.group_names;
  }

  if (Object.keys(allowed).length) {
    store.updateModel(row.id, allowed);
  }

  const configPath = path.join(os.homedir(), '.cc-proxy', 'config.json');
  let config;
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (e) {
    return res.json({ ok: true, warning: `DB updated but config read failed: ${e.message}` });
  }

  const prov = (config.providers || []).find(p => p.name.toLowerCase() === provider.toLowerCase());
  const canonicalProvider = prov ? prov.name : provider;
  let configDirty = false;

  // Handle provider-level fields (api_base, api_key)
  if (prov) {
    if (updates.api_base) { prov.base_url = updates.api_base; configDirty = true; }
    if (updates.api_key) { prov.api_key = updates.api_key; configDirty = true; }
    if (allowed.model_type) {
      const newType = allowed.model_type === 'Anthropic' ? 'anthropic' : 'openai';
      if (prov.type !== newType) { prov.type = newType; configDirty = true; }
    }
  }

  // Handle model rename in config
  const newModelName = allowed.model_name || model_name;
  if (allowed.model_name && allowed.model_name !== model_name && prov) {
    if (prov.models) {
      const idx = prov.models.indexOf(model_name);
      if (idx !== -1) prov.models[idx] = newModelName;
    }
    for (const entries of Object.values(config.profiles || {})) {
      for (const e of entries) {
        if (e.model === model_name && e.provider.toLowerCase() === canonicalProvider.toLowerCase()) {
          e.model = newModelName;
        }
      }
    }
    if (Array.isArray(config.priority)) {
      for (const e of config.priority) {
        if (e.model === model_name && e.provider.toLowerCase() === canonicalProvider.toLowerCase()) {
          e.model = newModelName;
        }
      }
    }
    configDirty = true;
  }

  // Handle group change in config profiles (multi-profile support)
  const newGroups = Array.isArray(updates.group_names) ? updates.group_names
    : (allowed.group_name ? allowed.group_name.split(',').filter(Boolean) : null);
  if (newGroups) {
    if (!config.profiles) config.profiles = {};
    for (const profKey of ['premium', 'balanced', 'cheap']) {
      if (!config.profiles[profKey]) continue;
      config.profiles[profKey] = config.profiles[profKey].filter(e =>
        !(e.model === newModelName && e.provider.toLowerCase() === canonicalProvider.toLowerCase())
      );
    }
    for (const gn of newGroups) {
      if (!gn || gn === 'default') continue;
      if (!config.profiles[gn]) config.profiles[gn] = [];
      const exists = config.profiles[gn].some(e =>
        e.model === newModelName && e.provider.toLowerCase() === canonicalProvider.toLowerCase()
      );
      if (!exists) config.profiles[gn].push({ provider: canonicalProvider, model: newModelName });
    }

    if (!config.profiles['default']) config.profiles['default'] = [];
    const inDefault = config.profiles['default'].some(e =>
      e.model === newModelName && e.provider.toLowerCase() === canonicalProvider.toLowerCase()
    );
    if (!inDefault) config.profiles['default'].push({ provider: canonicalProvider, model: newModelName });
    configDirty = true;
  }

  if (configDirty) {
    try {
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    } catch (e) {
      return res.json({ ok: true, warning: `DB updated but config write failed: ${e.message}` });
    }
    await ccProxyClient.reloadConfig();
  }

  res.json({ ok: true, model_name: newModelName, provider, updates: allowed });
});

router.post('/api/models/sync', async (req, res) => {
  const result = await ccProxyClient.reloadConfig();
  if (result && result.error) {
    return res.status(503).json({ error: result.error });
  }
  res.json({ ok: true, message: 'cc-proxy config reloaded' });
});

router.get('/api/models/monthly-cost', (req, res) => {
  const allResp = store.queryMonthlyCost();

  const buckets = {};
  for (const r of allResp) {
    const month = r.month;
    if (!month) continue;
    const model = r.actual_model || 'unknown';
    const provider = r.actual_provider || '';
    const key = `${month}|${model}|${provider}`;

    const inp = r.total_input || 0;
    const out = r.total_output || 0;
    const cacheRead = r.total_cache_read || 0;
    const cacheCreate = r.total_cache_create || 0;
    const cost = estimateCost(model, inp, out, cacheRead, cacheCreate);

    if (!buckets[key]) {
      buckets[key] = { month, model, provider, input_tokens: 0, output_tokens: 0, request_count: 0, cost_rmb: 0 };
    }
    buckets[key].input_tokens += inp + cacheRead + cacheCreate;
    buckets[key].output_tokens += out;
    buckets[key].request_count += r.request_count || 0;
    buckets[key].cost_rmb += cost;
  }

  const months = {};
  for (const b of Object.values(buckets)) {
    const month = b.month;
    if (!months[month]) months[month] = { month, total_cost: 0, models: [] };
    b.cost_rmb = Math.round(b.cost_rmb * 100) / 100;
    months[month].total_cost = Math.round((months[month].total_cost + b.cost_rmb) * 100) / 100;
    months[month].models.push(b);
  }

  for (const m of Object.values(months)) {
    m.models.sort((a, b) => b.cost_rmb - a.cost_rmb);

    // Aggregate by provider
    const byProv = {};
    for (const entry of m.models) {
      const prov = entry.provider || 'unknown';
      if (!byProv[prov]) byProv[prov] = { provider: prov, cost_rmb: 0, request_count: 0, input_tokens: 0, output_tokens: 0, models: [] };
      byProv[prov].cost_rmb = Math.round((byProv[prov].cost_rmb + entry.cost_rmb) * 100) / 100;
      byProv[prov].request_count += entry.request_count;
      byProv[prov].input_tokens += entry.input_tokens;
      byProv[prov].output_tokens += entry.output_tokens;
      byProv[prov].models.push(entry);
    }
    m.by_provider = Object.values(byProv).sort((a, b) => b.cost_rmb - a.cost_rmb);
  }

  const result = Object.values(months).sort((a, b) => b.month.localeCompare(a.month));
  res.json(result);
});

function _syncModelToCcProxy(data) {
  const configPath = path.join(os.homedir(), '.cc-proxy', 'config.json');
  let config;
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (e) {
    return `Failed to read cc-proxy config: ${e.message}`;
  }

  const providerName = data.provider;
  const modelName = data.model_name;
  const apiKey = data.api_key || '';
  const apiBase = data.api_base || '';
  const modelType = data.model_type || 'OpenAI';
  const groupNames = Array.isArray(data.group_names) ? data.group_names
    : (data.group_name ? data.group_name.split(',').filter(Boolean) : []);

  let provider = null;
  for (const p of (config.providers || [])) {
    if (p.name.toLowerCase() === providerName.toLowerCase()) {
      provider = p;
      break;
    }
  }

  if (provider) {
    if (!(provider.models || []).includes(modelName)) {
      if (!provider.models) provider.models = [];
      provider.models.push(modelName);
    }
    if (apiKey) provider.api_key = apiKey;
    if (apiBase) provider.base_url = apiBase;
  } else {
    if (!apiKey || !apiBase) {
      return '\u65b0\u4f9b\u5e94\u5546\u9700\u8981\u586b\u5199 API Key \u548c API Base';
    }
    const ptype = modelType === 'Anthropic' ? 'anthropic' : 'openai';
    if (!config.providers) config.providers = [];
    config.providers.push({
      name: providerName,
      type: ptype,
      api_key: apiKey,
      base_url: apiBase,
      models: [modelName],
    });
  }

  const canonicalProv = provider ? provider.name : providerName;

  if (!config.profiles) config.profiles = {};

  if (!config.profiles['default']) config.profiles['default'] = [];
  const inDefault = config.profiles['default'].some(e =>
    e.provider.toLowerCase() === canonicalProv.toLowerCase() && e.model === modelName);
  if (!inDefault) {
    config.profiles['default'].push({ provider: canonicalProv, model: modelName });
  }

  for (const gn of groupNames) {
    if (!gn || gn === 'default') continue;
    if (!config.profiles[gn]) config.profiles[gn] = [];
    const exists = config.profiles[gn].some(e =>
      e.provider.toLowerCase() === canonicalProv.toLowerCase() && e.model === modelName);
    if (!exists) {
      config.profiles[gn].push({ provider: providerName, model: modelName });
    }
  }

  if (!config.priority || !config.priority.length) {
    config.priority = [{ provider: providerName, model: modelName }];
  }

  try {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  } catch (e) {
    return `Failed to write cc-proxy config: ${e.message}`;
  }

  try {
    ccProxyClient.reloadConfig();
  } catch {}
  return null;
}

// ============ Provider CRUD ============

function _readConfig(configPath) {
  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

function _writeConfig(configPath, config) {
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

const CONFIG_PATH = path.join(os.homedir(), '.cc-proxy', 'config.json');

router.get('/api/providers', (req, res) => {
  try {
    const config = _readConfig(CONFIG_PATH);
    const list = (config.providers || []).map(p => {
      const key = p.api_key || '';
      const masked = key && !key.startsWith('YOUR_')
        ? (key.length > 8 ? key.slice(0, 4) + '****' + key.slice(-4) : '****')
        : '';
      return {
        name: p.name,
        type: p.type || 'openai',
        base_url: p.base_url || '',
        models: p.models || [],
        has_key: !!(key && !key.startsWith('YOUR_')),
        api_key_masked: masked,
      };
    });
    res.json({ providers: list });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/api/providers', async (req, res) => {
  const { name, type, base_url, api_key } = req.body || {};
  if (!name || !api_key || !base_url) {
    return res.status(400).json({ error: 'name, api_key, base_url 必填' });
  }
  try {
    const config = _readConfig(CONFIG_PATH);
    if (!config.providers) config.providers = [];
    if (config.providers.some(p => p.name.toLowerCase() === name.toLowerCase())) {
      return res.status(409).json({ error: `Provider "${name}" 已存在` });
    }
    config.providers.push({ name, type: type || 'openai', api_key, base_url, models: [] });
    _writeConfig(CONFIG_PATH, config);
    const reload = await ccProxyClient.reloadConfig();
    res.json({ ok: true, name, proxy_reloaded: !reload?.error });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/api/providers/:name', async (req, res) => {
  const targetName = req.params.name;
  const { name, type, base_url, api_key } = req.body || {};
  try {
    const config = _readConfig(CONFIG_PATH);
    const prov = (config.providers || []).find(p => p.name.toLowerCase() === targetName.toLowerCase());
    if (!prov) return res.status(404).json({ error: `Provider "${targetName}" 不存在` });

    const newName = (name || '').trim() || prov.name;
    // If renaming, update references in profiles/priority
    if (newName !== prov.name) {
      for (const entries of Object.values(config.profiles || {})) {
        for (const e of entries) {
          if (e.provider.toLowerCase() === prov.name.toLowerCase()) e.provider = newName;
        }
      }
      if (Array.isArray(config.priority)) {
        for (const e of config.priority) {
          if (e.provider.toLowerCase() === prov.name.toLowerCase()) e.provider = newName;
        }
      }
      prov.name = newName;
    }
    if (type) prov.type = type;
    if (base_url) prov.base_url = base_url;
    if (api_key) prov.api_key = api_key;

    _writeConfig(CONFIG_PATH, config);
    const reload = await ccProxyClient.reloadConfig();
    res.json({ ok: true, name: newName, proxy_reloaded: !reload?.error });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/api/providers/:name', async (req, res) => {
  const targetName = req.params.name;
  try {
    const config = _readConfig(CONFIG_PATH);
    const idx = (config.providers || []).findIndex(p => p.name.toLowerCase() === targetName.toLowerCase());
    if (idx === -1) return res.status(404).json({ error: `Provider "${targetName}" 不存在` });

    const canonicalName = config.providers[idx].name;
    config.providers.splice(idx, 1);

    // Clean up profiles
    for (const [pName, entries] of Object.entries(config.profiles || {})) {
      config.profiles[pName] = entries.filter(e => e.provider.toLowerCase() !== canonicalName.toLowerCase());
    }
    // Clean up priority
    if (Array.isArray(config.priority)) {
      config.priority = config.priority.filter(e => e.provider.toLowerCase() !== canonicalName.toLowerCase());
    }

    _writeConfig(CONFIG_PATH, config);
    const reload = await ccProxyClient.reloadConfig();
    res.json({ ok: true, name: canonicalName, proxy_reloaded: !reload?.error });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
