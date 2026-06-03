'use strict';

const router = require('express').Router();
const fs = require('fs');
const path = require('path');
const os = require('os');
const { store } = require('../lib/store');
const ccProxyClient = require('../ingest/cc-proxy-client');

const CC_PROXY_LOG_DIR = path.join(os.homedir(), '.cc-proxy', 'logs');

let _toolQualityAnalyzer = null;
let _providerRouter = null;
let _costAggregator = null;

function getAnalytics() {
  if (!_toolQualityAnalyzer) {
    try {
      const { ToolCallQualityAnalyzer } = require('../analytics/engines');
      _toolQualityAnalyzer = new ToolCallQualityAnalyzer(store);
    } catch { _toolQualityAnalyzer = { analyzeSession: () => null }; }
  }
  if (!_providerRouter) {
    try {
      const { ProviderRouteTracker } = require('../analytics/engines');
      _providerRouter = new ProviderRouteTracker(store);
    } catch { _providerRouter = { trackSession: () => null, globalStats: () => ({}) }; }
  }
  if (!_costAggregator) {
    try {
      const { SessionCostAggregator } = require('../analytics/cost-aggregator');
      _costAggregator = new SessionCostAggregator(store);
    } catch { _costAggregator = { sessionCost: () => null }; }
  }
  return { toolQualityAnalyzer: _toolQualityAnalyzer, providerRouter: _providerRouter, costAggregator: _costAggregator };
}

// --- CC Proxy Ingestion ---
router.post('/api/ingest/cc-proxy', (req, res) => {
  const data = req.body;
  if (!data) return res.status(400).json({ error: 'empty payload' });

  const sessionId = data.session_id || '';
  if (!sessionId) return res.status(400).json({ error: 'missing session_id' });

  store.addCcProxyRequest({
    session_id: sessionId,
    session_dir: data.session_dir || '',
    seq: data.seq || 0,
    requested_model: data.requested_model || '',
    system_prompt: data.system_prompt || '',
    tool_definitions: data.tool_definitions || [],
    message_count: data.message_count || 0,
    raw_file_path: data.raw_file_path || '',
  });

  const respData = data.response || {};
  if (respData.actual_model) {
    store.addCcProxyResponse({
      session_id: sessionId,
      seq: data.seq || 0,
      request_id: respData.request_id || '',
      actual_model: respData.actual_model || '',
      actual_provider: respData.actual_provider || '',
      fallback_occurred: respData.fallback_occurred || false,
      input_tokens: respData.input_tokens || 0,
      output_tokens: respData.output_tokens || 0,
      elapsed_ms: respData.elapsed_ms || 0,
      raw_file_path: data.raw_file_path || '',
      timestamp: respData.timestamp || '',
    });
  }

  const toolCalls = data.tool_calls || [];
  if (toolCalls.length > 0) {
    for (const tc of toolCalls) {
      tc.session_id = sessionId;
      tc.seq = data.seq || 0;
      if (tc.is_hallucinated === undefined) tc.is_hallucinated = false;
      if (tc.is_fossil === undefined) tc.is_fossil = false;
      if (tc.fossil_hash === undefined) tc.fossil_hash = '';
    }
    store.addToolCallBatch(toolCalls);
  }

  res.json({ ok: true, session_id: sessionId, seq: data.seq || 0 });
});

// --- CC Proxy Sessions (scan filesystem) ---
// Sole caller is the strategy "限定 Session" picker. Optimized to avoid parsing
// every .resp.json: we only read the first req (for session_id + timestamp) and
// one resp (for a representative model). Token totals etc. are not used by the
// picker and are omitted. `?limit=N` caps the work (default 100).
router.get('/api/cc-proxy/sessions', (req, res) => {
  if (!fs.existsSync(CC_PROXY_LOG_DIR)) return res.json([]);

  const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 100, 1000));

  const sessions = [];
  let dateDirs;
  try { dateDirs = fs.readdirSync(CC_PROXY_LOG_DIR, { withFileTypes: true }); } catch { return res.json([]); }
  dateDirs = dateDirs.filter(d => d.isDirectory() && !d.name.startsWith('.'));
  dateDirs.sort((a, b) => b.name.localeCompare(a.name));

  outer: for (const dateDir of dateDirs) {
    const datePath = path.join(CC_PROXY_LOG_DIR, dateDir.name);
    const dateStr = dateDir.name;
    let sessionDirs;
    try { sessionDirs = fs.readdirSync(datePath, { withFileTypes: true }); } catch { continue; }

    const dirs = sessionDirs.filter(d => d.isDirectory()).map(d => d.name).sort((a, b) => b.localeCompare(a));

    for (const sdName of dirs) {
      const sdPath = path.join(datePath, sdName);
      let entries;
      try { entries = fs.readdirSync(sdPath); } catch { continue; }
      const reqFiles = entries.filter(f => f.endsWith('.req.json')).sort();
      const respFiles = entries.filter(f => f.endsWith('.resp.json')).sort();
      if (reqFiles.length === 0) continue;

      let fullSid = sdName;
      let firstTs = '';
      try {
        const firstReq = JSON.parse(fs.readFileSync(path.join(sdPath, reqFiles[0]), 'utf8'));
        fullSid = firstReq.session_id || sdName;
        firstTs = firstReq.timestamp || '';
      } catch {}

      const models = [];
      if (respFiles.length) {
        try {
          const rd = JSON.parse(fs.readFileSync(path.join(sdPath, respFiles[respFiles.length - 1]), 'utf8'));
          if (rd.model) models.push(rd.model);
        } catch {}
      }

      sessions.push({
        sessionId: fullSid,
        dirName: sdName,
        date: dateStr,
        startTime: firstTs,
        endTime: '',
        spanCount: reqFiles.length,
        logCount: respFiles.length,
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        models,
        providers: [],
        source: 'cc-proxy',
        toolCount: 0,
        errorCount: 0,
        traceIds: [],
      });

      if (sessions.length >= limit) break outer;
    }
  }

  sessions.sort((a, b) => (b.startTime || '').localeCompare(a.startTime || ''));
  res.json(sessions);
});

// --- Session tool quality ---
router.get('/api/session/:sessionId/tool-quality', (req, res) => {
  const sessionId = req.params.sessionId;
  const { toolQualityAnalyzer } = getAnalytics();
  const result = toolQualityAnalyzer.analyzeSession ? toolQualityAnalyzer.analyzeSession(sessionId) : null;
  if (result === null) {
    return res.status(404).json({ error: 'no cc-proxy data for this session', session_id: sessionId });
  }
  res.json(result);
});

// --- Tool stats ---
router.get('/api/tool-stats', (req, res) => {
  const ccSessions = store.queryCcProxySessionIds();
  const results = [];
  for (const s of ccSessions) {
    const sid = s.session_id;
    const calls = store.queryToolCallsBySession(sid);
    if (!calls || calls.length === 0) continue;
    const total = calls.length;
    const empty = calls.filter(c => !c.has_input).length;
    const fossil = calls.filter(c => c.is_fossil).length;
    results.push({
      session_id: sid,
      session_label: sid.slice(0, 20),
      total_calls: total,
      empty_count: empty,
      empty_rate: Math.round((empty / Math.max(total, 1)) * 1000) / 1000,
      fossil_count: fossil,
    });
  }
  res.json(results);
});

// --- Session routes (provider tracking) ---
router.get('/api/session/:sessionId/routes', (req, res) => {
  const sessionId = req.params.sessionId;
  const { providerRouter } = getAnalytics();
  const result = providerRouter.trackSession ? providerRouter.trackSession(sessionId) : null;
  if (result === null) {
    return res.status(404).json({ error: 'no cc-proxy data for this session' });
  }
  res.json(result);
});

// --- Provider stats ---
router.get('/api/provider-stats', (req, res) => {
  const { providerRouter } = getAnalytics();
  res.json(providerRouter.globalStats ? providerRouter.globalStats() : {});
});

// --- Session cost ---
router.get('/api/session/:sessionId/cost', (req, res) => {
  const sessionId = req.params.sessionId;
  const { costAggregator } = getAnalytics();
  const result = costAggregator.sessionCost ? costAggregator.sessionCost(sessionId) : null;
  if (result === null) {
    return res.status(404).json({ error: 'no cc-proxy data for this session' });
  }
  res.json(result);
});

// --- CC Proxy Checkpoint ---
router.post('/api/cc-proxy/checkpoint', async (req, res) => {
  const result = await ccProxyClient.checkpoint();
  res.json(result);
});

// --- CC Proxy Active Sessions ---
router.get('/api/cc-proxy/active-sessions', async (req, res) => {
  const result = await ccProxyClient.sessions();
  res.json(result);
});

// --- CC Proxy Session Projects ---
router.get('/api/cc-proxy/session-projects', (req, res) => {
  res.json(store.querySessionProjects());
});

// --- Session bind/unbind ---
router.post('/api/session/:sessionId/bind', async (req, res) => {
  const sessionId = req.params.sessionId;
  const profile = (req.body || {}).profile || '';
  if (!profile) return res.status(400).json({ error: 'profile required' });
  const result = await ccProxyClient.bindSession(sessionId, profile);
  res.json(result);
});

router.post('/api/session/:sessionId/unbind', async (req, res) => {
  const sessionId = req.params.sessionId;
  const result = await ccProxyClient.unbindSession(sessionId);
  res.json(result);
});

function _globSync(dir, suffix) {
  try {
    return fs.readdirSync(dir)
      .filter(f => f.endsWith(suffix))
      .sort()
      .map(f => path.join(dir, f));
  } catch { return []; }
}

module.exports = router;
