'use strict';

const { DANGEROUS_RE: DANGEROUS_BASH, EXFIL_RE: EXFIL_BASH } = require('./alert-rules');

class AlertManager {
  constructor() {
    this.clients = new Set();
    this.thresholds = { risk_score: 0.5, intent_alignment: 0.3 };
    this._cooldown = new Map();
    this._cooldownSecs = 600;
  }

  register(ws) { this.clients.add(ws); }
  unregister(ws) { this.clients.delete(ws); }

  get clientCount() { return this.clients.size; }

  broadcast(message) {
    const data = JSON.stringify(message);
    const dead = [];
    for (const ws of this.clients) {
      try { ws.send(data); } catch { dead.push(ws); }
    }
    for (const ws of dead) this.clients.delete(ws);
  }

  _shouldAlert(sessionId, alertType) {
    const key = `${sessionId}:${alertType}`;
    const now = Date.now() / 1000;
    const last = this._cooldown.get(key) || 0;
    if (now - last < this._cooldownSecs) return false;
    this._cooldown.set(key, now);
    return true;
  }

  checkLogEvent(parsed) {
    const attrs = parsed.attributes || {};
    const eventName = attrs['event.name'] || '';
    const sessionId = attrs['session.id'] || (parsed.resource || {})['session.id'] || '';
    if (!sessionId) return;

    if (eventName.includes('tool_result')) {
      const toolName = attrs.tool_name || '';
      if (toolName === 'Bash') {
        const cmd = String(attrs.command || attrs.input || '');
        if (DANGEROUS_BASH.test(cmd) && this._shouldAlert(sessionId, 'dangerous_bash')) {
          this._emitAlert(sessionId, 'critical', 'Dangerous command detected',
            `Bash: ${cmd.slice(0, 120)}`, { tool: 'Bash', command: cmd.slice(0, 200) });
        }
        if (EXFIL_BASH.test(cmd) && this._shouldAlert(sessionId, 'exfil_bash')) {
          this._emitAlert(sessionId, 'warning', 'Potential data exfiltration',
            `Network command: ${cmd.slice(0, 120)}`, { tool: 'Bash', command: cmd.slice(0, 200) });
        }
      }
    }

    if (eventName === 'api_request') {
      const cost = parseFloat(attrs.cost_rmb || attrs.cost_usd || 0);
      if (cost > 3.5 && this._shouldAlert(sessionId, 'high_cost')) {
        this._emitAlert(sessionId, 'warning', 'High single-request cost',
          `¥${cost.toFixed(4)} for ${attrs.model || 'unknown'}`,
          { cost_rmb: cost, model: attrs.model || '' });
      }
    }
  }

  checkAnalysisResult(sessionId, analysis) {
    const risk = analysis.risk || {};
    const score = risk.cumulative_score || 0;
    const level = risk.level || 'low';
    if (score >= this.thresholds.risk_score && this._shouldAlert(sessionId, 'risk_score')) {
      const flags = risk.flags || [];
      this._emitAlert(sessionId, level === 'critical' ? 'critical' : 'warning',
        `Risk score ${score.toFixed(2)} (${level})`,
        flags.length ? `Flags: ${flags.join(', ')}` : 'Elevated risk',
        { risk_score: score, level, flags });
    }
    const anomaly = analysis.anomaly_detection || {};
    if (anomaly) {
      const det = anomaly.detection || {};
      if (det.is_anomalous && this._shouldAlert(sessionId, 'anomaly')) {
        this._emitAlert(sessionId, 'warning',
          `Anomaly: ${det.anomaly_type || 'unknown'}`,
          (det.explanation || '').slice(0, 200), { anomaly: det });
      }
    }
  }

  checkIntentAlignment(sessionId, intentResult) {
    const alignment = intentResult.overall_alignment ?? 1.0;
    if (alignment < this.thresholds.intent_alignment && this._shouldAlert(sessionId, 'intent')) {
      const mismatches = intentResult.mismatches || [];
      const detail = mismatches[0]?.detail || 'Low alignment';
      this._emitAlert(sessionId, 'warning',
        `Intent alignment low (${(alignment * 100).toFixed(0)}%)`,
        detail.slice(0, 200), { alignment, mismatches: mismatches.slice(0, 5) });
    }
  }

  checkRoutingEvent(event) {
    const sessionId = event.session_id || 'unknown';
    const stop = event.stop_reason || '';
    const errorReasons = new Set(['error', 'timeout', 'rate_limit', 'overloaded']);
    if (errorReasons.has(stop) && this._shouldAlert(sessionId, `route_error_${stop}`)) {
      this._emitAlert(sessionId, stop === 'error' ? 'critical' : 'warning',
        `Routing error: ${stop}`,
        `${event.actual_provider || '?'}/${event.actual_model || '?'}`,
        { stop_reason: stop, provider: event.actual_provider, model: event.actual_model });
    }
    const hvr = event.hvr_score;
    if (hvr != null && hvr < 0.3 && this._shouldAlert(sessionId, 'low_hvr')) {
      this._emitAlert(sessionId, 'warning', `Low HVR score: ${hvr.toFixed(2)}`,
        `Model ${event.actual_model || '?'} may be hedging`,
        { hvr_score: hvr, model: event.actual_model });
    }
  }

  checkProviderHealth(healthList) {
    for (const h of healthList) {
      const provider = h.provider || 'unknown';
      const model = h.model || 'unknown';
      const successRate = h.success_rate ?? 1.0;
      if (successRate < 0.8 && (h.total_requests || 0) >= 10) {
        const key = `${provider}/${model}`;
        if (this._shouldAlert(key, 'provider_degraded')) {
          this._emitAlert(key, 'critical', `Provider degraded: ${provider}/${model}`,
            `Success rate ${(successRate * 100).toFixed(1)}% over ${h.total_requests} requests`,
            { provider, model, success_rate: successRate, total_requests: h.total_requests });
        }
      }
    }
  }

  _emitAlert(sessionId, severity, title, detail, data) {
    const msg = {
      type: 'alert', severity, session_id: sessionId,
      title, detail,
      timestamp: new Date().toISOString(),
      data: data || {},
    };
    if (this._store && (severity === 'critical' || severity === 'warning')) {
      try { this._store.addSessionRiskEvent({ session_id: sessionId, severity, title, detail, data }); } catch (_) {}
    }
    setImmediate(() => this.broadcast(msg));
  }

  setStore(store) { this._store = store; }
}

const alertManager = new AlertManager();
module.exports = { AlertManager, alertManager };
