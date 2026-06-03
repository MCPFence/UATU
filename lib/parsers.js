'use strict';

const CST_OFFSET = 8 * 3600 * 1000;

function parseAnyValue(av) {
  if ('stringValue' in av) return av.stringValue;
  if ('intValue' in av) return parseInt(av.intValue, 10);
  if ('doubleValue' in av) return av.doubleValue;
  if ('boolValue' in av) return av.boolValue;
  if ('arrayValue' in av) return (av.arrayValue.values || []).map(parseAnyValue);
  if ('kvlistValue' in av) {
    const obj = {};
    for (const kv of (av.kvlistValue.values || [])) {
      obj[kv.key] = parseAnyValue(kv.value || {});
    }
    return obj;
  }
  return String(av);
}

function parseAttributes(attrs) {
  const result = {};
  for (const kv of (attrs || [])) {
    result[kv.key] = parseAnyValue(kv.value || {});
  }
  return result;
}

function nanoToIso(nano) {
  if (!nano) return '';
  try {
    const ms = parseInt(nano, 10) / 1e6;
    const d = new Date(ms + CST_OFFSET);
    return d.toISOString().replace('T', ' ').replace('Z', '').slice(0, 23);
  } catch {
    return String(nano);
  }
}

function nanoToMs(start, end) {
  try {
    return Math.round((parseInt(end, 10) - parseInt(start, 10)) / 1e6 * 100) / 100;
  } catch {
    return 0;
  }
}

const GEN_AI_TO_LEGACY = {
  'gen_ai.request.model': 'model',
  'gen_ai.response.model': 'model',
  'gen_ai.usage.input_tokens': 'input_tokens',
  'gen_ai.usage.output_tokens': 'output_tokens',
  'gen_ai.usage.cache_read_input_tokens': 'cache_read_tokens',
  'gen_ai.usage.cache_creation_input_tokens': 'cache_creation_tokens',
  'gen_ai.response.finish_reasons': 'finish_reason',
  'gen_ai.request.max_tokens': 'max_tokens',
  'gen_ai.system': 'ai_system',
};

const LEGACY_TO_GEN_AI = {
  model: 'gen_ai.request.model',
  input_tokens: 'gen_ai.usage.input_tokens',
  output_tokens: 'gen_ai.usage.output_tokens',
  cache_read_tokens: 'gen_ai.usage.cache_read_input_tokens',
  cache_creation_tokens: 'gen_ai.usage.cache_creation_input_tokens',
};

function normalizeAttributes(attrs) {
  const extra = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (GEN_AI_TO_LEGACY[k]) {
      const legacy = GEN_AI_TO_LEGACY[k];
      if (!(legacy in attrs)) extra[legacy] = v;
    } else if (LEGACY_TO_GEN_AI[k]) {
      const genAiKey = LEGACY_TO_GEN_AI[k];
      if (!(genAiKey in attrs)) extra[genAiKey] = v;
    }
  }
  Object.assign(attrs, extra);
  return attrs;
}

function getSessionId(item) {
  return (item.attributes || {})['session.id'] || (item.resource || {})['session.id'] || '';
}

function groupBySession(spans, logs) {
  const spanSessions = {};
  for (const s of spans) {
    const sid = getSessionId(s);
    if (sid) (spanSessions[sid] ||= []).push(s);
  }
  const logSessions = {};
  for (const l of logs) {
    const sid = getSessionId(l);
    if (sid) (logSessions[sid] ||= []).push(l);
  }
  const allSids = new Set([...Object.keys(spanSessions), ...Object.keys(logSessions)]);
  return { spanSessions, logSessions, allSids };
}

module.exports = {
  parseAnyValue, parseAttributes, nanoToIso, nanoToMs,
  normalizeAttributes, getSessionId, groupBySession,
  GEN_AI_TO_LEGACY, LEGACY_TO_GEN_AI,
};
