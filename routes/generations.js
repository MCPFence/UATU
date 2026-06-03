'use strict';

const router = require('express').Router();
const { store } = require('../lib/store');
const { estimateCost } = require('../analytics/cost-aggregator');

const _queryCache = {};

function _dataVersion() {
  try {
    const db = store._db;
    const proxyCount = db.prepare('SELECT COUNT(*) as c FROM cc_proxy_responses').get().c;
    return store.countTraces() + store.countLogs() + proxyCount;
  } catch {
    return store.countTraces() + store.countLogs();
  }
}

// --- Generations API (Langfuse-style) ---
router.get('/api/generations', (req, res) => {
  const qs = req.originalUrl || '';
  const version = _dataVersion();
  const ck = `generations|${qs}|${version}`;
  const cached = _queryCache.generations;
  if (cached && cached[0] === ck) {
    return res.json(cached[1]);
  }

  const allLogs = store.queryAllLogs();
  const allSpans = store.queryAllTraces();

  const spanByTypeTime = {};
  for (const s of allSpans) {
    const stype = s.name.includes('llm_request') ? 'llm' : (s.name.includes('tool') ? 'tool' : 'other');
    spanByTypeTime[`${stype}|${s.startTime}`] = s.attributes;
  }

  const qModel = (req.query.model || '').toLowerCase();
  const qMinCost = parseFloat(req.query.min_cost || 0);
  const qMaxCost = parseFloat(req.query.max_cost || 999999);
  const qMinLatency = parseFloat(req.query.min_latency || 0);
  const qSession = req.query.session || '';
  const qStatus = req.query.status || '';

  const generations = [];
  for (const l of allLogs) {
    const attrs = l.attributes || {};
    const eventName = attrs['event.name'] || '';
    if (eventName !== 'api_request') continue;

    const model = attrs.model || 'unknown';
    const duration = parseFloat(attrs.duration_ms || 0);
    const inputTokens = parseInt(attrs.input_tokens || 0);
    const outputTokens = parseInt(attrs.output_tokens || 0);
    const cacheRead = parseInt(attrs.cache_read_tokens || 0);
    const cacheCreate = parseInt(attrs.cache_creation_tokens || 0);
    const cost = estimateCost(model, inputTokens, outputTokens, cacheRead, cacheCreate);
    const sid = attrs['session.id'] || (l.resource || {})['session.id'] || '';
    const hasToolCall = !!attrs['response.has_tool_call'];
    const success = attrs.success;

    if (qModel && !model.toLowerCase().includes(qModel)) continue;
    if (cost < qMinCost || cost > qMaxCost) continue;
    if (duration < qMinLatency) continue;
    if (qSession && qSession !== sid) continue;
    if (qStatus === 'error' && success !== false) continue;
    if (qStatus === 'ok' && success === false) continue;

    const completionPreview = String(attrs['response.model_output'] || '')
      || String((spanByTypeTime[`llm|${attrs['event.timestamp'] || ''}`] || {})['response.model_output'] || '');

    generations.push({
      id: `gen-${l.spanId || ''}-${attrs['event.sequence'] || 0}`,
      timestamp: attrs['event.timestamp'] || l.time || '',
      model,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
      cache_read_tokens: cacheRead,
      cache_creation_tokens: cacheCreate,
      cost_rmb: cost,
      duration_ms: duration,
      session_id: sid,
      has_tool_call: hasToolCall,
      success: success !== false,
      prompt_preview: String(attrs.new_context || '').slice(0, 200),
      completion_preview: completionPreview.slice(0, 200),
    });
  }

  for (const r of store.queryAllCcProxyResponses()) {
    const model = r.actual_model || '';
    if (!model) continue;
    const sid = r.session_id || '';
    if (qSession && qSession !== sid) continue;
    if (qModel && !model.toLowerCase().includes(qModel)) continue;

    const inputTokens = parseInt(r.input_tokens || 0);
    const outputTokens = parseInt(r.output_tokens || 0);
    const cacheRead = parseInt(r.cache_read_tokens || 0);
    const cacheCreate = parseInt(r.cache_creation_tokens || 0);
    const duration = parseFloat(r.elapsed_ms || 0);
    const cost = estimateCost(model, inputTokens, outputTokens, cacheRead, cacheCreate);

    if (cost < qMinCost || cost > qMaxCost) continue;
    if (duration < qMinLatency) continue;

    const received = r.received_at || 0;
    const ts = received ? new Date(received * 1000).toISOString() : '';

    generations.push({
      id: `cc-${sid.slice(0, 8)}-${r.seq || 0}`,
      timestamp: ts,
      model,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
      cache_read_tokens: cacheRead,
      cache_creation_tokens: cacheCreate,
      cost_rmb: cost,
      duration_ms: duration,
      session_id: sid,
      has_tool_call: false,
      success: true,
      prompt_preview: '',
      completion_preview: '',
      provider: r.actual_provider || '',
    });
  }

  generations.sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));

  const totalCost = generations.reduce((sum, g) => sum + g.cost_rmb, 0);
  const totalTokens = generations.reduce((sum, g) => sum + g.total_tokens, 0);
  const avgLatency = generations.length > 0
    ? generations.reduce((sum, g) => sum + g.duration_ms, 0) / generations.length
    : 0;
  const models = [...new Set(generations.map(g => g.model))];

  const result = {
    generations: generations.slice(0, 500),
    summary: {
      count: generations.length,
      total_cost: Math.round(totalCost * 1e6) / 1e6,
      total_tokens: totalTokens,
      avg_latency_ms: Math.round(avgLatency * 10) / 10,
      models,
    },
  };

  _queryCache.generations = [ck, result];
  res.json(result);
});

// --- Latency Percentiles API ---
router.get('/api/latency', (req, res) => {
  const qs = req.originalUrl || '';
  const version = _dataVersion();
  const ck = `latency|${qs}|${version}`;
  const cached = _queryCache.latency;
  if (cached && cached[0] === ck) {
    return res.json(cached[1]);
  }

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayStartTs = todayStart.getTime() / 1000;

  const allLogs = store.queryAllLogs();
  const todayResponses = store.queryCcProxyResponsesSince(todayStartTs);

  const latencies = [];
  let errorCount = 0;
  let totalCount = 0;
  const timeBuckets = {};
  const modelTimeBuckets = {};

  for (const l of allLogs) {
    const attrs = l.attributes || {};
    const eventName = attrs['event.name'] || '';
    if (eventName !== 'api_request') continue;

    const ts = attrs['event.timestamp'] || l.time || '';
    if (ts) {
      try {
        const t = new Date(ts.replace('Z', '+00:00')).getTime() / 1000;
        if (t < todayStartTs) continue;
      } catch { continue; }
    } else {
      continue;
    }

    const dur = parseFloat(attrs.duration_ms || 0);
    const success = attrs.success;
    totalCount++;

    if (dur > 0) latencies.push(dur);
    if (success === false) errorCount++;

    const bucket = ts.slice(0, 16);
    if (!timeBuckets[bucket]) timeBuckets[bucket] = { latencies: [], errors: 0, total: 0 };
    timeBuckets[bucket].latencies.push(dur);
    timeBuckets[bucket].total += 1;
    if (success === false) timeBuckets[bucket].errors += 1;
  }

  for (const r of todayResponses) {
    const received = r.received_at;
    if (!received) continue;
    const dur = parseFloat(r.elapsed_ms || 0);
    if (dur <= 0) continue;
    latencies.push(dur);
    totalCount++;
    const bucket = new Date(received * 1000).toISOString().slice(0, 16);
    const model = r.actual_model || 'unknown';
    if (!timeBuckets[bucket]) timeBuckets[bucket] = { latencies: [], errors: 0, total: 0 };
    timeBuckets[bucket].latencies.push(dur);
    timeBuckets[bucket].total += 1;

    if (!modelTimeBuckets[model]) modelTimeBuckets[model] = {};
    if (!modelTimeBuckets[model][bucket]) modelTimeBuckets[model][bucket] = [];
    modelTimeBuckets[model][bucket].push({ dur, out: parseInt(r.output_tokens || 0) });
  }

  latencies.sort((a, b) => a - b);
  const n = latencies.length;

  function percentile(p) {
    if (n === 0) return 0;
    const idx = Math.min(Math.floor(n * p / 100), n - 1);
    return Math.round(latencies[idx] * 10) / 10;
  }

  const bucketsSorted = Object.keys(timeBuckets).sort();
  const timeseries = [];
  for (const b of bucketsSorted) {
    const bd = timeBuckets[b];
    const bl = [...bd.latencies].sort((a, c) => a - c);
    const bn = bl.length;
    timeseries.push({
      time: b,
      p50: Math.round((bn > 0 ? bl[Math.floor(bn * 0.5)] : 0) * 10) / 10,
      p95: Math.round((bn >= 2 ? bl[Math.floor(bn * 0.95)] : (bn > 0 ? bl[0] : 0)) * 10) / 10,
      p99: Math.round((bn >= 2 ? bl[Math.floor(bn * 0.99)] : (bn > 0 ? bl[0] : 0)) * 10) / 10,
      avg: Math.round((bl.reduce((s, v) => s + v, 0) / Math.max(bn, 1)) * 10) / 10,
      error_rate: Math.round((bd.errors / Math.max(bd.total, 1)) * 10000) / 10000,
      count: bd.total,
    });
  }

  const modelTimeseriesArr = [];
  for (const [model, buckets] of Object.entries(modelTimeBuckets)) {
    const series = [];
    for (const b of Object.keys(buckets).sort()) {
      const bl = buckets[b];
      const totalOut = bl.reduce((s, v) => s + v.out, 0);
      const totalDur = bl.reduce((s, v) => s + v.dur, 0);
      const tps = totalDur > 0 ? Math.round(totalOut / (totalDur / 1000) * 10) / 10 : 0;
      series.push({
        time: b,
        tps,
        count: bl.length,
      });
    }
    modelTimeseriesArr.push({
      model,
      series,
      count: series.reduce((s, p) => s + p.count, 0),
    });
  }
  modelTimeseriesArr.sort((a, b) => b.count - a.count);

  const modelBuckets = {};
  for (const r of todayResponses) {
    const dur = parseFloat(r.elapsed_ms || 0);
    if (dur <= 0) continue;
    const model = r.actual_model || 'unknown';
    const outTokens = parseInt(r.output_tokens || 0);
    const inTokens = parseInt(r.input_tokens || 0) + parseInt(r.cache_read_tokens || 0) + parseInt(r.cache_creation_tokens || 0);
    if (!modelBuckets[model]) modelBuckets[model] = { durations: [], throughputs: [], total_input: 0, total_output: 0, total_elapsed: 0 };
    const mb = modelBuckets[model];
    mb.durations.push(dur);
    mb.total_input += inTokens;
    mb.total_output += outTokens;
    mb.total_elapsed += dur;
    if (outTokens > 0 && dur > 0) mb.throughputs.push(outTokens / (dur / 1000));
  }

  const modelLatency = [];
  for (const [model, mb] of Object.entries(modelBuckets)) {
    const durations = [...mb.durations].sort((a, b) => a - b);
    const mn = durations.length;
    const tpsList = mb.throughputs.length > 0 ? [...mb.throughputs].sort((a, b) => a - b) : [0];
    const tn = tpsList.length;
    modelLatency.push({
      model,
      avg: Math.round((durations.reduce((s, v) => s + v, 0) / mn) * 10) / 10,
      p50: Math.round(durations[Math.floor(mn * 0.5)] * 10) / 10,
      p95: Math.round((mn >= 2 ? durations[Math.floor(mn * 0.95)] : durations[0]) * 10) / 10,
      max: Math.round(durations[mn - 1] * 10) / 10,
      count: mn,
      throughput_avg: Math.round((tpsList.reduce((s, v) => s + v, 0) / Math.max(tn, 1)) * 10) / 10,
      throughput_p50: tn > 0 ? Math.round(tpsList[Math.floor(tn * 0.5)] * 10) / 10 : 0,
      total_input_tokens: mb.total_input,
      total_output_tokens: mb.total_output,
    });
  }

  const result = {
    percentiles: {
      p50: percentile(50),
      p95: percentile(95),
      p99: percentile(99),
      avg: Math.round((latencies.reduce((s, v) => s + v, 0) / Math.max(n, 1)) * 10) / 10,
      min: n > 0 ? Math.round(latencies[0] * 10) / 10 : 0,
      max: n > 0 ? Math.round(latencies[n - 1] * 10) / 10 : 0,
    },
    total_requests: totalCount,
    error_count: errorCount,
    error_rate: Math.round((errorCount / Math.max(totalCount, 1)) * 10000) / 10000,
    timeseries,
    model_timeseries: modelTimeseriesArr,
    model_latency: modelLatency,
  };

  _queryCache.latency = [ck, result];
  res.json(result);
});

module.exports = router;
