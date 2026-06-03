'use strict';

const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const { store } = require('../lib/store');

let _anomalyEngine = null;

function getAnomalyEngine() {
  if (!_anomalyEngine) {
    try {
      const { AnomalyDetectionEngine } = require('../analytics/anomaly');
      _anomalyEngine = new AnomalyDetectionEngine();
    } catch { _anomalyEngine = null; }
  }
  return _anomalyEngine;
}

// --- Scores ---
router.get('/api/scores', (req, res) => {
  const sessionId = req.query.session || '';
  const data = store.queryScores(500, sessionId || null);
  res.json(data);
});

router.post('/api/scores', (req, res) => {
  const data = req.body || {};
  const score = {
    id: `score-${(typeof uuidv4 === 'function' ? uuidv4() : Math.random().toString(36)).slice(0, 8)}`,
    timestamp: new Date().toISOString(),
    session_id: data.session_id || '',
    trace_id: data.trace_id || '',
    name: data.name || '',
    value: data.value || 0,
    data_type: data.data_type || 'NUMERIC',
    comment: data.comment || '',
    source: data.source || 'manual',
  };
  store.addScore(score);
  res.json(score);
});

// --- Auto Scores ---
router.get('/api/scores/auto/:sessionId', (req, res) => {
  const sessionId = req.params.sessionId;
  const sessionLogs = store.queryLogsBySession(sessionId);
  if (!sessionLogs || sessionLogs.length === 0) {
    return res.json([]);
  }

  const logsSorted = [...sessionLogs].sort((a, b) =>
    ((a.attributes || {})['event.sequence'] || 0) - ((b.attributes || {})['event.sequence'] || 0));
  const turns = logsSorted.filter(l => ((l.attributes || {})['event.name'] || '').includes('user_prompt'));

  let analysis;
  try {
    const { runSessionAnalysis } = require('../analytics/session');
    analysis = runSessionAnalysis(sessionId, logsSorted, turns);
  } catch {
    analysis = {};
  }

  const autoScores = [];
  const risk = analysis.risk || {};
  autoScores.push({
    id: `auto-risk-${sessionId.slice(0, 8)}`,
    session_id: sessionId, name: 'risk_score',
    value: Math.round((risk.cumulative_score || 0) * 10000) / 10000,
    data_type: 'NUMERIC', source: 'auto',
    comment: `Level: ${risk.level || 'low'}, Flags: ${(risk.flags || []).join(',')}`,
  });

  const cost = analysis.cost_analysis || {};
  autoScores.push({
    id: `auto-cost-${sessionId.slice(0, 8)}`,
    session_id: sessionId, name: 'total_cost',
    value: Math.round((cost.total_rmb || cost.total_usd || 0) * 1e6) / 1e6,
    data_type: 'NUMERIC', source: 'auto',
    comment: `Tokens: ${cost.total_tokens || 0}, Efficiency: ${cost.token_efficiency || 0}`,
  });

  autoScores.push({
    id: `auto-cache-${sessionId.slice(0, 8)}`,
    session_id: sessionId, name: 'cache_hit_rate',
    value: Math.round((cost.cache_hit_rate || 0) * 10000) / 10000,
    data_type: 'NUMERIC', source: 'auto',
  });

  const ad = analysis.anomaly_detection || {};
  const det = ad.detection || {};
  autoScores.push({
    id: `auto-anomaly-${sessionId.slice(0, 8)}`,
    session_id: sessionId, name: 'anomaly_score',
    value: Math.round((det.confidence || 0) * 10000) / 10000,
    data_type: 'NUMERIC', source: 'auto',
    comment: `Type: ${det.anomaly_type || 'normal'}, Anomalous: ${det.is_anomalous || false}`,
  });

  const behavior = analysis.behavioral_summary || {};
  autoScores.push({
    id: `auto-pattern-${sessionId.slice(0, 8)}`,
    session_id: sessionId, name: 'behavior_pattern',
    value: behavior.pattern || 'unknown',
    data_type: 'CATEGORICAL', source: 'auto',
    comment: `Diversity: ${behavior.tool_diversity || 0}, Tools/Turn: ${behavior.avg_tools_per_turn || 0}`,
  });

  res.json(autoScores);
});

// --- Session evaluate ---
router.get('/api/session/:sessionId/evaluate', (req, res) => {
  const sessionId = req.params.sessionId;
  try {
    const { EvaluationPipeline } = require('../analytics/evaluation');
    const { runSessionAnalysis } = require('../analytics/session');
    const { IntentAnalyzer } = require('../analytics/intent');
    const pipeline = new EvaluationPipeline(store, runSessionAnalysis, new IntentAnalyzer());
    const result = pipeline.evaluateSession(sessionId);
    if (result === null || result === undefined) {
      return res.status(404).json({ error: 'no data' });
    }
    return res.json(result);
  } catch {
    return res.status(404).json({ error: 'evaluation not available' });
  }
});

// --- Evaluations ---
router.get('/api/evaluations', (req, res) => {
  const sessionId = req.query.session || '';
  if (sessionId) {
    const ev = store.queryEvaluation(sessionId);
    return res.json(ev ? [ev] : []);
  }
  try {
    const db = store._db;
    const rows = db.prepare('SELECT * FROM evaluations ORDER BY timestamp DESC LIMIT 100').all();
    const results = rows.map(r => ({
      id: r.id, session_id: r.session_id,
      timestamp: r.timestamp,
      task_completion: r.task_completion,
      efficiency: r.efficiency, safety: r.safety,
      intent_alignment: r.intent_alignment,
      overall: r.overall,
    }));
    res.json(results);
  } catch {
    res.json([]);
  }
});

// --- Anomaly status ---
router.get('/api/anomaly/status', (req, res) => {
  const engine = getAnomalyEngine();
  if (!engine) {
    return res.json({ error: 'anomaly engine not available' });
  }
  res.json(engine.getStatus());
});

// --- Anomaly train ---
router.post('/api/anomaly/train', (req, res) => {
  const engine = getAnomalyEngine();
  if (!engine) {
    return res.status(500).json({ error: 'anomaly engine not available' });
  }
  const samples = engine.trainingStore.loadSamples();
  if (samples.length < 5) {
    return res.json({ error: `Need >= 5 samples, got ${samples.length}` });
  }
  const result = engine.smallModel.train(samples);
  res.json(result);
});

// --- Anomaly feedback ---
router.post('/api/anomaly/feedback', (req, res) => {
  const engine = getAnomalyEngine();
  if (!engine) {
    return res.status(500).json({ error: 'anomaly engine not available' });
  }
  const data = req.body || {};
  const sessionId = data.session_id || '';
  const isAnomalous = !!data.is_anomalous;
  const anomalyType = data.anomaly_type || (isAnomalous ? 'human_flagged' : 'normal');
  const explanation = data.explanation || '';

  const label = { is_anomalous: isAnomalous, anomaly_type: anomalyType, confidence: 1.0, explanation };
  const features = data.features || {};

  engine.trainingStore.saveSample(features, label, 'human', {
    session_id: sessionId,
    feedback_timestamp: new Date().toISOString(),
  });

  res.json({ ok: true, session_id: sessionId, label });
});

// --- Anomaly transition matrix ---
router.get('/api/anomaly/matrix', (req, res) => {
  const engine = getAnomalyEngine();
  if (!engine) {
    return res.json({ error: 'anomaly engine not available' });
  }
  res.json(engine.baseline.getTransitionMatrix());
});

// --- Alert feedback (false positive reports) ---
router.post('/api/alert-feedback', (req, res) => {
  const { session_id, alert_title, severity, feedback, ts } = req.body || {};
  if (!session_id) return res.status(400).json({ error: 'session_id required' });
  store.addAlertFeedback({ session_id, alert_title, severity, feedback, ts });
  res.json({ ok: true });
});

router.get('/api/alert-feedback', (req, res) => {
  const rows = store.queryAlertFeedback(200);
  res.json(rows);
});

// --- Session risk events (persisted alerts) ---
router.get('/api/session-risks', (req, res) => {
  const hours = parseInt(req.query.hours || '24', 10);
  const rows = store.queryActiveRiskEvents(hours);
  res.json(rows);
});

router.post('/api/session-risks/dismiss', (req, res) => {
  const { session_id } = req.body || {};
  if (!session_id) return res.status(400).json({ error: 'session_id required' });
  store.dismissRiskEvent(session_id);
  res.json({ ok: true });
});

module.exports = router;
