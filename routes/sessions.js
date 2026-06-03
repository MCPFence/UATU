'use strict';

const router = require('express').Router();
const fs = require('fs');
const path = require('path');
const os = require('os');
const { store } = require('../lib/store');
const { getSessionId, groupBySession } = require('../lib/parsers');
const { alertManager } = require('../lib/websocket');
const ccProxyClient = require('../ingest/cc-proxy-client');
const { estimateCost } = require('../analytics/cost-aggregator');

const _PII_LOG = path.join(os.homedir(), '.cc-proxy', 'logs', 'pii.jsonl');

function _readPiiEvents(sessionId) {
  try {
    if (!fs.existsSync(_PII_LOG)) return [];
    const prefix = sessionId.substring(0, 16);
    const lines = fs.readFileSync(_PII_LOG, 'utf8').split('\n').filter(Boolean);
    const events = [];
    for (const line of lines) {
      try {
        const r = JSON.parse(line);
        if (r.session_id === prefix) events.push(r);
      } catch {}
    }
    return events;
  } catch { return []; }
}

let _intentAnalyzer = null;
let _anomalyEngine = null;
let _toolQualityAnalyzer = null;
let _providerRouter = null;
let _costAggregator = null;

function getAnalytics() {
  if (!_intentAnalyzer) {
    try {
      const { IntentAnalyzer } = require('../analytics/intent');
      _intentAnalyzer = new IntentAnalyzer();
    } catch { _intentAnalyzer = { analyzeSessionAlignment: () => ({}) }; }
  }
  if (!_anomalyEngine) {
    try {
      const { AnomalyDetectionEngine } = require('../analytics/anomaly');
      _anomalyEngine = new AnomalyDetectionEngine();
    } catch { _anomalyEngine = null; }
  }
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
    } catch { _providerRouter = { trackSession: () => null }; }
  }
  if (!_costAggregator) {
    try {
      const { SessionCostAggregator } = require('../analytics/cost-aggregator');
      _costAggregator = new SessionCostAggregator(store);
    } catch { _costAggregator = { sessionCost: () => null }; }
  }
  return { intentAnalyzer: _intentAnalyzer, anomalyEngine: _anomalyEngine, toolQualityAnalyzer: _toolQualityAnalyzer, providerRouter: _providerRouter, costAggregator: _costAggregator };
}

const CC_PROXY_LOG_DIR = path.join(os.homedir(), '.cc-proxy', 'logs');

const _sessionsCache = { version: -1, data: [] };

function _dataVersion() {
  try {
    const db = store._db;
    const proxyCount = db.prepare('SELECT COUNT(*) as c FROM cc_proxy_responses').get().c;
    return store.countTraces() + store.countLogs() + proxyCount;
  } catch {
    return store.countTraces() + store.countLogs();
  }
}

function _parseTs(t) {
  if (!t) return 0;
  t = String(t).trim();
  const tClean = t.replace('Z', '').replace('+00:00', '').replace('T', ' ');
  try {
    const d = new Date(tClean.slice(0, 26).replace(' ', 'T') + 'Z');
    if (!isNaN(d.getTime())) return d.getTime();
  } catch {}
  return 0;
}

const _ccProxySessionsCache = { mtime: 0, data: [] };

function _scanCcProxySessions() {
  if (!fs.existsSync(CC_PROXY_LOG_DIR)) return [];

  let currentMtime = 0;
  try {
    const entries = fs.readdirSync(CC_PROXY_LOG_DIR, { withFileTypes: true });
    for (const d of entries) {
      if (d.isDirectory() && !d.name.startsWith('.')) {
        const mt = fs.statSync(path.join(CC_PROXY_LOG_DIR, d.name)).mtimeMs;
        if (mt > currentMtime) currentMtime = mt;
      }
    }
  } catch { currentMtime = 0; }

  if (_ccProxySessionsCache.mtime === currentMtime && _ccProxySessionsCache.data.length > 0) {
    return _ccProxySessionsCache.data;
  }

  const sessions = [];
  let dateDirs;
  try { dateDirs = fs.readdirSync(CC_PROXY_LOG_DIR, { withFileTypes: true }); } catch { return []; }
  dateDirs = dateDirs.filter(d => d.isDirectory() && !d.name.startsWith('.'));
  dateDirs.sort((a, b) => b.name.localeCompare(a.name));

  for (const dateDir of dateDirs) {
    const datePath = path.join(CC_PROXY_LOG_DIR, dateDir.name);
    let sessionDirs;
    try { sessionDirs = fs.readdirSync(datePath, { withFileTypes: true }); } catch { continue; }

    for (const sd of sessionDirs.filter(d => d.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
      const sdPath = path.join(datePath, sd.name);
      const reqFiles = _globSync(sdPath, '.req.json');
      const respFiles = _globSync(sdPath, '.resp.json');
      if (reqFiles.length === 0) continue;

      let fullSid = sd.name;
      let firstTs = '';
      let lastTs = '';
      const models = new Set();
      let totalInput = 0;
      let totalOutput = 0;

      try {
        const firstReq = JSON.parse(fs.readFileSync(reqFiles[0], 'utf8'));
        fullSid = firstReq.session_id || sd.name;
        firstTs = firstReq.timestamp || '';
      } catch {}

      let sample = respFiles;
      if (respFiles.length > 30) {
        const mid = Math.floor(respFiles.length / 2);
        sample = [
          ...respFiles.slice(0, 10),
          ...respFiles.slice(mid - 5, mid + 5),
          ...respFiles.slice(-10),
        ];
      }

      for (const rf of sample) {
        try {
          const rd = JSON.parse(fs.readFileSync(rf, 'utf8'));
          const m = rd.model || '';
          if (m) models.add(m);
          const ts = rd.timestamp || '';
          if (ts && (!lastTs || ts > lastTs)) lastTs = ts;
          const ri = rd.response || {};
          if (typeof ri === 'object') {
            const u = ri.usage || {};
            totalInput += (u.input_tokens || 0);
            totalOutput += (u.output_tokens || 0);
          }
        } catch {}
      }

      sessions.push({
        sessionId: fullSid,
        startTime: firstTs,
        endTime: lastTs,
        spanCount: reqFiles.length,
        logCount: respFiles.length,
        toolCount: 0,
        errorCount: 0,
        totalTokens: totalInput + totalOutput,
        models: [...models].sort(),
        traceIds: [],
        source: 'cc-proxy',
      });
    }
  }

  _ccProxySessionsCache.mtime = currentMtime;
  _ccProxySessionsCache.data = sessions;
  return sessions;
}

function _globSync(dir, suffix) {
  try {
    return fs.readdirSync(dir)
      .filter(f => f.endsWith(suffix))
      .sort()
      .map(f => path.join(dir, f));
  } catch { return []; }
}

// --- Sessions list ---
router.get('/api/sessions', (req, res) => {
  const version = _dataVersion();
  if (_sessionsCache.version === version && _sessionsCache.data.length > 0) {
    return res.json(_sessionsCache.data);
  }

  const allSpans = store.queryAllTraces();
  const allLogs = store.queryAllLogs();
  const { spanSessions, logSessions, allSids } = groupBySession(allSpans, allLogs);

  const result = [];
  for (const sid of allSids) {
    const spans = spanSessions[sid] || [];
    const slogs = logSessions[sid] || [];

    let times = [];
    if (spans.length > 0) {
      const spansSorted = [...spans].sort((a, b) => (a.startTime || '').localeCompare(b.startTime || ''));
      times.push(spansSorted[0].startTime);
      times.push(spansSorted[spansSorted.length - 1].endTime);
    }
    for (const l of slogs) {
      const t = (l.attributes || {})['event.timestamp'] || l.time || '';
      if (t) times.push(t);
    }
    times = times.filter(t => t);
    const startTime = times.length > 0 ? times.reduce((a, b) => a < b ? a : b) : '';
    const endTime = times.length > 0 ? times.reduce((a, b) => a > b ? a : b) : '';

    let totalTokens = 0;
    for (const s of spans) {
      totalTokens += ((s.attributes || {}).input_tokens || 0) + ((s.attributes || {}).output_tokens || 0);
    }
    for (const l of slogs) {
      const attrs = l.attributes || {};
      if (attrs['event.name'] === 'api_request') {
        totalTokens += parseInt(attrs.input_tokens || 0) + parseInt(attrs.output_tokens || 0);
      }
    }

    const modelsSet = new Set();
    for (const s of spans) {
      const m = (s.attributes || {}).model;
      if (m) modelsSet.add(m);
    }
    for (const l of slogs) {
      const m = (l.attributes || {}).model;
      if (m) modelsSet.add(m);
    }
    const models = [...modelsSet].filter(m => m);

    let toolCount = 0;
    for (const l of slogs) {
      const en = (l.attributes || {})['event.name'] || '';
      if (en.includes('tool') && en.includes('tool_result')) toolCount++;
    }

    let errorCount = 0;
    for (const s of spans) {
      if ((s.status || {}).code === 2) errorCount++;
    }

    result.push({
      sessionId: sid,
      startTime, endTime,
      spanCount: spans.length,
      logCount: slogs.length,
      toolCount, errorCount,
      totalTokens,
      models,
      traceIds: [...new Set(spans.filter(s => s.traceId).map(s => s.traceId))],
      source: 'otlp',
    });
  }

  const existingSids = new Set(result.map(r => r.sessionId));
  const ccProxySessions = _scanCcProxySessions();
  for (const cps of ccProxySessions) {
    if (!existingSids.has(cps.sessionId)) {
      result.push(cps);
    } else {
      for (const r of result) {
        if (r.sessionId === cps.sessionId) {
          r.source = 'both';
          if (!r.models || r.models.length === 0) r.models = cps.models || [];
          if (!r.totalTokens) r.totalTokens = cps.totalTokens || 0;
          break;
        }
      }
    }
  }

  result.sort((a, b) => (b.startTime || '').localeCompare(a.startTime || ''));
  _sessionsCache.version = version;
  _sessionsCache.data = result;
  res.json(result);
});

// --- Filtered session list with cost aggregation ---
router.get('/api/sessions/filter', (req, res) => {
  const qModel = (req.query.model || '').toLowerCase();
  const qMinCost = parseFloat(req.query.min_cost || 0);
  const qMaxCost = parseFloat(req.query.max_cost || Infinity);
  const qSearch = (req.query.q || '').toLowerCase();
  const qSort = req.query.sort || 'time';
  const qOrder = req.query.order || 'desc';

  const version = _dataVersion();
  if (_sessionsCache.version !== version || _sessionsCache.data.length === 0) {
    const allSpans = store.queryAllTraces();
    const allLogs = store.queryAllLogs();
    const { spanSessions, logSessions, allSids } = groupBySession(allSpans, allLogs);
    const sessions = [];
    for (const sid of allSids) {
      const spans = spanSessions[sid] || [];
      const slogs = logSessions[sid] || [];
      let times = [];
      if (spans.length > 0) {
        const sorted = [...spans].sort((a, b) => (a.startTime || '').localeCompare(b.startTime || ''));
        times.push(sorted[0].startTime, sorted[sorted.length - 1].endTime);
      }
      for (const l of slogs) {
        const t = (l.attributes || {})['event.timestamp'] || l.time || '';
        if (t) times.push(t);
      }
      times = times.filter(t => t);
      let totalTokens = 0;
      for (const s of spans) totalTokens += ((s.attributes || {}).input_tokens || 0) + ((s.attributes || {}).output_tokens || 0);
      for (const l of slogs) {
        const a = l.attributes || {};
        if (a['event.name'] === 'api_request') totalTokens += parseInt(a.input_tokens || 0) + parseInt(a.output_tokens || 0);
      }
      const modelsSet = new Set();
      for (const s of spans) { const m = (s.attributes || {}).model; if (m) modelsSet.add(m); }
      for (const l of slogs) { const m = (l.attributes || {}).model; if (m) modelsSet.add(m); }
      let errorCount = 0;
      for (const s of spans) { if ((s.status || {}).code === 2) errorCount++; }
      sessions.push({
        sessionId: sid,
        startTime: times.length > 0 ? times.reduce((a, b) => a < b ? a : b) : '',
        endTime: times.length > 0 ? times.reduce((a, b) => a > b ? a : b) : '',
        totalTokens, models: [...modelsSet].filter(m => m), errorCount, source: 'otlp',
      });
    }
    _sessionsCache.version = version;
    _sessionsCache.data = sessions;
  }

  let sessions = [..._sessionsCache.data];

  // Merge cc-proxy sessions from filesystem scan (real timestamps)
  const existingSids = new Set(sessions.map(s => s.sessionId));
  const ccProxySessions = _scanCcProxySessions();
  for (const cps of ccProxySessions) {
    if (!existingSids.has(cps.sessionId)) {
      sessions.push({ ...cps });
      existingSids.add(cps.sessionId);
    } else {
      for (const r of sessions) {
        if (r.sessionId === cps.sessionId) {
          r.source = 'both';
          if (!r.models || r.models.length === 0) r.models = cps.models || [];
          if (!r.totalTokens) r.totalTokens = cps.totalTokens || 0;
          if (!r.startTime && cps.startTime) r.startTime = cps.startTime;
          if (!r.endTime && cps.endTime) r.endTime = cps.endTime;
          break;
        }
      }
    }
  }

  // Attach cost and interaction stats to each session.
  // Single batch query replaces per-session costAggregator.sessionCost() loop —
  // turns N×(2-3 LIKE queries + 1 SELECT *) into 1 GROUP BY + 1 stats query.
  const { estimateCost } = require('../analytics/cost-aggregator');
  const costRollup = store.querySessionCostRollup();
  const costBySid = {};
  for (const r of costRollup) {
    const c = estimateCost(r.model, r.input_tokens, r.output_tokens, r.cache_read_tokens, r.cache_creation_tokens);
    costBySid[r.session_id] = (costBySid[r.session_id] || 0) + c;
  }
  const interactionStats = store.querySessionInteractionStats();
  const firstQueryRows = store.querySessionFirstQuery();
  const firstQueryMap = {};
  for (const r of firstQueryRows) firstQueryMap[r.session_id] = r.query_preview;
  for (const s of sessions) {
    s.totalCost = Math.round((costBySid[s.sessionId] || 0) * 10000) / 10000;

    const st = _parseTs(s.startTime);
    const et = _parseTs(s.endTime);
    s.latency_ms = (st && et && et > st) ? et - st : 0;

    const iStats = interactionStats[s.sessionId];
    s.human_turns = iStats ? iStats.human_turns : 0;
    s.max_turn_ms = iStats ? iStats.max_turn_ms : 0;
    s.firstQuery = firstQueryMap[s.sessionId] || '';
  }

  // Filter
  sessions = sessions.filter(s => {
    if (qModel && !(s.models || []).some(m => m.toLowerCase().includes(qModel))) return false;
    if (s.totalCost < qMinCost) return false;
    if (isFinite(qMaxCost) && s.totalCost > qMaxCost) return false;
    if (qSearch && !s.sessionId.toLowerCase().includes(qSearch) &&
        !(s.models || []).some(m => m.toLowerCase().includes(qSearch)) &&
        !(s.firstQuery || '').toLowerCase().includes(qSearch)) return false;
    return true;
  });

  // Sort
  const dir = qOrder === 'asc' ? 1 : -1;
  sessions.sort((a, b) => {
    switch (qSort) {
      case 'cost': return (a.totalCost - b.totalCost) * dir;
      case 'tokens': return (a.totalTokens - b.totalTokens) * dir;
      case 'latency': return (a.latency_ms - b.latency_ms) * dir;
      case 'errors': return ((a.errorCount || 0) - (b.errorCount || 0)) * dir;
      default: return (a.startTime || '').localeCompare(b.startTime || '') * dir;
    }
  });

  const totalCost = sessions.reduce((sum, s) => sum + (s.totalCost || 0), 0);
  res.json({
    sessions,
    total: sessions.length,
    total_cost: Math.round(totalCost * 1e6) / 1e6,
  });
});

// --- Session detail ---
router.get('/api/session/:sessionId', (req, res) => {
  const sessionId = req.params.sessionId;
  const spans = store.queryTracesBySession(sessionId);
  const sessionLogs = store.queryLogsBySession(sessionId);

  const spansSorted = [...spans].sort((a, b) => (a.startTime || '').localeCompare(b.startTime || ''));
  const logsSorted = [...sessionLogs].sort((a, b) =>
    ((a.attributes || {})['event.sequence'] || 0) - ((b.attributes || {})['event.sequence'] || 0));

  const nodes = [];
  const edges = [];

  const spanIds = new Set(spansSorted.map(s => s.spanId));
  const spanParentEdges = [];
  const spanList = [];

  for (const s of spansSorted) {
    const name = s.name;
    const attrs = s.attributes;
    let ntype = 'other';
    if (name.includes('llm_request')) ntype = 'llm';
    else if (name.includes('hook')) ntype = 'hook';
    else if (name.includes('tool')) ntype = 'tool';

    spanList.push({
      spanId: s.spanId, name, type: ntype,
      duration: s.durationMs, startTime: s.startTime,
      endTime: s.endTime, attributes: attrs,
      status: s.status || {}, parentSpanId: s.parentSpanId || '',
      traceId: s.traceId,
    });

    if (s.parentSpanId && spanIds.has(s.parentSpanId)) {
      spanParentEdges.push({ source: s.parentSpanId, target: s.spanId });
    }
  }

  const logNodeIds = [];
  const tooldefCollector = { names: [], firstSeq: 0, firstI: 0, ts: '' };

  for (let i = 0; i < logsSorted.length; i++) {
    const l = logsSorted[i];
    let body = l.body || '';
    if (typeof body === 'object') body = body.name || JSON.stringify(body);
    const bodyStr = String(body);
    const attrs = l.attributes || {};
    const eventName = attrs['event.name'] || bodyStr;
    const seq = attrs['event.sequence'] || i;

    let ntype = 'event';
    if (eventName.includes('api_request')) ntype = 'llm';
    else if (eventName === 'tool') ntype = 'tooldef';
    else if (eventName.includes('tool') && eventName !== 'hook_execution_start' && eventName !== 'hook_execution_complete') ntype = 'tool';
    else if (eventName.includes('hook')) ntype = 'hook';
    else if (eventName.includes('system_prompt') || eventName.includes('user_prompt')) ntype = 'prompt';

    const nodeId = `log-${seq}-${i}`;

    if (ntype === 'tooldef') {
      if (tooldefCollector.names.length === 0) {
        tooldefCollector.firstSeq = seq;
        tooldefCollector.firstI = i;
        tooldefCollector.ts = attrs['event.timestamp'] || l.time || '';
      }
      tooldefCollector.names.push(attrs.tool_name || bodyStr);
      continue;
    }

    if (tooldefCollector.names.length > 0) {
      const tdNames = tooldefCollector.names;
      const tdId = `log-${tooldefCollector.firstSeq}-${tooldefCollector.firstI}`;
      nodes.push({
        id: tdId, name: `Available Tools (${tdNames.length})`,
        type: 'tooldef', duration: 0,
        startTime: tooldefCollector.ts, endTime: tooldefCollector.ts,
        attributes: { tools: tdNames }, body: tdNames.join(', '),
        status: {}, parentId: '', traceId: '',
        source: 'log', sequence: tooldefCollector.firstSeq,
        severity: '', eventTimestamp: tooldefCollector.ts,
      });
      logNodeIds.push(tdId);
      tooldefCollector.names = [];
    }

    logNodeIds.push(nodeId);

    let label;
    if (ntype === 'tool') {
      label = `Tool: ${attrs.tool_name || 'unknown'}`;
    } else if (ntype === 'llm') {
      const model = attrs.model || '';
      const tokens = `${attrs.input_tokens || 0}\u2192${attrs.output_tokens || 0}`;
      label = `API: ${model} (${tokens})`;
    } else if (ntype === 'hook') {
      label = `Hook: ${attrs.hook_name || attrs.hook_event || ''}`;
    } else if (ntype === 'prompt') {
      label = eventName.replace('claude_code.', '');
    } else {
      label = bodyStr.slice(0, 40);
    }

    const node = {
      id: nodeId, name: label, type: ntype,
      duration: attrs.duration_ms || 0,
      startTime: attrs['event.timestamp'] || l.time || '',
      endTime: attrs['event.timestamp'] || l.time || '',
      attributes: attrs, body: bodyStr,
      status: {}, parentId: '', traceId: '',
      source: 'log', sequence: seq,
      severity: l.severityText || '',
      eventTimestamp: attrs['event.timestamp'] || l.time || '',
    };
    if (ntype === 'llm' && (attrs.cost_rmb || attrs.cost_usd)) {
      node.cost = attrs.cost_rmb || attrs.cost_usd;
    }
    nodes.push(node);
  }

  if (tooldefCollector.names.length > 0) {
    const tdNames = tooldefCollector.names;
    const tdId = `log-${tooldefCollector.firstSeq}-${tooldefCollector.firstI}`;
    nodes.push({
      id: tdId, name: `Available Tools (${tdNames.length})`,
      type: 'tooldef', duration: 0,
      startTime: tooldefCollector.ts, endTime: tooldefCollector.ts,
      attributes: { tools: tdNames }, body: tdNames.join(', '),
      status: {}, parentId: '', traceId: '',
      source: 'log', sequence: tooldefCollector.firstSeq,
      severity: '', eventTimestamp: tooldefCollector.ts,
    });
    logNodeIds.push(tdId);
  }

  for (let i = 1; i < logNodeIds.length; i++) {
    edges.push({ source: logNodeIds[i - 1], target: logNodeIds[i], edgeType: 'sequence' });
  }

  const nodeById = {};
  for (const n of nodes) nodeById[n.id] = n;

  const logNodesByType = {};
  for (const n of nodes) {
    const ts = _parseTs(n.startTime || n.eventTimestamp);
    if (n.source === 'log' && n.type !== 'tooldef') {
      (logNodesByType[n.type] ||= []).push([ts, n.id]);
    }
  }

  const spanToLog = {};
  const matchedSpans = new Set();

  for (const sp of spanList) {
    const spTs = _parseTs(sp.startTime);
    const spType = sp.type;
    const candidates = logNodesByType[spType] || [];
    let bestId = null;
    let bestDiff = Infinity;
    for (const [lts, lid] of candidates) {
      const diff = Math.abs(spTs - lts);
      if (diff < bestDiff && diff < 5000) {
        bestDiff = diff;
        bestId = lid;
      }
    }
    if (bestId && !matchedSpans.has(bestId)) {
      spanToLog[sp.spanId] = bestId;
      matchedSpans.add(bestId);
      const ln = nodeById[bestId];
      ln.spanId = sp.spanId;
      ln.traceId = sp.traceId;
      if (sp.duration && (!ln.duration || ln.duration === 0)) ln.duration = sp.duration;
      if (sp.endTime && ln.endTime === ln.startTime) ln.endTime = sp.endTime;
      ln.status = sp.status || {};
      for (const [k, v] of Object.entries(sp.attributes)) {
        if (!(k in ln.attributes)) ln.attributes[k] = v;
      }
    } else {
      const spNode = {
        id: sp.spanId, name: sp.name, type: sp.type,
        duration: sp.duration, startTime: sp.startTime,
        endTime: sp.endTime, attributes: sp.attributes,
        status: sp.status || {},
        parentId: sp.parentSpanId || '', traceId: sp.traceId,
        source: 'span',
      };
      nodes.push(spNode);
      nodeById[sp.spanId] = spNode;

      let bestLog = null;
      let bestDiff2 = Infinity;
      for (const n of nodes) {
        if (n.source === 'log') {
          const nts = _parseTs(n.startTime || n.eventTimestamp);
          const diff = Math.abs(spTs - nts);
          if (diff < bestDiff2) {
            bestDiff2 = diff;
            bestLog = n.id;
          }
        }
      }
      if (bestLog) {
        edges.push({ source: bestLog, target: sp.spanId, edgeType: 'span-link' });
      }
    }
  }

  for (const pe of spanParentEdges) {
    const src = spanToLog[pe.source] || pe.source;
    const tgt = spanToLog[pe.target] || pe.target;
    if (nodeById[src] && nodeById[tgt] && src !== tgt) {
      edges.push({ source: src, target: tgt, edgeType: 'span-parent' });
    }
  }

  const spanAttrByTypeTime = {};
  for (const sp of spanList) {
    spanAttrByTypeTime[`${sp.type}|${sp.startTime}`] = sp.attributes;
  }

  // Build turns
  const turns = [];
  let currentTurn = null;
  let currentLlm = null;
  let turnIdx = 0;
  let llmIdx = 0;
  let toolIdx = 0;
  let pendingTools = [];

  for (let i = 0; i < logsSorted.length; i++) {
    const l = logsSorted[i];
    let body = l.body || '';
    let bodyStr;
    if (typeof body === 'object') bodyStr = body.name || JSON.stringify(body);
    else bodyStr = String(body);
    const attrs = l.attributes || {};
    const eventName = attrs['event.name'] || bodyStr;
    const seq = attrs['event.sequence'] || i;
    const ts = attrs['event.timestamp'] || l.time || '';

    if (eventName.includes('user_prompt')) {
      turnIdx++;
      llmIdx = 0;
      toolIdx = 0;
      currentLlm = null;
      pendingTools = [];
      currentTurn = {
        id: `turn-${turnIdx}`, type: 'turn',
        label: `Turn ${turnIdx}`, prompt: attrs.prompt || bodyStr,
        startTime: ts, endTime: ts, sequence: seq,
        llm_calls: [], hooks: [], events: [], attributes: attrs,
      };
      turns.push(currentTurn);

    } else if (eventName.includes('system_prompt')) {
      if (currentTurn) {
        currentTurn.events.push({
          id: `evt-${seq}-${i}`, type: 'prompt',
          label: eventName.replace('claude_code.', ''),
          sequence: seq, startTime: ts, attributes: attrs,
        });
      }

    } else if (eventName === 'tool') {
      continue;

    } else if (eventName.includes('tool_use_start') || eventName.includes('tool_start') || eventName === 'tool_decision') {
      toolIdx++;
      const toolName = attrs.tool_name || attrs.name || 'unknown';
      let toolInput = '';
      if (attrs.tool) {
        try {
          const ti = typeof attrs.tool === 'object' ? attrs.tool : JSON.parse(String(attrs.tool));
          toolInput = JSON.stringify(ti);
        } catch { toolInput = String(attrs.tool || ''); }
      } else if (attrs.input) {
        toolInput = String(attrs.input);
      }

      const spAttrs = spanAttrByTypeTime[`tool|${ts}`] || {};
      if (!toolInput && spAttrs.tool_input) toolInput = String(spAttrs.tool_input);

      const toolNode = {
        id: `tool-${turnIdx}-${llmIdx}-${toolIdx}`, type: 'tool',
        label: toolName, tool_name: toolName,
        input: toolInput, output: '',
        duration_ms: attrs.duration_ms || 0, success: true,
        startTime: ts, endTime: ts, sequence: seq,
        attributes: { ...spAttrs, ...attrs },
      };
      if (currentLlm) currentLlm.tools.push(toolNode);
      else pendingTools.push(toolNode);

    } else if (eventName.includes('api_request_start') || eventName === 'api_request') {
      llmIdx++;
      const spAttrs = spanAttrByTypeTime[`llm|${ts}`] || {};
      const modelOutput = attrs['response.model_output']
        ? String(attrs['response.model_output'])
        : (spAttrs['response.model_output'] ? String(spAttrs['response.model_output']) : '');
      const thinkingOutput = spAttrs['response.thinking_output'] ? String(spAttrs['response.thinking_output']) : '';
      const mergedAttrs = { ...spAttrs, ...attrs };
      currentLlm = {
        id: `llm-${turnIdx}-${llmIdx}`, type: 'llm',
        label: `LLM Request #${llmIdx}`,
        model: attrs.model || 'unknown',
        startTime: ts, endTime: ts, sequence: seq,
        input_tokens: attrs.input_tokens || 0,
        output_tokens: attrs.output_tokens || 0,
        cache_read_tokens: attrs.cache_read_tokens || 0,
        cache_creation_tokens: attrs.cache_creation_tokens || 0,
        cost_rmb: attrs.cost_rmb || attrs.cost_usd || 0,
        duration_ms: attrs.duration_ms || 0,
        tools: [],
        response: modelOutput,
        thinking: thinkingOutput,
        has_tool_call: !!(attrs['response.has_tool_call'] || spAttrs['response.has_tool_call']),
        attributes: mergedAttrs,
      };
      if (pendingTools.length > 0) {
        currentLlm.tools = pendingTools;
        pendingTools = [];
      }
      if (currentTurn) {
        currentTurn.llm_calls.push(currentLlm);
      } else {
        if (turns.length === 0) {
          currentTurn = {
            id: 'turn-0', type: 'turn', label: 'Turn 0 (init)',
            prompt: '', startTime: ts, endTime: ts,
            sequence: 0, llm_calls: [], hooks: [], events: [],
            attributes: {},
          };
          turns.push(currentTurn);
        }
        currentTurn.llm_calls.push(currentLlm);
      }

    } else if (eventName.includes('api_request_complete') || eventName.includes('api_response')) {
      if (currentLlm) {
        currentLlm.endTime = ts;
        if (attrs.output_tokens) currentLlm.output_tokens = attrs.output_tokens;
        if (attrs.input_tokens) currentLlm.input_tokens = attrs.input_tokens;
        if (attrs.cost_usd) currentLlm.cost_rmb = attrs.cost_usd;
        if (attrs.duration_ms) currentLlm.duration_ms = attrs.duration_ms;
        if (attrs.cache_read_tokens) currentLlm.cache_read_tokens = attrs.cache_read_tokens;
        if (attrs['response.has_tool_call']) currentLlm.has_tool_call = true;
        if (attrs['response.model_output']) currentLlm.response = String(attrs['response.model_output']);
        if (attrs['response.thinking_output']) currentLlm.thinking = String(attrs['response.thinking_output']);
        Object.assign(currentLlm.attributes, attrs);
        if (!currentLlm.response) {
          const spAttrs = spanAttrByTypeTime[`llm|${currentLlm.startTime}`] || {};
          if (spAttrs['response.model_output']) currentLlm.response = String(spAttrs['response.model_output']);
          if (spAttrs['response.thinking_output'] && !currentLlm.thinking) currentLlm.thinking = String(spAttrs['response.thinking_output']);
        }
      }

    } else if (eventName.includes('tool_use_complete') || eventName.includes('tool_complete') || eventName.includes('tool_result')) {
      const targetList = (currentLlm && currentLlm.tools.length > 0) ? currentLlm.tools : pendingTools;
      const toolNameResult = attrs.tool_name || attrs.name || '';
      let matched = false;
      if (targetList.length > 0) {
        for (let ti = targetList.length - 1; ti >= 0; ti--) {
          const t = targetList[ti];
          if (t.tool_name === toolNameResult || !toolNameResult) {
            t.endTime = ts;
            if (attrs.duration_ms) t.duration_ms = attrs.duration_ms;
            if (attrs.output) t.output = String(attrs.output);
            if (attrs.error || attrs.success === false) t.success = false;
            Object.assign(t.attributes, attrs);
            const spAttrs = spanAttrByTypeTime[`tool|${t.startTime}`];
            if (spAttrs) {
              if (spAttrs.new_context && !t.output) t.output = String(spAttrs.new_context);
              if (spAttrs.tool_input && !t.input) t.input = String(spAttrs.tool_input);
              for (const [sk, sv] of Object.entries(spAttrs)) {
                if (!(sk in t.attributes)) t.attributes[sk] = sv;
              }
            }
            matched = true;
            break;
          }
        }
      }
      if (!matched && toolNameResult) {
        toolIdx++;
        const dur = attrs.duration_ms || 0;
        const spAttrs = spanAttrByTypeTime[`tool|${ts}`] || {};
        const toolOutput = String(attrs.output || '') || String(spAttrs.new_context || '');
        const toolNode = {
          id: `tool-${turnIdx}-${llmIdx}-${toolIdx}`, type: 'tool',
          label: toolNameResult, tool_name: toolNameResult,
          input: String(attrs.input || '') || String(spAttrs.tool_input || ''),
          output: toolOutput,
          duration_ms: dur,
          success: attrs.success !== false && attrs.success !== 'false',
          startTime: ts, endTime: ts, sequence: seq,
          attributes: { ...spAttrs, ...attrs },
        };
        if (currentLlm) currentLlm.tools.push(toolNode);
        else pendingTools.push(toolNode);
      }

    } else if (eventName.includes('hook')) {
      const hookNode = {
        id: `hook-${seq}-${i}`, type: 'hook',
        label: `Hook: ${attrs.hook_name || attrs.hook_event || eventName}`,
        startTime: ts, sequence: seq, attributes: attrs,
      };
      if (currentTurn) currentTurn.hooks.push(hookNode);

    } else if (eventName.toLowerCase().includes('agent') || eventName.toLowerCase().includes('subagent') || eventName.toLowerCase().includes('sub_agent')) {
      const agentNode = {
        id: `agent-${seq}-${i}`, type: 'agent',
        label: `Agent: ${attrs.agent_type || attrs.name || eventName}`,
        startTime: ts, sequence: seq, attributes: attrs,
      };
      if (currentLlm) currentLlm.tools.push(agentNode);
      else if (currentTurn) currentTurn.events.push(agentNode);

    } else {
      if (currentTurn) {
        currentTurn.events.push({
          id: `evt-${seq}-${i}`, type: 'event',
          label: bodyStr ? bodyStr.slice(0, 60) : eventName,
          sequence: seq, startTime: ts, attributes: attrs,
        });
      }
    }
  }

  for (const turn of turns) {
    const allTimes = [turn.startTime];
    for (const lc of turn.llm_calls) {
      allTimes.push(lc.endTime || '');
      for (const t of lc.tools) allTimes.push(t.endTime || '');
    }
    const validTimes = allTimes.filter(t => t);
    if (validTimes.length > 0) turn.endTime = validTimes.reduce((a, b) => a > b ? a : b);
  }

  const { intentAnalyzer } = getAnalytics();
  const sessionIntent = intentAnalyzer.analyzeSessionAlignment ? intentAnalyzer.analyzeSessionAlignment(turns) : {};
  if (alertManager.checkIntentAlignment) alertManager.checkIntentAlignment(sessionId, sessionIntent);

  res.json({
    sessionId, turns,
    nodes, edges,
    logs: logsSorted, spans: spansSorted,
    intent_analysis: sessionIntent,
  });
});

// --- Session analysis ---
router.get('/api/session/:sessionId/analysis', (req, res) => {
  const sessionId = req.params.sessionId;
  const sessionLogs = store.queryLogsBySession(sessionId);

  if (!sessionLogs || sessionLogs.length === 0) {
    return res.json({
      error: 'no data',
      risk: { cumulative_score: 0, level: 'low', history: [], flags: [] },
      data_lineage: { nodes: [], edges: [], taint_summary: {} },
      tool_stats: { total_calls: 0, by_tool: {}, avg_duration_ms: {}, sink_calls: 0, dangerous_calls: 0, details: [] },
      cost_analysis: { total_rmb: 0, by_model: {}, total_tokens: 0, input_tokens: 0, output_tokens: 0,
        cache_read_tokens: 0, cache_creation_tokens: 0, token_efficiency: 0, cache_hit_rate: 0 },
      behavioral_summary: { turns: 0, total_tool_calls: 0, avg_tools_per_turn: 0, unique_tools: 0,
        tool_diversity: 0, tool_sequence: [], pattern: 'empty' },
      sink_alerts: [],
      anomaly_detection: null,
    });
  }

  const logsSorted = [...sessionLogs].sort((a, b) =>
    ((a.attributes || {})['event.sequence'] || 0) - ((b.attributes || {})['event.sequence'] || 0));
  const turnLogs = logsSorted.filter(l => ((l.attributes || {})['event.name'] || '').includes('user_prompt'));

  let result;
  try {
    const { anomalyEngine } = getAnalytics();
    const { runSessionAnalysis } = require('../analytics/session');
    result = runSessionAnalysis(sessionId, logsSorted, turnLogs, anomalyEngine);
  } catch {
    result = { error: 'analysis engine not available' };
  }
  res.json(result);
});

// --- Session overview ---
router.get('/api/session/:sessionId/overview', (req, res) => {
  const sessionId = req.params.sessionId;
  const { toolQualityAnalyzer, providerRouter, costAggregator, anomalyEngine } = getAnalytics();

  const quality = toolQualityAnalyzer.analyzeSession ? toolQualityAnalyzer.analyzeSession(sessionId) : null;
  const routing = providerRouter.trackSession ? providerRouter.trackSession(sessionId) : null;
  const cost = costAggregator.sessionCost ? costAggregator.sessionCost(sessionId) : null;

  const sessionLogs = store.queryLogsBySession(sessionId);
  let analysisSummary = null;
  let deepAnalysis = null;

  if (sessionLogs && sessionLogs.length > 0) {
    const logsSorted = [...sessionLogs].sort((a, b) =>
      ((a.attributes || {})['event.sequence'] || 0) - ((b.attributes || {})['event.sequence'] || 0));
    const turnLogs = logsSorted.filter(l => ((l.attributes || {})['event.name'] || '').includes('user_prompt'));
    if (turnLogs.length > 0) {
      let analysis;
      try {
        const { runSessionAnalysis } = require('../analytics/session');
        analysis = runSessionAnalysis(sessionId, logsSorted, turnLogs, anomalyEngine);
      } catch { analysis = null; }
      if (analysis) {
        const risk = analysis.risk || {};
        const behavior = analysis.behavioral_summary || {};
        const costA = analysis.cost_analysis || {};
        analysisSummary = {
          risk_level: risk.level || 'low',
          risk_score: risk.cumulative_score || 0,
          behavior_pattern: behavior.pattern || 'unknown',
          turn_count: behavior.turns || 0,
          otlp_tokens: {
            input: costA.input_tokens || 0,
            output: costA.output_tokens || 0,
            efficiency: costA.token_efficiency || 0,
          },
          flags: (risk.flags || []).slice(0, 5),
        };
        deepAnalysis = {
          risk,
          behavioral_summary: behavior,
          anomaly_detection: analysis.anomaly_detection,
          sink_alerts: analysis.sink_alerts || [],
          cost_analysis: costA,
        };
      }
    }
  }

  // Fallback: build summary from cc-proxy data when OTLP logs are empty
  if (!analysisSummary) {
    const reqs = store.queryCcProxyRequests(sessionId);
    const resps = store.queryCcProxyResponses(sessionId);
    if ((reqs && reqs.length > 0) || (resps && resps.length > 0)) {
      let totalInput = 0, totalOutput = 0;
      for (const r of (resps || [])) {
        totalInput += (r.input_tokens || 0);
        totalOutput += (r.output_tokens || 0);
      }
      analysisSummary = {
        risk_level: 'low',
        risk_score: 0,
        behavior_pattern: 'cc-proxy',
        turn_count: (reqs || []).length,
        otlp_tokens: { input: totalInput, output: totalOutput, efficiency: 0 },
        flags: [],
      };
    }
  }

  const piiEvents = _readPiiEvents(sessionId);

  res.json({
    session_id: sessionId,
    analysis: analysisSummary,
    deep_analysis: deepAnalysis,
    quality, routing, cost,
    pii_events: piiEvents,
  });
});

// --- Session turns (paginated) ---
router.get('/api/session/:sessionId/turns', (req, res) => {
  const sessionId = req.params.sessionId;
  const page = parseInt(req.query.page) || 1;
  let perPage = parseInt(req.query.per_page) || 5;
  perPage = Math.min(perPage, 20);

  const sessionLogs = store.queryLogsBySession(sessionId);
  if (!sessionLogs || sessionLogs.length === 0) {
    return res.json(_buildTurnsFromCcProxy(sessionId, page, perPage));
  }

  const logsSorted = [...sessionLogs].sort((a, b) =>
    ((a.attributes || {})['event.sequence'] || 0) - ((b.attributes || {})['event.sequence'] || 0));

  const allTurns = [];
  let cTurn = null;
  for (const l of logsSorted) {
    const attrs = l.attributes || {};
    const eventName = attrs['event.name'] || '';
    const ts = attrs['event.timestamp'] || l.time || '';

    if (eventName.includes('user_prompt')) {
      if (cTurn) allTurns.push(cTurn);
      cTurn = {
        id: `turn-${allTurns.length + 1}`,
        prompt: (attrs.prompt || '').slice(0, 200),
        startTime: ts,
        llm_calls: [],
      };
    } else if (eventName.includes('api_request') && cTurn) {
      cTurn.llm_calls.push({
        model: attrs.model || '?',
        input_tokens: attrs.input_tokens || 0,
        output_tokens: attrs.output_tokens || 0,
        cost_rmb: attrs.cost_rmb || attrs.cost_usd || 0,
        duration_ms: attrs.duration_ms || 0,
        tool_count: 0,
      });
    } else if (eventName.includes('tool_result') && cTurn) {
      const toolName = attrs.tool_name || '?';
      const success = attrs.success !== false && attrs.success !== 'false';
      const dur = attrs.duration_ms || 0;
      if (cTurn.llm_calls.length > 0) {
        const lastCall = cTurn.llm_calls[cTurn.llm_calls.length - 1];
        if (!lastCall.tools) lastCall.tools = [];
        lastCall.tools.push({ tool: toolName, success, duration_ms: dur });
        lastCall.tool_count += 1;
      }
    }
  }
  if (cTurn) allTurns.push(cTurn);

  const total = allTurns.length;
  const start = (page - 1) * perPage;
  const end = start + perPage;
  const pageTurns = allTurns.slice(start, end);

  res.json({
    turns: pageTurns,
    total,
    page,
    per_page: perPage,
    has_more: end < total,
  });
});

// --- Session waterfall ---
router.get('/api/session/:sessionId/waterfall', (req, res) => {
  const sessionId = req.params.sessionId;
  const sessionDirs = _findSessionDirs(sessionId);
  if (!sessionDirs.length) {
    return res.json({ spans: [], session_id: sessionId, source: 'cc-proxy', total_spans: 0, page: 1, page_size: 200, total_pages: 0 });
  }

  const { spans: allSpans, fullSid } = _buildWaterfallSpans(sessionDirs, sessionId);

  // Enrich with PII mask info from pii.jsonl
  const piiMaskEvents = _readPiiEvents(sessionId).filter(e => e.direction === 'mask');
  if (piiMaskEvents.length > 0) {
    const piiBySeq = {};
    for (const e of piiMaskEvents) {
      if (!piiBySeq[e.seq]) piiBySeq[e.seq] = [];
      piiBySeq[e.seq].push(e);
    }
    // Mark existing user_prompt spans with PII info
    for (const s of allSpans) {
      if (s.type !== 'user_prompt') continue;
      const seqPii = piiBySeq[s.seq];
      if (!seqPii || !seqPii.length) continue;
      s.attributes.has_pii = true;
      s.attributes.pii_replacements = seqPii.map(e => ({
        type: e.pii_type, token: e.token, hint: e.raw_hint
      }));
    }
    // For seqs with PII but no user_prompt span, insert pii_mask span before the LLM span
    const seqsWithPrompt = new Set(allSpans.filter(s => s.type === 'user_prompt').map(s => s.seq));
    const insertions = [];
    for (const [seqStr, events] of Object.entries(piiBySeq)) {
      const seq = Number(seqStr);
      if (seqsWithPrompt.has(seq)) continue;
      const llmIdx = allSpans.findIndex(s => s.seq === seq && s.kind === 'llm');
      const insertAt = llmIdx >= 0 ? llmIdx : allSpans.findIndex(s => s.seq === seq);
      if (insertAt < 0) continue;
      const deduped = [];
      const seen = new Set();
      for (const e of events) {
        const k = `${e.pii_type}:${e.token}`;
        if (seen.has(k)) continue;
        seen.add(k);
        deduped.push(e);
      }
      const ts = allSpans[insertAt].start_time || '';
      insertions.push({ idx: insertAt, span: {
        name: `PII Mask: ${deduped.map(e => e.pii_type).join(', ')}`,
        type: 'pii_mask', kind: 'pii_mask',
        start_time: ts, end_time: ts,
        duration_ms: 0, depth: 0, seq,
        attributes: {
          replacements: deduped.map(e => ({ type: e.pii_type, token: e.token, hint: e.raw_hint })),
          count: events.length,
        },
      }});
    }
    for (const ins of insertions.sort((a, b) => b.idx - a.idx)) {
      allSpans.splice(ins.idx, 0, ins.span);
    }
  }

  const page = Math.max(1, parseInt(req.query.page) || 1);
  const pageSize = Math.min(500, Math.max(1, parseInt(req.query.page_size) || 200));
  const totalPages = Math.max(1, Math.ceil(allSpans.length / pageSize));
  const start = (page - 1) * pageSize;
  const spans = allSpans.slice(start, start + pageSize);

  const roleSummary = {};
  for (const s of allSpans) {
    if (s.kind === 'llm') {
      const rf = (s.attributes || {}).role_family || '';
      if (rf) {
        if (!roleSummary[rf]) roleSummary[rf] = { count: 0, total_tokens: 0 };
        roleSummary[rf].count += 1;
        roleSummary[rf].total_tokens += ((s.attributes || {}).total_tokens || 0);
      }
    }
  }

  const errorSummary = {};
  for (const s of allSpans) {
    if (s.kind === 'provider_error') {
      const pm = (s.attributes || {}).provider_model || '';
      if (!errorSummary[pm]) errorSummary[pm] = { count: 0, total_latency_ms: 0 };
      errorSummary[pm].count += 1;
      errorSummary[pm].total_latency_ms += ((s.attributes || {}).latency_ms || 0);
    }
  }

  res.json({
    spans,
    session_id: fullSid || sessionId,
    source: 'cc-proxy',
    total_spans: allSpans.length,
    page,
    page_size: pageSize,
    total_pages: totalPages,
    role_summary: roleSummary,
    error_summary: errorSummary,
  });
});

// --- Session routing detail ---
router.get('/api/session/:sessionId/routing-detail', (req, res) => {
  const sessionId = req.params.sessionId;
  const events = store.queryRoutingEventsBySession(sessionId);
  if (!events || events.length === 0) {
    return res.status(404).json({ error: 'no routing events for this session' });
  }
  res.json({
    session_id: sessionId,
    events,
    total: events.length,
  });
});

// --- Helpers ---

function _findSessionDirs(sessionId) {
  if (!fs.existsSync(CC_PROXY_LOG_DIR)) return [];
  const prefix = sessionId.includes('-') ? sessionId.split('-')[0] : sessionId;
  let dateDirs;
  try { dateDirs = fs.readdirSync(CC_PROXY_LOG_DIR, { withFileTypes: true }); } catch { return []; }
  dateDirs = dateDirs.filter(d => d.isDirectory() && !d.name.startsWith('.'));
  dateDirs.sort((a, b) => a.name.localeCompare(b.name));

  const results = [];
  for (const dd of dateDirs) {
    const datePath = path.join(CC_PROXY_LOG_DIR, dd.name);
    let entries;
    try { entries = fs.readdirSync(datePath, { withFileTypes: true }); } catch { continue; }
    for (const sd of entries) {
      if (!sd.isDirectory()) continue;
      if (sessionId.startsWith(sd.name) || sd.name.startsWith(prefix)) {
        results.push({ dateDir: datePath, sessionDir: path.join(datePath, sd.name) });
      }
    }
  }
  return results;
}

function _toolNameFromId(toolUseId) {
  for (const prefix of ['functions.', 'functions_']) {
    if (toolUseId.startsWith(prefix)) {
      const rest = toolUseId.slice(prefix.length);
      return rest.split(':')[0].split('-')[0];
    }
  }
  return 'unknown';
}

function _buildWaterfallSpans(sessionDirs, sessionId) {
  let reqFiles = [];
  for (const { sessionDir, dateDir } of sessionDirs) {
    const dateTag = path.basename(dateDir);
    for (const f of _globSync(sessionDir, '.req.json')) {
      reqFiles.push({ path: f, sortKey: `${dateTag}/${path.basename(f)}`, sessionDir });
    }
  }
  reqFiles.sort((a, b) => a.sortKey.localeCompare(b.sortKey));

  const spans = [];
  let sessionFullId = '';
  let prevMsgCount = 0;
  let prevToolUseMap = {};
  const globalToolMap = {};
  const seenToolResultIds = new Set();
  const blobUserTextMap = {};

  for (const { sessionDir } of sessionDirs) {
    const blobDir = path.join(sessionDir, '_blobs');
    if (fs.existsSync(blobDir)) {
      try {
        for (const blobFile of fs.readdirSync(blobDir).filter(f => f.endsWith('.json'))) {
          try {
            const blobHash = blobFile.replace('.json', '');
            const blobData = JSON.parse(fs.readFileSync(path.join(blobDir, blobFile), 'utf8'));
            const content = blobData.content || [];
            if (!Array.isArray(content)) continue;
            for (const b of content) {
              if (b && typeof b === 'object' && b.type === 'tool_use') {
                if (b.id && b.name) globalToolMap[b.id] = b.name;
              }
            }
            // Index user message text by blob hash for user_prompt resolution
            if (blobData.role === 'user') {
              let text = '';
              if (typeof blobData.content === 'string') {
                text = blobData.content.trim();
              } else if (Array.isArray(blobData.content)) {
                for (const b of blobData.content) {
                  if (!b || b.type !== 'text' || !b.text) continue;
                  const t = b.text.trim();
                  if (t.startsWith('<system-reminder>')) continue;
                  text = t;
                  break;
                }
              }
              if (text) blobUserTextMap[blobHash] = text;
            }
          } catch {}
        }
      } catch {}
    }
  }

  const roleMap = {};
  const queryPreviewMap = {};
  try {
    const revents = store.queryRoutingEventsBySession(sessionId);
    for (const ev of revents) {
      roleMap[ev.request_seq] = ev.agent_role || '';
      if (ev.query_preview) queryPreviewMap[ev.request_seq] = ev.query_preview;
    }
  } catch {}

  const providerErrors = {};
  for (const { sessionDir } of sessionDirs) {
    try {
      const allFiles = fs.readdirSync(sessionDir).filter(f => f.includes('.provider_error.') && f.endsWith('.json')).sort();
      for (const pef of allFiles) {
        try {
          const pe = JSON.parse(fs.readFileSync(path.join(sessionDir, pef), 'utf8'));
          const seqVal = pe.seq || 0;
          if (!providerErrors[seqVal]) providerErrors[seqVal] = [];
          providerErrors[seqVal].push({
            provider_model: pe.provider_model || '',
            error_class: pe.error_class || '',
            error: (pe.error || '').slice(0, 300),
            latency_ms: pe.latency_ms || 0,
            timestamp: pe.timestamp || '',
          });
        } catch {}
      }
    } catch {}
  }

  for (const reqEntry of reqFiles) {
    const reqFile = reqEntry.path;
    let reqData;
    try { reqData = JSON.parse(fs.readFileSync(reqFile, 'utf8')); } catch { continue; }

    if (!sessionFullId) sessionFullId = reqData.session_id || '';

    const respFile = reqFile.replace('.req.json', '.resp.json');
    let respData = null;
    if (fs.existsSync(respFile)) {
      try { respData = JSON.parse(fs.readFileSync(respFile, 'utf8')); } catch {}
    }

    const reqTs = reqData.timestamp || '';
    const requestedModel = reqData.model || '';
    const seq = reqData.seq || 0;
    const messages = reqData.messages || [];

    let respTs = '', elapsedMs = 0, actualModel = '', actualProvider = '', inputTokens = 0, outputTokens = 0, contentBlocks = [];
    if (respData) {
      respTs = respData.timestamp || '';
      elapsedMs = respData.elapsed_ms || 0;
      actualModel = respData.model || '';
      actualProvider = respData.provider || '';
      const respInner = respData.response || {};
      const usage = (typeof respInner === 'object' ? respInner.usage : {}) || {};
      inputTokens = usage.input_tokens || 0;
      outputTokens = usage.output_tokens || 0;
      contentBlocks = (typeof respInner === 'object' ? respInner.content : []) || [];
    }

    const stopReason = respData?.response?.stop_reason || '';
    const hasToolUse = contentBlocks.some(b => b?.type === 'tool_use');
    const hasThinking = contentBlocks.some(b => b?.type === 'thinking');
    const thinkingText = hasThinking
      ? contentBlocks.filter(b => b?.type === 'thinking').map(b => b.thinking || '').join('\n')
      : '';

    const newMsgs = prevMsgCount > 0 ? messages.slice(prevMsgCount) : messages;
    prevMsgCount = messages.length;

    for (const m of messages) {
      if (typeof m === 'object' && '$blob' in m) continue;
      const content = m.content || [];
      if (!Array.isArray(content)) continue;
      for (const b of content) {
        if (b && typeof b === 'object' && b.type === 'tool_use' && b.id && b.name) {
          globalToolMap[b.id] = b.name;
        }
      }
    }

    // user_prompt — extract user's typed input from messages/blobs
    let foundUserPrompt = false;
    let originalUserText = '';

    for (let mi = newMsgs.length - 1; mi >= 0; mi--) {
      const m = newMsgs[mi];
      if (m && typeof m === 'object' && '$blob' in m) {
        const blobText = blobUserTextMap[m['$blob']] || '';
        if (blobText) { originalUserText = blobText; break; }
        continue;
      }
      if (m.role !== 'user') continue;
      const content = m.content || '';
      let userText = '';
      if (typeof content === 'string' && content.trim()) {
        userText = content.trim();
      } else if (Array.isArray(content)) {
        for (const b of content) {
          if (b && typeof b === 'object' && b.type === 'text') {
            const t = (b.text || '').trim();
            if (t && !t.startsWith('<system-reminder>')) { userText = t; break; }
          }
        }
      }
      if (userText) {
        originalUserText = userText;
        break;
      }
    }

    // Clean: strip system-reminders, extract <session> content
    if (originalUserText) {
      originalUserText = originalUserText.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
      const sessionMatch = originalUserText.match(/<session>([\s\S]*?)<\/session>/);
      if (sessionMatch) {
        originalUserText = sessionMatch[1].trim();
      } else if (originalUserText.startsWith('<')) {
        originalUserText = '';
      }
    }

    // Get masked text from routing_events.query_preview (post-PII-mask)
    let maskedText = '';
    if (queryPreviewMap[seq]) {
      let qp = queryPreviewMap[seq];
      if (qp.startsWith('<system-reminder>')) qp = '';
      const sessionMatch2 = qp.match(/<session>([\s\S]*?)<\/session>/);
      if (sessionMatch2) qp = sessionMatch2[1].trim();
      else qp = qp.replace(/<[^>]*>/g, '').trim();
      if (qp.startsWith('The user stepped away') || qp.startsWith('Perform a web search') ||
          qp.startsWith('[Request interrupted') || qp.startsWith('[SUGGESTION MODE')) qp = '';
      maskedText = qp;
    }

    // Determine display and PII status
    const displayText = originalUserText || maskedText;
    const hasPii = !!(displayText && displayText.includes('⟦'));

    if (displayText) {
      spans.push({
        name: `User: ${displayText.slice(0, 60)}${displayText.length > 60 ? '...' : ''}`,
        type: 'user_prompt', kind: 'user_prompt',
        start_time: reqTs, end_time: reqTs,
        duration_ms: 0, depth: 0, seq,
        attributes: {
          text: displayText.slice(0, 500),
          text_original: originalUserText ? originalUserText.slice(0, 800) : '',
          text_masked: maskedText ? maskedText.slice(0, 800) : '',
          has_pii: hasPii,
        },
      });
      foundUserPrompt = true;
    }

    // tool_result — only extract results whose tool_use_id hasn't been seen before
    for (const m of newMsgs) {
      if (m.role !== 'user') continue;
      const content = m.content;
      if (!Array.isArray(content)) continue;
      for (const b of content) {
        if (!b || typeof b !== 'object' || b.type !== 'tool_result') continue;
        const tuId = b.tool_use_id || '';
        if (seenToolResultIds.has(tuId)) continue;
        seenToolResultIds.add(tuId);
        const toolName = globalToolMap[tuId] || prevToolUseMap[tuId] || _toolNameFromId(tuId);
        let resultText = '';
        const rc = b.content;
        if (Array.isArray(rc)) {
          const parts = [];
          for (const rb of rc) {
            if (rb && typeof rb === 'object' && rb.type === 'text') parts.push(rb.text || '');
          }
          resultText = parts.join('\n');
        } else if (typeof rc === 'string') {
          resultText = rc;
        } else {
          resultText = String(rc);
        }

        spans.push({
          name: `Result: ${toolName}`,
          type: 'tool_result', kind: 'tool_result',
          start_time: reqTs, end_time: reqTs,
          duration_ms: 0, depth: 1, seq,
          attributes: {
            tool_name: toolName,
            tool_use_id: tuId,
            content: resultText.slice(0, 500),
            is_error: b.is_error || false,
          },
        });
      }
    }

    // LLM call span
    const agentRole = roleMap[seq] || '';
    let roleFamily = '';
    if (agentRole) {
      roleFamily = agentRole.includes(':') ? agentRole.split(':')[0] : agentRole;
    }

    const fallback = !!(actualModel && requestedModel && actualModel !== requestedModel);
    const roleTag = roleFamily ? `[${roleFamily}] ` : '';
    let name;
    if (actualModel && actualModel !== requestedModel) {
      name = `${roleTag}Seq ${seq}: ${requestedModel} \u2192 ${actualModel}`;
    } else if (actualModel) {
      name = `${roleTag}Seq ${seq}: ${actualModel}`;
    } else {
      name = `${roleTag}Seq ${seq}: ${requestedModel} (pending)`;
    }

    spans.push({
      name, type: 'llm', kind: 'llm',
      start_time: reqTs,
      end_time: respTs || reqTs,
      duration_ms: elapsedMs, depth: 0, seq,
      attributes: {
        requested_model: requestedModel,
        actual_model: actualModel,
        provider: actualProvider,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens,
        fallback,
        message_count: messages.length,
        elapsed_ms: elapsedMs,
        agent_role: agentRole,
        role_family: roleFamily,
      },
    });

    for (const pe of (providerErrors[seq] || [])) {
      spans.push({
        name: `\u2717 ${pe.provider_model}: ${pe.error_class}`,
        type: 'provider_error', kind: 'provider_error',
        start_time: pe.timestamp,
        end_time: pe.timestamp,
        duration_ms: pe.latency_ms,
        depth: 1, seq,
        attributes: {
          provider_model: pe.provider_model,
          error_class: pe.error_class,
          error: pe.error,
          latency_ms: pe.latency_ms,
        },
      });
    }

    // thinking span
    if (hasThinking && thinkingText.trim()) {
      spans.push({
        name: `思考: ${thinkingText.slice(0, 50)}${thinkingText.length > 50 ? '...' : ''}`,
        type: 'thinking', kind: 'thinking',
        start_time: respTs || reqTs, end_time: respTs || reqTs,
        duration_ms: 0, depth: 1, seq,
        attributes: { text: thinkingText.slice(0, 1000) },
      });
    }

    // tool_call from response
    const curToolUseMap = {};
    for (const b of contentBlocks) {
      if (!b || typeof b !== 'object' || b.type !== 'tool_use') continue;
      const toolName = b.name || 'unknown';
      const toolInput = b.input || {};
      const tuId = b.id || '';
      curToolUseMap[tuId] = toolName;
      const inputSummary = {};
      if (typeof toolInput === 'object') {
        for (const [k, v] of Object.entries(toolInput)) {
          const sv = String(v);
          inputSummary[k] = sv.length > 200 ? sv.slice(0, 200) : sv;
        }
      }

      spans.push({
        name: `Call: ${toolName}`,
        type: 'tool_call', kind: 'tool_call',
        start_time: respTs || reqTs,
        end_time: respTs || reqTs,
        duration_ms: 0, depth: 1, seq,
        attributes: {
          tool_name: toolName,
          tool_use_id: tuId,
          ...inputSummary,
        },
      });
    }

    // llm_response text
    const textParts = [];
    for (const b of contentBlocks) {
      if (b && typeof b === 'object' && b.type === 'text') {
        const t = b.text || '';
        if (t.trim()) textParts.push(t);
      }
    }
    if (textParts.length > 0) {
      const combined = textParts.join('\n');
      const responseType = hasToolUse ? 'reasoning' : 'text';
      const toolNames = contentBlocks.filter(b => b?.type === 'tool_use').map(b => b.name || '').join(', ');
      let responseName;
      if (responseType === 'reasoning') {
        const firstTool = contentBlocks.find(b => b?.type === 'tool_use')?.name || '';
        responseName = `推理 → ${firstTool}`;
      } else {
        responseName = combined.slice(0, 60) + (combined.length > 60 ? '...' : '');
      }
      spans.push({
        name: responseName,
        type: 'llm_response', kind: 'llm_response',
        start_time: respTs || reqTs,
        end_time: respTs || reqTs,
        duration_ms: 0, depth: 1, seq,
        attributes: {
          text: combined.slice(0, 500),
          response_type: responseType,
          stop_reason: stopReason,
          has_thinking: hasThinking,
          thinking_preview: hasThinking ? thinkingText.slice(0, 300) : '',
          tool_names: toolNames,
        },
      });
    }

    prevToolUseMap = curToolUseMap;
  }

  // Merge tool_call + tool_result
  // Strategy: 1) by tool_use_id, 2) by tool_name + seq proximity (result at seq N → call at seq N-1)
  const toolCallById = {};
  const toolCallBySeqName = {};
  for (let i = 0; i < spans.length; i++) {
    const s = spans[i];
    if (s.kind !== 'tool_call') continue;
    const tuId = s.attributes && s.attributes.tool_use_id;
    if (tuId) toolCallById[tuId] = i;
    const tName = s.attributes && s.attributes.tool_name;
    if (tName) {
      const key = `${s.seq}|${tName}`;
      if (!toolCallBySeqName[key]) toolCallBySeqName[key] = [];
      toolCallBySeqName[key].push(i);
    }
  }
  const removeIndices = new Set();
  const usedCalls = new Set();

  for (let ri = 0; ri < spans.length; ri++) {
    const s = spans[ri];
    if (s.kind !== 'tool_result' || !s.attributes) continue;
    const tuId = s.attributes.tool_use_id;
    let callIdx = tuId ? toolCallById[tuId] : undefined;
    if (callIdx != null && !usedCalls.has(callIdx)) {
      // matched by id
    } else {
      // fallback: find tool_call with same name at seq-1
      const tName = s.attributes.tool_name;
      const prevSeq = (s.seq || 1) - 1;
      const candidates = (tName && toolCallBySeqName[`${prevSeq}|${tName}`]) || [];
      callIdx = candidates.find(ci => !usedCalls.has(ci));
    }
    if (callIdx == null) continue;
    const call = spans[callIdx];
    call.kind = 'tool';
    call.type = 'tool';
    call.name = call.attributes.tool_name || call.name;
    call.attributes._result_content = s.attributes.content || '';
    call.attributes._result_is_error = s.attributes.is_error || false;
    call.attributes._result_rejected = !!(s.attributes.is_error &&
      typeof s.attributes.content === 'string' &&
      s.attributes.content.includes("doesn't want to proceed"));
    usedCalls.add(callIdx);
    removeIndices.add(ri);
  }
  const mergedSpans = spans.filter((s, i) => !removeIndices.has(i) && s.kind !== 'tool_result');

  return { spans: mergedSpans, fullSid: sessionFullId };
}

function _buildTurnsFromCcProxy(sessionId, page, perPage) {
  const reqs = store.queryCcProxyRequests(sessionId);
  const resps = store.queryCcProxyResponses(sessionId);
  const tools = store.queryToolCallsBySession(sessionId);

  const respBySeq = {};
  const seenResp = new Set();
  for (const r of resps) {
    const dedupKey = `${r.seq}|${r.request_id || ''}`;
    if (seenResp.has(dedupKey)) continue;
    seenResp.add(dedupKey);
    (respBySeq[r.seq] ||= []).push(r);
  }
  const toolsBySeq = {};
  for (const t of tools) {
    (toolsBySeq[t.seq] ||= []).push(t);
  }

  const allTurns = [];
  const seenSeqs = new Set();
  for (const rq of reqs) {
    const seq = rq.seq;
    if (seenSeqs.has(seq)) continue;
    seenSeqs.add(seq);
    const turn = {
      id: `turn-${seq}`,
      prompt: `[seq ${seq}] ${rq.requested_model || '?'}`,
      startTime: '',
      llm_calls: [],
    };
    for (const resp of (respBySeq[seq] || [])) {
      const callTools = [];
      for (const tc of (toolsBySeq[seq] || [])) {
        callTools.push({
          tool: tc.tool_name || '?',
          success: !(tc.is_hallucinated || false),
          duration_ms: 0,
        });
      }
      turn.llm_calls.push({
        model: resp.actual_model || '?',
        provider: resp.actual_provider || '',
        input_tokens: resp.input_tokens || 0,
        output_tokens: resp.output_tokens || 0,
        cost_rmb: estimateCost(resp.actual_model || '', resp.input_tokens || 0, resp.output_tokens || 0),
        duration_ms: resp.elapsed_ms || 0,
        tool_count: callTools.length,
        tools: callTools.length > 0 ? callTools : [],
        fallback: resp.fallback_occurred || false,
      });
    }
    if (turn.llm_calls.length === 0) continue;
    allTurns.push(turn);
  }

  const total = allTurns.length;
  const start = (page - 1) * perPage;
  const end = start + perPage;
  return {
    turns: allTurns.slice(start, end),
    total,
    page,
    per_page: perPage,
    has_more: end < total,
    source: 'cc-proxy',
  };
}

router.put('/api/session/:sessionId/name', (req, res) => {
  const sessionId = req.params.sessionId;
  const name = (req.body || {}).name || '';
  store.setSessionAlias(sessionId, name.trim());
  res.json({ ok: true, session_id: sessionId, name: name.trim() });
});

module.exports = router;
