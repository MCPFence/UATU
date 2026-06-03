'use strict';

/**
 * Cost aggregation — all prices in RMB per million tokens.
 *
 * Lookup priority: DB model_registry (non-zero prices) > hardcoded table.
 *
 * API token fields:
 *   input_tokens          — net new input (excludes cache)
 *   output_tokens         — generated tokens
 *   cache_read_tokens     — served from prompt cache (discounted)
 *   cache_creation_tokens — written to prompt cache (premium)
 */

// [key, inp, out, cacheRead, cacheWrite]  —  RMB / million tokens
const MODEL_PRICING_RMB = [
  // Claude (only provider with cache_write charges)
  ['claude-opus-4',        36.00,  180.00,  3.60,  45.00],
  ['claude-opus-3',       112.50,  562.50, 11.25, 140.63],
  ['claude-sonnet-4',      21.60,  108.00,  2.16,  27.00],
  ['claude-3-7-sonnet',    22.50,  112.50,  2.25,  28.13],
  ['claude-3-5-sonnet',    22.50,  112.50,  2.25,  28.13],
  ['claude-haiku-4',        7.20,   36.00,  0.72,   9.00],
  ['claude-3-5-haiku',      7.50,   37.50,  0.75,   9.38],
  ['claude-3-haiku',        1.88,    9.38,  0.19,   2.35],
  ['claude-opus',         112.50,  562.50, 11.25, 140.63],
  ['claude-sonnet',        21.60,  108.00,  2.16,  27.00],
  ['claude-haiku',          1.88,    9.38,  0.19,   2.35],
  // GPT / OpenAI (no cache_write charge — caching is automatic)
  ['gpt-5.5',              36.00,  216.00,  3.60,   0],
  ['gpt-5.4',              18.00,  108.00,  1.80,   0],
  ['gpt-5.3',              12.60,  100.80,  1.30,   0],
  ['gpt-5.2',              12.60,  100.80,  1.26,   0],
  ['gpt-5.1',               9.38,   75.00,  0.94,   0],
  ['gpt-5-codex',           9.38,   75.00,  0.94,   0],
  ['gpt-5',                 9.38,   75.00,  0.94,   0],
  ['gpt-4.5',             562.50, 1125.00, 56.25,   0],
  ['gpt-4.1',              15.00,   60.00,  1.50,   0],
  ['gpt-4o-mini',           1.12,    4.50,  0.11,   0],
  ['gpt-4o',               18.75,   75.00,  1.88,   0],
  ['o4-mini',               8.03,   32.12,  0.80,   0],
  ['o3-mini',               8.25,   33.00,  0.83,   0],
  ['o1-preview',           22.50,   90.00,  2.25,   0],
  ['o1-mini',             112.50,  450.00, 11.25,   0],
  ['o1',                  112.50,  450.00, 11.25,   0],
  // DeepSeek (no cache_write charge)
  ['deepseek-v4-flash',     1.00,    2.00,  0.20,   0],
  ['deepseek-v4-pro',      12.00,   24.00,  1.00,   0],
  ['deepseek-v4',           1.00,    2.00,  0.20,   0],
  ['deepseek-r1-distill-qwen-32b', 1.50, 6.00, 0.15, 0],
  ['deepseek-r1-distill-qwen-7b',  0.60, 2.40, 0.06, 0],
  ['deepseek-r1',           4.00,   16.00,  0.40,   0],
  ['deepseek-v3',           2.00,    8.00,  0.20,   0],
  ['deepseek-chat',         2.00,    8.00,  0.20,   0],
  ['deepseek-reasoner',     4.00,   16.00,  0.40,   0],
  // Kimi (no cache_write charge)
  ['kimi-k2.6',             6.50,   27.00,  1.10,   0],
  ['kimi-k2',               6.50,   27.00,  0.65,   0],
  ['kimi',                  6.50,   27.00,  0.65,   0],
  // Qwen (no cache_write charge)
  ['qwen3.5-397b',          1.20,    7.20,  0.12,   0],
  ['qwen3-coder',          15.00,   60.00,  1.50,   0],
  ['qwen3-235b',            2.00,    8.00,  0.20,   0],
  ['qwen3-30b',             0.75,    3.00,  0.08,   0],
  ['qwen3-8b',              0.50,    2.00,  0.05,   0],
  ['qwen3-vl-235',          2.00,    8.00,  0.20,   0],
  ['qwen3-vl-8b',           0.50,    2.00,  0.05,   0],
  ['qwen2.5-vl-72b',       16.00,   48.00,  1.60,   0],
  ['qwen2.5-vl-7b',         2.00,    5.00,  0.20,   0],
  ['qwen3',                 2.00,    8.00,  0.20,   0],
  ['qwen',                  2.00,    8.00,  0.20,   0],
  // GLM (no cache_write charge)
  ['glm-5.1',               6.00,   24.00,  1.30,   0],
  ['glm-5',                 4.00,   16.00,  0.80,   0],
  ['glm-4.7',               4.00,   16.00,  0.40,   0],
  ['glm-4.6v',              2.00,    6.00,  0.20,   0],
  ['glm-4.5',               4.00,   16.00,  0.40,   0],
  ['glm-4v-plus',          10.00,   10.00,  1.00,   0],
  ['glm-4v',               50.00,   50.00,  5.00,   0],
  ['glm-4-long',            1.00,    1.00,  0.10,   0],
  ['glm',                   4.00,   16.00,  0.40,   0],
  // Gemini (no cache_write charge)
  ['gemini-3.1-flash-lite', 1.80,   10.80,  0.22,   0],
  ['gemini-3.1-flash',      3.60,   21.60,  0.36,   0],
  ['gemini-3-flash',        3.75,   22.50,  0.38,   0],
  ['gemini-3-pro',         15.00,   90.00,  1.50,   0],
  ['gemini-2.5-flash',      2.30,   18.75,  0.23,   0],
  ['gemini-2.5-pro',       20.00,  120.00,  2.00,   0],
  ['gemini',                2.30,   18.75,  0.23,   0],
  // Others (no cache_write charge)
  ['doubao',                3.00,    9.00,  0.30,   0],
  ['minimax-m2',            2.10,    8.40,  0.21,   0],
  ['minimax',               2.10,    8.40,  0.21,   0],
  ['ernie-4.5-turbo',       0.80,    3.20,  0.08,   0],
  ['ernie',                 0.50,    2.00,  0.05,   0],
  ['citrus',               16.00,   48.00,  1.60,   0],
  ['internvl3-38b',         8.00,   24.00,  0.80,   0],
  ['internvl',              0.50,    2.00,  0.05,   0],
  ['minicpm',               0.50,    2.00,  0.05,   0],
  ['eurollm',              0.50,    2.00,  0.05,   0],
  ['chatrhino',             0.00,    0.00,  0.00,   0],
];

const PRICE_DEFAULT = [22.50, 112.50, 2.25, 0];

function _lookupHardcoded(name) {
  const m = name.toLowerCase();
  const row = MODEL_PRICING_RMB.find(([key]) => m.includes(key));
  return row ? row.slice(1) : null;
}

// --- DB pricing cache (refreshed every 5 min) ---
let _dbCache = null;
let _dbCacheTs = 0;

function _loadDbPricing() {
  if (_dbCache !== null && Date.now() / 1000 - _dbCacheTs < 300) return _dbCache;
  _dbCache = {};
  try {
    const { store } = require('../lib/store');
    for (const m of store.listModels()) {
      if (!m.enabled || !(m.input_price_per_1k > 0 || m.output_price_per_1k > 0)) continue;
      const cacheWrite = m.cache_write_price_per_1k > 0
        ? m.cache_write_price_per_1k * 1000
        : (_lookupHardcoded(m.model_name) || PRICE_DEFAULT)[3];
      _dbCache[m.model_name.toLowerCase()] = [
        m.input_price_per_1k * 1000,
        m.output_price_per_1k * 1000,
        (m.cache_price_per_1k || 0) * 1000,
        cacheWrite,
      ];
    }
    _dbCacheTs = Date.now() / 1000;
  } catch (_) {}
  return _dbCache;
}

/** Return [inp, out, cacheRead, cacheWrite] RMB/Mtok. DB wins over hardcoded; longest match wins. */
function lookupModelPrice(modelName) {
  const m = (modelName || '').toLowerCase();
  const db = _loadDbPricing();
  const dbMatch = Object.entries(db).reduce((best, [k, v]) => {
    return (m === k || m.startsWith(k)) && k.length > best[0] ? [k.length, v] : best;
  }, [0, null])[1];
  return dbMatch || _lookupHardcoded(m) || PRICE_DEFAULT;
}

/** Estimate cost in RMB from raw token counts. */
function estimateCost(modelName, inp = 0, out = 0, cacheRead = 0, cacheCreate = 0) {
  const [pi, po, pcr, pcw] = lookupModelPrice(modelName);
  return Math.round((inp * pi + out * po + cacheRead * pcr + cacheCreate * pcw) / 1_000_000 * 1_000_000) / 1_000_000;
}

class SessionCostAggregator {
  constructor(store) { this.store = store; }

  sessionCost(sessionId) {
    const resps = this.store.queryCcProxyResponses(sessionId);
    if (!resps?.length) return null;

    const byProvider = {};
    const totals = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };

    for (const r of resps) {
      const key = `${r.actual_provider || 'unknown'}/${r.actual_model || 'unknown'}`;
      const b = byProvider[key] ??= {
        provider: r.actual_provider || 'unknown',
        model: r.actual_model || 'unknown',
        input_tokens: 0, output_tokens: 0,
        cache_read_tokens: 0, cache_creation_tokens: 0,
        request_count: 0, total_elapsed_ms: 0, estimated_cost_rmb: 0,
      };
      const [inp, out, cacheR, cacheW] = [
        r.input_tokens || 0, r.output_tokens || 0,
        r.cache_read_tokens || 0, r.cache_creation_tokens || 0,
      ];
      b.input_tokens += inp;  b.output_tokens += out;
      b.cache_read_tokens += cacheR;  b.cache_creation_tokens += cacheW;
      b.request_count += 1;  b.total_elapsed_ms += r.elapsed_ms || 0;
      b.estimated_cost_rmb += estimateCost(b.model, inp, out, cacheR, cacheW);
      totals.input += inp;  totals.output += out;
      totals.cacheRead += cacheR;  totals.cacheCreate += cacheW;
    }

    const breakdown = Object.values(byProvider).map(v => ({
      ...v,
      avg_elapsed_ms: Math.round(v.total_elapsed_ms / Math.max(v.request_count, 1) * 10) / 10,
      estimated_cost_rmb: Math.round(v.estimated_cost_rmb * 1e6) / 1e6,
    })).sort((a, b) => b.estimated_cost_rmb - a.estimated_cost_rmb);

    return {
      session_id: sessionId,
      total_input_tokens: totals.input,
      total_output_tokens: totals.output,
      total_cache_read_tokens: totals.cacheRead,
      total_cache_creation_tokens: totals.cacheCreate,
      total_estimated_cost_rmb: Math.round(breakdown.reduce((s, b) => s + b.estimated_cost_rmb, 0) * 10000) / 10000,
      by_provider: breakdown,
    };
  }
}

module.exports = { MODEL_PRICING_RMB, lookupModelPrice, estimateCost, SessionCostAggregator };
