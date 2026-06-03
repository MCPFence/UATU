'use strict';

/**
 * Defensive analytics engines: data lineage, taint propagation, risk scoring.
 */

const { v4: uuidv4 } = require('uuid');

// ─── DataLineageTracker ─────────────────────────────────────────────────────
// 数据血缘追踪 DAG — 追踪 Agent session 中每条数据的来源和流向

class DataLineageTracker {
  constructor() {
    this.dataRegistry = {};
    this.transforms = [];
    this.forwardEdges = {};   // data_id -> [data_id]
    this.backwardEdges = {};  // data_id -> [data_id]
  }

  registerData(source, taintLevel, actionId, agentId = '', timestamp = '') {
    const dataId = `dat_${uuidv4().replace(/-/g, '').slice(0, 8)}`;
    this.dataRegistry[dataId] = {
      data_id: dataId,
      source,
      taint_level: taintLevel,
      taint_source: source,
      inherited_from: [],
      created_by_action: actionId,
      created_by_agent: agentId,
      created_at: timestamp || new Date().toISOString(),
    };
    return dataId;
  }

  recordTransform(actionId, inputIds, outputIds) {
    this.transforms.push({
      action_id: actionId,
      inputs: inputIds,
      outputs: outputIds,
      timestamp: new Date().toISOString(),
    });
    for (const inId of inputIds) {
      for (const outId of outputIds) {
        if (!this.forwardEdges[inId]) this.forwardEdges[inId] = [];
        this.forwardEdges[inId].push(outId);
        if (!this.backwardEdges[outId]) this.backwardEdges[outId] = [];
        this.backwardEdges[outId].push(inId);
      }
    }
  }

  updateTaint(dataId, taintLevel, inheritedFrom, taintSource) {
    const rec = this.dataRegistry[dataId];
    if (rec) {
      rec.taint_level = taintLevel;
      rec.inherited_from = inheritedFrom;
      rec.taint_source = taintSource;
    }
  }

  getTaintLevel(dataId) {
    const rec = this.dataRegistry[dataId];
    return rec ? rec.taint_level : 'untrusted';
  }

  _bfs(startId, edges) {
    const visited = new Set();
    const queue = [startId];
    const result = [];
    while (queue.length > 0) {
      const cur = queue.shift();
      for (const nb of (edges[cur] || [])) {
        if (!visited.has(nb)) {
          visited.add(nb);
          result.push(nb);
          queue.push(nb);
        }
      }
    }
    return result;
  }

  getForwardLineage(dataId) {
    return this._bfs(dataId, this.forwardEdges);
  }

  getBackwardLineage(dataId) {
    return this._bfs(dataId, this.backwardEdges);
  }

  toDict() {
    const nodes = Object.values(this.dataRegistry).map(d => ({
      id: d.data_id,
      source: d.source,
      taint: d.taint_level,
      action: d.created_by_action,
    }));

    const edges = [];
    for (const [src, dsts] of Object.entries(this.forwardEdges)) {
      for (const dst of dsts) {
        edges.push({ source: src, target: dst });
      }
    }

    // taint_summary: count by taint_level
    const taintCounts = {};
    for (const d of Object.values(this.dataRegistry)) {
      taintCounts[d.taint_level] = (taintCounts[d.taint_level] || 0) + 1;
    }

    return { nodes, edges, taint_summary: taintCounts };
  }
}

// ─── TaintEngine ────────────────────────────────────────────────────────────
// 污点传播 + Sink 检测

class TaintEngine {
  constructor(lineage) {
    this.lineage = lineage;
    this.sinkAlerts = [];
  }

  getToolSource(toolName, attrs) {
    const base = TaintEngine.TOOL_SOURCE_MAP[toolName] || ['unknown', 'mixed'];
    if (toolName === 'Bash' && attrs) {
      const cmd = String(attrs.command || attrs.input || '');
      if (TaintEngine.SINK_BASH_PATTERNS.test(cmd)) {
        return ['shell_network', 'untrusted'];
      }
    }
    return base;
  }

  propagate(inputIds, outputIds) {
    if (!inputIds || inputIds.length === 0) {
      return { output_taint: 'trusted', inherited_from: [], taint_source: 'none' };
    }

    let maxSev = 0;
    const sources = new Set();
    for (const did of inputIds) {
      const rec = this.lineage.dataRegistry[did];
      const level = rec ? rec.taint_level : 'untrusted';
      const sev = TaintEngine.TAINT_SEVERITY[level] !== undefined
        ? TaintEngine.TAINT_SEVERITY[level] : 2;
      if (sev > maxSev) maxSev = sev;
      sources.add(rec ? rec.taint_source : 'unknown');
    }

    let outTaint;
    if (maxSev >= 2) {
      const hasTrusted = inputIds.some(d => {
        const lvl = this.lineage.getTaintLevel(d);
        return (TaintEngine.TAINT_SEVERITY[lvl] || 0) === 0;
      });
      outTaint = hasTrusted ? 'mixed' : 'untrusted';
    } else if (maxSev >= 1) {
      outTaint = 'mixed';
    } else {
      outTaint = 'trusted';
    }

    const joinedSources = [...sources].join('+');
    for (const oid of outputIds) {
      this.lineage.updateTaint(oid, outTaint, [...inputIds], joinedSources);
    }

    return {
      output_taint: outTaint,
      inherited_from: [...inputIds],
      taint_source: joinedSources,
    };
  }

  checkSink(toolName, inputIds, attrs) {
    let isSink = TaintEngine.SINK_TOOLS.has(toolName);
    if (toolName === 'Bash' && attrs) {
      const cmd = String(attrs.command || attrs.input || '');
      if (TaintEngine.SINK_BASH_PATTERNS.test(cmd)) {
        isSink = true;
      }
    }
    if (!isSink) {
      return { is_sink: false, alert: null };
    }

    const tainted = [];
    for (const did of inputIds) {
      const level = this.lineage.getTaintLevel(did);
      if (level !== 'trusted') {
        tainted.push({ data_id: did, taint_level: level });
      }
    }
    if (tainted.length === 0) {
      return { is_sink: true, alert: null };
    }

    const alert = {
      type: 'tainted_data_at_sink',
      tool: toolName,
      tainted_inputs: tainted,
      timestamp: new Date().toISOString(),
    };
    this.sinkAlerts.push(alert);
    return { is_sink: true, alert };
  }

  assessSeverity(inputIds) {
    if (!inputIds || inputIds.length === 0) return 0.0;
    let maxSev = 0;
    for (const d of inputIds) {
      const lvl = this.lineage.getTaintLevel(d);
      const sev = TaintEngine.TAINT_SEVERITY[lvl] !== undefined
        ? TaintEngine.TAINT_SEVERITY[lvl] : 0;
      if (sev > maxSev) maxSev = sev;
    }
    return Math.min(maxSev / 2.0, 1.0);
  }
}

TaintEngine.TAINT_SEVERITY = { trusted: 0, mixed: 1, untrusted: 2 };

TaintEngine.TOOL_SOURCE_MAP = {
  Read: ['file_read', 'trusted'],
  Glob: ['file_search', 'trusted'],
  Grep: ['content_search', 'trusted'],
  Edit: ['file_write', 'trusted'],
  Write: ['file_write', 'trusted'],
  NotebookEdit: ['file_write', 'trusted'],
  Bash: ['shell_exec', 'mixed'],
  WebFetch: ['external_api', 'untrusted'],
  WebSearch: ['external_api', 'untrusted'],
  Agent: ['sub_agent', 'mixed'],
};

TaintEngine.SINK_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit']);

TaintEngine.SINK_BASH_PATTERNS = new RegExp(
  'curl|wget|git\\s+push|ssh|scp|nc\\s|netcat|docker\\s+push|npm\\s+publish|' +
  'aws\\s+s3\\s+cp|gcloud|az\\s+storage|gh\\s+pr\\s+create|gh\\s+issue', 'i'
);

TaintEngine.DANGEROUS_BASH_PATTERNS = new RegExp(
  'rm\\s+-rf|sudo|chmod\\s+777|kill\\s+-9|mkfs|dd\\s+if=|>\\s*/dev/|' +
  'shutdown|reboot|format|fdisk', 'i'
);

// ─── RiskScorer ─────────────────────────────────────────────────────────────
// 六维累积风险评分 (含意图对齐)

class RiskScorer {
  constructor(taintEngine) {
    this.taint = taintEngine;
    this.sessionScores = {};
    this.agentBaselines = {};
    this.lastTool = {};
  }

  scoreAction(sessionId, toolName, inputIds, attrs, intentAlignment) {
    const flags = [];

    // d1 — taint severity
    const d1 = this.taint.assessSeverity(inputIds);
    if (d1 > 0.5) flags.push('high_taint_severity');

    // d2 — privilege escalation
    let d2 = 0.0;
    if (RiskScorer.PRIVILEGE_TOOLS.has(toolName)) {
      d2 = 0.5;
      if (toolName === 'Bash' && attrs) {
        const cmd = String(attrs.command || attrs.input || '');
        if (TaintEngine.DANGEROUS_BASH_PATTERNS.test(cmd)) {
          d2 = 0.9;
          flags.push('dangerous_bash');
        }
      }
      if (toolName === 'Agent') {
        d2 = 0.6;
        flags.push('privilege_escalation');
      }
    }

    // d3 — data sensitivity
    let d3 = 0.0;
    const combined = JSON.stringify(attrs || {});
    if (RiskScorer.SENSITIVE_PATTERNS.test(combined)) {
      d3 = 0.7;
      flags.push('sensitive_data_access');
    }

    // d4 — boundary crossing
    let d4 = 0.0;
    const prev = this.lastTool[sessionId] || '';
    if (prev && toolName) {
      const prevDom = this._classifyDomain(prev);
      const currDom = this._classifyDomain(toolName);
      if (prevDom && currDom && prevDom !== currDom) {
        d4 = (prevDom === 'internal' && (currDom === 'external' || currDom === 'execution'))
          ? 0.7 : 0.4;
        flags.push('boundary_crossing');
      }
    }
    this.lastTool[sessionId] = toolName;

    // d5 — behavioral drift
    let d5 = 0.0;
    const baseline = this.agentBaselines[sessionId] || [];
    if (baseline.length >= 5 && toolName) {
      const freq = baseline.filter(t => t === toolName).length;
      const ratio = freq / baseline.length;
      if (ratio === 0) {
        d5 = 0.6;
        flags.push('behavioral_drift');
      } else if (ratio < 0.05) {
        d5 = 0.3;
      }
    }
    if (toolName) {
      if (!this.agentBaselines[sessionId]) this.agentBaselines[sessionId] = [];
      this.agentBaselines[sessionId].push(toolName);
    }

    // sink check
    const sink = this.taint.checkSink(toolName, inputIds, attrs);
    if (sink.alert) {
      flags.push('tainted_data_at_sink');
    }

    // d6 — intent misalignment
    let d6 = 0.0;
    if (intentAlignment !== null && intentAlignment !== undefined && intentAlignment < 0.5) {
      d6 = 1.0 - intentAlignment;
      flags.push('intent_misalignment');
    }

    const w = RiskScorer.WEIGHTS;
    let delta = (
      d1 * w.taint_severity +
      d2 * w.privilege_escalation +
      d3 * w.data_sensitivity +
      d4 * w.boundary_crossing +
      d5 * w.behavioral_drift +
      d6 * w.intent_misalignment
    );
    delta = Math.round(delta * 10000) / 10000;

    if (!this.sessionScores[sessionId]) {
      this.sessionScores[sessionId] = { score: 0.0, history: [] };
    }
    const entry = this.sessionScores[sessionId];
    entry.score = Math.min(entry.score + delta, 1.0);

    const uniqueFlags = [...new Set(flags)];
    entry.history.push({
      tool: toolName,
      delta,
      cumulative: Math.round(entry.score * 10000) / 10000,
      flags: uniqueFlags,
      dimensions: {
        taint: Math.round(d1 * 1000) / 1000,
        privilege: Math.round(d2 * 1000) / 1000,
        sensitivity: Math.round(d3 * 1000) / 1000,
        boundary: Math.round(d4 * 1000) / 1000,
        drift: Math.round(d5 * 1000) / 1000,
        intent: Math.round(d6 * 1000) / 1000,
      },
    });

    return {
      cumulative: Math.round(entry.score * 10000) / 10000,
      delta,
      flags: uniqueFlags,
    };
  }

  _classifyDomain(toolName) {
    for (const [domain, pattern] of Object.entries(RiskScorer.DOMAIN_MAP)) {
      if (pattern.test(toolName)) return domain;
    }
    return null;
  }

  getRiskLevel(score) {
    if (score >= 0.7) return 'critical';
    if (score >= 0.5) return 'high';
    if (score >= 0.3) return 'medium';
    return 'low';
  }
}

RiskScorer.WEIGHTS = {
  taint_severity: 0.25,
  privilege_escalation: 0.22,
  data_sensitivity: 0.18,
  boundary_crossing: 0.13,
  behavioral_drift: 0.10,
  intent_misalignment: 0.12,
};

RiskScorer.SENSITIVE_PATTERNS = new RegExp(
  '\\.env|credentials|password|secret|private_key|ssh_key|api_key|token|' +
  '\\.pem|\\.key|id_rsa|kubeconfig|\\.netrc|shadow|passwd', 'i'
);

RiskScorer.PRIVILEGE_TOOLS = new Set(['Agent', 'Bash']);

RiskScorer.DOMAIN_MAP = {
  internal: /^(Read|Glob|Grep|WebSearch|WebFetch|TaskList|TaskGet)$/,
  external: /^(WebFetch|WebSearch)$/,
  execution: /^(Bash|Agent)$/,
  storage: /^(Write|Edit|NotebookEdit)$/,
};

module.exports = { DataLineageTracker, TaintEngine, RiskScorer };
