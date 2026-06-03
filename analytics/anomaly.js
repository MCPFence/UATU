'use strict';

/**
 * Three-layer anomaly detection: RuleBasedDetector -> Statistical Baseline -> LLM.
 */

const fs = require('fs');
const path = require('path');

const ANOMALY_DATA_DIR = path.join(__dirname, '..', 'anomaly_data');
try { fs.mkdirSync(ANOMALY_DATA_DIR, { recursive: true }); } catch (_e) { /* ignore */ }

// ─── FeatureExtractor ───────────────────────────────────────────────────────
// 从 session analysis 结果提取固定维度特征向量 (~30维)

class FeatureExtractor {
  constructor() {
    this.TOOL_VOCAB = [
      'Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash', 'Agent',
      'WebFetch', 'WebSearch', 'NotebookEdit', 'AskUserQuestion',
      'EnterPlanMode', 'ExitPlanMode', 'Skill',
    ];
  }

  extract(analysis) {
    const risk = analysis.risk || {};
    const tools = analysis.tool_stats || {};
    const cost = analysis.cost_analysis || {};
    const behavior = analysis.behavioral_summary || {};
    const lineage = analysis.data_lineage || {};

    const total = Math.max(tools.total_calls || 0, 1);
    const byTool = tools.by_tool || {};
    const features = {};

    for (const t of this.TOOL_VOCAB) {
      features[`tool_ratio_${t}`] = Math.round(((byTool[t] || 0) / total) * 10000) / 10000;
    }

    features.total_tools = tools.total_calls || 0;
    features.unique_tools = behavior.unique_tools || 0;
    features.tool_diversity = behavior.tool_diversity || 0;
    features.avg_tools_per_turn = behavior.avg_tools_per_turn || 0;
    features.sink_ratio = Math.round(((tools.sink_calls || 0) / total) * 10000) / 10000;

    features.risk_final = risk.cumulative_score || 0;
    const history = risk.history || [];
    const deltas = history.map(h => h.delta || 0);
    features.risk_max_delta = deltas.length > 0 ? Math.max(...deltas) : 0;
    features.risk_avg_delta = deltas.length > 0
      ? Math.round((deltas.reduce((a, b) => a + b, 0) / deltas.length) * 10000) / 10000
      : 0;
    features.risk_flags_count = (risk.flags || []).length;
    features.has_dangerous_bash = (risk.flags || []).includes('dangerous_bash') ? 1 : 0;

    const taintSummary = lineage.taint_summary || {};
    const taintVals = Object.values(taintSummary);
    const totalNodes = taintVals.length > 0 ? Math.max(taintVals.reduce((a, b) => a + b, 0), 1) : 1;
    features.taint_untrusted_ratio = Math.round(((taintSummary.untrusted || 0) / totalNodes) * 10000) / 10000;
    features.taint_mixed_ratio = Math.round(((taintSummary.mixed || 0) / totalNodes) * 10000) / 10000;
    features.lineage_edges = (lineage.edges || []).length;

    features.cost_rmb = cost.total_rmb || cost.total_usd || 0;
    features.token_efficiency = cost.token_efficiency || 0;
    features.cache_hit_rate = cost.cache_hit_rate || 0;

    return features;
  }

  toVector(features) {
    return this.featureNames.map(k => features[k] || 0);
  }

  get featureNames() {
    return Object.keys(this.extract({})).sort();
  }
}

// ─── StatisticalBaseline ────────────────────────────────────────────────────
// 统计基线: Markov Chain (bigram) + 特征分布 (Welford online)

class StatisticalBaseline {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.bigramCounts = {};
    this.bigramContext = {};
    this.unigramCounts = {};
    this.nSequences = 0;
    this.featureStats = {};
    this._load();
  }

  learn(toolSeq, features) {
    const seq = ['<START>', ...toolSeq, '<END>'];
    this.nSequences += 1;
    for (let i = 0; i < seq.length; i++) {
      const t = seq[i];
      this.unigramCounts[t] = (this.unigramCounts[t] || 0) + 1;
      if (i >= 1) {
        const bigram = `${seq[i - 1]}|${t}`;
        this.bigramCounts[bigram] = (this.bigramCounts[bigram] || 0) + 1;
        this.bigramContext[seq[i - 1]] = (this.bigramContext[seq[i - 1]] || 0) + 1;
      }
    }
    for (const [k, v] of Object.entries(features)) {
      if (typeof v === 'number') {
        if (!this.featureStats[k]) {
          this.featureStats[k] = { sum: 0.0, sum_sq: 0.0, count: 0 };
        }
        const s = this.featureStats[k];
        s.count += 1;
        s.sum += v;
        s.sum_sq += v * v;
      }
    }
    this._save();
  }

  score(toolSeq, features) {
    const ppl = this._sequencePerplexity(toolSeq);
    const devs = this._featureDeviations(features);
    const nAnomalous = Object.values(devs).filter(d => Math.abs(d) > 2.0).length;
    const conf = this.nSequences >= 10 ? 'high' : 'low';
    const needsLlm = conf === 'low' || (ppl > 20 && nAnomalous >= 2);
    return {
      perplexity: Math.round(ppl * 100) / 100,
      feature_deviations: devs,
      n_anomalous_features: nAnomalous,
      confidence: conf,
      needs_llm: needsLlm,
    };
  }

  _sequencePerplexity(toolSeq) {
    if (this.nSequences < 2 || !toolSeq || toolSeq.length === 0) return 0.0;
    const seq = ['<START>', ...toolSeq, '<END>'];
    const vocabSize = Math.max(Object.keys(this.unigramCounts).length, 1);
    const alpha = 0.1;
    let logProbSum = 0.0;
    for (let i = 1; i < seq.length; i++) {
      const prev = seq[i - 1];
      const curr = seq[i];
      const count = this.bigramCounts[`${prev}|${curr}`] || 0;
      const total = this.bigramContext[prev] || 0;
      const prob = total > 0
        ? (count + alpha) / (total + alpha * vocabSize)
        : 1.0 / vocabSize;
      logProbSum += Math.log2(Math.max(prob, 1e-10));
    }
    const n = Math.max(seq.length - 1, 1);
    return Math.pow(2, -logProbSum / n);
  }

  _featureDeviations(features) {
    const devs = {};
    for (const [k, v] of Object.entries(features)) {
      if (typeof v !== 'number') continue;
      const s = this.featureStats[k];
      if (!s || s.count < 3) continue;
      const mean = s.sum / s.count;
      const variance = Math.max(s.sum_sq / s.count - mean * mean, 0);
      const std = variance > 0 ? Math.sqrt(variance) : 0.001;
      devs[k] = Math.round(((v - mean) / std) * 100) / 100;
    }
    return devs;
  }

  getModelStats() {
    const tools = Object.keys(this.unigramCounts)
      .filter(k => k !== '<START>' && k !== '<END>')
      .sort();

    const sortedBigrams = Object.entries(this.bigramCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15);

    return {
      n_sequences: this.nSequences,
      vocab_size: Object.keys(this.unigramCounts).length,
      n_bigrams: Object.keys(this.bigramCounts).length,
      vocabulary: tools,
      top_transitions: sortedBigrams.map(([k, v]) => ({ transition: k, count: v })),
    };
  }

  getTransitionMatrix() {
    const tools = Object.keys(this.unigramCounts)
      .filter(k => k !== '<START>' && k !== '<END>')
      .sort();
    const states = ['<START>', ...tools, '<END>'];
    const matrix = [];
    for (const prev of states) {
      const total = this.bigramContext[prev] || 0;
      const row = [];
      for (const curr of states) {
        const count = this.bigramCounts[`${prev}|${curr}`] || 0;
        row.push(total > 0 ? Math.round((count / total) * 1000) / 1000 : 0);
      }
      matrix.push(row);
    }
    return { states, matrix };
  }

  _save() {
    try {
      const data = {
        n_sequences: this.nSequences,
        bigrams: this.bigramCounts,
        bigram_ctx: this.bigramContext,
        unigrams: this.unigramCounts,
        feature_stats: this.featureStats,
      };
      fs.writeFileSync(
        path.join(this.dataDir, 'baseline.json'),
        JSON.stringify(data),
        'utf8'
      );
    } catch (_e) { /* ignore */ }
  }

  _load() {
    try {
      const raw = fs.readFileSync(path.join(this.dataDir, 'baseline.json'), 'utf8');
      const data = JSON.parse(raw);
      this.nSequences = data.n_sequences || 0;
      this.bigramCounts = data.bigrams || {};
      this.bigramContext = data.bigram_ctx || {};
      this.unigramCounts = data.unigrams || {};
      this.featureStats = data.feature_stats || {};
    } catch (_e) { /* ignore */ }
  }
}

// ─── TrainingDataStore ──────────────────────────────────────────────────────
// 标注数据 JSONL 存储

class TrainingDataStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.dataFile = path.join(dataDir, 'training_data.jsonl');
    this.seedFile = path.join(dataDir, 'seed_data.jsonl');
  }

  saveSample(features, label, source, metadata) {
    const record = {
      timestamp: new Date().toISOString(),
      features,
      label,
      source,
      metadata: metadata || {},
    };
    try {
      fs.appendFileSync(this.dataFile, JSON.stringify(record) + '\n', 'utf8');
    } catch (_e) { /* ignore */ }
  }

  loadSamples() {
    const samples = [];
    for (const fpath of [this.seedFile, this.dataFile]) {
      try {
        if (fs.existsSync(fpath)) {
          const content = fs.readFileSync(fpath, 'utf8');
          for (const line of content.split('\n')) {
            const trimmed = line.trim();
            if (trimmed) {
              try {
                samples.push(JSON.parse(trimmed));
              } catch (_e) { /* skip bad lines */ }
            }
          }
        }
      } catch (_e) { /* ignore */ }
    }
    return samples;
  }

  getStats() {
    const samples = this.loadSamples();
    if (samples.length === 0) {
      return { total: 0, by_label: {}, by_source: {} };
    }

    const byLabel = {};
    const bySource = {};
    let nAnomalous = 0;
    for (const s of samples) {
      const anomalyType = (s.label || {}).anomaly_type || 'unknown';
      byLabel[anomalyType] = (byLabel[anomalyType] || 0) + 1;
      const src = s.source || 'unknown';
      bySource[src] = (bySource[src] || 0) + 1;
      if ((s.label || {}).is_anomalous) nAnomalous++;
    }

    return {
      total: samples.length,
      n_anomalous: nAnomalous,
      n_normal: samples.length - nAnomalous,
      by_label: byLabel,
      by_source: bySource,
    };
  }
}

// ─── RuleBasedDetector ──────────────────────────────────────────────────────
// JS replacement for sklearn GradientBoosting — scores based on feature thresholds

class RuleBasedDetector {
  constructor(dataDir, featureExtractor) {
    this.dataDir = dataDir;
    this.extractor = featureExtractor;
    this.ready = false;
    this.meta = {};
    this.thresholds = {};
    this.metaFile = path.join(dataDir, 'model_meta.json');
    this._load();
  }

  train(trainingData) {
    if (trainingData.length < 5) {
      return { error: `Need >= 5 samples, got ${trainingData.length}` };
    }

    const featureNames = this.extractor.featureNames;

    // Separate normal and anomalous
    const normalSamples = [];
    const anomalousSamples = [];
    for (const s of trainingData) {
      if ((s.label || {}).is_anomalous) {
        anomalousSamples.push(s.features || {});
      } else {
        normalSamples.push(s.features || {});
      }
    }

    if (normalSamples.length === 0 || anomalousSamples.length === 0) {
      return { error: 'Need both normal and anomalous samples' };
    }

    // Compute per-feature thresholds: mean + 2*std of normal data
    const thresholds = {};
    for (const fname of featureNames) {
      const normalVals = normalSamples.map(f => f[fname] || 0);
      const mean = normalVals.reduce((a, b) => a + b, 0) / normalVals.length;
      const variance = normalVals.reduce((a, v) => a + (v - mean) ** 2, 0) / normalVals.length;
      const std = Math.sqrt(variance);
      thresholds[fname] = {
        mean,
        std,
        upper: mean + 2 * std,
        lower: mean - 2 * std,
      };
    }

    // Compute feature importances based on how well each feature separates
    const importances = {};
    for (const fname of featureNames) {
      const normalMean = normalSamples.reduce((a, f) => a + (f[fname] || 0), 0) / normalSamples.length;
      const anomMean = anomalousSamples.reduce((a, f) => a + (f[fname] || 0), 0) / anomalousSamples.length;
      importances[fname] = Math.round(Math.abs(anomMean - normalMean) * 10000) / 10000;
    }

    // Normalize importances
    const totalImp = Object.values(importances).reduce((a, b) => a + b, 0) || 1;
    for (const k of Object.keys(importances)) {
      importances[k] = Math.round((importances[k] / totalImp) * 10000) / 10000;
    }

    this.thresholds = thresholds;
    this.ready = true;

    this.meta = {
      feature_names: featureNames,
      n_samples: trainingData.length,
      n_anomalous: anomalousSamples.length,
      n_normal: normalSamples.length,
      cv_f1: 0,  // no cross-validation in rule-based
      importances,
    };

    // Save meta (thresholds embedded)
    try {
      const saveData = { ...this.meta, thresholds };
      fs.writeFileSync(this.metaFile, JSON.stringify(saveData, null, 2), 'utf8');
    } catch (_e) { /* ignore */ }

    return { ok: true, cv_f1: 0, n_samples: trainingData.length };
  }

  predict(features) {
    if (!this.ready) return null;

    try {
      const featureNames = this.meta.feature_names || this.extractor.featureNames;
      let anomalyScore = 0;
      let totalWeight = 0;
      const importances = this.meta.importances || {};

      for (const fname of featureNames) {
        const val = features[fname] || 0;
        const thresh = this.thresholds[fname];
        if (!thresh) continue;

        const weight = importances[fname] || (1 / featureNames.length);
        totalWeight += weight;

        if (val > thresh.upper || val < thresh.lower) {
          // How far outside the threshold
          const deviation = thresh.std > 0
            ? Math.abs(val - thresh.mean) / thresh.std
            : (val !== thresh.mean ? 3 : 0);
          anomalyScore += weight * Math.min(deviation / 3, 1.0);
        }
      }

      const normalizedScore = totalWeight > 0 ? anomalyScore / totalWeight : 0;
      const isAnomalous = normalizedScore > 0.5;
      const confidence = Math.round(Math.max(
        isAnomalous ? normalizedScore : (1 - normalizedScore),
        0.5
      ) * 10000) / 10000;

      return {
        is_anomalous: isAnomalous,
        confidence,
        probabilities: {
          normal: Math.round((1 - normalizedScore) * 10000) / 10000,
          anomalous: Math.round(normalizedScore * 10000) / 10000,
        },
      };
    } catch (_e) {
      return null;
    }
  }

  _load() {
    try {
      const raw = fs.readFileSync(this.metaFile, 'utf8');
      const data = JSON.parse(raw);
      this.meta = data;
      if (data.thresholds) {
        this.thresholds = data.thresholds;
        this.ready = true;
      }
    } catch (_e) { /* ignore */ }
  }
}

// ─── LLMAnalyzer ────────────────────────────────────────────────────────────
// 调用 Claude API 做语义异常分析 (uses Node built-in fetch)

class LLMAnalyzer {
  constructor(apiKey, model) {
    this.apiKey = apiKey || process.env.ANTHROPIC_API_KEY || '';
    this.model = model || 'claude-haiku-4-5-20251001';
    this.enabled = Boolean(this.apiKey);
  }

  static get ANOMALY_TYPES() {
    return [
      'normal', 'suspicious_data_flow', 'dangerous_execution',
      'data_exfiltration', 'privilege_abuse', 'injection_pattern',
    ];
  }

  async analyze(sessionSummary) {
    if (!this.enabled) return null;

    try {
      const headers = {
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      };
      const prompt = this._buildPrompt(sessionSummary);
      const body = {
        model: this.model,
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }],
      };

      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
      });

      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
      }

      const data = await resp.json();
      let text = data.content[0].text;

      if (text.includes('```')) {
        text = text.split('```')[1];
        if (text.startsWith('json')) {
          text = text.slice(4);
        }
      }

      const result = JSON.parse(text.trim());
      if (result.is_anomalous === undefined) result.is_anomalous = false;
      if (!result.anomaly_type) result.anomaly_type = 'normal';
      if (result.confidence === undefined) result.confidence = 0.8;
      if (!result.explanation) result.explanation = '';
      return result;
    } catch (e) {
      return {
        is_anomalous: false,
        anomaly_type: 'normal',
        confidence: 0.3,
        explanation: `LLM analysis failed: ${e}`,
      };
    }
  }

  _buildPrompt(s) {
    return `你是 AI Agent 行为安全分析师。分析以下 Claude Code session 数据，判断是否异常。

## Session 数据
- 工具调用序列: ${JSON.stringify(s.tool_sequence || [])}
- Bash 命令: ${JSON.stringify(s.bash_commands || [])}
- 风险标记: ${JSON.stringify(s.flags || [])}
- 累积风险分: ${s.risk_score || 0}
- Sink 告警数: ${s.sink_alert_count || 0}
- 行为模式: ${s.pattern || 'unknown'}
- 成本: $${s.cost || 0}

## 异常类型
- normal: 正常开发行为 (探索代码、修改、测试、调研等)
- suspicious_data_flow: 可疑数据流 (外部数据→文件写入)
- dangerous_execution: 危险命令执行 (反弹shell、系统破坏)
- data_exfiltration: 数据外泄 (读敏感文件→外发)
- privilege_abuse: 权限滥用 (sudo、修改系统文件)
- injection_pattern: 注入攻击模式

**重要**: Read→Grep→Edit→Bash(test) 是正常开发流程，不要标记为异常。关注的是真正危险的行为组合。

请用 JSON 返回: {"is_anomalous": bool, "anomaly_type": "...", "confidence": 0.0-1.0, "explanation": "..."}`;
  }
}

// ─── AnomalyDetectionEngine ────────────────────────────────────────────────
// 自优化异常检测引擎 — 三层瀑布: 小模型 → 统计基线 → LLM

class AnomalyDetectionEngine {
  constructor() {
    this.featureExtractor = new FeatureExtractor();
    this.baseline = new StatisticalBaseline(ANOMALY_DATA_DIR);
    this.llmAnalyzer = new LLMAnalyzer();
    this.trainingStore = new TrainingDataStore(ANOMALY_DATA_DIR);
    this.smallModel = new RuleBasedDetector(ANOMALY_DATA_DIR, this.featureExtractor);
    if (!this.smallModel.ready) {
      this._tryInitialTrain();
    }
  }

  _tryInitialTrain() {
    const samples = this.trainingStore.loadSamples();
    if (samples.length >= 5) {
      const result = this.smallModel.train(samples);
      if (result.ok) {
        console.log(`[AnomalyEngine] Auto-trained model: samples=${result.n_samples}`);
      }
    }
  }

  analyzeSession(sessionId, analysisResult) {
    const features = this.featureExtractor.extract(analysisResult);
    const toolSeq = (analysisResult.behavioral_summary || {}).tool_sequence || [];
    const bashCmds = [];
    for (const d of ((analysisResult.tool_stats || {}).details || [])) {
      if (d.tool === 'Bash') {
        bashCmds.push(String(d.command || ''));
      }
    }

    // Layer 1: Small model (rule-based detector)
    const smResult = this.smallModel.predict(features);
    if (smResult && smResult.confidence > 0.8) {
      const label = {
        is_anomalous: smResult.is_anomalous,
        anomaly_type: smResult.is_anomalous ? 'model_detected' : 'normal',
        confidence: smResult.confidence,
        explanation: `Local model prediction (p=${JSON.stringify(smResult.probabilities)})`,
      };
      this._record(features, label, 'small_model', sessionId, toolSeq);
      return this._result(label, 'small_model', features, toolSeq, smResult);
    }

    // Layer 2: Statistical baseline
    const baselineResult = this.baseline.score(toolSeq, features);

    // Layer 3: LLM (async — but we return sync result and let LLM happen async)
    // Note: The Python version calls LLM synchronously. In JS we handle this
    // by returning the baseline result and firing LLM async if needed.
    if (baselineResult.needs_llm && this.llmAnalyzer.enabled) {
      const summary = {
        tool_sequence: toolSeq,
        bash_commands: bashCmds,
        flags: (analysisResult.risk || {}).flags || [],
        risk_score: (analysisResult.risk || {}).cumulative_score || 0,
        sink_alert_count: (analysisResult.sink_alerts || []).length,
        pattern: (analysisResult.behavioral_summary || {}).pattern || '',
        cost: (analysisResult.cost_analysis || {}).total_rmb || 0,
      };

      // Fire LLM analysis asynchronously; update training data when complete
      this.llmAnalyzer.analyze(summary).then(llmResult => {
        if (llmResult) {
          this._record(features, llmResult, 'llm', sessionId, toolSeq);
          this.baseline.learn(toolSeq, features);
          this._maybeRetrain();
        }
      }).catch(_e => { /* ignore */ });
    }

    // Return statistical baseline result synchronously
    const isAnom = baselineResult.n_anomalous_features >= 3;
    const label = {
      is_anomalous: isAnom,
      anomaly_type: isAnom ? 'statistical_outlier' : 'normal',
      confidence: baselineResult.confidence === 'low' ? 0.5 : 0.7,
      explanation: `Statistical: ppl=${baselineResult.perplexity.toFixed(1)}, ` +
        `${baselineResult.n_anomalous_features} deviated features`,
    };
    this._record(features, label, 'statistical', sessionId, toolSeq);
    this.baseline.learn(toolSeq, features);
    return this._result(label, 'statistical', features, toolSeq, smResult, baselineResult);
  }

  _result(detection, layer, features, toolSeq, sm, bl) {
    return {
      detection,
      layer_used: layer,
      small_model: sm || null,
      baseline: bl || null,
      model_status: {
        small_model_ready: this.smallModel.ready,
        small_model_f1: this.smallModel.meta.cv_f1 || 0,
        training_samples: this.trainingStore.getStats().total || 0,
        baseline_sequences: this.baseline.nSequences,
        llm_enabled: this.llmAnalyzer.enabled,
      },
    };
  }

  _record(features, label, source, sessionId, toolSeq) {
    this.trainingStore.saveSample(features, label, source, {
      session_id: sessionId,
      tool_sequence: toolSeq,
    });
  }

  _maybeRetrain() {
    const stats = this.trainingStore.getStats();
    const llmCount = (stats.by_source || {}).llm || 0;
    if (llmCount >= 10 && llmCount % 10 === 0) {
      const samples = this.trainingStore.loadSamples();
      this.smallModel.train(samples);
    }
  }

  getStatus() {
    return {
      baseline: this.baseline.getModelStats(),
      training_data: this.trainingStore.getStats(),
      small_model: {
        ready: this.smallModel.ready,
        meta: this.smallModel.meta,
      },
      llm_enabled: this.llmAnalyzer.enabled,
    };
  }
}

module.exports = {
  FeatureExtractor,
  StatisticalBaseline,
  TrainingDataStore,
  RuleBasedDetector,
  LLMAnalyzer,
  AnomalyDetectionEngine,
  ANOMALY_DATA_DIR,
};
