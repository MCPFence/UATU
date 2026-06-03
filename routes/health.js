'use strict';

const router = require('express').Router();
const { store } = require('../lib/store');
const { estimateCost } = require('../analytics/cost-aggregator');

router.get('/api/health-dashboard', (req, res) => {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000;

  const toolStats = store.queryToolCallsSummaryAll();
  let totalCalls = 0, totalEmpty = 0, totalFossils = 0, totalHallucinations = 0;
  let criticalSessions = 0, warningSessions = 0;

  for (const s of toolStats) {
    totalCalls += s.total;
    totalEmpty += s.empty;
    totalFossils += s.fossils;
    totalHallucinations += s.hallucinations;
    const emptyRate = s.empty / Math.max(s.total, 1);
    if (emptyRate > 0.7 || s.fossils > 0) criticalSessions++;
    else if (emptyRate > 0.3) warningSessions++;
  }

  const healthySessions = Math.max(toolStats.length - criticalSessions - warningSessions, 0);

  const quality = {
    total_calls: totalCalls,
    empty_rate: Math.round((totalEmpty / Math.max(totalCalls, 1)) * 1000) / 1000,
    fossil_count: totalFossils,
    hallucination_count: totalHallucinations,
    critical_sessions: criticalSessions,
    warning_sessions: warningSessions,
    healthy_sessions: healthySessions,
  };

  const providerRows = store.queryProviderStats(todayStart);
  let totalFallbacks = 0;
  let totalProviderRequests = 0;
  let costInputTokens = 0, costOutputTokens = 0, totalCostRmb = 0;
  let totalLatencyMs = 0;
  const providerSet = new Set();

  for (const p of providerRows) {
    totalFallbacks += p.fallbacks || 0;
    totalProviderRequests += p.cnt || 0;
    p.estimated_cost_rmb = estimateCost(
      p.actual_model || '', p.total_input || 0, p.total_output || 0,
      p.total_cache_read || 0, p.total_cache_create || 0,
    );
    costInputTokens += (p.total_input || 0) + (p.total_cache_read || 0) + (p.total_cache_create || 0);
    costOutputTokens += p.total_output || 0;
    totalCostRmb += p.estimated_cost_rmb;
    totalLatencyMs += p.total_elapsed_ms || 0;
    if (p.actual_provider) providerSet.add(p.actual_provider);
  }

  totalCostRmb = Math.round(totalCostRmb * 100) / 100;
  const reqCount = totalProviderRequests;
  const avgLatency = Math.round((totalLatencyMs / Math.max(reqCount, 1)) * 10) / 10;

  const providers = {
    total_fallbacks: totalFallbacks,
    fallback_rate: Math.round((totalFallbacks / Math.max(totalProviderRequests, 1)) * 1000) / 1000,
    breakdown: providerRows,
  };

  const cost = {
    total_input_tokens: costInputTokens,
    total_output_tokens: costOutputTokens,
    estimated_rmb: totalCostRmb,
    avg_latency_ms: avgLatency,
    output_tps: totalLatencyMs > 0 ? Math.round(costOutputTokens / (totalLatencyMs / 1000) * 10) / 10 : 0,
  };

  const routing_summary = {
    total_requests: reqCount,
    success_rate: reqCount > 0 ? 1.0 : 0,
    avg_latency_ms: avgLatency,
    provider_count: providerSet.size,
    total_cost_rmb: totalCostRmb,
  };

  const recent_anomalies = [];
  if (totalFossils > 0) {
    recent_anomalies.push({
      type: 'fossil_loop',
      detail: `${totalFossils} fossil tool calls detected across sessions`,
    });
  }

  const sessionsTotal = toolStats.length;

  res.json({
    quality,
    providers,
    cost,
    routing_summary,
    recent_anomalies,
    sessions_total: sessionsTotal,
  });
});

router.get('/api/alert-rules', (req, res) => {
  const { DANGEROUS_PATTERNS, EXFIL_PATTERNS } = require('../lib/alert-rules');
  res.json({ dangerous: DANGEROUS_PATTERNS, exfil: EXFIL_PATTERNS });
});

module.exports = router;
