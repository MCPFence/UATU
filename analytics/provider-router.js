'use strict';

/**
 * Provider route tracking: health metrics, failover analysis, HVR analytics.
 */

const { estimateCost } = require('./cost-aggregator');

class ProviderRouteTracker {
  constructor(store) {
    this.store = store;
  }

  // ── Existing session-level tracking ────────────────────────────

  trackSession(sessionId) {
    const reqs = this.store.queryCcProxyRequests(sessionId);
    const resps = this.store.queryCcProxyResponses(sessionId);

    if (!reqs || !resps || reqs.length === 0 || resps.length === 0) return null;

    const respBySeq = {};
    for (const r of resps) {
      respBySeq[r.seq] = r;
    }

    const routingChain = [];
    let fallbackCount = 0;

    for (const req of reqs) {
      const seq = req.seq;
      const resp = respBySeq[seq];
      if (!resp) continue;

      const requested = req.requested_model || '';
      const actual = resp.actual_model || '';
      const provider = resp.actual_provider || '';
      const fellBack = resp.fallback_occurred !== undefined
        ? resp.fallback_occurred
        : (requested !== actual);

      if (fellBack) fallbackCount++;

      routingChain.push({
        seq,
        requested_model: requested,
        actual_model: actual,
        actual_provider: provider,
        fallback: fellBack,
        elapsed_ms: resp.elapsed_ms || 0,
        input_tokens: resp.input_tokens || 0,
        output_tokens: resp.output_tokens || 0,
      });
    }

    const providerStats = this._computeProviderStats(routingChain);
    const anomalies = this._detectAnomalies(routingChain);

    return {
      session_id: sessionId,
      total_requests: routingChain.length,
      fallback_count: fallbackCount,
      fallback_rate: Math.round((fallbackCount / Math.max(routingChain.length, 1)) * 1000) / 1000,
      routing_chain: routingChain,
      provider_stats: providerStats,
      anomalies,
    };
  }

  globalStats() {
    return {
      provider_stats: this.store.queryProviderStats(),
    };
  }

  _computeProviderStats(chain) {
    const stats = {};
    for (const hop of chain) {
      const key = `${hop.actual_provider}|${hop.actual_model}`;
      if (!stats[key]) {
        stats[key] = {
          provider: hop.actual_provider,
          model: hop.actual_model,
          count: 0,
          total_elapsed_ms: 0,
          total_input_tokens: 0,
          total_output_tokens: 0,
          fallback_count: 0,
        };
      }
      const s = stats[key];
      s.count += 1;
      s.total_elapsed_ms += hop.elapsed_ms;
      s.total_input_tokens += hop.input_tokens;
      s.total_output_tokens += hop.output_tokens;
      if (hop.fallback) s.fallback_count += 1;
    }

    const result = [];
    for (const s of Object.values(stats)) {
      s.avg_elapsed_ms = Math.round((s.total_elapsed_ms / Math.max(s.count, 1)) * 10) / 10;
      result.push(s);
    }
    result.sort((a, b) => b.count - a.count);
    return result;
  }

  _detectAnomalies(chain) {
    const anomalies = [];

    // Check consecutive fallbacks
    let consecutive = 0;
    let maxConsecutive = 0;
    for (const hop of chain) {
      if (hop.fallback) {
        consecutive++;
        maxConsecutive = Math.max(maxConsecutive, consecutive);
      } else {
        consecutive = 0;
      }
    }
    if (maxConsecutive >= 3) {
      anomalies.push({
        type: 'consecutive_fallback',
        detail: `${maxConsecutive} consecutive fallback requests`,
        severity: 'warning',
      });
    }

    // Check token growth
    const tokens = chain.filter(h => h.input_tokens > 0).map(h => h.input_tokens);
    if (tokens.length >= 3) {
      const growthRate = (tokens[tokens.length - 1] - tokens[0]) / Math.max(tokens[0], 1);
      if (growthRate > 0.5) {
        anomalies.push({
          type: 'token_growth',
          detail: `Input tokens grew ${Math.round(growthRate * 100)}% from first to last`,
          severity: 'warning',
          first_tokens: tokens[0],
          last_tokens: tokens[tokens.length - 1],
        });
      }
    }

    return anomalies;
  }

  // ── Provider health (from routing_events / DuckDB data) ────────

  providerHealth() {
    const events = this.store.queryRoutingEvents(10000);
    if (!events || events.length === 0) return [];

    const groups = {};
    for (const e of events) {
      const key = `${e.actual_provider}|${e.actual_model}`;
      if (!groups[key]) groups[key] = [];
      groups[key].push(e);
    }

    const SUCCESS_REASONS = new Set(['end_turn', 'tool_use', 'max_tokens']);
    const results = [];

    for (const [_key, entries] of Object.entries(groups)) {
      const provider = entries[0].actual_provider;
      const model = entries[0].actual_model;

      const latencies = entries
        .filter(e => e.actual_latency_ms && e.actual_latency_ms > 0)
        .map(e => e.actual_latency_ms)
        .sort((a, b) => a - b);
      const n = latencies.length;

      const success = entries.filter(e => SUCCESS_REASONS.has(e.stop_reason)).length;
      const errors = entries.filter(e => !SUCCESS_REASONS.has(e.stop_reason));

      const errorBreakdown = {};
      for (const e of errors) {
        const reason = e.stop_reason || 'unknown';
        errorBreakdown[reason] = (errorBreakdown[reason] || 0) + 1;
      }

      let totalCost = 0;
      for (const e of entries) {
        totalCost += estimateCost(model, e.input_tokens || 0, e.output_tokens || 0);
      }

      let avgHvr = 0;
      for (const e of entries) {
        avgHvr += (e.hvr_score != null ? e.hvr_score : 1);
      }
      avgHvr = Math.round((avgHvr / Math.max(entries.length, 1)) * 1000) / 1000;

      results.push({
        provider,
        model,
        total_requests: entries.length,
        success_count: success,
        success_rate: Math.round((success / Math.max(entries.length, 1)) * 10000) / 10000,
        error_count: errors.length,
        error_breakdown: errorBreakdown,
        latency_p50: n > 0 ? latencies[Math.floor(n * 0.5)] : 0,
        latency_p95: n > 0 ? latencies[Math.min(Math.floor(n * 0.95), n - 1)] : 0,
        latency_p99: n > 0 ? latencies[Math.min(Math.floor(n * 0.99), n - 1)] : 0,
        latency_avg: Math.round((latencies.reduce((a, b) => a + b, 0) / Math.max(n, 1)) * 10) / 10,
        total_cost_rmb: Math.round(totalCost * 10000) / 10000,
        total_input_tokens: entries.reduce((s, e) => s + (e.input_tokens || 0), 0),
        total_output_tokens: entries.reduce((s, e) => s + (e.output_tokens || 0), 0),
        avg_hvr_score: avgHvr,
      });
    }

    results.sort((a, b) => b.total_requests - a.total_requests);
    return results;
  }

  // ── Failover analysis ──────────────────────────────────────────

  failoverAnalysis() {
    const events = this.store.queryRoutingEvents(10000);
    if (!events || events.length === 0) {
      return { transitions: [], summary: {} };
    }

    const bySession = {};
    for (const e of events) {
      const sid = e.session_id;
      if (!bySession[sid]) bySession[sid] = [];
      bySession[sid].push(e);
    }

    const transitions = {};
    let totalHops = 0;
    let failoverSessions = 0;

    for (const [_sid, sessionEvents] of Object.entries(bySession)) {
      sessionEvents.sort((a, b) => (a.request_seq || 0) - (b.request_seq || 0));
      let sessionHadFailover = false;
      for (let i = 1; i < sessionEvents.length; i++) {
        const prevModel = sessionEvents[i - 1].actual_model || '';
        const currModel = sessionEvents[i].actual_model || '';
        if (prevModel !== currModel && prevModel && currModel) {
          const key = `${prevModel}|${currModel}`;
          transitions[key] = (transitions[key] || 0) + 1;
          totalHops++;
          sessionHadFailover = true;
        }
      }
      if (sessionHadFailover) failoverSessions++;
    }

    // Sort transitions by count descending, take top 20
    const transitionList = Object.entries(transitions)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([key, count]) => {
        const [fromModel, toModel] = key.split('|');
        return { from_model: fromModel, to_model: toModel, count };
      });

    return {
      transitions: transitionList,
      summary: {
        total_transitions: totalHops,
        sessions_with_failover: failoverSessions,
        total_sessions: Object.keys(bySession).length,
      },
    };
  }

  // ── HVR analytics ──────────────────────────────────────────────

  hvrAnalytics(model) {
    const events = this.store.queryRoutingEvents(10000);
    if (!events || events.length === 0) {
      return { distribution: {}, by_model: [], gate_pass_rate: 0, total_events: 0 };
    }

    let filtered = events;
    if (model) {
      filtered = events.filter(e =>
        (e.actual_model || '').toLowerCase().includes(model.toLowerCase())
      );
    }

    const buckets = { '0.0-0.2': 0, '0.2-0.4': 0, '0.4-0.6': 0, '0.6-0.8': 0, '0.8-1.0': 0 };
    const byModel = {};

    for (const e of filtered) {
      const score = e.hvr_score;
      if (score == null) continue;

      // Bucket distribution
      if (score < 0.2) {
        buckets['0.0-0.2']++;
      } else if (score < 0.4) {
        buckets['0.2-0.4']++;
      } else if (score < 0.6) {
        buckets['0.4-0.6']++;
      } else if (score < 0.8) {
        buckets['0.6-0.8']++;
      } else {
        buckets['0.8-1.0']++;
      }

      const m = e.actual_model || 'unknown';
      if (!byModel[m]) {
        byModel[m] = { scores: [], gate_passed: 0, total: 0 };
      }
      byModel[m].scores.push(score);
      byModel[m].total++;
      if (e.hvr_gate_passed) byModel[m].gate_passed++;
    }

    const modelList = [];
    for (const [m, d] of Object.entries(byModel)) {
      modelList.push({
        model: m,
        avg_hvr: Math.round((d.scores.reduce((a, b) => a + b, 0) / Math.max(d.scores.length, 1)) * 1000) / 1000,
        gate_pass_rate: Math.round((d.gate_passed / Math.max(d.total, 1)) * 1000) / 1000,
        total_requests: d.total,
      });
    }
    modelList.sort((a, b) => b.total_requests - a.total_requests);

    let totalGate = 0;
    let totalAll = 0;
    for (const d of Object.values(byModel)) {
      totalGate += d.gate_passed;
      totalAll += d.total;
    }

    return {
      distribution: buckets,
      by_model: modelList,
      gate_pass_rate: Math.round((totalGate / Math.max(totalAll, 1)) * 1000) / 1000,
      total_events: totalAll,
    };
  }

  // ── Cluster analysis ───────────────────────────────────────────

  clusterAnalysis() {
    const events = this.store.queryRoutingEvents(10000);
    const clusterStats = this.store.queryClusterStats();

    if (!events || events.length === 0) {
      return { clusters: [], reputation: clusterStats };
    }

    const byCluster = {};
    for (const e of events) {
      const cid = e.cluster_id || 0;
      if (!byCluster[cid]) byCluster[cid] = [];
      byCluster[cid].push(e);
    }

    const clusters = [];
    for (const [cid, entries] of Object.entries(byCluster)) {
      const latencies = entries
        .filter(e => e.actual_latency_ms)
        .map(e => e.actual_latency_ms);

      // Count models
      const modelCounts = {};
      for (const e of entries) {
        const m = e.actual_model || '';
        modelCounts[m] = (modelCounts[m] || 0) + 1;
      }
      // Sort by count descending, take top 3
      const topModels = Object.entries(modelCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3);

      let totalCost = 0;
      for (const e of entries) {
        totalCost += estimateCost(
          e.actual_model || '',
          e.input_tokens || 0,
          e.output_tokens || 0
        );
      }

      let avgHvr = 0;
      for (const e of entries) {
        avgHvr += (e.hvr_score != null ? e.hvr_score : 1);
      }
      avgHvr = Math.round((avgHvr / Math.max(entries.length, 1)) * 1000) / 1000;

      clusters.push({
        cluster_id: Number(cid),
        request_count: entries.length,
        avg_latency_ms: Math.round(
          (latencies.reduce((a, b) => a + b, 0) / Math.max(latencies.length, 1)) * 10
        ) / 10,
        total_cost_rmb: Math.round(totalCost * 10000) / 10000,
        top_models: topModels,
        avg_hvr: avgHvr,
      });
    }
    clusters.sort((a, b) => b.request_count - a.request_count);

    return {
      clusters: clusters.slice(0, 20),
      reputation: clusterStats,
    };
  }

  // ── Time-series routing data ───────────────────────────────────

  routingTimeseries(bucketMinutes, hours) {
    bucketMinutes = bucketMinutes || 5;
    hours = hours || 24;
    const raw = this.store.queryRoutingTimeseries(bucketMinutes, hours);

    const result = [];
    for (const r of raw) {
      result.push({
        time: r.bucket || '',
        requests: r.cnt || 0,
        avg_latency: Math.round((r.avg_latency || 0) * 10) / 10,
        error_count: r.error_count || 0,
        total_cost: Math.round((r.total_cost || 0) * 10000) / 10000,
        total_input_tokens: r.total_input || 0,
        total_output_tokens: r.total_output || 0,
      });
    }
    return { buckets: result };
  }
}

module.exports = { ProviderRouteTracker };
