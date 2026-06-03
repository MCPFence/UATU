'use strict';

/**
 * Tool call quality analysis: empty params, fossil loops, hallucinations.
 */

const fs = require('fs');

class ToolCallQualityAnalyzer {
  constructor(store) {
    this.store = store;
  }

  /**
   * Parse tool_use blocks from a request JSON and return structured records.
   */
  extractToolCalls(sessionId, reqData) {
    const msgs = (reqData || {}).messages || [];
    const seq = (reqData || {}).seq || 0;
    const calls = [];

    for (let msgIdx = 0; msgIdx < msgs.length; msgIdx++) {
      const m = msgs[msgIdx];
      const content = m.content;
      if (!Array.isArray(content)) continue;

      for (const b of content) {
        if (!b || typeof b !== 'object' || b.type !== 'tool_use') continue;

        const inp = b.input || {};
        const hasInput = Boolean(inp && typeof inp === 'object' && Object.keys(inp).length > 0);
        const toolName = b.name || '?';
        const paramKeys = hasInput ? Object.keys(inp).sort().join(',') : '';

        calls.push({
          session_id: sessionId,
          seq,
          msg_index: msgIdx,
          tool_name: toolName,
          tool_use_id: b.id || '',
          has_input: hasInput,
          input_params: inp,
          param_keys: paramKeys,
          is_hallucinated: !ToolCallQualityAnalyzer.KNOWN_TOOL_NAMES.has(toolName),
        });
      }
    }
    return calls;
  }

  /**
   * Detect fossil patterns: same empty tool call appearing across >= 3 seqs.
   */
  detectFossilLoops(sessionId, calls) {
    if (!calls || calls.length === 0) return [];

    // Build signatures from empty calls
    const sigMap = {};
    for (const c of calls) {
      if (c.has_input) continue;
      const sig = `${c.tool_name}|${c.param_keys}|${c.msg_index}`;
      if (!sigMap[sig]) sigMap[sig] = [];
      sigMap[sig].push(c);
    }

    const fossils = [];
    for (const [sig, entries] of Object.entries(sigMap)) {
      const seqSet = new Set(entries.map(e => e.seq));
      const seqs = [...seqSet].sort((a, b) => a - b);
      if (seqs.length < 3) continue;

      const parts = sig.split('|');
      const toolName = parts[0];
      const paramKeys = parts[1];
      const msgIndex = parts[2];

      fossils.push({
        tool_name: toolName,
        param_keys: paramKeys,
        msg_index: Number(msgIndex),
        occurrences: entries.length,
        unique_seqs: seqs,
        seq_count: seqs.length,
        signature: `${toolName}(${paramKeys})@msg[${msgIndex}]`,
      });
    }

    fossils.sort((a, b) => b.seq_count - a.seq_count);
    return fossils;
  }

  /**
   * Compute a 0-100 quality score based on empty rate and fossil count.
   */
  computeQualityScore(calls, fossils) {
    const total = calls.length;
    if (total === 0) {
      return [100.0, 'healthy'];
    }

    const emptyCount = calls.filter(c => !c.has_input).length;
    const emptyRate = emptyCount / total;
    const fossilPenalty = Math.min((fossils || []).length * 0.10, 0.50);
    const score = Math.round(100 * (1 - emptyRate) * (1 - fossilPenalty) * 10) / 10;

    let verdict;
    if (emptyRate > 0.7 || (fossils && fossils.length > 0)) {
      verdict = 'critical';
    } else if (emptyRate > 0.3) {
      verdict = 'warning';
    } else {
      verdict = 'healthy';
    }

    return [score, verdict];
  }

  /**
   * Full quality analysis for a session. Returns a complete report.
   */
  analyzeSession(sessionId) {
    sessionId = this.store.resolveCcProxySessionId(sessionId);
    let allCalls = this.store.queryToolCallsBySession(sessionId);

    // Normalize DB records
    allCalls = (allCalls || []).map(c => ({
      session_id: c.session_id,
      seq: c.seq,
      msg_index: c.msg_index,
      tool_name: c.tool_name,
      tool_use_id: c.tool_use_id,
      has_input: Boolean(c.has_input),
      input_params: (typeof c.input_params === 'object' && c.input_params) ? c.input_params : {},
      param_keys: c.param_keys || '',
      is_hallucinated: Boolean(c.is_hallucinated),
      is_fossil: Boolean(c.is_fossil),
      fossil_hash: c.fossil_hash || '',
    }));

    // If DB has no tool calls, try extracting from raw files
    if (allCalls.length === 0) {
      const reqs = this.store.queryCcProxyRequests(sessionId);
      if (!reqs || reqs.length === 0) return null;

      for (const req of reqs) {
        const rawPath = req.raw_file_path || '';
        if (rawPath) {
          try {
            const rawContent = fs.readFileSync(rawPath, 'utf8');
            const rawReq = JSON.parse(rawContent);
            const calls = this.extractToolCalls(sessionId, rawReq);
            allCalls.push(...calls);
          } catch (_e) { /* ignore FileNotFoundError or JSON parse error */ }
        }
      }
    }

    if (allCalls.length === 0) return null;

    // Sort by seq then msg_index
    allCalls.sort((a, b) => {
      if (a.seq !== b.seq) return a.seq - b.seq;
      return a.msg_index - b.msg_index;
    });

    // Persist to store
    this.store.addToolCallBatch(allCalls);

    // Detect fossils and mark them
    const fossils = this.detectFossilLoops(sessionId, allCalls);
    const fossilSigs = new Set(fossils.map(f => f.signature));

    // Mark fossil calls in data
    for (const c of allCalls) {
      if (c.has_input) continue;
      const sig = `${c.tool_name}(${c.param_keys})@msg[${c.msg_index}]`;
      c.is_fossil = fossilSigs.has(sig);
      c.fossil_hash = c.is_fossil ? sig : '';
    }

    // Re-persist with fossil markings
    this.store.addToolCallBatch(allCalls);

    const emptyCount = allCalls.filter(c => !c.has_input).length;
    const hallucinationCount = allCalls.filter(c => c.is_hallucinated).length;
    const fossilCount = fossils.length;
    const total = allCalls.length;
    const [score, verdict] = this.computeQualityScore(allCalls, fossils);

    return {
      session_id: sessionId,
      total_calls: total,
      empty_count: emptyCount,
      empty_rate: Math.round((emptyCount / Math.max(total, 1)) * 1000) / 1000,
      fossil_count: fossilCount,
      fossil_patterns: fossils.map(f => ({
        signature: f.signature,
        tool_name: f.tool_name,
        seq_count: f.seq_count,
        unique_seqs: f.unique_seqs,
      })),
      hallucination_count: hallucinationCount,
      quality_score: score,
      verdict,
      top_empty_tools: this._topEmpty(allCalls),
    };
  }

  _topEmpty(calls, limit) {
    limit = limit || 5;
    const empty = calls.filter(c => !c.has_input);
    const counter = {};
    for (const c of empty) {
      counter[c.tool_name] = (counter[c.tool_name] || 0) + 1;
    }
    return Object.entries(counter)
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([tool_name, count]) => ({ tool_name, count }));
  }
}

// Tools expected in Claude Code (from the tool definitions observed)
ToolCallQualityAnalyzer.KNOWN_TOOL_NAMES = new Set([
  'Agent', 'AskUserQuestion', 'Bash', 'CronCreate', 'CronDelete',
  'CronList', 'Edit', 'EnterPlanMode', 'EnterWorktree', 'ExitPlanMode',
  'ExitWorktree', 'Glob', 'Grep', 'Monitor', 'NotebookEdit',
  'PushNotification', 'Read', 'Skill', 'WebFetch', 'WebSearch',
  'Write', 'TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate',
  'TaskOutput', 'TaskStop', 'ScheduleWakeup', 'RemoteTrigger',
]);

module.exports = { ToolCallQualityAnalyzer };
