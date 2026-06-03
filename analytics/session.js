'use strict';

/**
 * Per-session analysis: builds lineage, propagates taint, scores risk.
 */

const { DataLineageTracker, TaintEngine, RiskScorer } = require('./engines');

function _detectBehaviorPattern(toolSeq) {
  if (!toolSeq || toolSeq.length === 0) return 'empty';

  const readTools = new Set(['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch']);
  const writeTools = new Set(['Write', 'Edit', 'NotebookEdit']);

  const readCount = toolSeq.filter(t => readTools.has(t)).length;
  const writeCount = toolSeq.filter(t => writeTools.has(t)).length;
  const bashCount = toolSeq.filter(t => t === 'Bash').length;
  const agentCount = toolSeq.filter(t => t === 'Agent').length;

  let firstWrite = toolSeq.length;
  for (let i = 0; i < toolSeq.length; i++) {
    if (writeTools.has(toolSeq[i])) {
      firstWrite = i;
      break;
    }
  }
  const readsBeforeWrite = toolSeq.slice(0, firstWrite).filter(t => readTools.has(t)).length;

  if (agentCount > 0) return 'delegating';
  if (readCount > 0 && writeCount > 0 && readsBeforeWrite >= 2) return 'explore-then-edit';
  if (writeCount > 0 && readCount === 0) return 'direct-write';
  if (readCount > 0 && writeCount === 0 && bashCount === 0) return 'read-only';
  if (bashCount > toolSeq.length * 0.5) return 'shell-heavy';
  if (readCount > 0 && writeCount > 0) return 'read-write';
  return 'mixed';
}

function runSessionAnalysis(sessionId, logsSorted, turns, anomalyEngine) {
  const lineage = new DataLineageTracker();
  const taint = new TaintEngine(lineage);
  const risk = new RiskScorer(taint);

  const activeDataIds = [];
  const toolCalls = [];
  const costByModel = {};
  let totalInTokens = 0;
  let totalOutTokens = 0;
  let totalCacheRead = 0;
  let totalCacheCreate = 0;
  let totalCost = 0.0;

  for (const l of logsSorted) {
    const attrs = l.attributes || {};
    const eventName = attrs['event.name'] || '';
    const ts = attrs['event.timestamp'] || l.time || '';

    if (eventName.includes('user_prompt')) {
      const did = lineage.registerData('user_input', 'untrusted', 'user_prompt', '', ts);
      activeDataIds.push(did);

    } else if (eventName === 'api_request') {
      const model = attrs.model || 'unknown';
      const cost = attrs.cost_rmb || attrs.cost_usd || 0;
      const inTok = attrs.input_tokens || 0;
      const outTok = attrs.output_tokens || 0;
      const cacheR = attrs.cache_read_tokens || 0;
      const cacheC = attrs.cache_creation_tokens || 0;

      if (cost) {
        costByModel[model] = (costByModel[model] || 0) + Number(cost);
        totalCost += Number(cost);
      }
      totalInTokens += Number(inTok || 0);
      totalOutTokens += Number(outTok || 0);
      totalCacheRead += Number(cacheR || 0);
      totalCacheCreate += Number(cacheC || 0);

      const outDid = lineage.registerData('llm_output', 'mixed', `llm_${model}`, '', ts);
      if (activeDataIds.length > 0) {
        lineage.recordTransform(`llm_${model}`, [...activeDataIds], [outDid]);
        taint.propagate([...activeDataIds], [outDid]);
      }
      activeDataIds.push(outDid);

    } else if (eventName.includes('tool_result')) {
      const toolName = attrs.tool_name || 'unknown';
      const duration = attrs.duration_ms || 0;
      const success = attrs.success !== undefined ? attrs.success : true;

      const [sourceType, taintLevel] = taint.getToolSource(toolName, attrs);
      const outDid = lineage.registerData(sourceType, taintLevel, `tool_${toolName}`, '', ts);

      const recentIds = activeDataIds.slice(-2);
      lineage.recordTransform(`tool_${toolName}`, [...recentIds], [outDid]);
      taint.propagate(activeDataIds.length > 0 ? recentIds : [], [outDid]);

      const riskResult = risk.scoreAction(sessionId, toolName, recentIds, attrs);

      activeDataIds.push(outDid);
      toolCalls.push({
        tool: toolName,
        duration_ms: duration,
        success,
        risk: riskResult,
        taint: taintLevel,
        is_sink: TaintEngine.SINK_TOOLS.has(toolName),
      });
    }
  }

  // tool_counter
  const toolCounter = {};
  for (const t of toolCalls) {
    toolCounter[t.tool] = (toolCounter[t.tool] || 0) + 1;
  }

  // avg durations
  const toolDurations = {};
  for (const t of toolCalls) {
    if (!toolDurations[t.tool]) toolDurations[t.tool] = [];
    try {
      toolDurations[t.tool].push(Number(t.duration_ms || 0) || 0);
    } catch (_e) {
      toolDurations[t.tool].push(0);
    }
  }
  const avgDurations = {};
  for (const [k, v] of Object.entries(toolDurations)) {
    avgDurations[k] = v.length > 0
      ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10
      : 0;
  }

  const scoreEntry = risk.sessionScores[sessionId] || { score: 0, history: [] };
  const allFlags = new Set();
  for (const h of scoreEntry.history) {
    for (const f of (h.flags || [])) {
      allFlags.add(f);
    }
  }

  const totalTokens = totalInTokens + totalOutTokens;
  const tokenEff = Math.round((totalOutTokens / Math.max(totalInTokens, 1)) * 1000) / 1000;
  const cacheHit = Math.round((totalCacheRead / Math.max(totalInTokens + totalCacheCreate, 1)) * 1000) / 1000;

  const toolSeq = toolCalls.map(t => t.tool);
  const pattern = _detectBehaviorPattern(toolSeq);

  const numTurns = turns ? turns.length : 1;
  const toolsPerTurn = Math.round((toolCalls.length / Math.max(numTurns, 1)) * 10) / 10;
  const uniqueTools = new Set(toolSeq).size;
  const diversity = Math.round((uniqueTools / Math.max(toolSeq.length, 1)) * 100) / 100;

  // cost by model rounded
  const costByModelRounded = {};
  for (const [k, v] of Object.entries(costByModel)) {
    costByModelRounded[k] = Math.round(v * 1000000) / 1000000;
  }

  const result = {
    risk: {
      cumulative_score: scoreEntry.score,
      level: risk.getRiskLevel(scoreEntry.score),
      history: scoreEntry.history,
      flags: [...allFlags],
    },
    data_lineage: lineage.toDict(),
    tool_stats: {
      total_calls: toolCalls.length,
      by_tool: toolCounter,
      avg_duration_ms: avgDurations,
      sink_calls: toolCalls.filter(t => t.is_sink).length,
      dangerous_calls: toolCalls.filter(t =>
        (t.risk.flags || []).includes('dangerous_bash')
      ).length,
      details: toolCalls,
    },
    cost_analysis: {
      total_rmb: Math.round(totalCost * 1000000) / 1000000,
      by_model: costByModelRounded,
      total_tokens: totalTokens,
      input_tokens: totalInTokens,
      output_tokens: totalOutTokens,
      cache_read_tokens: totalCacheRead,
      cache_creation_tokens: totalCacheCreate,
      token_efficiency: tokenEff,
      cache_hit_rate: cacheHit,
    },
    behavioral_summary: {
      turns: numTurns,
      total_tool_calls: toolCalls.length,
      avg_tools_per_turn: toolsPerTurn,
      unique_tools: uniqueTools,
      tool_diversity: diversity,
      tool_sequence: toolSeq,
      pattern,
    },
    sink_alerts: taint.sinkAlerts,
  };

  if (anomalyEngine) {
    try {
      const anomalyResult = anomalyEngine.analyzeSession(sessionId, result);
      result.anomaly_detection = anomalyResult;
    } catch (e) {
      console.error(e);
      result.anomaly_detection = { error: String(e) };
    }
  }

  return result;
}

module.exports = { runSessionAnalysis, _detectBehaviorPattern };
