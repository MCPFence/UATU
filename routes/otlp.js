'use strict';

const router = require('express').Router();
const { store } = require('../lib/store');
const { nanoToIso, nanoToMs, parseAnyValue, parseAttributes, normalizeAttributes, getSessionId } = require('../lib/parsers');
const { alertManager } = require('../lib/websocket');

// Lazy-load eval pipeline to avoid circular dependency at require-time
let _evalPipeline = null;
function getEvalPipeline() {
  if (!_evalPipeline) {
    try { _evalPipeline = require('../lib/evalPipeline'); } catch { _evalPipeline = null; }
  }
  return _evalPipeline;
}

// --- OTLP HTTP receivers ---

router.post('/v1/traces', (req, res) => {
  const data = req.body;
  if (!data) return res.status(200).send('');

  const resourceSpans = data.resourceSpans || [];
  for (const rs of resourceSpans) {
    const resourceAttrs = parseAttributes((rs.resource || {}).attributes);
    const serviceName = resourceAttrs['service.name'] || 'unknown';
    for (const ss of (rs.scopeSpans || [])) {
      const scopeName = (ss.scope || {}).name || '';
      for (const span of (ss.spans || [])) {
        const parsed = {
          traceId: span.traceId || '',
          spanId: span.spanId || '',
          parentSpanId: span.parentSpanId || '',
          name: span.name || '',
          kind: span.kind || 0,
          startTime: nanoToIso(span.startTimeUnixNano),
          endTime: nanoToIso(span.endTimeUnixNano),
          durationMs: nanoToMs(span.startTimeUnixNano, span.endTimeUnixNano),
          attributes: normalizeAttributes(parseAttributes(span.attributes)),
          status: span.status || {},
          service: serviceName,
          scope: scopeName,
          resource: resourceAttrs,
          _receivedAt: Date.now() / 1000,
        };
        store.addTrace(parsed);
      }
    }
  }
  res.status(200).send('');
});

router.post('/v1/metrics', (req, res) => {
  const data = req.body;
  if (!data) return res.status(200).send('');

  for (const rm of (data.resourceMetrics || [])) {
    const resourceAttrs = parseAttributes((rm.resource || {}).attributes);
    for (const sm of (rm.scopeMetrics || [])) {
      for (const metric of (sm.metrics || [])) {
        const parsed = {
          name: metric.name || '',
          description: metric.description || '',
          unit: metric.unit || '',
          resource: resourceAttrs,
          _receivedAt: Date.now() / 1000,
        };
        for (const key of ['gauge', 'sum', 'histogram', 'summary']) {
          if (metric[key]) {
            const points = metric[key].dataPoints || [];
            parsed.type = key;
            parsed.dataPoints = [];
            for (const dp of points) {
              const point = {
                attributes: parseAttributes(dp.attributes),
                time: nanoToIso(dp.timeUnixNano),
              };
              if ('asInt' in dp) point.value = dp.asInt;
              else if ('asDouble' in dp) point.value = dp.asDouble;
              parsed.dataPoints.push(point);
            }
            break;
          }
        }
        store.addMetric(parsed);
      }
    }
  }
  res.status(200).send('');
});

router.post('/v1/logs', (req, res) => {
  const data = req.body;
  if (!data) return res.status(200).send('');

  for (const rl of (data.resourceLogs || [])) {
    const resourceAttrs = parseAttributes((rl.resource || {}).attributes);
    for (const sl of (rl.scopeLogs || [])) {
      for (const lr of (sl.logRecords || [])) {
        const parsed = {
          time: nanoToIso(lr.timeUnixNano || lr.observedTimeUnixNano),
          severityText: lr.severityText || '',
          severityNumber: lr.severityNumber || 0,
          body: lr.body ? parseAnyValue(lr.body) : '',
          attributes: normalizeAttributes(parseAttributes(lr.attributes)),
          traceId: lr.traceId || '',
          spanId: lr.spanId || '',
          resource: resourceAttrs,
          _receivedAt: Date.now() / 1000,
        };
        store.addLog(parsed);
        alertManager.checkLogEvent(parsed);
        const sid = getSessionId(parsed);
        if (sid) {
          const ep = getEvalPipeline();
          if (ep && ep.trackEvent) ep.trackEvent(sid);
        }
      }
    }
  }
  res.status(200).send('');
});

module.exports = router;
