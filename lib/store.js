'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, 'observer.db');

const MAX_ITEMS = 50000;
const FLUSH_INTERVAL = 1000;
const FLUSH_THRESHOLD = 100;

function jsonDumps(obj) {
  if (obj == null) return 'null';
  return JSON.stringify(obj);
}

function jsonLoads(s) {
  if (s == null || s === 'null') return {};
  try { return JSON.parse(s); } catch { return {}; }
}

function extractProjectFromPrompt(sp) {
  try {
    const items = sp && sp.startsWith('[') ? JSON.parse(sp) : [];
    for (const item of items) {
      const text = typeof item === 'object' ? (item.text || '') : String(item);
      for (const line of text.split('\n')) {
        if (line.includes('Primary working directory:')) {
          const p = line.split('Primary working directory:')[1].trim();
          return p.replace(/\/+$/, '').split('/').pop();
        }
      }
    }
  } catch {}
  return '';
}

class Store {
  constructor(dbPath = DB_PATH) {
    this.dbPath = dbPath;
    this._bufTraces = [];
    this._bufMetrics = [];
    this._bufLogs = [];
    this._db = new Database(dbPath);
    this._db.pragma('journal_mode = WAL');
    this._db.pragma('synchronous = NORMAL');
    this._initDb();
    this._timer = setInterval(() => this.flushAll(), FLUSH_INTERVAL);
  }

  _initDb() {
    this._db.exec(`
      CREATE TABLE IF NOT EXISTS traces (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trace_id TEXT, span_id TEXT, parent_span_id TEXT,
        name TEXT, kind INTEGER,
        start_time TEXT, end_time TEXT, duration_ms REAL,
        attributes JSON, status JSON,
        service TEXT, scope TEXT, resource JSON,
        received_at REAL
      );
      CREATE INDEX IF NOT EXISTS idx_traces_trace ON traces(trace_id);
      CREATE INDEX IF NOT EXISTS idx_traces_recv ON traces(received_at);

      CREATE TABLE IF NOT EXISTS metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT, description TEXT, unit TEXT, type TEXT,
        data_points JSON, resource JSON,
        received_at REAL
      );

      CREATE TABLE IF NOT EXISTS logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        time TEXT, severity_text TEXT, severity_number INTEGER,
        body TEXT, attributes JSON,
        trace_id TEXT, span_id TEXT, resource JSON,
        received_at REAL
      );
      CREATE INDEX IF NOT EXISTS idx_logs_recv ON logs(received_at);
      CREATE INDEX IF NOT EXISTS idx_logs_trace ON logs(trace_id);

      CREATE TABLE IF NOT EXISTS scores (
        id TEXT PRIMARY KEY,
        timestamp TEXT, session_id TEXT, trace_id TEXT,
        name TEXT, value REAL, data_type TEXT,
        comment TEXT, source TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_scores_session ON scores(session_id);

      CREATE TABLE IF NOT EXISTS evaluations (
        id TEXT PRIMARY KEY,
        session_id TEXT, timestamp TEXT,
        task_completion REAL, efficiency REAL,
        safety REAL, intent_alignment REAL,
        overall REAL, details JSON
      );
      CREATE INDEX IF NOT EXISTS idx_eval_session ON evaluations(session_id);

      CREATE TABLE IF NOT EXISTS cc_proxy_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        session_dir TEXT,
        seq INTEGER,
        requested_model TEXT,
        system_prompt TEXT,
        tool_definitions JSON,
        message_count INTEGER,
        raw_file_path TEXT,
        received_at REAL
      );
      CREATE INDEX IF NOT EXISTS idx_cc_req_session ON cc_proxy_requests(session_id, seq);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_cc_req_dedup ON cc_proxy_requests(session_id, seq, raw_file_path);

      CREATE TABLE IF NOT EXISTS cc_proxy_responses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        seq INTEGER,
        request_id TEXT,
        actual_model TEXT,
        actual_provider TEXT,
        fallback_occurred BOOLEAN,
        input_tokens INTEGER,
        output_tokens INTEGER,
        cache_read_tokens INTEGER DEFAULT 0,
        cache_creation_tokens INTEGER DEFAULT 0,
        elapsed_ms REAL,
        raw_file_path TEXT,
        event_time REAL,
        received_at REAL
      );
      CREATE INDEX IF NOT EXISTS idx_cc_resp_session ON cc_proxy_responses(session_id, seq);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_cc_resp_dedup ON cc_proxy_responses(session_id, seq, request_id);
      CREATE INDEX IF NOT EXISTS idx_cc_resp_event_time ON cc_proxy_responses(event_time);

      CREATE TABLE IF NOT EXISTS tool_calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        seq INTEGER,
        msg_index INTEGER,
        tool_name TEXT,
        tool_use_id TEXT,
        has_input BOOLEAN,
        input_params JSON,
        param_keys TEXT,
        is_hallucinated BOOLEAN DEFAULT 0,
        is_fossil BOOLEAN DEFAULT 0,
        fossil_hash TEXT,
        received_at REAL
      );
      CREATE INDEX IF NOT EXISTS idx_tool_session ON tool_calls(session_id, seq);
      CREATE INDEX IF NOT EXISTS idx_tool_empty ON tool_calls(session_id, has_input);
      CREATE INDEX IF NOT EXISTS idx_tool_fossil ON tool_calls(session_id, is_fossil);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_tool_dedup ON tool_calls(session_id, seq, msg_index, tool_use_id);

      CREATE TABLE IF NOT EXISTS routing_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        duckdb_id INTEGER UNIQUE,
        timestamp TEXT,
        session_id TEXT,
        request_seq INTEGER,
        cluster_id INTEGER,
        query_preview TEXT,
        actual_provider TEXT,
        actual_model TEXT,
        actual_latency_ms INTEGER,
        actual_cost_usd REAL,
        input_tokens INTEGER,
        output_tokens INTEGER,
        hvr_score REAL,
        hvr_gate_passed BOOLEAN,
        stop_reason TEXT,
        is_stream BOOLEAN,
        received_at REAL
      );
      CREATE INDEX IF NOT EXISTS idx_re_session ON routing_events(session_id, request_seq);
      CREATE INDEX IF NOT EXISTS idx_re_provider ON routing_events(actual_provider);
      CREATE INDEX IF NOT EXISTS idx_re_timestamp ON routing_events(timestamp);
      CREATE INDEX IF NOT EXISTS idx_re_duckdb ON routing_events(duckdb_id);

      CREATE TABLE IF NOT EXISTS cluster_stats (
        cluster_id INTEGER,
        model_name TEXT,
        alpha INTEGER,
        beta INTEGER,
        total_requests INTEGER,
        synced_at REAL,
        PRIMARY KEY (cluster_id, model_name)
      );

      CREATE TABLE IF NOT EXISTS anomaly_feedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        is_anomalous BOOLEAN,
        label TEXT,
        comment TEXT,
        features JSON,
        created_at REAL
      );

      CREATE TABLE IF NOT EXISTS alert_feedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        alert_title TEXT,
        severity TEXT,
        feedback TEXT DEFAULT 'false_positive',
        alert_ts REAL,
        created_at REAL
      );

      CREATE TABLE IF NOT EXISTS session_risk_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        severity TEXT NOT NULL,
        title TEXT,
        detail TEXT,
        data JSON,
        dismissed BOOLEAN DEFAULT 0,
        created_at REAL
      );

      CREATE TABLE IF NOT EXISTS model_registry (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        model_name TEXT NOT NULL,
        provider TEXT NOT NULL,
        model_type TEXT NOT NULL DEFAULT 'OpenAI',
        group_name TEXT DEFAULT '',
        input_price_per_1k REAL DEFAULT 0,
        output_price_per_1k REAL DEFAULT 0,
        cache_price_per_1k REAL DEFAULT 0,
        max_context INTEGER DEFAULT 200000,
        enabled BOOLEAN DEFAULT 1,
        created_at REAL,
        updated_at REAL,
        UNIQUE(model_name, provider)
      );

      CREATE TABLE IF NOT EXISTS kv_meta (
        key TEXT PRIMARY KEY,
        value TEXT
      );
    `);
    this._upgradeRoutingEvents();
    this._upgradeModelRegistry();
    this._upgradeCcProxyResponses();
    this._seedModelRegistry();
  }

  _upgradeRoutingEvents() {
    const existing = new Set(this._db.pragma('table_info(routing_events)').map(r => r.name));
    const newCols = [
      ['profile_name', 'TEXT'], ['agent_role', 'TEXT'],
      ['cc_version_suffix', 'TEXT'], ['msg_count', 'INTEGER'],
      ['tool_call_count', 'INTEGER'], ['has_code', 'BOOLEAN'],
      ['user_msg_length', 'INTEGER'], ['is_retrial', 'BOOLEAN'],
      ['strategy_version', 'INTEGER'], ['strategy_rule_id', 'INTEGER'],
      ['dispatch_source', 'TEXT'],
    ];
    for (const [name, typ] of newCols) {
      if (!existing.has(name)) {
        this._db.exec(`ALTER TABLE routing_events ADD COLUMN ${name} ${typ}`);
      }
    }
    this._db.exec(`
      CREATE INDEX IF NOT EXISTS idx_re_dispatch ON routing_events(dispatch_source);
      CREATE INDEX IF NOT EXISTS idx_re_strategy_rule ON routing_events(strategy_rule_id);
      CREATE INDEX IF NOT EXISTS idx_re_agent_role ON routing_events(agent_role);
    `);
  }

  _upgradeModelRegistry() {
    const existing = new Set(this._db.pragma('table_info(model_registry)').map(r => r.name));
    if (!existing.has('model_type')) {
      this._db.exec("ALTER TABLE model_registry ADD COLUMN model_type TEXT NOT NULL DEFAULT 'OpenAI'");
      this._db.exec("UPDATE model_registry SET model_type = 'Anthropic' WHERE model_name LIKE 'Claude%'");
    }
    for (const [col, typ] of [['api_key', "TEXT DEFAULT ''"], ['api_base', "TEXT DEFAULT ''"]]) {
      if (!existing.has(col)) {
        this._db.exec(`ALTER TABLE model_registry ADD COLUMN ${col} ${typ}`);
      }
    }

    // Migrate old schema: model_name had a single-column UNIQUE constraint.
    // Recreate table with composite UNIQUE(model_name, provider) instead.
    const indexes = this._db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='model_registry'").get();
    if (indexes && indexes.sql && /model_name\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i.test(indexes.sql)) {
      this._db.exec(`
        CREATE TABLE model_registry_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          model_name TEXT NOT NULL,
          provider TEXT NOT NULL,
          model_type TEXT NOT NULL DEFAULT 'OpenAI',
          group_name TEXT DEFAULT '',
          input_price_per_1k REAL DEFAULT 0,
          output_price_per_1k REAL DEFAULT 0,
          cache_price_per_1k REAL DEFAULT 0,
          max_context INTEGER DEFAULT 200000,
          enabled BOOLEAN DEFAULT 1,
          created_at REAL,
          updated_at REAL,
          api_key TEXT DEFAULT '',
          api_base TEXT DEFAULT '',
          UNIQUE(model_name, provider)
        );
        INSERT INTO model_registry_new SELECT * FROM model_registry;
        DROP TABLE model_registry;
        ALTER TABLE model_registry_new RENAME TO model_registry;
      `);
      console.log('[store] migrated model_registry to composite UNIQUE(model_name, provider)');
    }
  }

  _upgradeCcProxyResponses() {
    const existing = new Set(this._db.pragma('table_info(cc_proxy_responses)').map(r => r.name));
    if (!existing.has('event_time')) {
      this._db.exec('ALTER TABLE cc_proxy_responses ADD COLUMN event_time REAL');
      this._db.exec('CREATE INDEX IF NOT EXISTS idx_cc_resp_event_time ON cc_proxy_responses(event_time)');
      this._db.exec('UPDATE cc_proxy_responses SET event_time = received_at WHERE event_time IS NULL');
    }
    if (!existing.has('cache_read_tokens')) {
      this._db.exec('ALTER TABLE cc_proxy_responses ADD COLUMN cache_read_tokens INTEGER DEFAULT 0');
      this._db.exec('ALTER TABLE cc_proxy_responses ADD COLUMN cache_creation_tokens INTEGER DEFAULT 0');
      // Clear all rows so log-watcher re-ingests with correct cache data
      this._db.exec('DELETE FROM cc_proxy_responses');
      console.log('[store] migration: cleared cc_proxy_responses for cache field re-ingestion');
    }
  }

  _seedModelRegistry() {
    const count = this._db.prepare('SELECT COUNT(*) as c FROM model_registry').get().c;
    if (count > 0) return;
    const now = Date.now() / 1000;
    const seeds = [
      ['Claude-Opus-4.6', 'anthropic', 'Anthropic', 'claude', 0.036, 0.18, 0.0036, 200000],
      ['DeepSeek-V4-Pro', 'deepseek', 'OpenAI', 'deepseek', 0.012, 0.024, 0.001, 1024000],
      ['DeepSeek-V4-Flash', 'deepseek', 'OpenAI', 'deepseek', 0.001, 0.002, 0.0002, 1024000],
      ['DeepSeek-R1', 'deepseek', 'OpenAI', 'deepseek', 0.004, 0.016, 0.001, 128000],
      ['Claude-Sonnet-4.6', 'anthropic', 'Anthropic', 'claude', 0.006, 0.03, 0.0006, 200000],
      ['Claude-Haiku-4.5', 'anthropic', 'Anthropic', 'claude', 0.0016, 0.01, 0.0002, 200000],
      ['GLM-5', 'zhipu', 'OpenAI', 'glm', 0.004, 0.016, 0.0008, 256000],
      ['Qwen3-Coder', 'alibaba', 'OpenAI', 'qwen', 0.015, 0.06, 0.0, 64000],
    ];
    const ins = this._db.prepare(
      'INSERT OR IGNORE INTO model_registry (model_name,provider,model_type,group_name,' +
      'input_price_per_1k,output_price_per_1k,cache_price_per_1k,max_context,enabled,created_at,updated_at) ' +
      'VALUES (?,?,?,?,?,?,?,?,1,?,?)'
    );
    const tx = this._db.transaction(() => {
      for (const [name, prov, mt, grp, inp, out, cache, ctx] of seeds) {
        ins.run(name, prov, mt, grp, inp, out, cache, ctx, now, now);
      }
    });
    tx();
  }

  // --- Buffer + flush ---

  addTrace(parsed) {
    this._bufTraces.push(parsed);
    if (this._bufTraces.length >= FLUSH_THRESHOLD) this._flushTraces();
  }

  addMetric(parsed) {
    this._bufMetrics.push(parsed);
    if (this._bufMetrics.length >= FLUSH_THRESHOLD) this._flushMetrics();
  }

  addLog(parsed) {
    this._bufLogs.push(parsed);
    if (this._bufLogs.length >= FLUSH_THRESHOLD) this._flushLogs();
  }

  _flushTraces() {
    if (!this._bufTraces.length) return;
    const rows = this._bufTraces.splice(0);
    const ins = this._db.prepare(
      'INSERT INTO traces (trace_id,span_id,parent_span_id,name,kind,' +
      'start_time,end_time,duration_ms,attributes,status,service,scope,resource,received_at) ' +
      'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
    );
    try {
      this._db.transaction(() => {
        for (const t of rows) {
          ins.run(
            t.traceId || '', t.spanId || '', t.parentSpanId || '',
            t.name || '', t.kind || 0,
            t.startTime || '', t.endTime || '', t.durationMs || 0,
            jsonDumps(t.attributes || {}), jsonDumps(t.status || {}),
            t.service || '', t.scope || '',
            jsonDumps(t.resource || {}), t._receivedAt || Date.now() / 1000
          );
        }
      })();
    } catch (e) { console.error('[Store] flush_traces error:', e.message); }
  }

  _flushMetrics() {
    if (!this._bufMetrics.length) return;
    const rows = this._bufMetrics.splice(0);
    const ins = this._db.prepare(
      'INSERT INTO metrics (name,description,unit,type,data_points,resource,received_at) VALUES (?,?,?,?,?,?,?)'
    );
    try {
      this._db.transaction(() => {
        for (const m of rows) {
          ins.run(m.name || '', m.description || '', m.unit || '', m.type || '',
            jsonDumps(m.dataPoints || []), jsonDumps(m.resource || {}), m._receivedAt || Date.now() / 1000);
        }
      })();
    } catch (e) { console.error('[Store] flush_metrics error:', e.message); }
  }

  _flushLogs() {
    if (!this._bufLogs.length) return;
    const rows = this._bufLogs.splice(0);
    const ins = this._db.prepare(
      'INSERT INTO logs (time,severity_text,severity_number,body,attributes,trace_id,span_id,resource,received_at) ' +
      'VALUES (?,?,?,?,?,?,?,?,?)'
    );
    try {
      this._db.transaction(() => {
        for (const l of rows) {
          let body = l.body || '';
          if (typeof body === 'object') body = jsonDumps(body);
          ins.run(l.time || '', l.severityText || '', l.severityNumber || 0, String(body),
            jsonDumps(l.attributes || {}), l.traceId || '', l.spanId || '',
            jsonDumps(l.resource || {}), l._receivedAt || Date.now() / 1000);
        }
      })();
    } catch (e) { console.error('[Store] flush_logs error:', e.message); }
  }

  flushAll() {
    this._flushTraces();
    this._flushMetrics();
    this._flushLogs();
  }

  stop() {
    clearInterval(this._timer);
    this.flushAll();
    this._db.close();
  }

  // --- Row converters ---

  _rowToTrace(r) {
    return {
      traceId: r.trace_id, spanId: r.span_id, parentSpanId: r.parent_span_id,
      name: r.name, kind: r.kind, startTime: r.start_time, endTime: r.end_time,
      durationMs: r.duration_ms, attributes: jsonLoads(r.attributes),
      status: jsonLoads(r.status), service: r.service, scope: r.scope,
      resource: jsonLoads(r.resource), _receivedAt: r.received_at,
    };
  }

  _rowToMetric(r) {
    return {
      name: r.name, description: r.description, unit: r.unit, type: r.type,
      dataPoints: jsonLoads(r.data_points), resource: jsonLoads(r.resource),
      _receivedAt: r.received_at,
    };
  }

  _rowToLog(r) {
    let body = r.body;
    try { body = JSON.parse(body); } catch {}
    return {
      time: r.time, severityText: r.severity_text, severityNumber: r.severity_number,
      body, attributes: jsonLoads(r.attributes), traceId: r.trace_id,
      spanId: r.span_id, resource: jsonLoads(r.resource), _receivedAt: r.received_at,
    };
  }

  _rowToScore(r) {
    return {
      id: r.id, timestamp: r.timestamp, session_id: r.session_id,
      trace_id: r.trace_id, name: r.name, value: r.value,
      data_type: r.data_type, comment: r.comment, source: r.source,
    };
  }

  // --- Reads ---

  queryTraces(limit = 500, traceId = null) {
    this.flushAll();
    if (traceId) {
      return this._db.prepare('SELECT * FROM traces WHERE trace_id=? ORDER BY start_time').all(traceId).map(r => this._rowToTrace(r));
    }
    return this._db.prepare('SELECT * FROM traces ORDER BY received_at DESC LIMIT ?').all(limit).map(r => this._rowToTrace(r));
  }

  queryMetrics(limit = 200) {
    this.flushAll();
    return this._db.prepare('SELECT * FROM metrics ORDER BY received_at DESC LIMIT ?').all(limit).map(r => this._rowToMetric(r));
  }

  queryLogs(limit = 500) {
    this.flushAll();
    return this._db.prepare('SELECT * FROM logs ORDER BY received_at DESC LIMIT ?').all(limit).map(r => this._rowToLog(r));
  }

  queryAllTraces() {
    this.flushAll();
    return this._db.prepare('SELECT * FROM traces ORDER BY received_at').all().map(r => this._rowToTrace(r));
  }

  queryAllLogs() {
    this.flushAll();
    return this._db.prepare('SELECT * FROM logs ORDER BY received_at').all().map(r => this._rowToLog(r));
  }

  countTraces() {
    this.flushAll();
    return this._db.prepare('SELECT COUNT(*) as c FROM traces').get().c;
  }

  countMetrics() {
    this.flushAll();
    return this._db.prepare('SELECT COUNT(*) as c FROM metrics').get().c;
  }

  countLogs() {
    this.flushAll();
    return this._db.prepare('SELECT COUNT(*) as c FROM logs').get().c;
  }

  queryTracesBySession(sessionId) {
    this.flushAll();
    return this._db.prepare(
      "SELECT * FROM traces WHERE json_extract(attributes, '$.\"session.id\"') = ? " +
      "OR json_extract(resource, '$.\"session.id\"') = ? ORDER BY start_time"
    ).all(sessionId, sessionId).map(r => this._rowToTrace(r));
  }

  queryLogsBySession(sessionId) {
    this.flushAll();
    return this._db.prepare(
      "SELECT * FROM logs WHERE json_extract(attributes, '$.\"session.id\"') = ? " +
      "OR json_extract(resource, '$.\"session.id\"') = ? ORDER BY received_at"
    ).all(sessionId, sessionId).map(r => this._rowToLog(r));
  }

  queryTimeline(buckets = 30, bucketSize = 60) {
    this.flushAll();
    const now = Date.now() / 1000;
    const cutoff = now - buckets * bucketSize;
    const tc = {}, mc = {}, lc = {};
    for (const r of this._db.prepare(
      'SELECT CAST((? - received_at) / ? AS INTEGER) AS bucket, COUNT(*) AS cnt FROM traces WHERE received_at > ? GROUP BY bucket'
    ).all(now, bucketSize, cutoff)) tc[r.bucket] = r.cnt;
    for (const r of this._db.prepare(
      'SELECT CAST((? - received_at) / ? AS INTEGER) AS bucket, COUNT(*) AS cnt FROM metrics WHERE received_at > ? GROUP BY bucket'
    ).all(now, bucketSize, cutoff)) mc[r.bucket] = r.cnt;
    for (const r of this._db.prepare(
      'SELECT CAST((? - received_at) / ? AS INTEGER) AS bucket, COUNT(*) AS cnt FROM logs WHERE received_at > ? GROUP BY bucket'
    ).all(now, bucketSize, cutoff)) lc[r.bucket] = r.cnt;
    return { tc, mc, lc };
  }

  queryStats() {
    this.flushAll();
    const traceCount = this._db.prepare('SELECT COUNT(*) as c FROM traces').get().c;
    const metricCount = this._db.prepare('SELECT COUNT(*) as c FROM metrics').get().c;
    const logCount = this._db.prepare('SELECT COUNT(*) as c FROM logs').get().c;
    const services = this._db.prepare('SELECT DISTINCT service FROM traces').all().map(r => r.service);
    const topSpans = {};
    for (const r of this._db.prepare('SELECT name, COUNT(*) AS cnt FROM traces GROUP BY name ORDER BY cnt DESC LIMIT 20').all()) {
      topSpans[r.name] = r.cnt;
    }
    return { traces: traceCount, metrics: metricCount, logs: logCount, services, topSpans };
  }

  // --- Scores ---

  addScore(score) {
    this._db.prepare(
      'INSERT OR REPLACE INTO scores (id,timestamp,session_id,trace_id,name,value,data_type,comment,source) VALUES (?,?,?,?,?,?,?,?,?)'
    ).run(score.id, score.timestamp || '', score.session_id || '', score.trace_id || '',
      score.name || '', score.value || 0, score.data_type || 'NUMERIC',
      score.comment || '', score.source || 'manual');
  }

  queryScores(limit = 500, sessionId = null) {
    if (sessionId) {
      return this._db.prepare('SELECT * FROM scores WHERE session_id=? ORDER BY timestamp DESC LIMIT ?')
        .all(sessionId, limit).map(r => this._rowToScore(r));
    }
    return this._db.prepare('SELECT * FROM scores ORDER BY timestamp DESC LIMIT ?')
      .all(limit).map(r => this._rowToScore(r));
  }

  // --- Evaluations ---

  addEvaluation(ev) {
    this._db.prepare(
      'INSERT OR REPLACE INTO evaluations (id,session_id,timestamp,task_completion,efficiency,safety,intent_alignment,overall,details) VALUES (?,?,?,?,?,?,?,?,?)'
    ).run(ev.id, ev.session_id, ev.timestamp, ev.task_completion || 0, ev.efficiency || 0,
      ev.safety || 0, ev.intent_alignment || 0, ev.overall || 0, jsonDumps(ev.details || {}));
  }

  queryEvaluation(sessionId) {
    const row = this._db.prepare('SELECT * FROM evaluations WHERE session_id=? ORDER BY timestamp DESC LIMIT 1').get(sessionId);
    if (!row) return null;
    return {
      id: row.id, session_id: row.session_id, timestamp: row.timestamp,
      task_completion: row.task_completion, efficiency: row.efficiency,
      safety: row.safety, intent_alignment: row.intent_alignment,
      overall: row.overall, details: jsonLoads(row.details),
    };
  }

  // --- Retention ---

  enforceRetention() {
    for (const table of ['traces', 'metrics', 'logs']) {
      const count = this._db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get().c;
      if (count > MAX_ITEMS) {
        const excess = count - MAX_ITEMS;
        this._db.prepare(`DELETE FROM ${table} WHERE id IN (SELECT id FROM ${table} ORDER BY received_at LIMIT ?)`).run(excess);
      }
    }
  }

  // --- CC Proxy ingestion ---

  addCcProxyRequest(data) {
    try {
      this._db.prepare(
        'INSERT OR IGNORE INTO cc_proxy_requests (session_id,session_dir,seq,requested_model,system_prompt,tool_definitions,message_count,raw_file_path,received_at) VALUES (?,?,?,?,?,?,?,?,?)'
      ).run(data.session_id, data.session_dir || '', data.seq || 0, data.requested_model || '',
        data.system_prompt || '', jsonDumps(data.tool_definitions || []),
        data.message_count || 0, data.raw_file_path || '', Date.now() / 1000);
    } catch {}
  }

  addCcProxyResponse(data) {
    try {
      let eventTime = Date.now() / 1000;
      if (data.timestamp) {
        const d = new Date(data.timestamp);
        if (!isNaN(d.getTime())) eventTime = d.getTime() / 1000;
      }
      this._db.prepare(
        'INSERT OR IGNORE INTO cc_proxy_responses (session_id,seq,request_id,actual_model,actual_provider,fallback_occurred,input_tokens,output_tokens,cache_read_tokens,cache_creation_tokens,elapsed_ms,raw_file_path,event_time,received_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
      ).run(data.session_id, data.seq || 0, data.request_id || '', data.actual_model || '',
        data.actual_provider || '', data.fallback_occurred ? 1 : 0,
        data.input_tokens || 0, data.output_tokens || 0,
        data.cache_read_tokens || 0, data.cache_creation_tokens || 0,
        data.elapsed_ms || 0,
        data.raw_file_path || '', eventTime, Date.now() / 1000);
    } catch {}
  }

  addToolCallBatch(calls) {
    if (!calls || !calls.length) return;
    const ins = this._db.prepare(
      'INSERT OR IGNORE INTO tool_calls (session_id,seq,msg_index,tool_name,tool_use_id,has_input,input_params,param_keys,is_hallucinated,is_fossil,fossil_hash,received_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)'
    );
    const now = Date.now() / 1000;
    this._db.transaction(() => {
      for (const c of calls) {
        ins.run(c.session_id || '', c.seq || 0, c.msg_index || 0, c.tool_name || '',
          c.tool_use_id || '', c.has_input ? 1 : 0, jsonDumps(c.input_params || {}),
          c.param_keys || '', c.is_hallucinated ? 1 : 0, c.is_fossil ? 1 : 0,
          c.fossil_hash || '', now);
      }
    })();
  }

  resolveCcProxySessionId(sessionId) {
    let row = this._db.prepare('SELECT session_id FROM cc_proxy_requests WHERE session_id=? LIMIT 1').get(sessionId);
    if (row) return row.session_id;
    row = this._db.prepare('SELECT session_id FROM cc_proxy_requests WHERE session_dir=? LIMIT 1').get(sessionId);
    if (row) return row.session_id;
    const prefix = sessionId.includes('-') ? sessionId.split('-')[0] : sessionId;
    const rows = this._db.prepare(
      'SELECT DISTINCT session_id, session_dir FROM cc_proxy_requests WHERE session_id LIKE ? OR session_dir LIKE ? ORDER BY LENGTH(session_id) DESC'
    ).all(sessionId + '%', prefix + '%');
    if (rows.length) return rows[0].session_id;
    return sessionId;
  }

  queryToolCallsBySession(sessionId) {
    sessionId = this.resolveCcProxySessionId(sessionId);
    return this._db.prepare('SELECT * FROM tool_calls WHERE session_id=? ORDER BY seq, msg_index').all(sessionId);
  }

  queryToolCallsSummaryAll() {
    return this._db.prepare(
      'SELECT session_id, COUNT(*) as total, ' +
      'SUM(CASE WHEN has_input = 0 THEN 1 ELSE 0 END) as empty, ' +
      'SUM(CASE WHEN is_fossil = 1 THEN 1 ELSE 0 END) as fossils, ' +
      'SUM(CASE WHEN is_hallucinated = 1 THEN 1 ELSE 0 END) as hallucinations ' +
      'FROM tool_calls GROUP BY session_id'
    ).all();
  }

  queryCcProxyRequests(sessionId) {
    sessionId = this.resolveCcProxySessionId(sessionId);
    return this._db.prepare('SELECT * FROM cc_proxy_requests WHERE session_id=? ORDER BY seq').all(sessionId);
  }

  queryCcProxyResponses(sessionId) {
    sessionId = this.resolveCcProxySessionId(sessionId);
    return this._db.prepare('SELECT * FROM cc_proxy_responses WHERE session_id=? ORDER BY seq').all(sessionId);
  }

  queryAllCcProxyResponses() {
    return this._db.prepare('SELECT * FROM cc_proxy_responses ORDER BY received_at DESC').all();
  }

  queryIngestedRespKeys() {
    return new Set(
      this._db.prepare("SELECT session_id || ':' || seq AS k FROM cc_proxy_responses").pluck().all()
    );
  }

  // Batched cost-summary rows for ALL sessions. One row per (session, provider, model).
  // Replaces N+1 per-session SELECT loops in list views.
  querySessionCostRollup() {
    return this._db.prepare(
      'SELECT session_id, ' +
      'COALESCE(actual_provider, \'unknown\') AS provider, ' +
      'COALESCE(actual_model, \'unknown\') AS model, ' +
      'SUM(COALESCE(input_tokens,0)) AS input_tokens, ' +
      'SUM(COALESCE(output_tokens,0)) AS output_tokens, ' +
      'SUM(COALESCE(cache_read_tokens,0)) AS cache_read_tokens, ' +
      'SUM(COALESCE(cache_creation_tokens,0)) AS cache_creation_tokens, ' +
      'COUNT(*) AS request_count, ' +
      'SUM(COALESCE(elapsed_ms,0)) AS total_elapsed_ms ' +
      'FROM cc_proxy_responses GROUP BY session_id, actual_provider, actual_model'
    ).all();
  }

  querySessionInteractionStats() {
    const reqRows = this._db.prepare(
      'SELECT session_id, seq, message_count, received_at FROM cc_proxy_requests ORDER BY session_id, seq'
    ).all();
    const respRows = this._db.prepare(
      'SELECT session_id, seq, elapsed_ms FROM cc_proxy_responses ORDER BY session_id, seq'
    ).all();

    const respMap = {};
    for (const r of respRows) {
      const key = `${r.session_id}|${r.seq}`;
      respMap[key] = r.elapsed_ms || 0;
    }

    const result = {};
    let prevSid = null, prevMsgCount = 0, turnElapsed = 0;

    function closeTurn(sid) {
      if (!result[sid]) result[sid] = { human_turns: 0, max_turn_ms: 0 };
      if (turnElapsed > result[sid].max_turn_ms) result[sid].max_turn_ms = turnElapsed;
    }

    for (const r of reqRows) {
      const sid = r.session_id;
      const mc = r.message_count || 0;
      const elapsed = respMap[`${sid}|${r.seq}`] || 0;

      if (sid !== prevSid) {
        if (prevSid) closeTurn(prevSid);
        prevSid = sid;
        prevMsgCount = mc;
        turnElapsed = elapsed;
        if (!result[sid]) result[sid] = { human_turns: 0, max_turn_ms: 0 };
        continue;
      }

      const delta = mc - prevMsgCount;
      if (delta >= 2) {
        closeTurn(sid);
        result[sid].human_turns += 1;
        turnElapsed = elapsed;
      } else {
        turnElapsed += elapsed;
      }
      prevMsgCount = mc;
    }
    if (prevSid) closeTurn(prevSid);

    for (const data of Object.values(result)) {
      data.max_turn_ms = Math.round(data.max_turn_ms);
    }
    return result;
  }

  querySessionFirstQuery() {
    return this._db.prepare(
      'SELECT r.session_id, r.query_preview FROM routing_events r ' +
      'INNER JOIN (SELECT session_id, MIN(request_seq) AS min_seq FROM routing_events GROUP BY session_id) t ' +
      'ON r.session_id = t.session_id AND r.request_seq = t.min_seq ' +
      "WHERE r.query_preview IS NOT NULL AND r.query_preview != ''"
    ).all();
  }

  queryCcProxyResponsesSince(sinceTs) {
    return this._db.prepare('SELECT * FROM cc_proxy_responses WHERE event_time >= ? ORDER BY event_time DESC').all(sinceTs);
  }

  queryProviderStats(since = null) {
    const q = 'SELECT actual_provider, actual_model, COUNT(*) as cnt, AVG(elapsed_ms) as avg_latency, ' +
      'SUM(input_tokens) as total_input, SUM(output_tokens) as total_output, ' +
      'SUM(cache_read_tokens) as total_cache_read, SUM(cache_creation_tokens) as total_cache_create, ' +
      'SUM(elapsed_ms) as total_elapsed_ms, ' +
      'SUM(CASE WHEN fallback_occurred THEN 1 ELSE 0 END) as fallbacks FROM cc_proxy_responses';
    if (since != null) {
      return this._db.prepare(q + ' WHERE event_time >= ? GROUP BY actual_provider, actual_model ORDER BY cnt DESC').all(since);
    }
    return this._db.prepare(q + ' GROUP BY actual_provider, actual_model ORDER BY cnt DESC').all();
  }

  queryMonthlyCost() {
    return this._db.prepare(
      "SELECT strftime('%Y-%m', datetime(received_at, 'unixepoch', 'localtime')) as month, " +
      'actual_model, actual_provider, SUM(input_tokens) as total_input, ' +
      'SUM(output_tokens) as total_output, ' +
      'SUM(cache_read_tokens) as total_cache_read, SUM(cache_creation_tokens) as total_cache_create, ' +
      'COUNT(*) as request_count ' +
      'FROM cc_proxy_responses GROUP BY month, actual_model, actual_provider ORDER BY month DESC, total_input DESC'
    ).all();
  }

  queryCcProxySessionIds() {
    return this._db.prepare('SELECT DISTINCT session_id, session_dir FROM cc_proxy_requests ORDER BY session_id').all();
  }

  hasCcProxyData(sessionId) {
    sessionId = this.resolveCcProxySessionId(sessionId);
    return this._db.prepare('SELECT COUNT(*) as c FROM cc_proxy_requests WHERE session_id=?').get(sessionId).c > 0;
  }

  queryCcProxySessionSummary() {
    return this._db.prepare(
      'SELECT session_id, COUNT(*) as call_count, GROUP_CONCAT(DISTINCT actual_model) as models, ' +
      'GROUP_CONCAT(DISTINCT actual_provider) as providers, ' +
      'SUM(input_tokens) + SUM(COALESCE(cache_read_tokens,0)) + SUM(COALESCE(cache_creation_tokens,0)) as total_input, ' +
      'SUM(output_tokens) as total_output, AVG(elapsed_ms) as avg_latency, MAX(elapsed_ms) as max_latency, ' +
      'MIN(received_at) as first_seen, MAX(received_at) as last_seen, ' +
      'SUM(CASE WHEN fallback_occurred THEN 1 ELSE 0 END) as fallback_count ' +
      'FROM cc_proxy_responses GROUP BY session_id'
    ).all();
  }

  querySessionProjects() {
    const rows = this._db.prepare(
      "SELECT session_id, system_prompt FROM cc_proxy_requests WHERE session_id != 'unknown' GROUP BY session_id HAVING seq = MAX(seq)"
    ).all();
    const result = {};
    // Load custom aliases first (takes priority)
    const aliasRows = this._db.prepare(
      "SELECT key, value FROM kv_meta WHERE key LIKE 'session_alias:%'"
    ).all();
    for (const a of aliasRows) {
      const sid = a.key.replace('session_alias:', '');
      if (a.value) result[sid] = a.value;
    }
    // Fill in auto-detected project names for sessions without alias
    for (const r of rows) {
      if (result[r.session_id]) continue;
      const project = extractProjectFromPrompt(r.system_prompt || '');
      if (project) result[r.session_id] = project;
    }
    return result;
  }

  setSessionAlias(sessionId, alias) {
    const key = `session_alias:${sessionId}`;
    if (!alias) {
      this._db.prepare("DELETE FROM kv_meta WHERE key = ?").run(key);
    } else {
      this._db.prepare("INSERT OR REPLACE INTO kv_meta (key, value) VALUES (?, ?)").run(key, alias);
    }
  }

  getSessionAlias(sessionId) {
    const key = `session_alias:${sessionId}`;
    const r = this._db.prepare("SELECT value FROM kv_meta WHERE key = ?").get(key);
    return r ? r.value : null;
  }

  // --- Routing events ---

  addRoutingEventsBatch(events) {
    if (!events.length) return;
    const ins = this._db.prepare(
      'INSERT OR IGNORE INTO routing_events (duckdb_id,timestamp,session_id,request_seq,cluster_id,' +
      'query_preview,actual_provider,actual_model,actual_latency_ms,actual_cost_usd,' +
      'input_tokens,output_tokens,hvr_score,hvr_gate_passed,stop_reason,is_stream,received_at,' +
      'profile_name,agent_role,cc_version_suffix,msg_count,tool_call_count,has_code,' +
      'user_msg_length,is_retrial,strategy_version,strategy_rule_id,dispatch_source) ' +
      'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
    );
    const now = Date.now() / 1000;
    this._db.transaction(() => {
      for (const e of events) {
        let ts = e.timestamp;
        if (ts && typeof ts === 'object' && ts.toISOString) ts = ts.toISOString();
        ins.run(e.id, String(ts || ''), e.session_id || '', e.request_seq || 0,
          e.cluster_id || 0, e.query_preview || '', e.actual_provider || '',
          e.actual_model || '', e.actual_latency_ms || 0, e.actual_cost_usd || 0,
          e.input_tokens || 0, e.output_tokens || 0, e.hvr_score || 0,
          (e.hvr_gate_passed != null ? (e.hvr_gate_passed ? 1 : 0) : 1), e.stop_reason || '', e.is_stream ? 1 : 0, now,
          e.profile_name || '', e.agent_role || '', e.cc_version_suffix || '', e.msg_count || 0,
          e.tool_call_count || 0, e.has_code ? 1 : 0, e.user_msg_length || 0, e.is_retrial ? 1 : 0,
          e.strategy_version || 0, e.strategy_rule_id || 0, e.dispatch_source || '');
      }
    })();
  }

  replaceClusterStats(stats) {
    if (!stats.length) return;
    const now = Date.now() / 1000;
    this._db.transaction(() => {
      this._db.exec('DELETE FROM cluster_stats');
      const ins = this._db.prepare('INSERT INTO cluster_stats (cluster_id,model_name,alpha,beta,total_requests,synced_at) VALUES (?,?,?,?,?,?)');
      for (const s of stats) {
        ins.run(s.cluster_id || 0, s.model_name || '', s.alpha || 1, s.beta || 1, s.total_requests || 0, now);
      }
    })();
  }

  getRoutingWatermark() {
    const r = this._db.prepare("SELECT value FROM kv_meta WHERE key='routing_watermark'").get();
    if (r) return parseInt(r.value, 10) || 0;
    const max = this._db.prepare('SELECT MAX(duckdb_id) as m FROM routing_events').get();
    return max.m || 0;
  }

  setRoutingWatermark(val) {
    this._db.prepare("INSERT OR REPLACE INTO kv_meta (key, value) VALUES ('routing_watermark', ?)").run(String(val));
  }

  resetRoutingWatermark(maxNewId) {
    this._db.prepare("INSERT OR REPLACE INTO kv_meta (key, value) VALUES ('routing_watermark', '0')").run();
  }

  queryRoutingEvents(provider = null, limit = 5000) {
    if (provider) {
      return this._db.prepare('SELECT * FROM routing_events WHERE actual_provider=? ORDER BY timestamp DESC LIMIT ?').all(provider, limit);
    }
    return this._db.prepare('SELECT * FROM routing_events ORDER BY timestamp DESC LIMIT ?').all(limit);
  }

  queryRoutingEventsBySession(sessionId) {
    return this._db.prepare('SELECT * FROM routing_events WHERE session_id=? ORDER BY request_seq').all(sessionId);
  }

  queryRoutingTimeseries(bucketMinutes = 5) {
    const trunc = bucketMinutes <= 5 ? 16 : 13;
    return this._db.prepare(
      'SELECT substr(timestamp, 1, ?) as bucket, COUNT(*) as cnt, AVG(actual_latency_ms) as avg_latency, ' +
      "SUM(CASE WHEN stop_reason NOT IN ('end_turn','tool_use','max_tokens') THEN 1 ELSE 0 END) as error_count, " +
      'SUM(actual_cost_usd) as total_cost, SUM(input_tokens) as total_input, SUM(output_tokens) as total_output ' +
      'FROM routing_events GROUP BY bucket ORDER BY bucket'
    ).all(trunc);
  }

  queryClusterStats() {
    return this._db.prepare('SELECT * FROM cluster_stats ORDER BY total_requests DESC').all();
  }

  queryStrategyHitStats(hours = 24) {
    const cutoff = Date.now() / 1000 - hours * 3600;
    return this._db.prepare(
      'SELECT strategy_rule_id, dispatch_source, COUNT(*) as hit_count, AVG(actual_latency_ms) as avg_latency, ' +
      'AVG(actual_cost_usd) as avg_cost, AVG(hvr_score) as avg_hvr, MAX(timestamp) as last_hit ' +
      'FROM routing_events WHERE received_at > ? AND strategy_rule_id IS NOT NULL AND strategy_rule_id > 0 ' +
      'GROUP BY strategy_rule_id, dispatch_source ORDER BY hit_count DESC'
    ).all(cutoff);
  }

  queryDispatchSourceStats(hours = 24) {
    const cutoff = Date.now() / 1000 - hours * 3600;
    const total = this._db.prepare(
      "SELECT COUNT(*) as c FROM routing_events WHERE received_at > ? AND dispatch_source IS NOT NULL AND dispatch_source != ''"
    ).get(cutoff).c || 1;
    return this._db.prepare(
      'SELECT dispatch_source, COUNT(*) as cnt, ROUND(COUNT(*) * 100.0 / ?, 2) as pct ' +
      "FROM routing_events WHERE received_at > ? AND dispatch_source IS NOT NULL AND dispatch_source != '' " +
      'GROUP BY dispatch_source ORDER BY cnt DESC'
    ).all(total, cutoff);
  }

  queryRoleStats(hours = 24) {
    const cutoff = Date.now() / 1000 - hours * 3600;
    return this._db.prepare(
      'SELECT agent_role, COUNT(*) as total, ' +
      'ROUND(COUNT(*) * 100.0 / MAX(1, (SELECT COUNT(*) FROM routing_events WHERE received_at > ?)), 1) as pct, ' +
      'AVG(actual_cost_usd) as avg_cost, SUM(actual_cost_usd) as total_cost, ' +
      'AVG(hvr_score) as avg_quality, AVG(actual_latency_ms) as avg_latency ' +
      "FROM routing_events WHERE received_at > ? AND agent_role IS NOT NULL AND agent_role != '' " +
      'GROUP BY agent_role ORDER BY total DESC'
    ).all(cutoff, cutoff);
  }

  queryRoleFamilyStats(hours = 24) {
    const cutoff = Date.now() / 1000 - hours * 3600;
    return this._db.prepare(
      "SELECT CASE WHEN agent_role LIKE 'main:%' THEN 'main' WHEN agent_role LIKE 'subagent:%' THEN 'subagent' " +
      "WHEN agent_role LIKE 'sidequery:%' THEN 'sidequery' ELSE agent_role END as role_family, " +
      'COUNT(*) as total, SUM(actual_cost_usd) as total_cost, AVG(hvr_score) as avg_quality, AVG(actual_latency_ms) as avg_latency ' +
      "FROM routing_events WHERE received_at > ? AND agent_role IS NOT NULL AND agent_role != '' " +
      'GROUP BY role_family ORDER BY total_cost DESC'
    ).all(cutoff);
  }

  queryToolCategoryStats(hours = 24) {
    const cutoff = Date.now() / 1000 - hours * 3600;
    return this._db.prepare(
      'SELECT agent_role, profile_name, COUNT(*) as calls, AVG(actual_latency_ms) as avg_latency, SUM(actual_cost_usd) as total_cost ' +
      "FROM routing_events WHERE received_at > ? AND agent_role LIKE 'main:tool:%' GROUP BY agent_role, profile_name ORDER BY total_cost DESC"
    ).all(cutoff);
  }

  querySessionBindingStats(hours = 24) {
    const cutoff = Date.now() / 1000 - hours * 3600;
    return this._db.prepare(
      'SELECT dispatch_source, COUNT(*) as requests, COUNT(DISTINCT session_id) as sessions ' +
      "FROM routing_events WHERE received_at > ? AND agent_role LIKE 'main:%' GROUP BY dispatch_source"
    ).all(cutoff);
  }

  queryExplorationEffectiveness() {
    return this._db.prepare(
      'SELECT strategy_rule_id, profile_name, COUNT(*) as n, AVG(hvr_score) as avg_quality, ' +
      'AVG(actual_cost_usd) as avg_cost, AVG(actual_latency_ms) as avg_latency ' +
      "FROM routing_events WHERE dispatch_source = 'strategy' AND strategy_rule_id IS NOT NULL " +
      'GROUP BY strategy_rule_id, profile_name ORDER BY strategy_rule_id'
    ).all();
  }

  queryBindingOverrideStats(hours = 24) {
    const cutoff = Date.now() / 1000 - hours * 3600;
    const total = this._db.prepare('SELECT COUNT(*) as c FROM routing_events WHERE received_at > ?').get(cutoff).c || 1;
    const rows = this._db.prepare(
      'SELECT dispatch_source, COUNT(*) as cnt FROM routing_events WHERE received_at > ? AND dispatch_source IS NOT NULL GROUP BY dispatch_source'
    ).all(cutoff);
    const result = {};
    for (const r of rows) result[r.dispatch_source] = { count: r.cnt, pct: Math.round(r.cnt * 1000 / total) / 10 };
    return result;
  }

  estimateShadowHits(agentRole = null, modelPattern = null, hours = 24) {
    const cutoff = Date.now() / 1000 - hours * 3600;
    const conds = ['received_at > ?'];
    const params = [cutoff];
    if (agentRole) {
      if (agentRole.includes(':')) { conds.push('agent_role = ?'); params.push(agentRole); }
      else { conds.push('(agent_role = ? OR agent_role LIKE ?)'); params.push(agentRole, agentRole + ':%'); }
    }
    if (modelPattern) { conds.push('actual_model LIKE ?'); params.push(`%${modelPattern}%`); }
    const where = conds.join(' AND ');
    return this._db.prepare(
      `SELECT COUNT(*) as potential_hits, COALESCE(AVG(actual_cost_usd),0) as avg_cost, COALESCE(SUM(actual_cost_usd),0) as total_cost FROM routing_events WHERE ${where}`
    ).get(...params);
  }

  queryTrafficFlow(hours = 24) {
    const cutoff = Date.now() / 1000 - hours * 3600;
    return this._db.prepare(
      'SELECT agent_role, profile_name, dispatch_source, COUNT(*) as cnt, SUM(actual_cost_usd) as total_cost ' +
      "FROM routing_events WHERE received_at > ? AND agent_role IS NOT NULL AND agent_role != '' " +
      'GROUP BY agent_role, profile_name, dispatch_source ORDER BY cnt DESC'
    ).all(cutoff);
  }

  estimateRuleImpact(agentRole = null, modelPattern = null, hours = 24) {
    const cutoff = Date.now() / 1000 - hours * 3600;
    const conds = ['received_at > ?'];
    const params = [cutoff];
    if (agentRole) {
      if (agentRole.includes(':')) { conds.push('agent_role = ?'); params.push(agentRole); }
      else { conds.push('(agent_role = ? OR agent_role LIKE ?)'); params.push(agentRole, agentRole + ':%'); }
    }
    if (modelPattern) { conds.push('actual_model LIKE ?'); params.push(`%${modelPattern}%`); }
    const where = conds.join(' AND ');
    return this._db.prepare(
      `SELECT COUNT(*) as matched_count, COALESCE(SUM(actual_cost_usd),0) as current_cost, COALESCE(AVG(actual_cost_usd),0) as avg_cost FROM routing_events WHERE ${where}`
    ).get(...params);
  }

  // --- Model Registry ---

  listModels() {
    return this._db.prepare('SELECT * FROM model_registry ORDER BY group_name, model_name').all();
  }

  getModel(modelId) {
    return this._db.prepare('SELECT * FROM model_registry WHERE id = ?').get(modelId) || null;
  }

  createModel(data) {
    const now = Date.now() / 1000;
    let modelType = data.model_type || 'OpenAI';
    if (!['Anthropic', 'OpenAI'].includes(modelType)) modelType = 'OpenAI';
    this._db.prepare(
      'INSERT OR REPLACE INTO model_registry (model_name,provider,model_type,group_name,input_price_per_1k,output_price_per_1k,' +
      'cache_price_per_1k,max_context,enabled,api_key,api_base,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)'
    ).run(data.model_name, data.provider, modelType, data.group_name || '',
      data.input_price_per_1k || 0, data.output_price_per_1k || 0,
      data.cache_price_per_1k || 0, data.max_context || 200000, data.enabled ?? 1,
      data.api_key || '', data.api_base || '', now, now);
    return this._db.prepare('SELECT last_insert_rowid() as id').get().id;
  }

  updateModel(modelId, data) {
    const fields = [];
    const values = [];
    for (const k of ['model_name', 'provider', 'model_type', 'group_name', 'input_price_per_1k',
      'output_price_per_1k', 'cache_price_per_1k', 'max_context', 'enabled', 'api_key', 'api_base']) {
      if (k in data) { fields.push(`${k} = ?`); values.push(data[k]); }
    }
    if (!fields.length) return false;
    fields.push('updated_at = ?');
    values.push(Date.now() / 1000);
    values.push(modelId);
    this._db.prepare(`UPDATE model_registry SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    return true;
  }

  deleteModel(modelId) {
    this._db.prepare('DELETE FROM model_registry WHERE id = ?').run(modelId);
  }

  listModelsInUse() {
    return this._db.prepare(
      'SELECT actual_model, actual_provider, COUNT(*) as request_count, ' +
      'SUM(input_tokens) + SUM(COALESCE(cache_read_tokens,0)) + SUM(COALESCE(cache_creation_tokens,0)) as total_input_tokens, ' +
      'SUM(output_tokens) as total_output_tokens, ROUND(AVG(elapsed_ms),0) as avg_latency_ms, MAX(received_at) as last_seen ' +
      "FROM cc_proxy_responses WHERE actual_model IS NOT NULL AND actual_model != '' GROUP BY actual_model, actual_provider ORDER BY request_count DESC"
    ).all();
  }

  listAllModels() {
    const inUseRows = this._db.prepare(
      'SELECT actual_model, actual_provider, COUNT(*) as request_count, ' +
      'SUM(input_tokens) + SUM(COALESCE(cache_read_tokens,0)) + SUM(COALESCE(cache_creation_tokens,0)) as total_input_tokens, ' +
      'SUM(output_tokens) as total_output_tokens, ROUND(AVG(elapsed_ms),0) as avg_latency_ms, MAX(received_at) as last_seen ' +
      "FROM cc_proxy_responses WHERE actual_model IS NOT NULL AND actual_model != '' GROUP BY actual_model, actual_provider"
    ).all();
    const inUseMap = {};
    for (const r of inUseRows) inUseMap[`${r.actual_model}|${r.actual_provider}`] = r;
    const registered = this._db.prepare(
      'SELECT model_name, provider, model_type, group_name, input_price_per_1k, output_price_per_1k, max_context, enabled FROM model_registry ORDER BY model_name'
    ).all();
    const seen = new Set();
    const result = [];
    for (const [key, stats] of Object.entries(inUseMap)) {
      seen.add(key);
      const [mn, mp] = key.split('|');
      const reg = registered.find(r => r.model_name === mn);
      result.push({
        model_name: mn, provider: mp,
        model_type: reg ? reg.model_type : Store._inferModelType(mn),
        group_name: reg ? reg.group_name : '',
        input_price_per_1k: reg ? reg.input_price_per_1k : 0,
        output_price_per_1k: reg ? reg.output_price_per_1k : 0,
        max_context: reg ? reg.max_context : 0,
        source: 'in_use',
        request_count: stats.request_count || 0,
        total_input_tokens: stats.total_input_tokens || 0,
        total_output_tokens: stats.total_output_tokens || 0,
        avg_latency_ms: stats.avg_latency_ms || 0,
        last_seen: stats.last_seen,
      });
    }
    for (const r of registered) {
      const key = `${r.model_name}|${r.provider}`;
      if (!seen.has(key)) {
        result.push({
          model_name: r.model_name, provider: r.provider, model_type: r.model_type,
          group_name: r.group_name, input_price_per_1k: r.input_price_per_1k || 0,
          output_price_per_1k: r.output_price_per_1k || 0, max_context: r.max_context || 0,
          source: 'registered', request_count: 0, total_input_tokens: 0,
          total_output_tokens: 0, avg_latency_ms: 0, last_seen: null,
        });
      }
    }
    return result;
  }

  listAvailableModels() {
    const inUse = this._db.prepare(
      "SELECT DISTINCT actual_model as model_name, actual_provider as provider FROM cc_proxy_responses WHERE actual_model IS NOT NULL AND actual_model != ''"
    ).all();
    const registered = this._db.prepare('SELECT model_name, provider, model_type FROM model_registry WHERE enabled = 1').all();
    const regTypes = {};
    for (const r of registered) regTypes[r.model_name] = r.model_type;
    const seen = new Set();
    const result = [];
    for (const r of inUse) {
      const key = `${r.model_name}|${r.provider}`;
      if (!seen.has(key)) {
        seen.add(key);
        result.push({ model_name: r.model_name, provider: r.provider,
          model_type: regTypes[r.model_name] || Store._inferModelType(r.model_name), source: 'in_use' });
      }
    }
    for (const r of registered) {
      const key = `${r.model_name}|${r.provider}`;
      if (!seen.has(key)) {
        seen.add(key);
        result.push({ model_name: r.model_name, provider: r.provider, model_type: r.model_type, source: 'registered' });
      }
    }
    return result;
  }

  static _inferModelType(modelName) {
    if (modelName && modelName.toLowerCase().startsWith('claude')) return 'Anthropic';
    return 'OpenAI';
  }

  listModelGroups() {
    return this._db.prepare(
      "SELECT group_name, COUNT(*) as count, GROUP_CONCAT(model_name, ', ') as models FROM model_registry WHERE enabled = 1 GROUP BY group_name ORDER BY group_name"
    ).all();
  }

  getModelByNameProvider(modelName, provider) {
    return this._db.prepare(
      'SELECT * FROM model_registry WHERE model_name = ? AND LOWER(provider) = LOWER(?)'
    ).get(modelName, provider) || null;
  }

  updateModelGroup(modelName, provider, groupName) {
    this._db.prepare(
      "UPDATE model_registry SET group_name = ?, updated_at = ? WHERE model_name = ? AND provider = ?"
    ).run(groupName, Date.now() / 1000, modelName, provider);
  }

  // --- Anomaly feedback ---

  addAnomalyFeedback(data) {
    this._db.prepare(
      'INSERT INTO anomaly_feedback (session_id,is_anomalous,label,comment,features,created_at) VALUES (?,?,?,?,?,?)'
    ).run(data.session_id, data.is_anomalous ? 1 : 0, data.label || '', data.comment || '',
      jsonDumps(data.features || {}), Date.now() / 1000);
  }

  queryAnomalyFeedback(limit = 500) {
    return this._db.prepare('SELECT * FROM anomaly_feedback ORDER BY created_at DESC LIMIT ?').all(limit).map(r => ({
      ...r, features: jsonLoads(r.features),
    }));
  }

  // --- Alert feedback ---

  addAlertFeedback(data) {
    this._db.prepare(
      'INSERT INTO alert_feedback (session_id,alert_title,severity,feedback,alert_ts,created_at) VALUES (?,?,?,?,?,?)'
    ).run(data.session_id, data.alert_title || '', data.severity || '', data.feedback || 'false_positive',
      data.ts || 0, Date.now() / 1000);
  }

  queryAlertFeedback(limit = 200) {
    return this._db.prepare('SELECT * FROM alert_feedback ORDER BY created_at DESC LIMIT ?').all(limit);
  }

  // --- Session risk events ---

  addSessionRiskEvent(data) {
    this._db.prepare(
      'INSERT INTO session_risk_events (session_id,severity,title,detail,data,created_at) VALUES (?,?,?,?,?,?)'
    ).run(data.session_id, data.severity, data.title || '', data.detail || '',
      JSON.stringify(data.data || {}), Date.now() / 1000);
  }

  queryActiveRiskEvents(hoursBack = 24) {
    const cutoff = Date.now() / 1000 - hoursBack * 3600;
    return this._db.prepare(
      'SELECT * FROM session_risk_events WHERE dismissed = 0 AND created_at > ? ORDER BY created_at DESC LIMIT 200'
    ).all(cutoff).map(r => ({ ...r, data: JSON.parse(r.data || '{}') }));
  }

  dismissRiskEvent(sessionId) {
    this._db.prepare('UPDATE session_risk_events SET dismissed = 1 WHERE session_id = ?').run(sessionId);
  }
}

const store = new Store();
module.exports = { Store, store };
