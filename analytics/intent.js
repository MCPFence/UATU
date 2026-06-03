'use strict';

/**
 * Intent extraction from LLM thinking traces and alignment scoring.
 */

class IntentAnalyzer {
  constructor() {
    this.INTENT_PATTERNS_EN = [
      /I(?:'m going to|'ll|will| want to| need to| should| plan to)\s+(.+?)(?:\.|;|,\s*(?:and|but)|$)/gim,
      /(?:Let me|Let's)\s+(.+?)(?:\.|;|,\s*(?:and|but)|$)/gim,
      /My (?:plan|approach|strategy) is to\s+(.+?)(?:\.|;|$)/gim,
      /First,?\s*I(?:'ll| will| should)\s+(.+?)(?:\.|;|$)/gim,
      /Next,?\s*I(?:'ll| will| should)\s+(.+?)(?:\.|;|$)/gim,
      /Then,?\s*I(?:'ll| will| should)\s+(.+?)(?:\.|;|$)/gim,
      /I (?:think I should|think I'll|am going to)\s+(.+?)(?:\.|;|$)/gim,
    ];

    this.INTENT_PATTERNS_ZH = [
      /我(?:打算|将要|需要|应该|计划|想要|准备)\s*(.+?)(?:。|；|$)/gm,
      /(?:让我|接下来(?:我)?|首先(?:我)?)\s*(.+?)(?:。|；|$)/gm,
      /我(?:先|再|然后)\s*(.+?)(?:。|；|$)/gm,
    ];
  }

  extractIntents(thinkingText) {
    if (!thinkingText) return [];

    const intents = [];
    const seen = new Set();

    const allPatterns = [...this.INTENT_PATTERNS_EN, ...this.INTENT_PATTERNS_ZH];
    for (const pattern of allPatterns) {
      // Reset lastIndex for each search since patterns have 'g' flag
      pattern.lastIndex = 0;
      let m;
      while ((m = pattern.exec(thinkingText)) !== null) {
        let text = (m[1] || '').trim();
        if (text.length < 3 || seen.has(text)) continue;
        if (text.length > 200) text = text.slice(0, 200);
        seen.add(text);
        const action = this._classifyAction(text);
        intents.push({
          text,
          action,
          confidence: action !== 'unknown' ? 0.9 : 0.4,
        });
      }
    }

    return intents;
  }

  _classifyAction(text) {
    const textLower = text.toLowerCase();
    const scores = {};
    for (const [action, keywords] of Object.entries(IntentAnalyzer.ACTION_KEYWORDS)) {
      for (const kw of keywords) {
        if (textLower.includes(kw)) {
          scores[action] = (scores[action] || 0) + kw.length;
        }
      }
    }
    if (Object.keys(scores).length === 0) return 'unknown';
    // Return the action with the highest score
    let maxAction = null;
    let maxScore = -1;
    for (const [action, score] of Object.entries(scores)) {
      if (score > maxScore) {
        maxScore = score;
        maxAction = action;
      }
    }
    return maxAction;
  }

  analyzeLlmCall(thinkingText, toolCalls) {
    const intents = this.extractIntents(thinkingText);
    if (intents.length === 0) {
      return {
        intents: [],
        actual_actions: [],
        alignment_score: 1.0,
        mismatches: [],
      };
    }

    const actualActions = [];
    for (const tool of toolCalls) {
      const toolName = tool.tool_name || tool.label || '';
      const action = IntentAnalyzer.TOOL_TO_ACTION[toolName] || 'unknown';
      actualActions.push(action);
    }

    const actualSet = new Set(actualActions);
    const intendedActions = intents
      .filter(i => i.action !== 'unknown')
      .map(i => i.action);

    if (intendedActions.length === 0) {
      return {
        intents,
        actual_actions: [...actualSet],
        alignment_score: 1.0,
        mismatches: [],
      };
    }

    let matched = 0;
    const mismatches = [];
    for (const intent of intents) {
      if (intent.action === 'unknown') continue;

      if (actualSet.has(intent.action)) {
        matched += 1;
      } else if (intent.action === 'read' && actualSet.has('search')) {
        matched += 0.8;
      } else if (intent.action === 'search' && actualSet.has('read')) {
        matched += 0.8;
      } else if (intent.action === 'analyze' && actualSet.size > 0) {
        matched += 0.5;
      } else {
        const actualDesc = actualSet.size > 0 ? [...actualSet].join(', ') : 'none';
        mismatches.push({
          intended: intent.action,
          actual: actualDesc,
          detail: `Intended '${intent.action}' (${intent.text.slice(0, 60)}) but did '${actualDesc}'`,
        });
      }
    }

    const alignment = Math.round((matched / Math.max(intendedActions.length, 1)) * 1000) / 1000;

    return {
      intents,
      actual_actions: [...actualSet],
      alignment_score: alignment,
      mismatches,
    };
  }

  analyzeSessionAlignment(turns) {
    const allScores = [];
    const allMismatches = [];

    for (const turn of turns) {
      for (const llmCall of (turn.llm_calls || [])) {
        const thinking = llmCall.thinking || '';
        const tools = llmCall.tools || [];
        if (thinking) {
          const result = this.analyzeLlmCall(thinking, tools);
          llmCall.intent_analysis = result;
          if (result.intents.length > 0) {
            allScores.push(result.alignment_score);
          }
          allMismatches.push(...result.mismatches);
        }
      }
    }

    const avgAlignment = allScores.length > 0
      ? Math.round((allScores.reduce((a, b) => a + b, 0) / Math.max(allScores.length, 1)) * 1000) / 1000
      : 1.0;

    return {
      overall_alignment: avgAlignment,
      analyzed_calls: allScores.length,
      total_mismatches: allMismatches.length,
      mismatches: allMismatches.slice(0, 20),
    };
  }
}

IntentAnalyzer.ACTION_KEYWORDS = {
  read: [
    'read', 'look at', 'check', 'examine', 'view', 'open', 'inspect', 'see',
    '读', '查看', '看一下', '看看', '检查', '打开',
  ],
  write: [
    'write', 'create', 'edit', 'modify', 'update', 'change', 'add', 'replace',
    '写', '创建', '修改', '编辑', '更新', '添加', '替换',
  ],
  search: [
    'search', 'find', 'grep', 'glob', 'look for', 'locate',
    '搜索', '查找', '寻找', '搜',
  ],
  execute: [
    'run', 'execute', 'bash', 'command', 'shell', 'install', 'build', 'test',
    '执行', '运行', '安装', '构建', '测试',
  ],
  web: [
    'fetch', 'browse', 'web', 'url', 'download', 'http',
    '网', '获取', '下载', '抓取',
  ],
  analyze: [
    'analyze', 'understand', 'figure out', 'investigate', 'explore', 'debug',
    '分析', '理解', '调查', '排查', '探索',
  ],
  plan: [
    'plan', 'design', 'think about', 'consider', 'decide',
    '规划', '设计', '考虑', '决定',
  ],
};

IntentAnalyzer.TOOL_TO_ACTION = {
  Read: 'read',
  Grep: 'search',
  Glob: 'search',
  Edit: 'write',
  Write: 'write',
  NotebookEdit: 'write',
  Bash: 'execute',
  WebFetch: 'web',
  WebSearch: 'web',
  Agent: 'execute',
  AskUserQuestion: 'analyze',
  EnterPlanMode: 'plan',
  ExitPlanMode: 'plan',
  Skill: 'execute',
};

const intentAnalyzer = new IntentAnalyzer();

module.exports = { IntentAnalyzer, intentAnalyzer };
