'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const ccProxyClient = require('./cc-proxy-client');

const DEFAULT_LOG_DIR = path.join(os.homedir(), '.cc-proxy', 'logs');

class LogFileIngester {
  constructor(logDir = DEFAULT_LOG_DIR) {
    this.logDir = logDir;
    this.completePairs = new Set();
    this.pendingResp = new Map();
    this.sessionDirs = {};
    this._timer = null;
  }

  scan() {
    if (!fs.existsSync(this.logDir)) return [];
    const results = [];
    const now = Date.now();
    const GIVE_UP_MS = 30 * 60 * 1000;
    for (const dateEntry of fs.readdirSync(this.logDir).sort()) {
      const dateDir = path.join(this.logDir, dateEntry);
      if (!fs.statSync(dateDir).isDirectory()) continue;
      for (const sesEntry of fs.readdirSync(dateDir).sort()) {
        const sessionDir = path.join(dateDir, sesEntry);
        if (!fs.statSync(sessionDir).isDirectory()) continue;
        const fullSid = this._resolveFullSessionId(sessionDir, sesEntry);
        const files = fs.readdirSync(sessionDir).filter(f => f.endsWith('.req.json')).sort();
        for (const reqName of files) {
          const reqFile = path.join(sessionDir, reqName);
          if (this.completePairs.has(reqFile)) continue;
          let reqData;
          try { reqData = JSON.parse(fs.readFileSync(reqFile, 'utf8')); } catch { continue; }
          const respFile = reqFile.replace('.req.json', '.resp.json');
          let respData = null;
          try { if (fs.existsSync(respFile)) respData = JSON.parse(fs.readFileSync(respFile, 'utf8')); } catch {}
          const parsed = this._parseRequest(fullSid, dateEntry, reqData, respData, reqFile);
          if (!parsed) continue;
          results.push(parsed);
          if (respData) {
            this.completePairs.add(reqFile);
            this.pendingResp.delete(reqFile);
          } else {
            if (!this.pendingResp.has(reqFile)) this.pendingResp.set(reqFile, now);
            if (now - this.pendingResp.get(reqFile) > GIVE_UP_MS) {
              this.completePairs.add(reqFile);
              this.pendingResp.delete(reqFile);
            }
          }
        }
      }
    }
    return results;
  }

  _resolveFullSessionId(sessionDir, fallback) {
    if (this.sessionDirs[sessionDir]) return this.sessionDirs[sessionDir];
    const files = fs.readdirSync(sessionDir).filter(f => f.endsWith('.req.json')).sort();
    if (files.length) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(sessionDir, files[0]), 'utf8'));
        const sid = data.session_id || '';
        if (sid && sid.length > fallback.length) {
          this.sessionDirs[sessionDir] = sid;
          return sid;
        }
      } catch {}
    }
    this.sessionDirs[sessionDir] = fallback;
    return fallback;
  }

  _parseRequest(sessionId, dateStr, reqData, respData, filePath) {
    const seq = reqData.seq || 0;
    const requestedModel = reqData.model || '';
    let sysPrompt = reqData.system || '';
    if (Array.isArray(sysPrompt)) sysPrompt = JSON.stringify(sysPrompt);
    const tools = Array.isArray(reqData.tools) ? reqData.tools : [];
    const toolNames = tools.map(t => (typeof t === 'object' ? t.name || '?' : '?'));
    const toolCallRecords = [];
    const msgs = reqData.messages || [];
    for (let mi = 0; mi < msgs.length; mi++) {
      const content = msgs[mi].content;
      if (!Array.isArray(content)) continue;
      for (const b of content) {
        if (!b || b.type !== 'tool_use') continue;
        const inp = b.input || {};
        const hasInput = Object.keys(inp).length > 0;
        toolCallRecords.push({
          tool_name: b.name || '?', tool_use_id: b.id || '',
          has_input: hasInput, input_params: inp,
          param_keys: hasInput ? Object.keys(inp).sort().join(',') : '',
          msg_index: mi,
        });
      }
    }
    let actualModel = '', actualProvider = '', inputTokens = 0, outputTokens = 0, elapsedMs = 0;
    let cacheReadTokens = 0, cacheCreationTokens = 0;
    if (respData) {
      actualModel = respData.model || '';
      actualProvider = respData.provider || '';
      // usage can be at top-level or nested under response
      const usage = respData.usage || (respData.response && typeof respData.response === 'object' ? respData.response.usage : null) || {};
      inputTokens = usage.input_tokens || 0;
      outputTokens = usage.output_tokens || 0;
      cacheReadTokens = usage.cache_read_input_tokens || 0;
      cacheCreationTokens = usage.cache_creation_input_tokens || 0;
      elapsedMs = respData.elapsed_ms || 0;
    }
    const fallback = !!(actualModel && requestedModel && actualModel !== requestedModel);
    return {
      session_id: sessionId, session_dir: dateStr, seq, requested_model: requestedModel,
      system_prompt: sysPrompt, tool_definitions: toolNames, message_count: msgs.length,
      raw_file_path: filePath, tool_calls: toolCallRecords,
      response: {
        request_id: respData ? (respData.request_id || '') : '',
        actual_model: actualModel, actual_provider: actualProvider,
        fallback_occurred: fallback, input_tokens: inputTokens,
        output_tokens: outputTokens, elapsed_ms: elapsedMs,
        cache_read_tokens: cacheReadTokens,
        cache_creation_tokens: cacheCreationTokens,
        timestamp: respData ? (respData.timestamp || '') : '',
      },
    };
  }

  warmup(store) {
    if (!fs.existsSync(this.logDir)) return;
    const now = Date.now();
    const GIVE_UP_MS = 30 * 60 * 1000;
    const ingestedKeys = store ? store.queryIngestedRespKeys() : new Set();
    for (const dateEntry of fs.readdirSync(this.logDir).sort()) {
      const dateDir = path.join(this.logDir, dateEntry);
      if (!fs.statSync(dateDir).isDirectory()) continue;
      for (const sesEntry of fs.readdirSync(dateDir).sort()) {
        const sessionDir = path.join(dateDir, sesEntry);
        if (!fs.statSync(sessionDir).isDirectory()) continue;
        const fullSid = this._resolveFullSessionId(sessionDir, sesEntry);
        const files = fs.readdirSync(sessionDir).filter(f => f.endsWith('.req.json'));
        for (const reqName of files) {
          const reqFile = path.join(sessionDir, reqName);
          const respFile = reqFile.replace('.req.json', '.resp.json');
          const seqMatch = reqName.match(/^(\d+)/);
          const seq = seqMatch ? parseInt(seqMatch[1], 10) : 0;
          const key = fullSid + ':' + seq;
          if (fs.existsSync(respFile) && ingestedKeys.has(key)) {
            this.completePairs.add(reqFile);
          } else if (!fs.existsSync(respFile)) {
            const age = now - fs.statSync(reqFile).mtimeMs;
            if (age > GIVE_UP_MS) {
              this.completePairs.add(reqFile);
            }
          }
        }
      }
    }
  }

  startBackgroundLoop(store, alertManager) {
    this._store = store;
    const FAST_INTERVAL = 5000;
    const NORMAL_INTERVAL = 60000;
    const FAST_COUNT = 6;
    let tick = 0;
    const poll = async () => {
      try {
        const results = this.scan();
        for (const parsed of results) {
          store.addCcProxyRequest(parsed);
          const resp = parsed.response;
          if (resp && resp.actual_model) store.addCcProxyResponse({ session_id: parsed.session_id, seq: parsed.seq, raw_file_path: parsed.raw_file_path, ...resp });
          if (parsed.tool_calls && parsed.tool_calls.length) {
            store.addToolCallBatch(parsed.tool_calls.map(tc => ({ ...tc, session_id: parsed.session_id, seq: parsed.seq })));
            if (alertManager) {
              for (const tc of parsed.tool_calls) {
                if (tc.tool_name === 'Bash' || tc.tool_name === 'bash') {
                  const cmd = tc.input_params && (tc.input_params.command || tc.input_params.input || '');
                  if (cmd) {
                    alertManager.checkLogEvent({
                      attributes: { 'event.name': 'tool_result', tool_name: 'Bash', command: cmd },
                      resource: { 'session.id': parsed.session_id },
                    });
                  }
                }
              }
            }
          }
        }
        const watermark = store.getRoutingWatermark();
        const logResp = await ccProxyClient.routingLog(500, 0);
        let routingRows = [];
        if (logResp.entries) {
          const entries = logResp.entries;
          const maxProxyId = entries.reduce((m, e) => Math.max(m, e.id || 0), 0);
          if (maxProxyId > 0 && maxProxyId < watermark) {
            console.log(`[Ingestion] 检测到 cc-proxy 已重启（路由计数器重置: 当前最大ID=${maxProxyId}, 本地记录=${watermark}），正在重新同步...`);
            store.resetRoutingWatermark();
            routingRows = entries;
          } else {
            routingRows = entries.filter(e => (e.id || 0) > watermark);
          }
        }
        if (routingRows.length) {
          store.addRoutingEventsBatch(routingRows);
          const newMax = routingRows.reduce((m, e) => Math.max(m, e.id || 0), 0);
          if (newMax > 0) store.setRoutingWatermark(newMax);
          if (alertManager) {
            for (const row of routingRows) alertManager.checkRoutingEvent(row);
          }
        }
        const repResp = await ccProxyClient.reputation();
        const clusterRows = repResp.entries || [];
        if (clusterRows.length) store.replaceClusterStats(clusterRows);
      } catch (e) {
        console.error('[Ingestion] 数据采集异常:', e.message.includes('fetch failed') || e.message.includes('ECONNREFUSED')
          ? 'cc-proxy 未运行或连接被拒绝，等待下次重试...'
          : e.message);
      }
    };
    setImmediate(() => poll());
    const schedule = () => {
      tick++;
      const delay = tick < FAST_COUNT ? FAST_INTERVAL : NORMAL_INTERVAL;
      this._timer = setTimeout(async () => { await poll(); schedule(); }, delay);
    };
    schedule();
  }

  stop() {
    if (this._timer) clearTimeout(this._timer);
  }
}

module.exports = { LogFileIngester };
