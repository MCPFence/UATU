'use strict';

const router = require('express').Router();
const { store } = require('../lib/store');
const ccProxyClient = require('../ingest/cc-proxy-client');

const ROLE_FAMILIES = ['main', 'subagent', 'sidequery', 'compaction'];

function _validateRule(data) {
  if (!data.profile && !data.weighted) {
    return 'must set profile or weighted';
  }
  const hasMatch = ['cluster_id', 'agent_role', 'model_pattern', 'cel_expr', 'session_id', 'cc_entrypoint']
    .some(k => data[k]);
  if (!hasMatch) {
    return 'must set at least one match condition (cluster_id, agent_role, model_pattern, cel_expr, session_id, cc_entrypoint)';
  }
  if (data.confidence !== undefined) {
    const c = parseFloat(data.confidence);
    if (isNaN(c) || c < 0 || c > 1) return 'confidence must be in [0,1]';
  }
  if (data.weighted && typeof data.weighted === 'string') {
    try {
      const parsed = JSON.parse(data.weighted);
      data.weighted = JSON.stringify(parsed);
    } catch {
      return 'weighted must be valid JSON';
    }
  }
  return null;
}

router.get('/api/strategy/rules', async (req, res) => {
  const result = await ccProxyClient.listStrategies();
  if (result && result.error) {
    return res.json({ strategies: [], _offline: true, _error: result.error });
  }
  res.json(result);
});

router.post('/api/strategy/rules', async (req, res) => {
  const data = req.body || {};
  const err = _validateRule(data);
  if (err) return res.status(400).json({ error: err });

  const result = await ccProxyClient.createStrategy(data);
  if (result && result.error) {
    return res.status(500).json(result);
  }
  ccProxyClient.refreshStrategy().catch(() => {});
  res.status(201).json(result);
});

router.get('/api/strategy/rules/:ruleId', async (req, res) => {
  const result = await ccProxyClient.getStrategy(req.params.ruleId);
  if (result && result.error) {
    return res.status(404).json(result);
  }
  res.json(result);
});

router.put('/api/strategy/rules/:ruleId', async (req, res) => {
  const data = req.body || {};
  if (data.weighted && typeof data.weighted === 'string') {
    try {
      data.weighted = JSON.stringify(JSON.parse(data.weighted));
    } catch {
      return res.status(400).json({ error: 'weighted must be valid JSON' });
    }
  }
  const result = await ccProxyClient.updateStrategy(req.params.ruleId, data);
  if (result && result.error) {
    return res.status(500).json(result);
  }
  ccProxyClient.refreshStrategy().catch(() => {});
  res.json(result);
});

router.delete('/api/strategy/rules/:ruleId', async (req, res) => {
  const result = await ccProxyClient.deleteStrategy(req.params.ruleId);
  if (result && result.error) {
    return res.status(500).json(result);
  }
  ccProxyClient.refreshStrategy().catch(() => {});
  res.json(result);
});

router.post('/api/strategy/rules/:ruleId/toggle', async (req, res) => {
  const current = await ccProxyClient.getStrategy(req.params.ruleId);
  if (current && current.error) {
    return res.status(404).json(current);
  }
  const newEnabled = !current.enabled;
  const result = await ccProxyClient.updateStrategy(req.params.ruleId, { enabled: newEnabled });
  if (result && result.error) {
    return res.status(500).json(result);
  }
  ccProxyClient.refreshStrategy().catch(() => {});
  res.json({ ok: true, enabled: newEnabled });
});

router.post('/api/strategy/rules/:ruleId/recharge', async (req, res) => {
  const data = req.body || {};
  if (data.exploration_budget === undefined) {
    return res.status(400).json({ error: 'exploration_budget required' });
  }
  const result = await ccProxyClient.updateStrategy(req.params.ruleId, {
    exploration_budget: data.exploration_budget,
  });
  if (result && result.error) {
    return res.status(500).json(result);
  }
  res.json({ ok: true });
});

router.post('/api/strategy/batch', async (req, res) => {
  const rules = req.body;
  if (!Array.isArray(rules) || rules.length === 0) {
    return res.status(400).json({ error: 'array of rules required' });
  }
  const created = [];
  const errors = [];
  for (let i = 0; i < rules.length; i++) {
    const err = _validateRule(rules[i]);
    if (err) {
      errors.push({ index: i, error: err });
      continue;
    }
    const result = await ccProxyClient.createStrategy(rules[i]);
    if (result && result.error) {
      errors.push({ index: i, error: result.error });
    } else {
      created.push(result);
    }
  }
  if (created.length > 0) {
    ccProxyClient.refreshStrategy().catch(() => {});
  }
  res.json({ created, errors });
});

router.get('/api/strategy/analytics', async (req, res) => {
  const hours = parseInt(req.query.hours) || 24;

  const hit_stats = store.queryStrategyHitStats(hours);
  const dispatch_source = store.queryDispatchSourceStats(hours);
  const role_stats = store.queryRoleStats(hours);
  const role_family_stats = store.queryRoleFamilyStats(hours);
  const tool_category_stats = store.queryToolCategoryStats(hours);
  const session_binding_stats = store.querySessionBindingStats(hours);
  const exploration_stats = store.queryExplorationEffectiveness();
  const binding_override = store.queryBindingOverrideStats(hours);
  const traffic_flow = store.queryTrafficFlow(hours);

  let shadow_stats = [];
  try {
    const allRules = await ccProxyClient.listStrategies();
    const ruleList = Array.isArray(allRules) ? allRules
      : (allRules && allRules.strategies ? allRules.strategies : []);
    for (const r of ruleList) {
      if (r.enabled) continue;
      const estimate = store.estimateShadowHits(
        r.agent_role || null, r.model_pattern || null, hours
      );
      shadow_stats.push({ rule_id: r.id, name: r.name, ...estimate });
    }
  } catch {}

  res.json({
    hit_stats, dispatch_source, role_stats, role_family_stats,
    tool_category_stats, session_binding_stats, exploration_stats,
    binding_override, traffic_flow, shadow_stats,
  });
});

router.get('/api/strategy/role-distribution', (req, res) => {
  const hours = parseInt(req.query.hours) || 168;
  res.json({
    by_role: store.queryRoleStats(hours),
    by_family: store.queryRoleFamilyStats(hours),
  });
});

router.post('/api/strategy/estimate-impact', (req, res) => {
  const data = req.body || {};
  const result = store.estimateRuleImpact(
    data.agent_role || null,
    data.model_pattern || null,
    parseInt(data.hours) || 24
  );
  res.json(result);
});

router.post('/api/strategy/check-conflicts', async (req, res) => {
  const data = req.body || {};
  const newPriority = data.priority || 0;
  const newRole = data.agent_role || '';
  const newRoleFamily = ROLE_FAMILIES.find(f => newRole === f || newRole.startsWith(f + ':')) || '';

  let allRules = [];
  try {
    const resp = await ccProxyClient.listStrategies();
    allRules = Array.isArray(resp) ? resp : (resp && resp.strategies ? resp.strategies : []);
  } catch {
    return res.json({ shadows: [], has_conflicts: false });
  }

  const shadows = [];
  for (const rule of allRules) {
    if (!rule.enabled) continue;
    if ((rule.priority || 0) <= newPriority) continue;

    const ruleRole = rule.agent_role || '';
    const ruleFamily = ROLE_FAMILIES.find(f => ruleRole === f || ruleRole.startsWith(f + ':')) || '';

    let overlaps = false;
    if (ruleRole && newRole) {
      if (ruleRole === newRole) overlaps = true;
      else if (ruleFamily && ruleFamily === newRoleFamily) overlaps = true;
      else if (newRole.startsWith(ruleRole + ':') || ruleRole.startsWith(newRole + ':')) overlaps = true;
    }
    if (data.cluster_id && rule.cluster_id && rule.cluster_id === data.cluster_id) overlaps = true;
    if (data.session_id && rule.session_id && rule.session_id === data.session_id) overlaps = true;
    if (!ruleRole && !rule.cluster_id && !rule.session_id && !rule.model_pattern && !rule.cel_expr) {
      overlaps = true;
    }

    if (overlaps) {
      shadows.push({
        rule_id: rule.id,
        name: rule.name,
        priority: rule.priority,
        agent_role: ruleRole,
        profile: rule.profile || '',
      });
    }
  }

  res.json({ shadows, has_conflicts: shadows.length > 0 });
});

const BUILTIN_RULES = [
  {
    id: 'builtin_sidequery_web_search_cheap',
    name: '网络搜索 → 省钱',
    description: '联网搜索时，结果由网页内容决定，模型只负责整理格式，使用低成本模型即可，无需浪费高级配额',
    rule: { name: '内置:网络搜索省钱', agent_role: 'sidequery:web_search', profile: 'cheap', confidence: 0.9, priority_order: 10, enabled: true },
  },
  {
    id: 'builtin_subagent_explore_cheap',
    name: '探索子智能体 → 省钱',
    description: 'AI 独立探索代码库或文件时，任务以查找和汇总为主，对推理能力要求低，低成本模型足以胜任',
    rule: { name: '内置:探索子智能体省钱', agent_role: 'subagent:explore', profile: 'cheap', confidence: 0.9, priority_order: 10, enabled: true },
  },
  {
    id: 'builtin_sidequery_other_balanced',
    name: '其他旁路查询 → 均衡',
    description: '意图识别、中间处理等辅助请求，需要一定理解能力但无需顶级模型，均衡模型在效果与成本之间取得平衡',
    rule: { name: '内置:其他旁路查询均衡', agent_role: 'sidequery:other', profile: 'balanced', confidence: 0.9, priority_order: 10, enabled: true },
  },
  {
    id: 'builtin_main_premium',
    name: '主智能体 → 高级',
    description: '主任务执行（代码编写、文件修改、推理决策）直接关系到输出质量，始终路由到高级模型，保障核心任务不降级',
    rule: { name: '内置:主智能体高级', agent_role: 'main', profile: 'premium', confidence: 0.95, priority_order: 10, enabled: true },
  },
];

router.get('/api/strategy/builtin', (req, res) => {
  res.json(BUILTIN_RULES);
});

router.post('/api/strategy/install-builtin', async (req, res) => {
  let existing = [];
  const resp = await ccProxyClient.listStrategies();
  if (resp && resp.error) {
    return res.json({ created: [], skipped: [], _offline: true, _error: resp.error });
  }
  existing = Array.isArray(resp) ? resp : (resp && resp.strategies ? resp.strategies : []);
  const existingNames = new Set(existing.map(r => r.name));

  const created = [];
  const skipped = [];
  for (const tpl of BUILTIN_RULES) {
    if (existingNames.has(tpl.rule.name)) {
      skipped.push(tpl.id);
      continue;
    }
    const result = await ccProxyClient.createStrategy(tpl.rule);
    if (result && result.error) {
      return res.json({ error: result.error, created, skipped, _offline: true });
    }
    created.push(tpl.id);
  }
  res.json({ created, skipped });
});

router.get('/api/strategy/templates', (req, res) => {
  res.json([
    {
      id: 'subagent_cheap',
      name: 'Subagent -> Cheap',
      description: 'Route all subagent calls (explore/general/plan) to cheap profile',
      rule: { agent_role: 'subagent', profile: 'cheap', confidence: 0.95, priority_order: 10 },
    },
    {
      id: 'sidequery_cheap',
      name: 'Sidequery -> Cheap',
      description: 'Route sidequery calls (title generation, web search) to cheap profile',
      rule: { agent_role: 'sidequery', profile: 'cheap', confidence: 0.9, priority_order: 10 },
    },
    {
      id: 'compaction_cheap',
      name: 'Compaction -> Cheap',
      description: 'Context compaction has low quality requirements, use cheap models',
      rule: { agent_role: 'compaction', profile: 'cheap', confidence: 0.95, priority_order: 10 },
    },
    {
      id: 'mutation_premium',
      name: 'Mutation -> Premium',
      description: 'File write/edit operations use premium profile for code quality',
      rule: { cel_expr: "is_main && tool_category == 'mutation' && has_code", profile: 'premium', confidence: 0.85, priority_order: 20 },
    },
    {
      id: 'info_balanced',
      name: 'Info Gathering -> Balanced',
      description: 'Read/Grep info gathering in deep conversations use balanced profile',
      rule: { agent_role: 'main:tool:info', cel_expr: 'msg_count > 20', profile: 'balanced', confidence: 0.8, priority_order: 30 },
    },
    {
      id: 'retrial_switch',
      name: 'Retrial -> Switch Profile',
      description: 'Automatically switch profile on retrial to avoid repeating failures',
      rule: { cel_expr: 'is_retrial && is_main', profile: 'balanced', confidence: 0.7, priority_order: 5 },
    },
  ]);
});

router.get('/api/strategy/profiles', async (req, res) => {
  const result = await ccProxyClient.profiles();
  if (result && result.error) {
    return res.json({ profiles: {}, _offline: true, _error: result.error });
  }
  res.json(result);
});

router.get('/api/strategy/status', async (req, res) => {
  const result = await ccProxyClient.status();
  if (result && result.error) {
    return res.json({ online: false, _error: result.error });
  }
  res.json({ ...result, online: true });
});

module.exports = router;
