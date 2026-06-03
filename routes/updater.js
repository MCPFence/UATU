'use strict';

const router = require('express').Router();
const { UpdateApplier } = require('../updater/applier');

const GITHUB_REPO = process.env.UATU_GITHUB_REPO || 'anthropics/uatu';

let _applier = null;
function getApplier(updateSite) {
  if (!_applier) _applier = new UpdateApplier(updateSite);
  return _applier;
}

router.get('/api/updater/status', (req, res) => {
  const updater = req.app.locals.updater;
  if (!updater) {
    return res.json({ observer_current: 'unknown', update_available: false });
  }
  res.json(updater.getStatus());
});

router.post('/api/updater/check', async (req, res) => {
  const updater = req.app.locals.updater;
  if (!updater) {
    return res.status(503).json({ error: 'updater not initialized' });
  }
  try {
    const result = await updater.checkNow();
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/api/updater/apply', async (req, res) => {
  const data = req.body || {};
  const component = data.component;
  if (!component || !['observer', 'cc_proxy'].includes(component)) {
    return res.status(400).json({ error: "component must be 'observer' or 'cc_proxy'" });
  }
  if (!data.version) {
    return res.status(400).json({ error: 'version is required' });
  }

  const updater = req.app.locals.updater;
  const updateSite = updater ? updater.updateSite : undefined;
  const applier = getApplier(updateSite);

  try {
    const url = data.url || '';
    const sha256 = data.sha256 || '';
    let result;
    if (component === 'observer') {
      result = await applier.applyObserverUpdate(url, data.version, sha256);
    } else {
      result = await applier.applyCcProxyUpdate(url, data.version, sha256);
    }
    res.json({ ok: true, component, version: data.version, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message, component });
  }
});

router.get('/api/updater/progress', (req, res) => {
  const applier = _applier;
  if (!applier) {
    return res.json({ status: 'idle', message: '', component: '' });
  }
  res.json(applier.getProgress());
});

router.get('/api/updater/versions', async (req, res) => {
  const repo = process.env.UATU_GITHUB_REPO || GITHUB_REPO;
  try {
    const resp = await fetch(`https://api.github.com/repos/${repo}/releases`, {
      signal: AbortSignal.timeout(15000),
      headers: { 'Accept': 'application/vnd.github+json' },
    });
    if (!resp.ok) return res.status(resp.status).json({ error: `GitHub API returned ${resp.status}` });
    const releases = await resp.json();

    const platformKey = `${process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'darwin' : 'linux'}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`;

    const versions = {};
    for (const rel of releases.slice(0, 20)) {
      const ver = (rel.tag_name || '').replace(/^v/, '');
      if (!ver) continue;
      const asset = (rel.assets || []).find(a => a.name.includes(platformKey));
      versions[ver] = {
        notes: rel.name || '',
        url: asset ? asset.browser_download_url : '',
        published_at: rel.published_at || '',
        channel: rel.prerelease ? 'beta' : 'stable',
      };
    }

    res.json({ observer: { versions } });
  } catch (e) {
    res.status(503).json({ error: e.message });
  }
});

router.post('/api/feedback', async (req, res) => {
  const feedbackUrl = process.env.UATU_FEEDBACK_URL;
  if (!feedbackUrl) {
    return res.status(501).json({ error: 'feedback endpoint not configured (set UATU_FEEDBACK_URL)' });
  }
  const body = req.body || {};
  try {
    const fs = require('fs');
    const path = require('path');
    const vf = path.join(__dirname, '..', 'version.json');
    const ver = JSON.parse(fs.readFileSync(vf, 'utf8'));
    body.version = ver.observer || '';
  } catch (_) {}
  try {
    const resp = await fetch(feedbackUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
    const text = await resp.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { error: text.slice(0, 200) }; }
    if (!resp.ok) return res.status(resp.status).json(data);
    res.json(data);
  } catch (e) {
    res.status(503).json({ error: e.message });
  }
});

module.exports = router;
