'use strict';

/**
 * Background evaluation pipeline -- auto-scores sessions on completion.
 * Uses setInterval instead of Python threading.Thread for the background loop.
 */

const { v4: uuidv4 } = require('uuid');

class EvaluationPipeline {
  constructor(store, runAnalysisFn, intentAnalyzer) {
    this.store = store;
    this.runAnalysis = runAnalysisFn;
    this.intentAnalyzer = intentAnalyzer;
    this._evaluated = new Set();
    this._sessionLastEvent = {};
    this._idleThreshold = 60;   // seconds
    this._intervalHandle = null;
  }

  start() {
    if (this._intervalHandle) return;
    this._intervalHandle = setInterval(() => this._loop(), 30000);
    // Make sure the interval doesn't prevent process exit
    if (this._intervalHandle.unref) this._intervalHandle.unref();
  }

  stop() {
    if (this._intervalHandle) {
      clearInterval(this._intervalHandle);
      this._intervalHandle = null;
    }
  }

  trackEvent(sessionId) {
    this._sessionLastEvent[sessionId] = Date.now() / 1000;
  }

  _loop() {
    const now = Date.now() / 1000;
    for (const [sid, lastT] of Object.entries(this._sessionLastEvent)) {
      if (this._evaluated.has(sid)) continue;
      if (now - lastT >= this._idleThreshold) {
        try {
          this._evaluate(sid);
        } catch (e) {
          console.error(`[EvalPipeline] Error evaluating ${sid.slice(0, 12)}: ${e}`);
        }
        this._evaluated.add(sid);
      }
    }
  }

  evaluateSession(sessionId) {
    if (this._evaluated.has(sessionId)) {
      const existing = this.store.queryEvaluation(sessionId);
      if (existing) return existing;
    }
    return this._evaluate(sessionId);
  }

  _evaluate(sessionId) {
    const { AnomalyDetectionEngine } = require('./anomaly');
    const sessionLogs = this.store.queryLogsBySession(sessionId);
    if (!sessionLogs || sessionLogs.length === 0) return null;

    const logsSorted = [...sessionLogs].sort(
      (a, b) => ((a.attributes || {})['event.sequence'] || 0) -
                ((b.attributes || {})['event.sequence'] || 0)
    );

    const turns = logsSorted.filter(l =>
      ((l.attributes || {})['event.name'] || '').includes('user_prompt')
    );

    const analysis = this.runAnalysis(sessionId, logsSorted, turns);

    const taskCompletion = this._scoreCompletion(logsSorted, analysis);
    const efficiency = this._scoreEfficiency(analysis);
    const safety = this._scoreSafety(analysis);
    const intentAlignment = this._scoreIntent(sessionId);

    const overall = Math.round((
      taskCompletion * 0.30 +
      efficiency * 0.25 +
      safety * 0.25 +
      intentAlignment * 0.20
    ) * 1000) / 1000;

    const ev = {
      id: `eval-${uuidv4().replace(/-/g, '').slice(0, 8)}`,
      session_id: sessionId,
      timestamp: new Date().toISOString(),
      task_completion: Math.round(taskCompletion * 1000) / 1000,
      efficiency: Math.round(efficiency * 1000) / 1000,
      safety: Math.round(safety * 1000) / 1000,
      intent_alignment: Math.round(intentAlignment * 1000) / 1000,
      overall,
      details: {
        pattern: (analysis.behavioral_summary || {}).pattern || 'unknown',
        total_tools: (analysis.tool_stats || {}).total_calls || 0,
        total_tokens: (analysis.cost_analysis || {}).total_tokens || 0,
        total_cost: (analysis.cost_analysis || {}).total_rmb || 0,
        risk_level: (analysis.risk || {}).level || 'low',
        risk_flags: (analysis.risk || {}).flags || [],
      },
    };

    this.store.addEvaluation(ev);
    this._evaluated.add(sessionId);
    return ev;
  }

  _scoreCompletion(logsSorted, analysis) {
    const toolStats = analysis.tool_stats || {};
    const totalCalls = toolStats.total_calls || 0;
    if (totalCalls === 0) return 0.3;

    const details = toolStats.details || [];
    if (details.length === 0) return 0.5;

    const lastTool = details[details.length - 1];
    const hasError = lastTool.success === false;
    const errorCount = details.filter(d => d.success === false).length;
    const errorRatio = errorCount / Math.max(totalCalls, 1);

    let score = 0.8;
    if (hasError) score -= 0.3;
    score -= errorRatio * 0.2;

    const behavior = analysis.behavioral_summary || {};
    const pattern = behavior.pattern || '';
    if (pattern === 'explore-then-edit' || pattern === 'read-write') {
      score += 0.15;
    } else if (pattern === 'direct-write') {
      score += 0.05;
    }

    return Math.max(0.0, Math.min(1.0, score));
  }

  _scoreEfficiency(analysis) {
    const cost = analysis.cost_analysis || {};
    const behavior = analysis.behavioral_summary || {};

    const tokenEff = Math.min((cost.token_efficiency || 0) * 2, 1.0);
    const cacheEff = cost.cache_hit_rate || 0;

    const pattern = behavior.pattern || 'mixed';
    const expected = EvaluationPipeline.PATTERN_EXPECTED_STEPS[pattern] || 5;
    const actual = behavior.total_tool_calls || 1;
    const stepEff = Math.min(expected / Math.max(actual, 1), 1.0);

    return Math.round((tokenEff * 0.35 + cacheEff * 0.30 + stepEff * 0.35) * 1000) / 1000;
  }

  _scoreSafety(analysis) {
    const risk = analysis.risk || {};
    const score = risk.cumulative_score || 0;
    return Math.round(Math.max(0.0, 1.0 - score) * 1000) / 1000;
  }

  _scoreIntent(sessionId) {
    const spans = this.store.queryTracesBySession(sessionId);
    const sessionLogs = this.store.queryLogsBySession(sessionId);
    if (!sessionLogs || sessionLogs.length === 0) return 1.0;

    const thinkingTexts = [];
    for (const s of (spans || [])) {
      const attrs = s.attributes || {};
      if (attrs['response.thinking_output']) {
        thinkingTexts.push(String(attrs['response.thinking_output']));
      }
    }
    for (const l of sessionLogs) {
      const attrs = l.attributes || {};
      if (attrs['response.thinking_output']) {
        thinkingTexts.push(String(attrs['response.thinking_output']));
      }
    }

    if (thinkingTexts.length === 0) return 1.0;

    const allIntents = [];
    for (const text of thinkingTexts) {
      const intents = this.intentAnalyzer.extractIntents(text);
      allIntents.push(...intents);
    }

    if (allIntents.length === 0) return 1.0;

    const classified = allIntents.filter(i => i.action !== 'unknown');
    return Math.round((classified.length / Math.max(allIntents.length, 1)) * 1000) / 1000;
  }
}

EvaluationPipeline.PATTERN_EXPECTED_STEPS = {
  'read-only': 3,
  'explore-then-edit': 6,
  'direct-write': 2,
  'shell-heavy': 4,
  'delegating': 5,
  'read-write': 5,
  'mixed': 5,
  'empty': 1,
};

module.exports = { EvaluationPipeline };
