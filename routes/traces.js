'use strict';

const router = require('express').Router();
const { store } = require('../lib/store');
const { groupBySession } = require('../lib/parsers');

// --- Read APIs ---

router.get('/api/traces', (req, res) => {
  res.json(store.queryTraces(500));
});

router.get('/api/trace/:traceId', (req, res) => {
  const spans = store.queryTraces(undefined, req.params.traceId);
  spans.sort((a, b) => (a.startTime || '').localeCompare(b.startTime || ''));
  res.json(spans);
});

router.get('/api/metrics', (req, res) => {
  res.json(store.queryMetrics(200));
});

router.get('/api/logs', (req, res) => {
  res.json(store.queryLogs(500));
});

router.get('/api/timeline', (req, res) => {
  const buckets = 30;
  const bucketSize = 60;
  const { tc, mc, lc } = store.queryTimeline(buckets, bucketSize);
  const labels = [];
  const td = [];
  const md = [];
  const ld = [];
  for (let i = buckets - 1; i >= 0; i--) {
    labels.push(`-${i}m`);
    td.push(tc[i] || 0);
    md.push(mc[i] || 0);
    ld.push(lc[i] || 0);
  }
  res.json({ labels, traces: td, metrics: md, logs: ld });
});

router.get('/api/stats', (req, res) => {
  res.json(store.queryStats());
});

router.get('/api/flow', (req, res) => {
  const allSpans = store.queryAllTraces();
  const allLogs = store.queryAllLogs();

  const groups = {};
  for (const s of allSpans) {
    if (s.traceId) {
      (groups[s.traceId] ||= []).push(s);
    }
  }

  const logGroups = {};
  for (const l of allLogs) {
    if (l.traceId) {
      (logGroups[l.traceId] ||= []).push(l);
    }
  }

  const sortedTids = Object.keys(groups).sort((a, b) => {
    const aTime = groups[a][0] ? groups[a][0].startTime : '';
    const bTime = groups[b][0] ? groups[b][0].startTime : '';
    return bTime.localeCompare(aTime);
  }).slice(0, 20);

  const flows = [];
  for (const tid of sortedTids) {
    const spans = groups[tid].sort((a, b) => (a.startTime || '').localeCompare(b.startTime || ''));
    const traceLogs = (logGroups[tid] || []).sort((a, b) => (a.time || '').localeCompare(b.time || ''));

    const nodes = [];
    const edges = [];
    for (const s of spans) {
      const name = s.name;
      const attrs = s.attributes;
      let ntype = 'other';
      if (name.includes('llm_request')) ntype = 'llm';
      else if (name.includes('hook')) ntype = 'hook';
      else if (name.includes('tool')) ntype = 'tool';

      nodes.push({
        id: s.spanId, name, type: ntype,
        duration: s.durationMs,
        startTime: s.startTime, endTime: s.endTime,
        attributes: attrs, status: s.status || {},
        parentId: s.parentSpanId || '',
      });

      if (s.parentSpanId) {
        edges.push({ from: s.parentSpanId, to: s.spanId });
      }
    }

    const logNodes = [];
    for (let i = 0; i < traceLogs.length; i++) {
      let body = traceLogs[i].body || '';
      if (typeof body === 'object') {
        body = body.name || JSON.stringify(body);
      }
      logNodes.push({
        id: `log-${tid.slice(0, 8)}-${i}`,
        name: String(body).slice(0, 60), type: 'log',
        time: traceLogs[i].time || '',
        severity: traceLogs[i].severityText || '',
        attributes: traceLogs[i].attributes || {},
      });
    }

    flows.push({
      traceId: tid,
      startTime: spans[0] ? spans[0].startTime : '',
      nodes, edges,
      logNodes,
      spanCount: nodes.length, logCount: logNodes.length,
    });
  }

  res.json(flows);
});

module.exports = router;
