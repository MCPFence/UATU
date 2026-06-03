// ============ State ============
let currentView = 'l1';
let currentDetailSid = null;
let currentDetailPage = {};
let currentTurnPage = 1;
let _lastSystemState = null;
let healthData = null;
const charts = {};
const API = '/api';

// ============ Auth ============
// Token sources (in order): ?token= query (one-time, then stripped) → localStorage.
// Token is NEVER embedded in HTML — that would leak it to anyone hitting `/`.
const _AUTH_TOKEN = (() => {
  const TS_KEY = 'cco_auth_token';
  try {
    const url = new URL(window.location.href);
    const fromQuery = url.searchParams.get('token');
    if (fromQuery) {
      localStorage.setItem(TS_KEY, fromQuery);
      url.searchParams.delete('token');
      window.history.replaceState(null, '', url.pathname + (url.search || '') + url.hash);
      return fromQuery;
    }
    return localStorage.getItem(TS_KEY) || '';
  } catch { return ''; }
})();

function _showAuthBanner() {
  if (document.getElementById('cco-auth-banner')) return;
  const div = document.createElement('div');
  div.id = 'cco-auth-banner';
  div.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;padding:14px 20px;background:#FF3B30;color:#fff;font:14px -apple-system,sans-serif;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,.2)';
  div.innerHTML = '需要 token 才能访问。请在 URL 后追加 <code style="background:rgba(0,0,0,.2);padding:2px 6px;border-radius:3px">?token=你的token</code> 然后刷新。token 见服务器启动日志 (API Auth: ENABLED token=...)。';
  document.body && document.body.appendChild(div);
}

(function patchFetch() {
  const _origFetch = window.fetch.bind(window);
  window.fetch = function(input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const isSameOrigin = url.startsWith('/') || url.startsWith(location.origin);
    if (!isSameOrigin) return _origFetch(input, init);
    const opts = init ? { ...init } : {};
    const headers = new Headers(opts.headers || (typeof input !== 'string' && input.headers) || {});
    if (_AUTH_TOKEN && !headers.has('Authorization')) {
      headers.set('Authorization', `Bearer ${_AUTH_TOKEN}`);
    }
    opts.headers = headers;
    return _origFetch(input, opts).then(r => {
      if (r.status === 401 && url.startsWith('/api/')) {
        try { localStorage.removeItem('cco_auth_token'); } catch {}
        _showAuthBanner();
      }
      return r;
    });
  };
})();

// ============ Apple Color System ============
const APPLE_COLORS = {
  blue: '#007AFF', green: '#34C759', red: '#FF3B30', orange: '#FF9500',
  yellow: '#FFCC00', purple: '#AF52DE', teal: '#5AC8FA', indigo: '#5856D6', pink: '#FF2D55',
};
const CHART_PALETTE = [
  APPLE_COLORS.blue, APPLE_COLORS.green, APPLE_COLORS.orange, APPLE_COLORS.purple,
  APPLE_COLORS.teal, APPLE_COLORS.pink, APPLE_COLORS.indigo, APPLE_COLORS.yellow,
];

// ============ SVG Icons (inline) ============
const ICONS = {
  sessions: '<svg viewBox="0 0 24 24"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
  quality: '<svg viewBox="0 0 24 24"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
  routing: '<svg viewBox="0 0 24 24"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>',
  cost: '<svg viewBox="0 0 24 24"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>',
  latency: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
  provider: '<svg viewBox="0 0 24 24"><rect x="2" y="2" width="20" height="8" rx="2" ry="2"/><rect x="2" y="14" width="20" height="8" rx="2" ry="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/></svg>',
  alert: '<svg viewBox="0 0 24 24"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
  error: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
  chevron: '<svg class="chevron" viewBox="0 0 24 24"><polyline points="9 18 15 12 9 6"/></svg>',
  clock: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
};

// ============ Utils ============
const _fetchCache = new Map();
const CACHE_MAX = 50;
const CACHE_TTL = 5000;

function _evictLRU() {
  if (_fetchCache.size <= CACHE_MAX) return;
  let oldest = null, oldestKey = null;
  for (const [k, v] of _fetchCache) {
    if (!oldest || v.at < oldest) { oldest = v.at; oldestKey = k; }
  }
  if (oldestKey) _fetchCache.delete(oldestKey);
}

async function fetchJSON(url, opts) {
  const cacheKey = url + (opts ? JSON.stringify(opts) : '');
  const cached = _fetchCache.get(cacheKey);
  if (cached && (Date.now() - cached.at < CACHE_TTL) && !(opts && opts.method && opts.method !== 'GET')) {
    cached.at = Date.now();
    return cached.data;
  }
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error(`${r.status}`);
  const data = await r.json();
  if (!opts || !opts.method || opts.method === 'GET') {
    _fetchCache.set(cacheKey, { data, at: Date.now() });
    _evictLRU();
  }
  return data;
}

function invalidateCache(urlPattern) {
  for (const k of _fetchCache.keys()) {
    if (k.includes(urlPattern)) _fetchCache.delete(k);
  }
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function escapeJsStr(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
}

function fmtCost(v) { return '¥' + (v || 0).toFixed((v || 0) >= 10 ? 2 : 4); }
function fmtNum(v) { return (v || 0).toLocaleString(); }
function fmtMs(v) { return v < 1000 ? `${Math.round(v)}ms` : v < 60000 ? `${(v/1000).toFixed(1)}s` : `${(v/60000).toFixed(1)}min`; }

// ============ Chart.js Theme ============
function chartTheme() {
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  return {
    text: dark ? 'rgba(235,235,245,0.78)' : '#3C3C43',
    grid: dark ? 'rgba(84,84,88,0.4)' : 'rgba(60,60,67,0.08)',
    tooltipBg: dark ? 'rgba(44,44,46,0.96)' : 'rgba(28,28,30,0.92)',
  };
}

function applyChartDefaults() {
  const t = chartTheme();
  Chart.defaults.font.family = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", system-ui, sans-serif';
  Chart.defaults.font.size = 11;
  Chart.defaults.color = t.text;
  Chart.defaults.borderColor = t.grid;
  Chart.defaults.elements.line.tension = 0.4;
  Chart.defaults.elements.line.borderWidth = 2;
  Chart.defaults.elements.point.radius = 0;
  Chart.defaults.elements.point.hoverRadius = 5;
  Chart.defaults.elements.bar.borderRadius = 6;
  Chart.defaults.elements.bar.borderSkipped = false;
  Chart.defaults.plugins.legend.labels.boxWidth = 8;
  Chart.defaults.plugins.legend.labels.usePointStyle = true;
  Chart.defaults.plugins.legend.labels.padding = 14;
  Chart.defaults.plugins.tooltip.backgroundColor = t.tooltipBg;
  Chart.defaults.plugins.tooltip.padding = 12;
  Chart.defaults.plugins.tooltip.cornerRadius = 10;
  Chart.defaults.plugins.tooltip.titleFont = { weight: '600', size: 12 };
  Chart.defaults.plugins.tooltip.bodyFont = { size: 12 };
  Chart.defaults.maintainAspectRatio = false;
}

function gradientFill(ctx, color) {
  const g = ctx.createLinearGradient(0, 0, 0, 240);
  g.addColorStop(0, color + '55');
  g.addColorStop(1, color + '00');
  return g;
}

// ============ Stat Card Factory ============
function statCard({ label, value, sub, accent = 'blue', icon, trend }) {
  return `<div class="stat-card">
    <div class="stat-row">
      <div class="stat-icon" style="background:var(--${accent}-bg);color:var(--${accent})">${icon || ''}</div>
      ${trend ? `<span class="trend-chip ${trend.dir || 'up'}">${escapeHtml(trend.label)}</span>` : ''}
    </div>
    <div class="stat-label">${escapeHtml(label)}</div>
    <div class="stat-value tnum" style="color:var(--${accent})">${value}</div>
    ${sub ? `<div class="stat-sub">${sub}</div>` : ''}
  </div>`;
}

// ============ Navigation ============
function navigate(view, sid) {
  currentView = view;
  currentDetailSid = sid || currentDetailSid;

  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));

  const viewEl = document.getElementById(`view-${view}`);
  if (viewEl) viewEl.classList.add('active');

  const navView = (view === 'l3') ? 'l2' : view;
  const navBtn = document.querySelector(`.nav-item[data-nav="${navView}"]`);
  if (navBtn) navBtn.classList.add('active');

  if (view === 'l1') loadHealthDashboard();
  else if (view === 'l2') loadSessionList();
  else if (view === 'l3') loadSessionDetail(sid);
  else if (view === 'l5') loadModelView();
  else if (view === 'l7') loadStrategyView();
  else if (view === 'l8') loadTerminalView();
}

// ============ L1: Health Dashboard ============
async function loadHealthDashboard() {
  try {
    checkConfigStatus();
    const [hd, latency] = await Promise.all([
      fetchJSON(`${API}/health-dashboard`),
      fetchJSON(`${API}/latency`).catch(() => null),
    ]);
    healthData = hd;
    renderHealthCards(healthData, latency);
    renderAnomalyBanner(healthData);
    renderAnomalies(healthData);
    renderTrendChart(healthData, latency);
    renderCostChart(healthData);
  } catch (e) {
    document.getElementById('healthCards').innerHTML =
      `<div class="empty">无法加载健康数据: ${escapeHtml(e.message)}</div>`;
  }
}

function renderHealthCards(d, latency) {
  const q = d.quality || {};
  const rs = d.routing_summary || {};
  const sessionTotal = d.sessions_total || 0;

  const totalCost = d.cost ? d.cost.estimated_rmb : 0;

  const totalReqs = rs.total_requests || 0;
  const avgLatency = rs.avg_latency_ms || 0;
  const totalOutput = d.cost ? d.cost.total_output_tokens || 0 : 0;
  const systemTps = d.cost ? d.cost.output_tps || 0 : 0;
  const effAccent = systemTps > 30 ? 'green' : systemTps > 10 ? 'orange' : 'red';

  document.getElementById('healthCards').innerHTML = [
    statCard({
      label: '任务', value: sessionTotal, accent: 'blue', icon: ICONS.sessions,
      sub: `${q.healthy_sessions || 0} 正常 · ${q.critical_sessions || 0} 异常`,
    }),
    statCard({
      label: '费用', value: fmtCost(totalCost), accent: 'green', icon: ICONS.cost,
      sub: `${d.cost ? (d.cost.total_input_tokens / 1000).toFixed(0) : 0}K input · ${(totalOutput / 1000).toFixed(0)}K output`,
    }),
    statCard({
      label: '效率', value: systemTps + ' tok/s', accent: effAccent, icon: ICONS.latency,
      sub: `${totalReqs} 次请求 · 平均 ${fmtMs(avgLatency)}/次`,
    }),
  ].join('');
}

function renderAnomalies(d) {
  const list = document.getElementById('anomalyList');
  const q = d.quality || {};
  const items = [];

  if (q.fossil_count > 0) {
    items.push({ type: '化石死循环', cls: 'critical', detail: `检测到 ${q.fossil_count} 个化石死循环 — 空参数调用在多个请求中重复出现` });
  }
  if (q.hallucination_count > 0) {
    items.push({ type: '工具幻觉', cls: 'critical', detail: `${q.hallucination_count} 次工具幻觉 (调用了不存在的工具)` });
  }
  if (d.providers && d.providers.failover_fallbacks > 0) {
    const fallbackModels = (d.providers.failover_breakdown || [])
      .filter(p => (p.failovers || 0) > 0)
      .sort((a, b) => (b.failovers || 0) - (a.failovers || 0))
      .slice(0, 3)
      .map(p => `${p.original_model || 'unknown'}→${p.actual_model || 'unknown'}(${p.failovers}次)`)
      .join('、');
    const suffix = fallbackModels ? `：${fallbackModels}` : '';
    items.push({ type: '模型不可用回退', cls: 'warning', detail: `今日 ${d.providers.failover_fallbacks} 次故障回退${suffix}` });
  }
  if (q.empty_rate > 0.3) {
    items.push({ type: '空参数率高', cls: 'warning', detail: `全局空参数率 ${Math.round(q.empty_rate * 100)}%，超过 30% 阈值` });
  }
  if (items.length === 0) {
    items.push({ type: '系统正常', cls: 'ok', detail: '未检测到异常' });
  }

  list.innerHTML = items.map(i => `
    <div class="anomaly-item">
      <span class="anomaly-type ${i.cls}"><span class="dot"></span>${escapeHtml(i.type)}</span>
      <span class="anomaly-detail">${escapeHtml(i.detail)}</span>
    </div>
  `).join('');
}

function renderTrendChart(d, latency) {
  if (charts.trend) charts.trend.destroy();
  const ctx = document.getElementById('trendChart');

  const modelSeries = (latency && latency.model_timeseries) || [];
  if (modelSeries.length > 0) {
    const sorted = modelSeries.slice().sort((a, b) => b.count - a.count).slice(0, 8);
    const labels = Array.from(new Set(sorted.flatMap(m => (m.series || []).map(p => p.time)))).sort();
    const pointsByModel = new Map(sorted.map(m => [m.model, new Map((m.series || []).map(p => [p.time, p]))]));
    const datasets = sorted.map((m, idx) => {
      const color = CHART_PALETTE[idx % CHART_PALETTE.length];
      const pointMap = pointsByModel.get(m.model);
      return {
        label: m.model,
        data: labels.map(t => {
          const p = pointMap.get(t);
          return p ? p.tps : null;
        }),
        borderColor: color,
        backgroundColor: color + '22',
        pointBackgroundColor: color,
        pointRadius: labels.map(t => {
          const p = pointMap.get(t);
          return p ? Math.min(6, 2 + p.count) : 0;
        }),
        spanGaps: true,
        borderWidth: 2,
        tension: 0.25,
        fill: false,
      };
    });

    charts.trend = new Chart(ctx, {
      type: 'line',
      data: { labels, datasets },
      options: {
        interaction: { mode: 'nearest', intersect: false },
        plugins: {
          tooltip: {
            callbacks: {
              title: items => items.length ? items[0].label : '',
              label: function(context) {
                const model = context.dataset.label;
                const point = pointsByModel.get(model)?.get(context.label);
                if (!point) return `${model}: 无请求`;
                return `${model}: ${point.tps} tok/s · ${point.count}次`;
              },
            },
          },
          legend: { position: 'top', labels: { usePointStyle: true, pointStyle: 'circle' } },
        },
        scales: {
          y: {
            grid: { color: chartTheme().grid },
            title: { display: true, text: '吞吐率 (tok/s)', font: { size: 11 } },
            ticks: { callback: v => v + ' tok/s' },
            beginAtZero: true,
          },
          x: {
            grid: { display: false },
            ticks: { font: { size: 11 }, maxRotation: 0, autoSkip: true, maxTicksLimit: 8 },
          },
        },
      },
    });
  } else {
    const q = d.quality || {};
    const pct = q.total_calls ? Math.round((1 - q.empty_rate) * 100) : 100;
    const color = pct > 70 ? APPLE_COLORS.green : pct > 30 ? APPLE_COLORS.orange : APPLE_COLORS.red;
    charts.trend = new Chart(ctx, {
      type: 'line',
      data: {
        labels: ['1h前', '50m', '40m', '30m', '20m', '10m', '当前'],
        datasets: [{ label: '成功率', data: [pct, pct, pct, pct, pct, pct, pct], borderColor: color, backgroundColor: gradientFill(ctx.getContext('2d'), color), fill: 'origin' }],
      },
      options: {
        plugins: { legend: { display: false } },
        scales: { y: { min: 0, max: 100, grid: { color: chartTheme().grid }, ticks: { callback: v => v + '%' } }, x: { grid: { display: false } } },
      },
    });
  }
}

function renderCostChart(d) {
  const providers = (d.providers && d.providers.breakdown) ? d.providers.breakdown : [];
  const labels = providers.map(p => `${p.actual_provider}/${p.actual_model}`);
  const data = providers.map(p => p.estimated_cost_rmb || 0);

  if (charts.cost) charts.cost.destroy();
  const ctx = document.getElementById('costChart');
  charts.cost = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: labels.length ? labels : ['无数据'],
      datasets: [{
        data: data.length ? data : [1],
        backgroundColor: CHART_PALETTE,
        borderWidth: 0,
        spacing: 2,
      }],
    },
    options: {
      cutout: '70%',
      plugins: {
        legend: { position: 'bottom' },
        tooltip: {
          callbacks: {
            label: (ctx) => ` ${ctx.label}: ¥${ctx.parsed.toFixed(4)}`,
          },
        },
      },
    },
  });
}

// ============ L1: Anomaly Banner + Traffic Light + Quality Trend ============
function renderAnomalyBanner(d) {
  const banner = document.getElementById('anomalyBanner');
  if (!banner) return;
  const q = d.quality || {};
  const criticals = [];
  if (q.fossil_count > 0) criticals.push(`${q.fossil_count} 化石死循环`);
  if (q.hallucination_count > 0) criticals.push(`${q.hallucination_count} 工具幻觉`);
  if (d.providers && d.providers.total_fallbacks > 10) criticals.push(`${d.providers.total_fallbacks} 次模型回退`);
  if (criticals.length === 0) { banner.hidden = true; return; }
  banner.hidden = false;
  banner.className = 'anomaly-banner ' + (q.fossil_count > 0 || q.hallucination_count > 0 ? 'critical' : 'warning');
  banner.innerHTML = `<span class="banner-icon">⚠</span> 检测到异常: ${criticals.join(' · ')}`;
}


// ============ L2: Enhanced Session Table ============
let evalCache = null;

async function loadSessionList() {
  try {
    const q = document.getElementById('sessionSearch').value;
    const sortEl = document.querySelector('#sessionSort .seg.active');
    const sort = sortEl ? sortEl.dataset.sort : 'time';
    const url = `${API}/sessions/filter?sort=${sort}&q=${encodeURIComponent(q)}`;
    const [sessionsResp, evals, activeSessions, projects, riskEvents] = await Promise.all([
      fetchJSON(url),
      evalCache ? Promise.resolve(evalCache) : fetchJSON(`${API}/evaluations`).catch(() => []),
      fetchJSON(`${API}/cc-proxy/active-sessions`).catch(() => ({sessions:[]})),
      fetchJSON(`${API}/cc-proxy/session-projects`).catch(() => ({})),
      fetchJSON(`${API}/session-risks`).catch(() => []),
    ]);
    evalCache = evals;
    // Restore persisted risk events into riskySessionMap
    if (Array.isArray(riskEvents)) {
      for (const ev of riskEvents) {
        if (ev.session_id && !riskySessionMap.has(ev.session_id)) {
          riskySessionMap.set(ev.session_id, { severity: ev.severity, title: ev.title, ts: ev.created_at * 1000 });
        }
      }
    }
    const sessions = Array.isArray(sessionsResp) ? sessionsResp : (sessionsResp.sessions || []);
    const activeSet = new Set((activeSessions.sessions || []).map(s => s.session_id));

    const rangeEl = document.querySelector('#dateRange .seg.active');
    const range = rangeEl ? rangeEl.dataset.range : 'all';
    const filtered = filterByDateRange(sessions, range);
    filtered.sort((a, b) => {
      const aActive = activeSet.has(a.sessionId) ? 1 : 0;
      const bActive = activeSet.has(b.sessionId) ? 1 : 0;
      if (bActive !== aActive) return bActive - aActive;
      const aTime = a.endTime || a.startTime || '';
      const bTime = b.endTime || b.startTime || '';
      return bTime.localeCompare(aTime);
    });
    renderSessionTable(filtered, evals, activeSet, projects);
  } catch (e) {
    document.getElementById('sessionTable').querySelector('tbody').innerHTML =
      `<tr><td colspan="5" class="empty">加载失败: ${escapeHtml(e.message)}</td></tr>`;
  }
}

function filterByDateRange(sessions, range) {
  if (range === 'all') return sessions;
  const now = Date.now();
  const msMap = { '1h': 3600000, '6h': 21600000, '24h': 86400000, '7d': 604800000 };
  const cutoff = now - (msMap[range] || 0);
  return sessions.filter(s => {
    const raw = s.endTime || s.startTime || s.lastSeen || s.firstSeen || '';
    if (!raw) return false;
    const t = new Date(raw).getTime();
    return t >= cutoff;
  });
}

function renderSessionTable(sessions, evals, activeSet, projects) {
  const tbody = document.getElementById('sessionTable').querySelector('tbody');
  if (!sessions.length) {
    tbody.innerHTML = `<tr><td colspan="7">
      <div class="guidance-card">
        <h3>尚无会话数据</h3>
        <p>请先完成 CC-Proxy 配置并使用 Claude Code，会话数据将自动出现在这里。</p>
        <div class="guidance-actions">
          <button class="btn-tinted btn-sm" onclick="navigate('l1')">查看配置状态</button>
        </div>
      </div>
    </td></tr>`;
    return;
  }

  const evalMap = {};
  (evals || []).forEach(e => { evalMap[e.session_id] = e; });
  activeSet = activeSet || new Set();
  projects = projects || {};

  tbody.innerHTML = sessions.map(s => {
    const sidFull = s.sessionId || '';
    const isActive = activeSet.has(sidFull);
    const statusDot = isActive
      ? '<span class="status-dot active" title="进行中"></span>'
      : '<span class="status-dot ended" title="已结束"></span>';

    const projectName = projects[sidFull] || '';
    const lastActive = (s.endTime || s.startTime) ? _fmtSessionTime(s.endTime || s.startTime) : '';
    const models = s.models || [];
    const dur = s.avgLatency ? `${(s.avgLatency / 1000).toFixed(1)}s` : '—';
    const cost = s.totalCost ? fmtCost(s.totalCost) : '-';
    const tokens = s.totalTokens ? _fmtTokens(s.totalTokens) : '';

    const titleLine = projectName
      ? `<span class="session-project session-name-editable" data-sid="${escapeHtml(sidFull)}" title="双击编辑名称">${escapeHtml(projectName)}</span>`
      : `<span class="session-sid session-name-editable" data-sid="${escapeHtml(sidFull)}" title="双击编辑名称">${escapeHtml(sidFull.substring(0, 16))}…</span>`;
    const timeLine = lastActive ? `<span class="session-time">${escapeHtml(lastActive)}</span>` : '';
    const modelLine = models.length
      ? `<span class="session-models">${escapeHtml(models.slice(0, 2).map(m => m.length > 14 ? m.substring(0, 14) + '…' : m).join(', '))}</span>`
      : '';
    const metaLine = [tokens ? `${tokens} tok` : '', s.spanCount ? `${s.spanCount} spans` : ''].filter(Boolean).join(' · ');

    const ev = evalMap[sidFull];
    let qualityBadge;
    if (ev && ev.overall != null) {
      const score = ev.overall;
      const cls = score >= 0.7 ? 'badge-green' : score >= 0.4 ? 'badge-orange' : 'badge-red';
      qualityBadge = `<span class="badge ${cls}">${(score * 100).toFixed(0)}</span>`;
    } else {
      const errRate = s.errorCount / Math.max(s.spanCount || 1, 1);
      const badgeCls = errRate > 0.3 ? 'badge-red' : errRate > 0.1 ? 'badge-orange' : 'badge-green';
      const badgeText = errRate > 0.3 ? '异常' : errRate > 0.1 ? '注意' : '正常';
      qualityBadge = `<span class="badge ${badgeCls}">${badgeText}</span>`;
    }

    const humanTurns = s.human_turns || 0;
    const maxTurnMs = s.max_turn_ms || 0;
    const maxTurnStr = maxTurnMs > 0 ? fmtMs(maxTurnMs) : '—';

    const queryLine = s.firstQuery
      ? `<div class="session-info-query">${escapeHtml(s.firstQuery.replace(/<[^>]*>/g, '').substring(0, 80))}${s.firstQuery.length > 80 ? '…' : ''}</div>`
      : '';

    const riskEntry = riskySessionMap.get(sidFull);
    const riskClass = riskEntry ? (riskEntry.severity === 'critical' ? 'session-risk-critical' : 'session-risk-warning') : '';

    return `<tr data-sid="${escapeHtml(sidFull)}" class="${riskClass}" onclick="navigate('l3','${escapeHtml(sidFull)}')">
      <td><div class="session-cell">
        ${statusDot}
        <div class="session-info">
          <div class="session-info-title">${titleLine}${timeLine}</div>
          ${queryLine}
          <div class="session-info-meta">${modelLine}${metaLine ? `<span class="session-meta-sep">${escapeHtml(metaLine)}</span>` : ''}</div>
        </div>
      </div></td>
      <td class="tnum">${dur}</td>
      <td class="tnum">${humanTurns > 0 ? humanTurns + '次' : '—'}</td>
      <td class="tnum">${maxTurnStr}</td>
      <td>${qualityBadge}</td>
      <td class="tnum">${cost}</td>
      <td class="td-action"><button class="btn-edit-session" onclick="event.stopPropagation();editSessionLabel('${escapeHtml(sidFull)}',this)" title="编辑会话标签">编辑</button></td>
    </tr>`;
  }).join('');
}

function _editSessionNameInline(el) {
  const sid = el.dataset.sid;
  const currentName = el.textContent;

  const wrap = document.createElement('span');
  wrap.className = 'session-edit-wrap';
  wrap.style.cssText = 'display:inline-flex;align-items:center;gap:4px;';
  wrap.addEventListener('click', (e) => e.stopPropagation());
  wrap.addEventListener('mousedown', (e) => e.stopPropagation());

  const input = document.createElement('input');
  input.type = 'text';
  input.value = currentName;
  input.style.cssText = 'font-size:13px;font-weight:600;background:var(--surface-2);border:2px solid var(--blue);border-radius:6px;padding:4px 8px;width:220px;color:var(--text);outline:none;';

  const confirmBtn = document.createElement('button');
  confirmBtn.textContent = '✓';
  confirmBtn.style.cssText = 'font-size:14px;width:26px;height:26px;border-radius:6px;background:var(--blue);color:#fff;border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;';

  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = '✕';
  cancelBtn.style.cssText = 'font-size:13px;width:26px;height:26px;border-radius:6px;background:var(--surface-3);color:var(--text-secondary);border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;';

  wrap.append(input, confirmBtn, cancelBtn);
  el.replaceWith(wrap);
  input.focus();
  input.select();

  let committed = false;
  const commit = async (save) => {
    if (committed) return;
    committed = true;
    const newName = save ? input.value.trim() : currentName;
    const span = document.createElement('span');
    span.className = 'session-project session-name-editable';
    span.dataset.sid = sid;
    span.textContent = newName || currentName;
    wrap.replaceWith(span);

    if (save && newName && newName !== currentName) {
      await fetch(`${API}/session/${encodeURIComponent(sid)}/name`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName }),
      }).catch(() => {});
      invalidateCache(`${API}/cc-proxy/session-projects`);
    }
  };

  confirmBtn.addEventListener('click', () => commit(true));
  cancelBtn.addEventListener('click', () => commit(false));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') commit(true);
    if (e.key === 'Escape') commit(false);
  });
  input.addEventListener('blur', () => {
    setTimeout(() => { if (!committed) commit(true); }, 200);
  });
}

function editSessionLabel(sid, btn) {
  const row = btn.closest('tr');
  if (!row) return;
  const nameEl = row.querySelector('.session-project, .session-name-editable');
  if (nameEl) {
    _editSessionNameInline(nameEl);
  } else {
    const titleEl = row.querySelector('.session-info-title');
    if (!titleEl) return;
    const span = document.createElement('span');
    span.className = 'session-project session-name-editable';
    span.dataset.sid = sid;
    span.textContent = sid.substring(0, 12);
    titleEl.prepend(span);
    _editSessionNameInline(span);
  }
}

function _fmtSessionTime(isoStr) {
  const d = new Date(isoStr);
  const now = new Date();
  const diffMs = now - d;
  if (diffMs < 3600000) return `${Math.floor(diffMs / 60000)}分钟前`;
  if (diffMs < 86400000) return `${Math.floor(diffMs / 3600000)}小时前`;
  const month = d.getMonth() + 1;
  const day = d.getDate();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  if (d.getFullYear() === now.getFullYear()) return `${month}/${day} ${hh}:${mm}`;
  return `${d.getFullYear()}/${month}/${day}`;
}

function _fmtTokens(n) {
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(2) + 'B';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(0) + 'K';
  return String(n);
}

// ============ L3: Enhanced Overview ============
async function loadSessionDetail(sid) {
  if (!sid) return;
  currentDetailSid = sid;
  const titleEl = document.getElementById('detailTitle');
  // Show project name or session ID
  const projects = await fetchJSON(`${API}/cc-proxy/session-projects`).catch(() => ({}));
  const displayName = projects[sid] || sid.substring(0, 40);
  titleEl.textContent = displayName;
  titleEl.title = '点击编辑会话名称';
  titleEl.style.cursor = 'pointer';
  titleEl.onclick = () => _startEditSessionName(titleEl, sid, displayName);
  currentDetailPage = { overview: false, waterfall: false, 'quality-eval': false, 'model-dispatch': false, turns: false };
  currentTurnPage = 1;
  _wfCurrentPage = 1;
  loadSessionBinding(sid);
  switchDetailTab('overview');
}

function _startEditSessionName(el, sid, currentName) {
  const input = document.createElement('input');
  input.type = 'text';
  input.value = currentName;
  input.className = 'detail-title-input';
  input.style.cssText = 'font-size:inherit;font-weight:inherit;background:var(--bg-secondary);border:1px solid var(--border);border-radius:4px;padding:2px 6px;width:300px;color:var(--text-primary);outline:none;';
  el.replaceWith(input);
  input.focus();
  input.select();

  const commit = async () => {
    const newName = input.value.trim();
    const titleEl = document.createElement('span');
    titleEl.id = 'detailTitle';
    titleEl.className = 'detail-title';
    titleEl.textContent = newName || sid.substring(0, 40);
    titleEl.title = '点击编辑会话名称';
    titleEl.style.cursor = 'pointer';
    titleEl.onclick = () => _startEditSessionName(titleEl, sid, newName || sid.substring(0, 40));
    input.replaceWith(titleEl);

    if (newName !== currentName) {
      await fetch(`${API}/session/${encodeURIComponent(sid)}/name`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName }),
      }).catch(() => {});
      invalidateCache(`${API}/cc-proxy/session-projects`);
    }
  };

  input.addEventListener('blur', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') input.blur();
    if (e.key === 'Escape') {
      input.value = currentName;
      input.blur();
    }
  });
}

async function loadSessionBinding(sid) {
  const select = document.getElementById('sessionProfileSelect');
  const status = document.getElementById('bindStatus');
  select.value = '';
  status.textContent = '';
  try {
    // Load available profiles and populate dropdown
    const profiles = await fetchJSON(`${API}/strategy/profiles`).catch(() => null);
    if (profiles && profiles.profiles && Array.isArray(profiles.profiles)) {
      const existing = new Set([...select.options].map(o => o.value));
      profiles.profiles.forEach(p => {
        const name = typeof p === 'string' ? p : (p.name || p.id || '');
        if (name && !existing.has(name)) {
          const opt = document.createElement('option');
          opt.value = name;
          opt.textContent = name;
          select.appendChild(opt);
        }
      });
    }
    // Check current binding
    const data = await fetchJSON(`${API}/cc-proxy/active-sessions`).catch(() => ({}));
    const sessions = data.sessions || data.entries || [];
    if (Array.isArray(sessions)) {
      const match = sessions.find(s => s.session_id === sid || (s.session_id && sid.startsWith(s.session_id)));
      if (match && match.bound_profile) {
        select.value = match.bound_profile;
        status.textContent = '已绑定';
      }
    }
  } catch (e) {}
}

async function bindSessionProfile(profile) {
  const sid = currentDetailSid;
  const status = document.getElementById('bindStatus');
  if (!sid) return;
  try {
    if (profile) {
      await fetchJSON(`${API}/session/${encodeURIComponent(sid)}/bind`, {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ profile })
      });
      status.textContent = '已绑定';
      showToast(`Session 已绑定 profile: ${profile}`, 'green');
    } else {
      await fetchJSON(`${API}/session/${encodeURIComponent(sid)}/unbind`, { method: 'POST' });
      status.textContent = '';
      showToast('已解除绑定，恢复规则匹配', 'blue');
    }
  } catch (e) {
    status.textContent = '失败';
    showToast(`绑定失败: ${e.message}`, 'red');
  }
}

function switchDetailTab(tabName) {
  document.querySelectorAll('#detailTabs .tab-seg').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.dtab').forEach(d => d.classList.remove('active'));

  const tabEl = document.querySelector(`[data-dtab="${tabName}"]`);
  if (tabEl) tabEl.classList.add('active');
  const contentEl = document.getElementById(`dtab-${tabName}`);
  if (contentEl) contentEl.classList.add('active');

  // Sliding indicator
  requestAnimationFrame(() => {
    const ind = document.querySelector('#detailTabs .tab-indicator');
    if (ind && tabEl) {
      ind.style.transform = `translateX(${tabEl.offsetLeft - 3}px)`;
      ind.style.width = `${tabEl.offsetWidth}px`;
    }
  });

  if (!currentDetailSid) return;
  if (tabName === 'overview' && !currentDetailPage.overview) loadOverview();
  else if (tabName === 'quality-eval' && !currentDetailPage['quality-eval']) loadQualityEvalTab();
  else if (tabName === 'model-dispatch' && !currentDetailPage['model-dispatch']) loadModelDispatchTab();
  else if (tabName === 'turns' && !currentDetailPage.turns) loadTurnsTab();
  else if (tabName === 'waterfall' && !currentDetailPage.waterfall) loadWaterfallTab();
}

async function loadOverview() {
  try {
    const d = await fetchJSON(`${API}/session/${currentDetailSid}/overview`);
    currentDetailPage.overview = true;
    renderOverview(d);
  } catch (e) {
    document.getElementById('dtab-overview').innerHTML = `<div class="empty">加载失败: ${escapeHtml(e.message)}</div>`;
  }
}

function renderOverview(d) {
  const a = d.analysis || {};
  const q = d.quality || {};
  const r = d.routing || {};
  const c = d.cost || {};
  const analysis = d.deep_analysis || null;
  const costData = d.cost || null;
  const riskLevel = a.risk_level || 'low';
  const riskColor = riskLevel === 'critical' ? 'red' : riskLevel === 'high' ? 'orange' : 'green';

  let fossilHTML = '';
  if (q.fossil_patterns && q.fossil_patterns.length) {
    fossilHTML = `
      <div class="panel-title" style="margin-top:14px">化石死循环</div>
      <table class="fossil-table">
        <thead><tr><th>签名</th><th>工具</th><th>出现轮数</th></tr></thead>
        <tbody>${q.fossil_patterns.map(f => `
          <tr><td class="mono" style="font-size:11px">${escapeHtml(f.signature)}</td><td>${escapeHtml(f.tool_name)}</td><td>${f.seq_count}</td></tr>
        `).join('')}</tbody>
      </table>`;
  }

  let analysisHTML = '';
  if (analysis && !analysis.error) {
    const risk = analysis.risk || {};
    const behav = analysis.behavioral_summary || {};
    const anomaly = analysis.anomaly_detection || {};
    const sinks = analysis.sink_alerts || [];
    const costA = analysis.cost_analysis || {};

    analysisHTML = `
    <div class="panel">
      <div class="panel-title">深度分析</div>
      <div class="stat-grid">
        <div class="stat-box"><div class="stat-num" style="color:var(--${risk.cumulative_score > 50 ? 'red' : risk.cumulative_score > 20 ? 'orange' : 'green'})">${risk.cumulative_score || 0}</div><div class="stat-label">风险评分</div></div>
        <div class="stat-box"><div class="stat-num">${escapeHtml(behav.pattern || '?')}</div><div class="stat-label">行为模式</div></div>
        <div class="stat-box"><div class="stat-num">${anomaly.detection ? (anomaly.detection.confidence * 100).toFixed(0) + '%' : 'N/A'}</div><div class="stat-label">异常置信度</div></div>
        <div class="stat-box"><div class="stat-num">${costA.cache_hit_rate != null ? (costA.cache_hit_rate * 100).toFixed(0) + '%' : 'N/A'}</div><div class="stat-label">缓存命中率</div></div>
      </div>
      ${sinks.length ? `<div style="margin-top:8px"><div class="panel-title">Sink 告警</div>${sinks.map(s => `<div class="anomaly-item"><span class="anomaly-type warning"><span class="dot"></span>${escapeHtml(s.type || 'sink')}</span><span class="anomaly-detail">${escapeHtml(s.detail || s.message || '')}</span></div>`).join('')}</div>` : ''}
    </div>`;
  }

  let costHTML = '';
  if (costData && costData.by_provider && costData.by_provider.length) {
    const maxCost = Math.max(...costData.by_provider.map(b => b.estimated_cost_rmb || 0), 0.0001);
    costHTML = `
    <div class="panel">
      <div class="panel-title">成本明细 <span class="panel-sub">总计: ${fmtCost(costData.total_estimated_cost_rmb || 0)}</span></div>
      ${costData.by_provider.map(b => `
        <div class="cost-row">
          <span>${escapeHtml(b.provider)}/${escapeHtml(b.model)}</span>
          <div class="cost-bar"><div class="cost-bar-fill" style="width:${((b.estimated_cost_rmb || 0) / maxCost * 100).toFixed(1)}%"></div></div>
          <span class="tnum">${fmtCost(b.estimated_cost_rmb)} · ${b.request_count}次</span>
        </div>`).join('')}
    </div>`;
  }

  document.getElementById('dtab-overview').innerHTML = `
    <div class="stat-grid">
      <div class="stat-box"><div class="stat-num" style="color:var(--${riskColor})">${escapeHtml(riskLevel.toUpperCase())}</div><div class="stat-label">风险等级</div></div>
      <div class="stat-box"><div class="stat-num">${escapeHtml(a.behavior_pattern || '?')}</div><div class="stat-label">行为模式</div></div>
      <div class="stat-box"><div class="stat-num">${a.turn_count || 0}</div><div class="stat-label">轮数</div></div>
      <div class="stat-box"><div class="stat-num">${fmtCost(c.total_estimated_cost_rmb || 0)}</div><div class="stat-label">估算成本</div></div>
    </div>

    ${q.total_calls ? `
    <div class="panel">
      <div class="panel-title">工具调用质量</div>
      <div class="quality-bar-wrap">
        <div class="quality-bar">
          <div class="quality-bar-fill ${q.verdict === 'healthy' ? 'green' : q.verdict === 'warning' ? 'yellow' : 'red'}"
               style="width:${q.quality_score || 0}%"></div>
        </div>
        <div class="quality-label">质量分: ${q.quality_score} / 100 · ${q.empty_count}/${q.total_calls} 空参数 · 判定: ${escapeHtml(q.verdict)}</div>
      </div>
      ${fossilHTML}
    </div>` : ''}

    ${r.routing_chain ? `
    <div class="panel">
      <div class="panel-title">Provider 路由 <span class="panel-sub">${r.total_requests} 请求 · ${r.fallback_count} 回退</span></div>
      ${(r.provider_stats || []).map(p => `
        <div style="display:flex;justify-content:space-between;padding:6px 0;font-size:13px;border-bottom:1px solid var(--separator)">
          <span>${escapeHtml(p.provider)}/${escapeHtml(p.model)}</span>
          <span style="color:var(--text-tertiary)">${p.count}次 · ${p.avg_elapsed_ms}ms · ${((p.total_input_tokens||0)/1000).toFixed(0)}K tokens</span>
        </div>`).join('')}
    </div>` : ''}

    ${analysisHTML}
    ${costHTML}
    ${_renderPiiPanel(d.pii_events)}
  `;
}

function _renderPiiPanel(events) {
  if (!events || !events.length) return '';
  const maskEvents = events.filter(e => e.direction === 'mask');
  const unmaskEvents = events.filter(e => e.direction === 'unmask' && e.pii_type !== 'UNKNOWN');
  const uniqueTokens = new Map();
  maskEvents.forEach(e => { if (!uniqueTokens.has(e.token)) uniqueTokens.set(e.token, e); });
  const rows = [...uniqueTokens.values()].map(e => {
    const unmasked = unmaskEvents.some(u => u.token === e.token);
    return `<tr>
      <td><span class="badge badge-${e.pii_type === 'EMAIL' ? 'blue' : e.pii_type === 'PHONE' ? 'green' : 'orange'}">${escapeHtml(e.pii_type)}</span></td>
      <td class="mono" style="font-size:11px">${escapeHtml(e.raw_hint || '***')}</td>
      <td class="mono" style="font-size:11px">${escapeHtml(e.token)}</td>
      <td>seq ${e.seq}</td>
      <td>${unmasked ? '<span style="color:var(--green)">&#10003; unmask</span>' : '<span style="color:var(--text-tertiary)">mask only</span>'}</td>
    </tr>`;
  });
  return `<div class="panel">
    <div class="panel-title">PII Mask/Unmask <span class="panel-sub">${maskEvents.length} mask &middot; ${unmaskEvents.length} unmask</span></div>
    <table class="fossil-table"><thead><tr><th>Type</th><th>Raw Hint</th><th>Token</th><th>Seq</th><th>Status</th></tr></thead>
    <tbody>${rows.join('')}</tbody></table>
  </div>`;
}

// ============ L3: Waterfall Tab ============
let _DANGEROUS_CMD_RE = /rm\s|mkfs|dd\s+if=.*of=\/dev\/|shutdown|reboot|curl.*\|\s*(?:bash|sh)|wget.*\|\s*(?:bash|sh)/i;
let _EXFIL_CMD_RE = /while.*curl|for.*curl.*done|nc\s+-l|ncat\s+-l|bash\s+-i\s+>.*\/dev\/tcp/i;
(async function loadAlertRules() {
  try {
    const r = await fetch(`${API}/alert-rules`);
    if (r.ok) {
      const rules = await r.json();
      if (rules.dangerous) _DANGEROUS_CMD_RE = new RegExp(rules.dangerous.join('|'), 'i');
      if (rules.exfil) _EXFIL_CMD_RE = new RegExp(rules.exfil.join('|'), 'i');
    }
  } catch (_) {}
})();
function _isDangerousToolCall(attrs) {
  const toolName = (attrs.tool_name || '').toLowerCase();
  if (toolName !== 'bash') return false;
  const cmd = attrs.command || attrs.input || '';
  return _DANGEROUS_CMD_RE.test(cmd) || _EXFIL_CMD_RE.test(cmd);
}

let _wfCurrentPage = 1;
const _WF_PAGE_SIZE = 200;

async function loadWaterfallTab(page) {
  if (page === undefined) { _wfCurrentPage = 1; }
  else { _wfCurrentPage = page; }
  try {
    currentDetailPage.waterfall = true;

    // Try cc-proxy waterfall first, fallback to OTLP spans
    let spans = [];
    let source = 'otlp';
    let roleSummary = {};
    let errorSummaryData = {};
    let wfTotalSpans = 0, wfTotalPages = 1;
    try {
      const wf = await fetchJSON(`${API}/session/${currentDetailSid}/waterfall?page=${_wfCurrentPage}&page_size=${_WF_PAGE_SIZE}`);
      if (wf.spans && wf.spans.length > 0) {
        spans = wf.spans;
        source = 'cc-proxy';
      }
      roleSummary = wf.role_summary || {};
      errorSummaryData = wf.error_summary || {};
      wfTotalSpans = wf.total_spans || spans.length;
      wfTotalPages = wf.total_pages || 1;
    } catch (_) {}

    if (!spans.length) {
      const d = await fetchJSON(`${API}/session/${currentDetailSid}`);
      spans = d.spans || [];
    }

    if (!spans.length) {
      document.getElementById('dtab-waterfall').innerHTML = '<div class="empty">暂无 Trace 数据</div>';
      return;
    }

    // Build compressed timeline — collapse idle gaps between active spans
    const displaySpans = spans;
    const COMPRESSED_GAP = 200;
    const spanIntervals = [];
    for (const s of displaySpans) {
      const st = tsToMs(s.start_time || s.startTime || 0);
      const dur = s.duration_ms || s.durationMs || 0;
      const et = tsToMs(s.end_time || s.endTime || 0) || (st + dur);
      if (st > 0) spanIntervals.push({ s: st, e: Math.max(et, st + 1) });
    }
    spanIntervals.sort((a, b) => a.s - b.s);
    // Merge overlapping intervals to find active periods
    const active = [];
    for (const iv of spanIntervals) {
      if (active.length && iv.s <= active[active.length - 1].e) {
        active[active.length - 1].e = Math.max(active[active.length - 1].e, iv.e);
      } else {
        active.push({ s: iv.s, e: iv.e });
      }
    }
    // Build segments from active periods, compressing gaps between them
    const _segs = [];
    let cs = 0;
    for (let i = 0; i < active.length; i++) {
      _segs.push({ rs: active[i].s, re: active[i].e, cs });
      cs += (active[i].e - active[i].s) + COMPRESSED_GAP;
    }
    const totalDur = _segs.length > 0
      ? _segs[_segs.length - 1].cs + (_segs[_segs.length - 1].re - _segs[_segs.length - 1].rs) || 1
      : 1;
    function _tc(t) {
      for (let i = _segs.length - 1; i >= 0; i--) {
        if (t >= _segs[i].rs) return _segs[i].cs + (t - _segs[i].rs);
      }
      return 0;
    }

    const legend = `<div class="waterfall-legend">
      <span><span class="dot" style="background:var(--blue)"></span>LLM调用</span>
      <span><span class="dot" style="background:var(--purple, #a855f7)"></span>用户输入</span>
      <span><span class="dot" style="background:var(--green)"></span>工具</span>
      <span><span class="dot" style="background:var(--orange)"></span>PII Mask</span>
      <span><span class="dot" style="background:var(--red)"></span>已拒绝</span>
      <span><span class="dot" style="background:var(--indigo, #5856D6)"></span>文本回复</span>
      <span><span class="dot" style="background:var(--gray, #999)"></span>思考</span>
      <span><span class="dot" style="background:var(--red, #ef4444)"></span>失败尝试</span>
      ${source === 'cc-proxy' ? '<span class="badge badge-gray" style="font-size:9px;margin-left:8px">cc-proxy</span>' : ''}
    </div>`;

    // Role summary from backend (if available)
    let roleSummaryHtml = '';
    if (roleSummary && Object.keys(roleSummary).length > 0) {
      const rsItems = Object.entries(roleSummary)
        .sort((a, b) => b[1].count - a[1].count)
        .map(([rf, v]) => {
          const tokens = v.total_tokens ? ` · ${(v.total_tokens / 1000).toFixed(1)}K tok` : '';
          return `<span class="role-badge role-${rf}">${rf}: ${v.count}${tokens}</span>`;
        }).join('');
      roleSummaryHtml = `<div style="margin-bottom:10px;padding:6px 0;font-size:11px;">${rsItems}</div>`;
    }

    // Error summary from backend (if available)
    let errorSummaryHtml = '';
    if (Object.keys(errorSummaryData).length > 0) {
      const esItems = Object.entries(errorSummaryData)
        .sort((a, b) => b[1].count - a[1].count)
        .map(([pm, v]) => `<span class="role-badge role-error">${escapeHtml(pm)}: ${v.count}次 · ${fmtMs(v.total_latency_ms)}</span>`)
        .join('');
      errorSummaryHtml = `<div style="margin-bottom:8px;font-size:11px;">失败尝试: ${esItems}</div>`;
    }

    const kindLabels = { llm: 'LLM调用', user_prompt: '用户输入', tool: '工具', llm_response: 'LLM回复', thinking: '思考', provider_error: '失败尝试', pii_mask: 'PII Mask' };
    const existingKinds = new Set(spans.map(s => { const k = (s.kind || s.type || '').toLowerCase(); return k === 'tool_call' ? 'tool' : k; }));
    const spanKinds = ['llm', 'user_prompt', 'pii_mask', 'tool', 'llm_response', 'thinking', 'provider_error'].filter(k => existingKinds.has(k));
    const agentRoles = [...new Set(spans.filter(s => (s.kind || s.type) === 'llm' && (s.attributes || {}).agent_role)
      .map(s => s.attributes.agent_role))].sort();

    let filterDropdownHtml = '<div class="wf-fd-section">类型</div>';
    for (const k of spanKinds) {
      filterDropdownHtml += `<label><input type="checkbox" data-filter="kind" value="${k}" checked>${kindLabels[k]}</label>`;
    }
    if (agentRoles.length > 0) {
      filterDropdownHtml += '<div class="wf-fd-section" style="margin-top:4px">Agent Role</div>';
      for (const r of agentRoles) {
        filterDropdownHtml += `<label><input type="checkbox" data-filter="role" value="${escapeHtml(r)}" checked>${escapeHtml(r)}</label>`;
      }
    }
    filterDropdownHtml += `<div class="wf-fd-actions"><span id="wfFilterAll">全选</span><span id="wfFilterNone">清空</span></div>`;

    const header = `<div class="waterfall-header">
      <span>名称</span>
      <span class="wf-col-filter">类型<button class="wf-filter-btn" id="wfFilterToggle">&#9662;</button>
        <div class="wf-filter-dropdown" id="wfFilterDropdown">${filterDropdownHtml}</div>
      </span>
      <span>时间线</span><span>耗时</span>
    </div>`;

    const rows = displaySpans.map((s, i) => {
      const name = s.name || s.operationName || `span-${i}`;
      const st = tsToMs(s.start_time || s.startTime || 0);
      const durMs = s.duration_ms || s.durationMs || 0;
      const et = tsToMs(s.end_time || s.endTime || 0) || (st + durMs);
      const dur = durMs || (et - st);
      const leftPct = _tc(st) / totalDur * 100;
      const rightPct = _tc(et) / totalDur * 100;
      const left = leftPct.toFixed(4);
      const width = Math.max(rightPct - leftPct, 0.15).toFixed(4);
      const kind = (s.kind || s.type || '').toLowerCase();
      const attrs = s.attributes || s.attrs || {};
      const isFallback = attrs.fallback === true;

      let barClass, badgeClass, badgeLabel, roleBadgeHtml = '';
      if (kind === 'user_prompt') {
        barClass = 'bar-prompt'; badgeClass = 'badge-purple'; badgeLabel = '用户输入';
      } else if (kind === 'tool' || kind === 'tool_call') {
        if (attrs._result_rejected) {
          barClass = 'bar-error'; badgeClass = 'badge-red'; badgeLabel = '已拒绝';
        } else if (attrs._result_is_error) {
          barClass = 'bar-fallback'; badgeClass = 'badge-orange'; badgeLabel = '工具异常';
        } else if (_isDangerousToolCall(attrs)) {
          barClass = 'bar-risk'; badgeClass = 'badge-red'; badgeLabel = '高危操作';
        } else {
          barClass = 'bar-tool'; badgeClass = 'badge-green'; badgeLabel = '工具';
        }
      } else if (kind === 'tool_result') {
        if (_isDangerousToolCall(attrs)) {
          barClass = 'bar-risk'; badgeClass = 'badge-red'; badgeLabel = '高危结果';
        } else {
          barClass = 'bar-result'; badgeClass = 'badge-teal'; badgeLabel = '工具结果';
        }
      } else if (kind === 'llm_response') {
        const rt = attrs.response_type || 'text';
        if (rt === 'reasoning') {
          barClass = 'bar-response'; badgeClass = 'badge-purple'; badgeLabel = '推理';
        } else {
          barClass = 'bar-response'; badgeClass = 'badge-blue'; badgeLabel = '文本回复';
        }
      } else if (kind === 'thinking') {
        barClass = 'bar-thinking'; badgeClass = 'badge-gray'; badgeLabel = '思考';
      } else if (kind === 'llm') {
        const rf = attrs.role_family || '';
        const ar = attrs.agent_role || '';
        barClass = isFallback ? 'bar-fallback' : (rf ? `bar-llm role-${rf}` : 'bar-llm');
        badgeClass = isFallback ? 'badge-orange' : 'badge-blue';
        badgeLabel = isFallback ? 'Fallback' : 'LLM';
        roleBadgeHtml = ar ? `<span class="role-badge role-${rf || 'main'}" title="${escapeHtml(ar)}">${escapeHtml(ar)}</span>` : '';
      } else if (kind === 'provider_error') {
        barClass = 'bar-error'; badgeClass = 'badge-red'; badgeLabel = '失败尝试';
      } else if (kind === 'pii_mask') {
        barClass = 'bar-prompt'; badgeClass = 'badge-orange'; badgeLabel = 'PII Mask';
      } else {
        barClass = 'bar-llm'; badgeClass = 'badge-blue'; badgeLabel = 'LLM';
      }

      const depth = s.depth || 0;

      // Build detail panel based on type
      let detailHtml = '';
      if (kind === 'llm') {
        const parts = [];
        if (attrs.agent_role) parts.push(`Agent Role: ${attrs.agent_role}`);
        if (attrs.requested_model) parts.push(`请求模型: ${attrs.requested_model}`);
        if (attrs.actual_model) parts.push(`实际模型: ${attrs.actual_model}`);
        if (attrs.provider) parts.push(`Provider: ${attrs.provider}`);
        if (isFallback) parts.push(`⚠ Fallback: 是 (详见下方 "失败尝试" 条目)`);
        if (attrs.input_tokens) parts.push(`Input Tokens: ${_fmtTokens(Number(attrs.input_tokens))}`);
        if (attrs.output_tokens) parts.push(`Output Tokens: ${_fmtTokens(Number(attrs.output_tokens))}`);
        if (attrs.message_count) parts.push(`消息数: ${attrs.message_count}`);
        if (attrs.elapsed_ms) parts.push(`耗时: ${fmtMs(attrs.elapsed_ms)}`);
        detailHtml = `<pre>${escapeHtml(parts.join('\n'))}</pre>`;
      } else if (kind === 'user_prompt') {
        const parts = [];
        if (attrs.has_pii && attrs.pii_replacements && attrs.pii_replacements.length) {
          parts.push('── 用户输入 ──');
          parts.push(attrs.text || '');
          parts.push('');
          parts.push('── PII 替换 ──');
          for (const r of attrs.pii_replacements) {
            parts.push(`  ${r.hint || '***'}  →  ${r.token}  (${r.type})`);
          }
        } else if (attrs.has_pii && attrs.text_original && attrs.text_masked && attrs.text_original !== attrs.text_masked) {
          parts.push('── Mask 前 ──');
          parts.push(attrs.text_original);
          parts.push('');
          parts.push('── Mask 后 ──');
          parts.push(attrs.text_masked);
        } else {
          parts.push(attrs.text || attrs.text_original || '');
        }
        detailHtml = `<pre>${escapeHtml(parts.join('\n'))}</pre>`;
        if (attrs.has_pii) {
          badgeLabel = '用户输入 (PII)';
          badgeClass = 'badge-orange';
        }
      } else if (kind === 'pii_mask') {
        const parts = ['── PII Mask 替换 ──', ''];
        const reps = attrs.replacements || [];
        for (const r of reps) {
          parts.push(`  ${r.hint || '***'}  →  ${r.token}  (${r.type})`);
        }
        if (attrs.count > reps.length) {
          parts.push(`\n共 ${attrs.count} 次替换 (${reps.length} 个唯一值)`);
        }
        detailHtml = `<pre>${escapeHtml(parts.join('\n'))}</pre>`;
      } else if (kind === 'tool' || kind === 'tool_call') {
        const head = `工具: ${attrs.tool_name || '?'}\nID: ${attrs.tool_use_id || ''}`;
        const params = Object.entries(attrs)
          .filter(([k]) => !['tool_name', 'tool_use_id', '_result_content', '_result_is_error'].includes(k))
          .map(([k, v]) => `  ${k}: ${v}`).join('\n');
        let resultSection = '';
        if (attrs._result_content != null) {
          const errTag = attrs._result_is_error ? ' [ERROR]' : '';
          resultSection = `\n\n── 结果${errTag} ──\n${attrs._result_content}`;
        }
        detailHtml = `<pre>${escapeHtml(head + '\n\n参数:\n' + params + resultSection)}</pre>`;
      } else if (kind === 'tool_result') {
        const head = `工具: ${attrs.tool_name || '?'}${attrs.is_error ? ' [ERROR]' : ''}\nID: ${attrs.tool_use_id || ''}\n\n结果:\n`;
        detailHtml = `<pre>${escapeHtml(head + (attrs.content || ''))}</pre>`;
      } else if (kind === 'llm_response') {
        const parts = [];
        if (attrs.response_type === 'reasoning') {
          parts.push('类型: 推理/工具调用意图');
          if (attrs.tool_names) parts.push(`目标工具: ${attrs.tool_names}`);
        } else {
          parts.push('类型: 文本回复');
        }
        if (attrs.stop_reason) parts.push(`Stop Reason: ${attrs.stop_reason}`);
        if (attrs.has_thinking) parts.push('含思考过程: 是');
        parts.push('');
        parts.push(attrs.text || '');
        detailHtml = `<pre>${escapeHtml(parts.join('\n'))}</pre>`;
      } else if (kind === 'thinking') {
        detailHtml = `<pre>${escapeHtml(attrs.text || '')}</pre>`;
      } else if (kind === 'provider_error') {
        const parts = [];
        parts.push(`Provider: ${attrs.provider_model || '?'}`);
        parts.push(`错误分类: ${attrs.error_class || '?'}`);
        parts.push(`延迟: ${fmtMs(attrs.latency_ms || 0)}`);
        parts.push(`\n错误详情:\n${attrs.error || ''}`);
        detailHtml = `<pre>${escapeHtml(parts.join('\n'))}</pre>`;
      } else {
        const attrStr = Object.entries(attrs).map(([k, v]) => `${k}: ${v}`).join('\n');
        detailHtml = attrStr ? `<pre>${escapeHtml(attrStr)}</pre>` : '<span style="color:var(--text-tertiary)">无属性</span>';
      }

      const agentRole = (attrs.agent_role || '');
      const riskRowClass = barClass === 'bar-risk' ? ' wf-row-risk' : '';
      if (riskRowClass) {
        const cmd = attrs.command || attrs.input || '';
        detailHtml += `<div class="wf-risk-actions"><button class="btn-false-positive" onclick="event.stopPropagation();reportWaterfallFalsePositive(this,'${escapeHtml(currentDetailSid)}','${escapeHtml(cmd.substring(0,200))}')">误报</button></div>`;
      }

      return `<div class="waterfall-row${riskRowClass}" data-kind="${kind}" data-role="${escapeHtml(agentRole)}" data-depth="${depth}" onclick="this.nextElementSibling.classList.toggle('open')">
        <span class="wf-name">${escapeHtml(name)}</span>
        <span class="wf-type"><span class="badge ${badgeClass}">${escapeHtml(badgeLabel)}</span>${roleBadgeHtml}</span>
        <div class="waterfall-track"><div class="waterfall-bar ${barClass}" style="left:${left}%;width:${width}%"></div></div>
        <span class="wf-dur">${dur > 0 ? fmtMs(dur) : '-'}</span>
      </div>
      <div class="waterfall-detail${riskRowClass}" data-kind="${kind}">${detailHtml}</div>`;
    }).join('');

    const startIdx = (_wfCurrentPage - 1) * _WF_PAGE_SIZE + 1;
    const endIdx = Math.min(_wfCurrentPage * _WF_PAGE_SIZE, wfTotalSpans);
    let paginationHtml = '';
    if (wfTotalPages > 1) {
      const prevDisabled = _wfCurrentPage <= 1 ? 'disabled' : '';
      const nextDisabled = _wfCurrentPage >= wfTotalPages ? 'disabled' : '';
      paginationHtml = `<div class="wf-pagination">
        <button class="wf-page-btn" ${prevDisabled} onclick="loadWaterfallTab(${_wfCurrentPage - 1})">&#8592; 上一页</button>
        <span class="wf-page-info">第 ${_wfCurrentPage} / ${wfTotalPages} 页 &nbsp;(${startIdx}–${endIdx} / 共 ${wfTotalSpans} 条)</span>
        <button class="wf-page-btn" ${nextDisabled} onclick="loadWaterfallTab(${_wfCurrentPage + 1})">下一页 &#8594;</button>
      </div>`;
    } else if (wfTotalSpans > 0) {
      paginationHtml = `<div class="wf-pagination"><span class="wf-page-info">共 ${wfTotalSpans} 条</span></div>`;
    }

    document.getElementById('dtab-waterfall').innerHTML = legend + roleSummaryHtml + errorSummaryHtml + header + `<div class="waterfall-container">${rows}</div>` + paginationHtml;

    const filterToggle = document.getElementById('wfFilterToggle');
    const filterDropdown = document.getElementById('wfFilterDropdown');
    if (filterToggle && filterDropdown) {
      filterToggle.addEventListener('click', (e) => {
        e.stopPropagation();
        filterDropdown.classList.toggle('open');
      });
      if (window._wfFilterDocClick) {
        document.removeEventListener('click', window._wfFilterDocClick);
      }
      window._wfFilterDocClick = (e) => {
        if (!filterDropdown.contains(e.target) && e.target !== filterToggle) {
          filterDropdown.classList.remove('open');
        }
      };
      document.addEventListener('click', window._wfFilterDocClick);
      filterDropdown.querySelectorAll('input[type="checkbox"]').forEach(cb => {
        cb.addEventListener('change', () => {
          _applyWaterfallFilter();
          const total = filterDropdown.querySelectorAll('input[type="checkbox"]').length;
          const checked = filterDropdown.querySelectorAll('input[type="checkbox"]:checked').length;
          filterToggle.classList.toggle('has-filter', checked < total);
        });
      });
      const allBtn = document.getElementById('wfFilterAll');
      const noneBtn = document.getElementById('wfFilterNone');
      if (allBtn) allBtn.addEventListener('click', () => {
        filterDropdown.querySelectorAll('input[type="checkbox"]').forEach(cb => { cb.checked = true; });
        _applyWaterfallFilter();
        filterToggle.classList.remove('has-filter');
      });
      if (noneBtn) noneBtn.addEventListener('click', () => {
        filterDropdown.querySelectorAll('input[type="checkbox"]').forEach(cb => { cb.checked = false; });
        _applyWaterfallFilter();
        filterToggle.classList.add('has-filter');
      });
    }
  } catch (e) {
    document.getElementById('dtab-waterfall').innerHTML = `<div class="empty">暂无数据: ${escapeHtml(e.message)}</div>`;
  }
}

function _applyWaterfallFilter() {
  const dropdown = document.getElementById('wfFilterDropdown');
  if (!dropdown) return;
  const kindCbs = dropdown.querySelectorAll('input[data-filter="kind"]');
  const activeKinds = new Set([...kindCbs].filter(cb => cb.checked).map(cb => cb.value));
  const allKinds = activeKinds.size === 0 || activeKinds.size === kindCbs.length;

  const roleCbs = dropdown.querySelectorAll('input[data-filter="role"]');
  const activeRoles = new Set([...roleCbs].filter(cb => cb.checked).map(cb => cb.value));
  const allRoles = roleCbs.length === 0 || activeRoles.size === 0 || activeRoles.size === roleCbs.length;

  document.querySelectorAll('.waterfall-row').forEach(row => {
    const kind = row.dataset.kind;
    const role = row.dataset.role || '';
    const kindMatch = allKinds || activeKinds.has(kind) || (kind === 'tool_call' && activeKinds.has('tool'));
    let roleMatch = allRoles || kind !== 'llm' || !role;
    if (!roleMatch) {
      roleMatch = activeRoles.has(role);
    }
    const show = kindMatch && roleMatch;
    row.style.display = show ? '' : 'none';
    row.nextElementSibling.style.display = show ? '' : 'none';
  });
}

// ============ L3: Generations Tab ============
async function loadGenerationsTab() {
  try {
    const data = await fetchJSON(`${API}/generations?session=${encodeURIComponent(currentDetailSid)}`);
    currentDetailPage.generations = true;
    const gens = data.generations || [];
    const summary = data.summary || {};

    if (!gens.length) {
      document.getElementById('dtab-generations').innerHTML = '<div class="empty">暂无 Generation 数据</div>';
      return;
    }

    const cardsHTML = `<div class="stat-grid">
      <div class="stat-box"><div class="stat-num">${summary.count || gens.length}</div><div class="stat-label">调用次数</div></div>
      <div class="stat-box"><div class="stat-num">${fmtCost(summary.total_cost || 0)}</div><div class="stat-label">总成本</div></div>
      <div class="stat-box"><div class="stat-num">${fmtNum(summary.total_tokens || 0)}</div><div class="stat-label">总 Tokens</div></div>
      <div class="stat-box"><div class="stat-num">${fmtMs(summary.avg_latency_ms || 0)}</div><div class="stat-label">平均延迟</div></div>
    </div>`;

    const tableHTML = renderGenerationsTable(gens);
    document.getElementById('dtab-generations').innerHTML = cardsHTML + tableHTML;
  } catch (e) {
    document.getElementById('dtab-generations').innerHTML = `<div class="empty">暂无数据: ${escapeHtml(e.message)}</div>`;
  }
}

function renderGenerationsTable(gens) {
  return `<div class="table-wrap"><table class="gen-table">
    <thead><tr><th>模型</th><th>Input</th><th>Output</th><th>延迟</th><th>成本</th><th>预览</th></tr></thead>
    <tbody>${gens.map(g => `<tr>
      <td><span class="model-chip">${escapeHtml((g.model || '?').length > 20 ? (g.model || '?').substring(0, 20) + '…' : (g.model || '?'))}</span></td>
      <td class="tnum">${_fmtTokens(g.input_tokens || 0)}</td>
      <td class="tnum">${_fmtTokens(g.output_tokens || 0)}</td>
      <td class="tnum">${fmtMs(g.duration_ms || 0)}</td>
      <td class="tnum">${fmtCost(g.cost_rmb || 0)}</td>
      <td><div class="gen-preview">${escapeHtml(g.completion_preview || g.prompt_preview || '')}</div></td>
    </tr>`).join('')}</tbody>
  </table></div>`;
}

// ============ L3: Scores Tab ============
async function loadScoresTab() {
  try {
    const [autoScores, manualScores, evaluation] = await Promise.all([
      fetchJSON(`${API}/scores/auto/${encodeURIComponent(currentDetailSid)}`).catch(() => []),
      fetchJSON(`${API}/scores?session=${encodeURIComponent(currentDetailSid)}`).catch(() => []),
      fetchJSON(`${API}/evaluations?session=${encodeURIComponent(currentDetailSid)}`).catch(() => []),
    ]);
    currentDetailPage.scores = true;

    const allScores = [...(autoScores || []), ...(manualScores || [])];
    const ev = Array.isArray(evaluation) && evaluation.length ? evaluation[0] : null;

    let radarHTML = '';
    if (ev) {
      const dims = ['task_completion', 'efficiency', 'safety', 'intent_alignment', 'overall'];
      const vals = dims.map(d => (ev[d] || 0) * 100);
      radarHTML = `<div class="panel"><div class="panel-title">质量维度</div>
        <div class="stat-grid">${dims.map((d, i) => {
          const color = vals[i] >= 70 ? 'green' : vals[i] >= 40 ? 'orange' : 'red';
          return `<div class="stat-box"><div class="stat-num" style="color:var(--${color})">${vals[i].toFixed(0)}</div><div class="stat-label">${escapeHtml(d)}</div></div>`;
        }).join('')}</div>
      </div>`;
    }

    let scoresHTML = '';
    if (allScores.length) {
      scoresHTML = `<div class="panel"><div class="panel-title">评分记录</div>
        ${allScores.map(s => {
          const numVal = parseFloat(s.value);
          const isNum = !isNaN(numVal);
          const pct = isNum ? Math.min(numVal * (numVal <= 1 ? 100 : 1), 100) : 0;
          const color = pct >= 70 ? 'var(--green)' : pct >= 40 ? 'var(--orange)' : 'var(--red)';
          return `<div class="score-row">
            <span class="score-name">${escapeHtml(s.name)}</span>
            ${isNum ? `<div class="score-bar-wrap"><div class="score-bar-fill" style="width:${pct}%;background:${color}"></div></div>` : ''}
            <span class="score-value">${escapeHtml(String(s.value))}</span>
            <span class="badge badge-gray">${escapeHtml(s.source || '?')}</span>
          </div>`;
        }).join('')}
      </div>`;
    }

    const formHTML = `<div class="score-form">
      <div class="panel-title">提交评分</div>
      <label>指标名称</label>
      <input type="text" id="scoreNameInput" placeholder="e.g. helpfulness">
      <label>分值 (0-1)</label>
      <input type="number" id="scoreValueInput" min="0" max="1" step="0.1" placeholder="0.8">
      <label>备注</label>
      <textarea id="scoreCommentInput" placeholder="可选备注…"></textarea>
      <button class="btn-filled" onclick="submitScore()">提交</button>
    </div>`;

    document.getElementById('dtab-scores').innerHTML = radarHTML + scoresHTML + formHTML;
  } catch (e) {
    document.getElementById('dtab-scores').innerHTML = `<div class="empty">暂无数据: ${escapeHtml(e.message)}</div>`;
  }
}

async function submitScore() {
  const name = document.getElementById('scoreNameInput').value.trim();
  const value = parseFloat(document.getElementById('scoreValueInput').value);
  const comment = document.getElementById('scoreCommentInput').value.trim();
  if (!name || isNaN(value)) return;

  try {
    await fetch(`${API}/scores`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: currentDetailSid, name, value, comment, source: 'manual' }),
    });
    currentDetailPage['quality-eval'] = false;
    loadQualityEvalTab();
  } catch (e) {
    console.error('Submit score failed:', e);
  }
}

function tsToMs(v) {
  if (!v) return 0;
  if (typeof v === 'number') return v > 1e15 ? v / 1e6 : v > 1e12 ? v : v * 1000;
  return new Date(v).getTime() || 0;
}

async function loadQualityTab() {
  try {
    const q = await fetchJSON(`${API}/session/${currentDetailSid}/tool-quality`);
    currentDetailPage.quality = true;
    const verdictColor = q.verdict === 'healthy' ? 'green' : q.verdict === 'warning' ? 'orange' : 'red';
    document.getElementById('dtab-quality').innerHTML = `
      <div class="stat-grid">
        <div class="stat-box"><div class="stat-num" style="color:var(--${verdictColor})">${escapeHtml(q.verdict.toUpperCase())}</div><div class="stat-label">判定</div></div>
        <div class="stat-box"><div class="stat-num">${q.quality_score}</div><div class="stat-label">质量评分 / 100</div></div>
        <div class="stat-box"><div class="stat-num">${q.empty_count}/${q.total_calls}</div><div class="stat-label">空参数调用</div></div>
        <div class="stat-box"><div class="stat-num">${q.fossil_count}</div><div class="stat-label">化石死循环</div></div>
      </div>
      ${q.fossil_patterns && q.fossil_patterns.length ? `
      <div class="panel">
        <div class="panel-title">化石死循环详情</div>
        <table class="fossil-table">
          <thead><tr><th>签名</th><th>工具</th><th>出现序列号</th></tr></thead>
          <tbody>${q.fossil_patterns.map(f => `
            <tr><td class="mono" style="font-size:11px">${escapeHtml(f.signature)}</td><td>${escapeHtml(f.tool_name)}</td><td>${(f.unique_seqs||[]).join(', ')}</td></tr>
          `).join('')}</tbody>
        </table>
      </div>` : ''}
      ${q.top_empty_tools && q.top_empty_tools.length ? `
      <div class="panel">
        <div class="panel-title">最多空参数的工具</div>
        ${q.top_empty_tools.map(t => `<div style="display:flex;justify-content:space-between;padding:6px 0;font-size:13px;border-bottom:1px solid var(--separator)"><span>${escapeHtml(t.tool_name)}</span><span style="color:var(--text-tertiary)">${t.count} 次</span></div>`).join('')}
      </div>` : ''}
    `;
  } catch (e) {
    document.getElementById('dtab-quality').innerHTML = `<div class="empty">暂无数据: ${escapeHtml(e.message)}</div>`;
  }
}

async function loadRoutingTab() {
  try {
    const r = await fetchJSON(`${API}/session/${currentDetailSid}/routes`);
    currentDetailPage.routing = true;

    let chainHTML = '';
    if (r.routing_chain) {
      chainHTML = r.routing_chain.slice(0, 30).map(h =>
        `<tr>
          <td class="tnum">${h.seq}</td>
          <td>${escapeHtml(h.requested_model)}</td>
          <td>${h.fallback ? '↪' : '→'} ${escapeHtml(h.actual_model)}</td>
          <td>${escapeHtml(h.actual_provider)}</td>
          <td class="tnum">${h.elapsed_ms}ms</td>
          <td class="tnum">${((h.input_tokens||0)/1000).toFixed(1)}K</td>
        </tr>`
      ).join('');
    }

    document.getElementById('dtab-routing').innerHTML = `
      <div class="stat-grid">
        <div class="stat-box"><div class="stat-num">${r.total_requests || 0}</div><div class="stat-label">总请求</div></div>
        <div class="stat-box"><div class="stat-num">${r.fallback_count || 0}</div><div class="stat-label">回退次数</div></div>
        <div class="stat-box"><div class="stat-num">${r.fallback_rate ? (r.fallback_rate*100).toFixed(0)+'%' : '0%'}</div><div class="stat-label">回退率</div></div>
      </div>
      ${chainHTML ? `
      <div class="panel">
        <div class="panel-title">路由链</div>
        <div class="table-wrap">
          <table class="fossil-table">
            <thead><tr><th>Seq</th><th>请求模型</th><th>实际模型</th><th>Provider</th><th>耗时</th><th>Tokens</th></tr></thead>
            <tbody>${chainHTML}</tbody>
          </table>
        </div>
      </div>` : ''}
      ${r.anomalies && r.anomalies.length ? `
      <div class="panel">
        <div class="panel-title">路由异常</div>
        ${r.anomalies.map(a => `<div class="anomaly-item"><span class="anomaly-type ${a.severity}"><span class="dot"></span>${escapeHtml(a.type)}</span><span class="anomaly-detail">${escapeHtml(a.detail)}</span></div>`).join('')}
      </div>` : ''}
    `;
  } catch (e) {
    document.getElementById('dtab-routing').innerHTML = `<div class="empty">暂无数据: ${escapeHtml(e.message)}</div>`;
  }
}

async function loadTurnsTab() {
  currentDetailPage.turns = true;
  await loadTurnPage(1);
}

// ============ L3: Combined Quality+Eval Tab ============
async function loadQualityEvalTab() {
  const container = document.getElementById('dtab-quality-eval');
  try {
    const [q, autoScores, manualScores, evaluation] = await Promise.all([
      fetchJSON(`${API}/session/${currentDetailSid}/tool-quality`),
      fetchJSON(`${API}/scores/auto/${encodeURIComponent(currentDetailSid)}`).catch(() => []),
      fetchJSON(`${API}/scores?session=${encodeURIComponent(currentDetailSid)}`).catch(() => []),
      fetchJSON(`${API}/evaluations?session=${encodeURIComponent(currentDetailSid)}`).catch(() => []),
    ]);
    currentDetailPage['quality-eval'] = true;

    const verdictColor = q.verdict === 'healthy' ? 'green' : q.verdict === 'warning' ? 'orange' : 'red';
    let qualityHTML = `
      <div class="panel"><div class="panel-title">工具调用质量</div>
      <div class="stat-grid">
        <div class="stat-box"><div class="stat-num" style="color:var(--${verdictColor})">${escapeHtml(q.verdict.toUpperCase())}</div><div class="stat-label">判定</div></div>
        <div class="stat-box"><div class="stat-num">${q.quality_score}</div><div class="stat-label">质量评分 / 100</div></div>
        <div class="stat-box"><div class="stat-num">${q.empty_count}/${q.total_calls}</div><div class="stat-label">空参数调用</div></div>
        <div class="stat-box"><div class="stat-num">${q.fossil_count}</div><div class="stat-label">化石死循环</div></div>
      </div>
      ${q.fossil_patterns && q.fossil_patterns.length ? `
        <table class="fossil-table"><thead><tr><th>签名</th><th>工具</th><th>出现序列号</th></tr></thead>
        <tbody>${q.fossil_patterns.map(f => `<tr><td class="mono" style="font-size:11px">${escapeHtml(f.signature)}</td><td>${escapeHtml(f.tool_name)}</td><td>${(f.unique_seqs||[]).join(', ')}</td></tr>`).join('')}</tbody></table>` : ''}
      ${q.top_empty_tools && q.top_empty_tools.length ? `
        <div style="margin-top:12px"><div class="panel-title">最多空参数的工具</div>
        ${q.top_empty_tools.map(t => `<div style="display:flex;justify-content:space-between;padding:6px 0;font-size:13px;border-bottom:1px solid var(--separator)"><span>${escapeHtml(t.tool_name)}</span><span style="color:var(--text-tertiary)">${t.count} 次</span></div>`).join('')}</div>` : ''}
      </div>`;

    const ev = Array.isArray(evaluation) && evaluation.length ? evaluation[0] : null;
    let evalHTML = '';
    if (ev) {
      const dims = ['task_completion', 'efficiency', 'safety', 'intent_alignment', 'overall'];
      const vals = dims.map(d => (ev[d] || 0) * 100);
      evalHTML = `<div class="panel"><div class="panel-title">质量维度评估</div>
        <div class="stat-grid">${dims.map((d, i) => {
          const color = vals[i] >= 70 ? 'green' : vals[i] >= 40 ? 'orange' : 'red';
          return `<div class="stat-box"><div class="stat-num" style="color:var(--${color})">${vals[i].toFixed(0)}</div><div class="stat-label">${escapeHtml(d)}</div></div>`;
        }).join('')}</div></div>`;
    }

    const allScores = [...(autoScores || []), ...(manualScores || [])];
    let scoresHTML = '';
    if (allScores.length) {
      scoresHTML = `<div class="panel"><div class="panel-title">评分记录</div>
        ${allScores.map(s => {
          const numVal = parseFloat(s.value);
          const isNum = !isNaN(numVal);
          const pct = isNum ? Math.min(numVal * (numVal <= 1 ? 100 : 1), 100) : 0;
          const color = pct >= 70 ? 'var(--green)' : pct >= 40 ? 'var(--orange)' : 'var(--red)';
          return `<div class="score-row"><span class="score-name">${escapeHtml(s.name)}</span>${isNum ? `<div class="score-bar-wrap"><div class="score-bar-fill" style="width:${pct}%;background:${color}"></div></div>` : ''}<span class="score-value">${escapeHtml(String(s.value))}</span><span class="badge badge-gray">${escapeHtml(s.source || '?')}</span></div>`;
        }).join('')}</div>`;
    }

    const formHTML = `<div class="score-form"><div class="panel-title">提交评分</div>
      <label>指标名称</label><input type="text" id="scoreNameInput" placeholder="e.g. helpfulness">
      <label>分值 (0-1)</label><input type="number" id="scoreValueInput" min="0" max="1" step="0.1" placeholder="0.8">
      <label>备注</label><textarea id="scoreCommentInput" placeholder="可选备注…"></textarea>
      <button class="btn-filled" onclick="submitScore()">提交</button></div>`;

    container.innerHTML = qualityHTML + evalHTML + scoresHTML + formHTML;
  } catch (e) {
    container.innerHTML = `<div class="empty">加载失败: ${escapeHtml(e.message)}</div>`;
  }
}

// ============ L3: Combined Model Dispatch Tab ============
async function loadModelDispatchTab() {
  const container = document.getElementById('dtab-model-dispatch');
  try {
    const [r, genData] = await Promise.all([
      fetchJSON(`${API}/session/${currentDetailSid}/routes`).catch(() => ({})),
      fetchJSON(`${API}/generations?session=${encodeURIComponent(currentDetailSid)}`).catch(() => ({generations:[]})),
    ]);
    currentDetailPage['model-dispatch'] = true;

    let routingHTML = '';
    if (r.routing_chain) {
      const chainHTML = r.routing_chain.slice(0, 30).map(h =>
        `<tr><td class="tnum">${h.seq}</td><td>${escapeHtml(h.requested_model)}</td><td>${h.fallback ? '↪' : '→'} ${escapeHtml(h.actual_model)}</td><td>${escapeHtml(h.actual_provider)}</td><td class="tnum">${h.elapsed_ms}ms</td><td class="tnum">${((h.input_tokens||0)/1000).toFixed(1)}K</td></tr>`
      ).join('');
      routingHTML = `
        <div class="panel"><div class="panel-title">Provider 路由</div>
        <div class="stat-grid">
          <div class="stat-box"><div class="stat-num">${r.total_requests || 0}</div><div class="stat-label">总请求</div></div>
          <div class="stat-box"><div class="stat-num">${r.fallback_count || 0}</div><div class="stat-label">回退次数</div></div>
          <div class="stat-box"><div class="stat-num">${r.fallback_rate ? (r.fallback_rate*100).toFixed(0)+'%' : '0%'}</div><div class="stat-label">回退率</div></div>
        </div>
        <div class="table-wrap"><table class="fossil-table">
          <thead><tr><th>Seq</th><th>请求模型</th><th>实际模型</th><th>Provider</th><th>耗时</th><th>Tokens</th></tr></thead>
          <tbody>${chainHTML}</tbody>
        </table></div></div>
        ${r.anomalies && r.anomalies.length ? `<div class="panel"><div class="panel-title">路由异常</div>${r.anomalies.map(a => `<div class="anomaly-item"><span class="anomaly-type ${a.severity}"><span class="dot"></span>${escapeHtml(a.type)}</span><span class="anomaly-detail">${escapeHtml(a.detail)}</span></div>`).join('')}</div>` : ''}`;
    }

    const gens = genData.generations || [];
    const summary = genData.summary || {};
    let genHTML = '';
    if (gens.length) {
      genHTML = `<div class="panel"><div class="panel-title">Generations</div>
        <div class="stat-grid">
          <div class="stat-box"><div class="stat-num">${summary.count || gens.length}</div><div class="stat-label">调用次数</div></div>
          <div class="stat-box"><div class="stat-num">${fmtCost(summary.total_cost || 0)}</div><div class="stat-label">总成本</div></div>
          <div class="stat-box"><div class="stat-num">${fmtNum(summary.total_tokens || 0)}</div><div class="stat-label">总 Tokens</div></div>
          <div class="stat-box"><div class="stat-num">${fmtMs(summary.avg_latency_ms || 0)}</div><div class="stat-label">平均延迟</div></div>
        </div>
        ${renderGenerationsTable(gens)}</div>`;
    }

    container.innerHTML = (routingHTML || '<div class="empty">暂无路由数据</div>') + genHTML;
  } catch (e) {
    container.innerHTML = `<div class="empty">加载失败: ${escapeHtml(e.message)}</div>`;
  }
}

async function loadTurnPage(page) {
  try {
    const d = await fetchJSON(`${API}/session/${currentDetailSid}/turns?page=${page}&per_page=5`);
    currentTurnPage = page;
    renderTurns(d);
  } catch (e) {
    document.getElementById('turnPages').innerHTML = `<div class="empty">加载失败: ${escapeHtml(e.message)}</div>`;
  }
}

function renderTurns(d) {
  const turns = d.turns || [];
  if (!turns.length) {
    document.getElementById('turnPages').innerHTML = `<div class="empty">暂无 Turn 数据</div>`;
    document.getElementById('turnPager').innerHTML = '';
    return;
  }

  document.getElementById('turnPages').innerHTML = turns.map((t, i) => `
    <div class="turn-card">
      <div class="turn-header" onclick="this.parentElement.classList.toggle('expanded')">
        ${ICONS.chevron}
        <span class="turn-name">Turn #${(d.page-1)*5 + i + 1}</span>
        <span class="turn-prompt">${escapeHtml(t.prompt || '(无提示词)')}</span>
        <span class="turn-meta">${t.llm_calls ? t.llm_calls.length : 0} API</span>
      </div>
      <div class="turn-body">${(t.llm_calls || []).map(c => `
        <div class="llm-call">
          <div class="llm-head">
            <span class="model-name">${escapeHtml(c.model)}</span>
            <span class="model-stats">${_fmtTokens(c.input_tokens||0)}→${_fmtTokens(c.output_tokens||0)} tokens · ${c.duration_ms}ms · ${fmtCost(c.cost_rmb||0)}</span>
          </div>
          ${c.tools && c.tools.length ? `<div class="llm-tools">${c.tools.map(tool => `<span class="badge ${tool.success ? 'badge-green' : 'badge-red'}">${escapeHtml(tool.tool)}</span>`).join('')}</div>` : ''}
        </div>`).join('')}</div>
    </div>
  `).join('');

  const totalPages = Math.ceil(d.total / d.per_page);
  let pagerHTML = '';
  for (let p = 1; p <= totalPages && p <= 20; p++) {
    pagerHTML += `<button ${p === d.page ? 'disabled' : ''} onclick="loadTurnPage(${p})">${p}</button>`;
  }
  if (d.has_more) pagerHTML += `<button disabled>…</button>`;
  document.getElementById('turnPager').innerHTML = pagerHTML;
}




// ============ L5: Model View (merged L5+L8) ============
let genFilterModel = '';

async function loadModelView() {
  try {
    const [configModelsData, genDataResp, profileData, monthlyCost, configStatus] = await Promise.all([
      fetchJSON(`${API}/models/config-models`),
      fetchJSON(`${API}/generations${genFilterModel ? '?model=' + encodeURIComponent(genFilterModel) : ''}`),
      fetchJSON(`${API}/strategy/profiles`).catch(() => null),
      fetchJSON(`${API}/models/monthly-cost`).catch(() => []),
      fetchJSON(`${API}/models/config-status`).catch(() => null),
    ]);
    const models = configModelsData.models || [];
    const gens = genDataResp.generations || [];
    const summary = genDataResp.summary || {};

    const activeModels = models;
    const modelNames = [...new Set(activeModels.filter(m => m.request_count > 0).map(m => m.model_name))].sort();

    // Build profile → model+provider mapping from profile data
    const profileModels = {};  // { profileName: [{model, provider}] }
    if (profileData && profileData.profiles) {
      for (const [pName, entries] of Object.entries(profileData.profiles)) {
        profileModels[pName] = (entries || []).map(e => ({ model: e.model || '', provider: e.provider || '' }));
      }
    }

    const providers = new Set(activeModels.map(m => m.provider));
    const totalReqs = activeModels.reduce((s, m) => s + (m.request_count || 0), 0);

    // Current month cost — match by calendar month, not just latest data
    const nowMonth = new Date().toISOString().slice(0, 7);
    const currentMonth = (monthlyCost || []).find(m => m.month === nowMonth) || null;
    const monthCostVal = currentMonth ? currentMonth.total_cost : 0;
    const monthLabel = currentMonth ? currentMonth.month : nowMonth;

    document.getElementById('genSummaryCards').innerHTML = [
      statCard({ label: '模型数', value: activeModels.length, accent: 'blue', icon: ICONS.sessions }),
      statCard({ label: 'Provider', value: providers.size, accent: 'purple', icon: ICONS.provider }),
      statCard({ label: '总请求', value: fmtNum(totalReqs), accent: 'green', icon: ICONS.routing }),
      statCard({ label: '当月费用', value: fmtCost(monthCostVal), accent: 'teal', icon: ICONS.cost, sub: monthLabel }),
    ].join('');

    const ccProxyProviders = new Set();
    _lastConfigStatus = configStatus;
    if (configStatus && configStatus.provider_list) {
      for (const p of configStatus.provider_list) {
        if (p.name) ccProxyProviders.add(p.name.toLowerCase());
      }
    }

    renderModelTable(activeModels, profileModels, ccProxyProviders);
    _renderMonthlyCostDetail(currentMonth, profileModels);

    const filterHTML = `<div class="filter-bar" id="genFilters">
      <span class="filter-pill ${!genFilterModel ? 'active' : ''}" onclick="genFilterModel='';loadModelView()">全部</span>
      ${modelNames.map(m => `<span class="filter-pill ${genFilterModel === m ? 'active' : ''}" onclick="genFilterModel='${escapeHtml(m)}';loadModelView()">${escapeHtml(m.length > 20 ? m.substring(0, 20) + '…' : m)}</span>`).join('')}
    </div>`;
    const filtersEl = document.getElementById('genFilters');
    if (filtersEl) filtersEl.outerHTML = filterHTML;

    renderGenTokenChart(gens);
    renderGenLatencyChart(gens);

    const tableWrap = document.getElementById('genTableWrap');
    if (tableWrap) tableWrap.innerHTML = renderGenerationsTable(gens.slice(0, 100));
  } catch (e) {
    document.getElementById('genSummaryCards').innerHTML = `<div class="empty">加载失败: ${escapeHtml(e.message)}</div>`;
  }
}

function _renderMonthlyCostDetail(monthData, profileModels) {
  const container = document.getElementById('modelGroupContainer');
  if (!container || !monthData || !monthData.models || !monthData.models.length) return;

  // Match cost entries to profiles by model+provider (case-insensitive)
  const profileOrder = ['premium', 'balanced', 'cheap', 'default'];
  const groups = {};
  const assigned = new Set();

  for (const [pName, entries] of Object.entries(profileModels || {})) {
    groups[pName] = [];
    for (const pe of entries) {
      const match = monthData.models.find(m =>
        m.model === pe.model && m.provider.toLowerCase() === pe.provider.toLowerCase()
      );
      if (match) {
        groups[pName].push(match);
        if (pName !== 'default') {
          assigned.add(`${match.model}||${match.provider.toLowerCase()}`);
        }
      }
    }
  }

  const ungrouped = monthData.models.filter(m =>
    !assigned.has(`${m.model}||${(m.provider || '').toLowerCase()}`) && m.cost_rmb > 0
  );

  const allProfiles = [...profileOrder.filter(p => groups[p] && groups[p].length), ...Object.keys(groups).filter(p => !profileOrder.includes(p) && groups[p] && groups[p].length)];

  function costRows(items) {
    const sorted = items.slice().sort((a, b) => b.cost_rmb - a.cost_rmb);
    const subtotal = sorted.reduce((s, m) => s + m.cost_rmb, 0);
    const rows = sorted.map(m => `<tr>
      <td><strong>${escapeHtml(m.model)}</strong></td>
      <td>${escapeHtml(m.provider || '-')}</td>
      <td class="tnum">${fmtNum(m.request_count)}</td>
      <td class="tnum">${_fmtTokens(m.input_tokens)}</td>
      <td class="tnum">${_fmtTokens(m.output_tokens)}</td>
      <td class="tnum"><strong>${fmtCost(m.cost_rmb)}</strong></td>
    </tr>`).join('');
    return { rows, subtotal };
  }

  let html = `<div class="panel model-group panel-collapsed" style="margin-bottom:16px">
    <div class="model-group-header" onclick="togglePanelCollapse('cost-detail', this)"><span class="panel-chevron collapsed">▾</span><span style="font-weight:600;font-size:13px">${escapeHtml(monthData.month)} 费用明细</span><span class="model-group-meta">合计 ${fmtCost(monthData.total_cost)}</span></div>
    <div class="panel-body" style="display:none">`;

  for (const p of allProfiles) {
    const { rows, subtotal } = costRows(groups[p]);
    const badgeClass = `profile-${p}`;
    const label = PROFILE_LABELS[p] || p;
    html += `<div style="margin:12px 0 4px 0"><span class="profile-badge ${badgeClass}">${escapeHtml(label)}</span> <span style="color:var(--text-tertiary);font-size:11px">小计 ${fmtCost(subtotal)}</span></div>
    <div class="table-wrap"><table class="fossil-table">
      <thead><tr><th>模型</th><th>Provider</th><th>请求数</th><th>Input</th><th>Output</th><th>费用</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
  }

  if (ungrouped.length) {
    const { rows } = costRows(ungrouped);
    html += `<div style="margin:12px 0 4px 0"><span class="profile-badge">未分组</span></div>
    <div class="table-wrap"><table class="fossil-table">
      <thead><tr><th>模型</th><th>Provider</th><th>请求数</th><th>Input</th><th>Output</th><th>费用</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
  }

  // Provider-level cost summary
  if (monthData.by_provider && monthData.by_provider.length) {
    const maxCost = Math.max(...monthData.by_provider.map(p => p.cost_rmb), 0.0001);
    html += `<div style="margin:16px 0 4px 0;font-weight:600;font-size:13px;color:var(--text-primary)">按 Provider 汇总</div>
    <div class="provider-cost-list">
    ${monthData.by_provider.map(p => `
      <div class="provider-cost-row">
        <div class="provider-cost-head">
          <span class="provider-cost-name">${escapeHtml(p.provider)}</span>
          <span class="provider-cost-val">${fmtCost(p.cost_rmb)}</span>
          <span class="provider-cost-meta">${p.request_count} 次</span>
        </div>
        <div class="provider-cost-bar-wrap">
          <div class="provider-cost-bar-fill" style="width:${(p.cost_rmb / maxCost * 100).toFixed(1)}%"></div>
        </div>
        <div class="provider-cost-models">
          ${p.models.map(m => `<span class="prov-model-chip">${escapeHtml(m.model)} <span class="prov-model-cost">${fmtCost(m.cost_rmb)}</span></span>`).join('')}
        </div>
      </div>`).join('')}
    </div>`;
  }

  html += '</div></div>';
  container.insertAdjacentHTML('beforeend', html);
}

const PROFILE_LABELS = { default: '默认', premium: '高级', balanced: '均衡', cheap: '经济' };
let _currentProfileModels = {};
let _lastConfigStatus = null;

function _findModelGroups(modelName, provider) {
  const prov = (provider || '').toLowerCase();
  const groups = [];
  for (const grp of ['premium', 'balanced', 'cheap']) {
    const entries = _currentProfileModels[grp] || [];
    if (entries.some(e => e.model === modelName && e.provider.toLowerCase() === prov)) groups.push(grp);
  }
  return groups;
}

function renderModelTable(models, profileModels, ccProxyProviders) {
  const container = document.getElementById('modelGroupContainer');
  if (!container) return;
  if (!models.length) {
    container.innerHTML = `<div class="guidance-card">
      <h3>尚无模型数据</h3>
      <p>请先完成 CC-Proxy 配置，或手动添加模型。配置完成后使用 Claude Code，模型使用数据将自动出现。</p>
      <div class="guidance-actions">
        <button class="btn-filled btn-sm" onclick="openAddModelModal()">添加模型</button>
        <button class="btn-tinted btn-sm" onclick="navigate('l1')">查看配置指南</button>
      </div>
    </div>`;
    return;
  }

  _currentProfileModels = profileModels || {};

  const groups = {};
  const assigned = new Set();
  const profileOrder = ['premium', 'balanced', 'cheap', 'default'];

  const knownProviders = new Set(ccProxyProviders || []);
  for (const [pName, entries] of Object.entries(profileModels || {})) {
    if (!groups[pName]) groups[pName] = [];
    for (const pe of entries) {
      knownProviders.add(pe.provider.toLowerCase());
      const match = models.find(m =>
        m.model_name === pe.model && m.provider.toLowerCase() === pe.provider.toLowerCase()
      );
      if (match) {
        groups[pName].push({ ...match, _profileModel: pe.model, _profileProvider: pe.provider });
        if (pName !== 'default') {
          assigned.add(`${match.model_name}||${match.provider.toLowerCase()}`);
        }
      }
    }
  }

  const ungrouped = models.filter(m =>
    !assigned.has(`${m.model_name}||${(m.provider || '').toLowerCase()}`)
  );

  const allProfiles = [...profileOrder.filter(p => groups[p] && groups[p].length), ...Object.keys(groups).filter(p => !profileOrder.includes(p) && groups[p] && groups[p].length)];

  let html = '';
  for (const p of allProfiles) {
    html += _renderModelGroup(p, PROFILE_LABELS[p] || p, groups[p], knownProviders);
  }
  if (ungrouped.length) {
    html += _renderModelGroup('ungrouped', '未分组', ungrouped, knownProviders);
  }
  container.innerHTML = html;
}

const _collapsedPanels = new Set(['default', 'premium', 'balanced', 'cheap', 'ungrouped', 'cost-detail']);

function togglePanelCollapse(profileKey, el) {
  const panel = el.closest('.model-group');
  const chevron = panel.querySelector('.panel-chevron');
  if (_collapsedPanels.has(profileKey)) {
    _collapsedPanels.delete(profileKey);
  } else {
    _collapsedPanels.add(profileKey);
  }
  const isCollapsed = _collapsedPanels.has(profileKey);
  panel.classList.toggle('panel-collapsed', isCollapsed);
  if (chevron) chevron.classList.toggle('collapsed', isCollapsed);
  const body = panel.querySelector('.panel-body');
  if (body) body.style.display = isCollapsed ? 'none' : '';
}

function _renderModelGroup(profileKey, label, models, knownProviders) {
  const isDefault = profileKey === 'default';
  const badgeClass = profileKey !== 'ungrouped' ? `profile-${profileKey}` : '';
  const canReorder = profileKey !== 'ungrouped';
  const profileOptions = [
    { key: 'premium', label: '高级' },
    { key: 'balanced', label: '均衡' },
    { key: 'cheap', label: '经济' },
  ];
  const rows = models.map((m, idx) => {
    const lastSeen = m.last_seen ? new Date(m.last_seen * 1000).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '-';
    const modelType = m.model_type || _inferModelType(m.model_name);
    const priorityBadge = canReorder ? (idx === 0 ? '<span class="priority-badge priority-primary">主力</span>' : `<span class="priority-badge priority-fallback">备选${idx}</span>`) : '';
    const prov = escapeHtml(m.provider || '');
    const mName = escapeHtml(m.model_name);
    const isKnownProvider = knownProviders && knownProviders.has((m.provider || '').toLowerCase());
    const modelGroups = _findModelGroups(m.model_name, m.provider);
    let selectHtml;
    if (isDefault) {
      const groupLabels = modelGroups.map(g => PROFILE_LABELS[g] || g);
      selectHtml = `<span style="font-size:12px;color:var(--text-secondary)">${groupLabels.length ? escapeHtml(groupLabels.join(', ')) : '未分组'}</span>`;
    } else if (profileKey === 'ungrouped' && !isKnownProvider) {
      selectHtml = '<span style="color:var(--text-tertiary);font-size:12px">非代理模型</span>';
    } else {
      selectHtml = profileOptions.map(o => {
        const active = modelGroups.includes(o.key);
        return `<span class="profile-pill ${active ? 'active' : ''} pill-${o.key}" onclick="toggleModelProfile('${escapeJsStr(prov)}','${escapeJsStr(mName)}','${o.key}',this)">${o.label}</span>`;
      }).join(' ');
    }
    const modelData = encodeURIComponent(JSON.stringify({
      model_name: mName, provider: prov, model_type: modelType,
      group_name: m.group_name || '', api_base: m.api_base || '', api_key_masked: m.api_key_masked || '',
    }));
    const editBtn = `<button class="model-action-btn" onclick="openEditModelModal('${modelData}')">编辑</button>`;
    const toggleBtn = `<button class="model-action-btn danger" onclick="deleteModel('${escapeJsStr(mName)}','${escapeJsStr(prov)}')">删除</button>`;
    const dragHandle = canReorder ? `<td class="drag-handle" draggable="true" data-profile="${profileKey}" data-idx="${idx}">⠿</td>` : '<td></td>';
    return `<tr class="model-row${canReorder ? ' draggable-row' : ''}" data-profile="${profileKey}" data-idx="${idx}">
      ${dragHandle}
      <td class="tnum">${priorityBadge}</td>
      <td><strong>${mName}</strong></td>
      <td>${prov || '-'}</td>
      <td><span class="type-badge type-${modelType.toLowerCase()}">${modelType}</span></td>
      <td class="tnum">${fmtNum(m.request_count)}</td>
      <td class="tnum">${fmtMs(m.avg_latency_ms || 0)}</td>
      <td>${lastSeen}</td>
      <td>${selectHtml}</td>
      <td><span class="model-actions">${editBtn}${toggleBtn}</span></td>
    </tr>`;
  }).join('');

  const groupClass = 'panel model-group';
  const desc = PROFILE_DESC[profileKey] || '';
  const descHtml = desc ? ` <span style="color:var(--text-tertiary);font-size:12px;margin-left:4px">${desc}</span>` : '';
  if (models.length < 5) _collapsedPanels.delete(profileKey);
  const collapsed = _collapsedPanels.has(profileKey);
  const chevron = `<span class="panel-chevron${collapsed ? ' collapsed' : ''}">▾</span>`;
  return `<div class="${groupClass}${collapsed ? ' panel-collapsed' : ''}">
    <div class="model-group-header" onclick="togglePanelCollapse('${profileKey}', this)">${chevron}<span class="profile-badge ${badgeClass}">${escapeHtml(label)}</span>${descHtml}<span class="model-group-meta">${models.length} 个模型${canReorder ? ' · 拖拽排序即优先级' : ''}</span></div>
    <div class="table-wrap panel-body">
      <table class="fossil-table" data-profile="${profileKey}">
        <thead><tr>
          <th style="width:32px"></th><th>优先级</th><th>模型</th><th>Provider</th><th>协议</th>
          <th>请求数</th><th>平均耗时</th><th>最近使用</th><th>分组</th><th>操作</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </div>`;
}

async function changeModelProfile(provider, model, newProfile, oldProfile) {
  if (newProfile === oldProfile) return;
  try {
    const resp = await fetch(`${API}/models/change-profile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider, model, from: oldProfile === 'ungrouped' ? '' : oldProfile, to: newProfile }),
    });
    const data = await resp.json();
    if (!resp.ok) { showToast({ severity: 'error', title: '分组变更失败', detail: data.error || '' }); return; }
    if (data.warning) { showToast({ severity: 'warn', title: '分组已保存', detail: data.warning }); }
    else { showToast({ severity: 'info', title: '分组变更成功', detail: `${model} → ${PROFILE_LABELS[newProfile] || newProfile}` }); }
    invalidateCache('/models/in-use');
    invalidateCache('/models/config-models');
    invalidateCache('/strategy/profiles');
    loadModelView();
  } catch (e) {
    showToast({ severity: 'error', title: '分组变更失败', detail: e.message });
  }
}

async function toggleModelProfile(provider, model, profile, el) {
  const action = el.classList.contains('active') ? 'remove' : 'add';
  try {
    const resp = await fetch(`${API}/models/toggle-profile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider, model, profile, action }),
    });
    const data = await resp.json();
    if (!resp.ok) { showToast({ severity: 'error', title: '分组变更失败', detail: data.error || '' }); return; }
    if (data.warning) { showToast({ severity: 'warn', title: '分组已保存', detail: data.warning }); }
    else {
      const label = PROFILE_LABELS[profile] || profile;
      showToast({ severity: 'info', title: action === 'add' ? '已加入分组' : '已移出分组', detail: `${model} ${action === 'add' ? '→' : '←'} ${label}` });
    }
    invalidateCache('/models/in-use');
    invalidateCache('/models/config-models');
    invalidateCache('/strategy/profiles');
    loadModelView();
  } catch (e) {
    showToast({ severity: 'error', title: '分组变更失败', detail: e.message });
  }
}

async function moveModelInProfile(profileKey, index, direction) {
  const entries = _currentProfileModels[profileKey];
  if (!entries) return;
  const newIndex = index + direction;
  if (newIndex < 0 || newIndex >= entries.length) return;
  const updated = [...entries];
  [updated[index], updated[newIndex]] = [updated[newIndex], updated[index]];
  try {
    const resp = await fetch(`${API}/models/profile-order`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile: profileKey, models: updated }),
    });
    const data = await resp.json();
    if (data.error) { showToast({ severity: 'warning', title: '调整失败', detail: data.error }); return; }
    showToast({ severity: 'info', title: '优先级已更新', detail: `${PROFILE_LABELS[profileKey] || profileKey} 模型顺序已调整` });
    invalidateCache('/models');
    invalidateCache('/profiles');
    loadModelView();
  } catch (e) {
    showToast({ severity: 'warning', title: '调整失败', detail: e.message });
  }
}

(function initDragSort() {
  let dragSrcRow = null;
  let dragProfile = null;

  document.addEventListener('dragstart', function(e) {
    const handle = e.target.closest('.drag-handle');
    if (!handle) return;
    const row = handle.closest('tr.draggable-row');
    if (!row) return;
    dragSrcRow = row;
    dragProfile = row.dataset.profile;
    row.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', row.dataset.idx);
  });

  document.addEventListener('dragover', function(e) {
    const row = e.target.closest('tr.draggable-row');
    if (!row || !dragSrcRow || row.dataset.profile !== dragProfile) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const rect = row.getBoundingClientRect();
    const mid = rect.top + rect.height / 2;
    row.classList.remove('drag-over-top', 'drag-over-bottom');
    row.classList.add(e.clientY < mid ? 'drag-over-top' : 'drag-over-bottom');
  });

  document.addEventListener('dragleave', function(e) {
    const row = e.target.closest('tr.draggable-row');
    if (row) row.classList.remove('drag-over-top', 'drag-over-bottom');
  });

  document.addEventListener('drop', async function(e) {
    const row = e.target.closest('tr.draggable-row');
    if (!row || !dragSrcRow || row.dataset.profile !== dragProfile) return;
    e.preventDefault();
    row.classList.remove('drag-over-top', 'drag-over-bottom');
    dragSrcRow.classList.remove('dragging');

    const fromIdx = parseInt(dragSrcRow.dataset.idx);
    let toIdx = parseInt(row.dataset.idx);
    const rect = row.getBoundingClientRect();
    if (e.clientY > rect.top + rect.height / 2) toIdx++;
    if (fromIdx === toIdx || fromIdx + 1 === toIdx) { dragSrcRow = null; return; }

    const profileKey = dragProfile;
    const entries = _currentProfileModels[profileKey];
    if (!entries) { dragSrcRow = null; return; }

    const updated = [...entries];
    const [moved] = updated.splice(fromIdx, 1);
    const insertAt = toIdx > fromIdx ? toIdx - 1 : toIdx;
    updated.splice(insertAt, 0, moved);

    try {
      const resp = await fetch(`${API}/models/profile-order`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile: profileKey, models: updated }),
      });
      const data = await resp.json();
      if (data.error) { showToast({ severity: 'warning', title: '调整失败', detail: data.error }); return; }
      showToast({ severity: 'info', title: '优先级已更新', detail: `${PROFILE_LABELS[profileKey] || profileKey} 模型顺序已调整` });
      invalidateCache('/models');
      invalidateCache('/profiles');
      loadModelView();
    } catch (err) {
      showToast({ severity: 'warning', title: '调整失败', detail: err.message });
    }
    dragSrcRow = null;
  });

  document.addEventListener('dragend', function(e) {
    if (dragSrcRow) dragSrcRow.classList.remove('dragging');
    document.querySelectorAll('.drag-over-top,.drag-over-bottom').forEach(el => el.classList.remove('drag-over-top', 'drag-over-bottom'));
    dragSrcRow = null;
  });
})();

function _inferModelType(modelName) {
  if (modelName && modelName.toLowerCase().startsWith('claude')) return 'Anthropic';
  return 'OpenAI';
}

function renderGenTokenChart(gens) {
  if (charts.genToken) charts.genToken.destroy();
  const ctx = document.getElementById('genTokenChart');
  if (!ctx) return;

  const byModel = {};
  gens.forEach(g => {
    const m = g.model || 'unknown';
    if (!byModel[m]) byModel[m] = { input: 0, output: 0, cache: 0 };
    byModel[m].input += g.input_tokens || 0;
    byModel[m].output += g.output_tokens || 0;
    byModel[m].cache += g.cache_read_tokens || 0;
  });
  const labels = Object.keys(byModel);

  charts.genToken = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: labels.map(l => l.length > 16 ? l.substring(0, 16) + '…' : l),
      datasets: [
        { label: 'Input', data: labels.map(m => byModel[m].input), backgroundColor: APPLE_COLORS.blue },
        { label: 'Output', data: labels.map(m => byModel[m].output), backgroundColor: APPLE_COLORS.green },
        { label: 'Cache Read', data: labels.map(m => byModel[m].cache), backgroundColor: APPLE_COLORS.teal },
      ],
    },
    options: {
      plugins: { legend: { position: 'bottom' } },
      scales: {
        x: { stacked: true, grid: { display: false } },
        y: { stacked: true, grid: { color: chartTheme().grid } },
      },
    },
  });
}

function renderGenLatencyChart(gens) {
  if (charts.genLatency) charts.genLatency.destroy();
  const ctx = document.getElementById('genLatencyChart');
  if (!ctx) return;

  const sorted = [...gens].sort((a, b) => (a.duration_ms || 0) - (b.duration_ms || 0));
  const buckets = [0, 1000, 2000, 5000, 10000, 20000, 50000, Infinity];
  const bucketLabels = ['<1s', '1-2s', '2-5s', '5-10s', '10-20s', '20-50s', '>50s'];
  const counts = bucketLabels.map(() => 0);
  sorted.forEach(g => {
    const ms = g.duration_ms || 0;
    for (let i = 0; i < buckets.length - 1; i++) {
      if (ms >= buckets[i] && ms < buckets[i + 1]) { counts[i]++; break; }
    }
  });

  charts.genLatency = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: bucketLabels,
      datasets: [{ label: '调用次数', data: counts, backgroundColor: APPLE_COLORS.blue }],
    },
    options: {
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { display: false } },
        y: { grid: { color: chartTheme().grid } },
      },
    },
  });
}



// ============ WebSocket Alerts ============
let alertSocket = null;
const alertBuffer = [];
const riskySessionMap = new Map();

function initAlerts() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  try {
    const wsUrl = `${proto}://${location.host}/ws/alerts` + (_AUTH_TOKEN ? `?token=${encodeURIComponent(_AUTH_TOKEN)}` : '');
    alertSocket = new WebSocket(wsUrl);
    alertSocket.onopen = () => console.log('[alerts] connected');
    alertSocket.onmessage = e => {
      try { handleAlert(JSON.parse(e.data)); } catch (_) {}
    };
    alertSocket.onclose = () => {
      alertSocket = null;
      setTimeout(initAlerts, 5000);
    };
    alertSocket.onerror = () => { try { alertSocket && alertSocket.close(); } catch (_) {} };
  } catch (e) {
    setTimeout(initAlerts, 5000);
  }
}

function handleAlert(a) {
  if (!a || a.type === 'pong') return;
  if (a.type === 'log_init') { _termInitLines(a.lines || []); return; }
  if (a.type === 'log_line') { _termAppendLine(a); return; }
  if (a.type === 'update_available') { checkForUpdates(); return; }
  if (a.type === 'update_progress') {
    const pt = document.getElementById('progressText');
    if (pt && a.data) pt.textContent = a.data.message || a.data.status;
    return;
  }
  if (a.type === 'update_applied') {
    const pt = document.getElementById('progressText');
    if (pt) pt.textContent = `${a.data.component} 已更新到 v${a.data.version}`;
    if (a.data.restarting) setTimeout(() => waitForRestart(), 2000);
    return;
  }
  if (a.type === 'config_changed') {
    invalidateCache('/models/config-models');
    invalidateCache('/models/config-status');
    invalidateCache('/system-status');
    invalidateCache('/health-dashboard');
    if (currentView === 'l5') loadModelView();
    if (currentView === 'l1') loadHealthDashboard();
    showToast({ severity: 'info', title: '配置已更新', detail: 'config.json 已变更并重载' });
    return;
  }
  if (a.type === 'config_error') {
    showToast({ severity: 'warning', title: a.title || '配置错误', detail: a.detail || '' });
    return;
  }
  if (a.type === 'alert' && a.session_id && (a.severity === 'critical' || a.severity === 'warning')) {
    riskySessionMap.set(a.session_id, { severity: a.severity, title: a.title, ts: Date.now() });
    highlightSessionRow(a.session_id, a.severity);
  }
  alertBuffer.unshift({ ...a, ts: a.timestamp || Date.now() });
  if (alertBuffer.length > 50) alertBuffer.length = 50;
  updateAlertCount();
  showToast(a);
  renderAlertDrawer();
  if (a.severity === 'critical' && currentView === 'l1') loadHealthDashboard();
}

function highlightSessionRow(sessionId, severity) {
  const row = document.querySelector(`tr[data-sid="${sessionId}"]`);
  if (!row) return;
  row.classList.remove('session-risk-warning', 'session-risk-critical');
  row.classList.add(severity === 'critical' ? 'session-risk-critical' : 'session-risk-warning');
  const btn = row.querySelector('.btn-false-positive');
  if (btn) btn.hidden = false;
}

async function reportFalsePositive(sessionId) {
  const entry = riskySessionMap.get(sessionId);
  if (!entry) return;
  riskySessionMap.delete(sessionId);
  const row = document.querySelector(`tr[data-sid="${sessionId}"]`);
  if (row) {
    row.classList.remove('session-risk-critical', 'session-risk-warning');
    const btn = row.querySelector('.btn-false-positive');
    if (btn) btn.hidden = true;
  }
  try {
    await Promise.all([
      fetch(`${API}/alert-feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sessionId, alert_title: entry.title, severity: entry.severity, feedback: 'false_positive', ts: entry.ts }),
      }),
      fetch(`${API}/session-risks/dismiss`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sessionId }),
      }),
    ]);
  } catch (_) {}
}

async function reportWaterfallFalsePositive(btn, sessionId, command) {
  btn.disabled = true;
  btn.textContent = '已标记';
  const wfRow = btn.closest('.waterfall-detail');
  if (wfRow) wfRow.classList.remove('wf-row-risk');
  const prevRow = wfRow && wfRow.previousElementSibling;
  if (prevRow) prevRow.classList.remove('wf-row-risk');
  try {
    await fetch(`${API}/alert-feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId, alert_title: 'Waterfall: ' + command.substring(0, 100), severity: 'false_positive_waterfall', feedback: 'false_positive', ts: Date.now() }),
    });
  } catch (_) {}
}

setInterval(() => {
  const cutoff = Date.now() - 5 * 60 * 1000;
  for (const [sid, entry] of riskySessionMap) {
    if (entry.ts < cutoff) {
      riskySessionMap.delete(sid);
      const row = document.querySelector(`tr[data-sid="${sid}"]`);
      if (row) {
        row.classList.remove('session-risk-critical', 'session-risk-warning');
        const btn = row.querySelector('.btn-false-positive');
        if (btn) btn.hidden = true;
      }
    }
  }
}, 30000);

function showToast(a) {
  const stack = document.getElementById('toastStack');
  if (!stack) return;
  const sev = a.severity || 'info';
  const el = document.createElement('div');
  el.className = `toast toast-${sev}`;
  const icon = sev === 'critical' ? ICONS.error : sev === 'warning' ? ICONS.alert : ICONS.check;
  el.innerHTML = `
    <div class="toast-icon">${icon}</div>
    <div class="toast-body">
      <div class="toast-title">${escapeHtml(a.title || a.type || '告警')}</div>
      <div class="toast-msg">${escapeHtml(a.detail || a.message || '')}</div>
    </div>
    <button class="toast-close" aria-label="关闭">×</button>`;
  el.querySelector('.toast-close').onclick = () => dismissToast(el);
  stack.appendChild(el);
  setTimeout(() => dismissToast(el), 6000);
}

function dismissToast(el) {
  if (!el || !el.parentNode) return;
  el.classList.add('out');
  setTimeout(() => el.remove(), 280);
}

function updateAlertCount() {
  const badge = document.getElementById('alertCount');
  const n = alertBuffer.length;
  badge.hidden = n === 0;
  badge.textContent = n > 99 ? '99+' : n;
}

// ── Config Setup Guide ──

let _configChecked = false;
async function checkConfigStatus() {
  if (_configChecked) return;
  try {
    const status = await fetchJSON(`${API}/models/config-status`);
    if (status.configured) { _configChecked = true; return; }
    showSetupGuide(status);
  } catch (_) {}
}

async function updateSystemStatus() {
  try {
    const s = await fetchJSON(`${API}/system-status`);
    const pill = document.getElementById('headerStatus');
    if (!pill) return;

    pill.className = 'status-pill';
    if (s.state === 'unconfigured') pill.classList.add('status-unconfigured');
    else if (s.state === 'offline') pill.classList.add('status-offline');

    pill.querySelector('span:last-child') && (pill.querySelector('span:last-child').textContent = s.label);

    if (_lastSystemState === 'unconfigured' && s.state !== 'unconfigured') {
      _configChecked = true;
    }
    _lastSystemState = s.state;
  } catch (_) {}
}

const SETUP_MODEL_CATALOG = [
  // Anthropic 协议 (RMB/千tokens)
  { name: 'Claude-Opus-4.6', type: 'anthropic', input: 0.036, output: 0.18, cache: 0.0036, ctx: 200000, badge: '最强', group: 'premium', default: true },
  { name: 'Claude-Sonnet-4.6', type: 'anthropic', input: 0.0216, output: 0.108, cache: 0.00216, ctx: 200000, badge: '推荐', group: 'premium' },
  { name: 'Claude-Haiku-4.5', type: 'anthropic', input: 0.0072, output: 0.036, cache: 0.00072, ctx: 200000, badge: '经济', group: 'cheap' },
  // OpenAI 协议 (RMB/千tokens)
  { name: 'GPT-5.5', type: 'openai', input: 0.036, output: 0.216, cache: 0.0036, ctx: 1050000, badge: '旗舰', group: 'premium' },
  { name: 'GPT-5.4', type: 'openai', input: 0.018, output: 0.108, cache: 0.0018, ctx: 1050000, badge: '推荐', group: 'premium' },
  { name: 'GPT-5.3-Codex', type: 'openai', input: 0.0126, output: 0.1008, cache: 0.0013, ctx: 400000, badge: '编码', group: 'balanced' },
  { name: 'GPT-4.1', type: 'openai', input: 0.015, output: 0.060, cache: 0.0015, ctx: 128000, badge: '经济', group: 'cheap' },
  { name: 'DeepSeek-V4-Pro', type: 'openai', input: 0.012, output: 0.024, cache: 0.001, ctx: 1024000, badge: '高性能', group: 'premium', default: true },
  { name: 'DeepSeek-V4-Flash', type: 'openai', input: 0.001, output: 0.002, cache: 0.0002, ctx: 1024000, badge: '极速', group: 'cheap', default: true },
  { name: 'DeepSeek-R1-0528', type: 'openai', input: 0.004, output: 0.016, cache: 0.0004, ctx: 64000, badge: '推理', group: 'balanced' },
  { name: 'DeepSeek-V3.2', type: 'openai', input: 0.002, output: 0.003, cache: 0.0002, ctx: 64000, badge: '经济', group: 'cheap' },
  { name: 'GLM-5.1', type: 'openai', input: 0.006, output: 0.024, cache: 0.0013, ctx: 200000, badge: '旗舰', group: 'premium', default: true },
  { name: 'GLM-5', type: 'openai', input: 0.004, output: 0.016, cache: 0.0008, ctx: 256000, badge: '均衡', group: 'balanced' },
  { name: 'GLM-4.7', type: 'openai', input: 0.004, output: 0.016, cache: 0.0004, ctx: 200000, badge: '外采', group: 'balanced' },
  { name: 'Kimi-K2.6', type: 'openai', input: 0.0065, output: 0.027, cache: 0.0011, ctx: 256000, badge: '最新', group: 'premium', default: true },
  { name: 'Kimi-K2.5', type: 'openai', input: 0.004, output: 0.021, cache: 0.0004, ctx: 256000, badge: '均衡', group: 'balanced' },
  { name: 'Kimi-K2-0905-jcloud', type: 'openai', input: 0.004, output: 0.016, cache: 0.0004, ctx: 256000, badge: '自部署', group: 'cheap' },
  { name: 'Qwen3.5-397B-A17B', type: 'openai', input: 0.0012, output: 0.0072, cache: 0.00012, ctx: 256000, badge: '最新MoE', group: 'premium', default: true },
  { name: 'Qwen3-Coder', type: 'openai', input: 0.015, output: 0.060, cache: 0.0015, ctx: 64000, badge: '编码', group: 'premium' },
  { name: 'Qwen3-235B-A22B', type: 'openai', input: 0.002, output: 0.008, cache: 0.0002, ctx: 64000, badge: 'MoE', group: 'balanced' },
  { name: 'Qwen3-32B', type: 'openai', input: 0.002, output: 0.008, cache: 0.0002, ctx: 128000, badge: '密集', group: 'balanced' },
];

const DEFAULT_PROVIDERS = [
  { name: 'openai', base_url: 'https://api.openai.com/v1', type: 'openai' },
];

const DEFAULT_API_BASE = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
};

function _providerRowHtml(p) {
  const t = (p.type || 'openai').toLowerCase();
  const base = p.base_url || DEFAULT_API_BASE[t] || '';
  return `<div class="setup-provider-row">
    <input type="text" placeholder="Provider 名称" value="${escapeHtml(p.name || '')}" data-field="name">
    <select data-field="type" onchange="onSetupTypeChange(this)">
      <option value="openai" ${t !== 'anthropic' ? 'selected' : ''}>OpenAI</option>
      <option value="anthropic" ${t === 'anthropic' ? 'selected' : ''}>Anthropic</option>
    </select>
    <input type="text" placeholder="API Base URL" value="${escapeHtml(base)}" data-field="base_url">
    <input type="text" placeholder="API Key" value="${escapeHtml(p.api_key || '')}" data-field="api_key">
    <button class="setup-row-del" onclick="this.closest('.setup-provider-row').remove()" title="删除">&times;</button>
  </div>`;
}

function onSetupTypeChange(sel) {
  const row = sel.closest('.setup-provider-row');
  if (!row) return;
  const baseInput = row.querySelector('[data-field="base_url"]');
  if (!baseInput) return;
  const curVal = baseInput.value.trim();
  const oldDefaults = Object.values(DEFAULT_API_BASE);
  if (!curVal || oldDefaults.includes(curVal)) {
    baseInput.value = DEFAULT_API_BASE[sel.value] || '';
  }
}

function addSetupProviderRow() {
  const list = document.getElementById('setupProviderList');
  if (!list) return;
  list.insertAdjacentHTML('beforeend', _providerRowHtml({}));
}

function showSetupGuide(status) {
  const existing = document.getElementById('setupGuide');
  if (existing) return;

  const configPath = status.path || '~/.cc-proxy/config.json';
  const providers = status.provider_list || [];

  let initProviders;
  if (providers.length && providers.some(p => p.has_key)) {
    initProviders = providers.map(p => ({
      name: p.name, base_url: p.base_url || '', api_key: p.has_key ? '••••••••' : '',
    }));
  } else if (providers.length) {
    initProviders = providers.map(p => ({ name: p.name, base_url: p.base_url || '', api_key: '' }));
  } else {
    initProviders = DEFAULT_PROVIDERS.map(p => ({ ...p, api_key: '' }));
  }

  const providerRows = initProviders.map(p => _providerRowHtml(p)).join('');

  const modelListHtml = '<p class="setup-section-desc" style="color:var(--text-tertiary)">请先完成 Step 1 保存配置</p>';

  const guide = document.createElement('div');
  guide.id = 'setupGuide';
  guide.className = 'setup-guide';
  guide.innerHTML = `
    <div class="setup-guide-header">
      <strong>欢迎使用 UATU</strong>
      <button class="btn-plain btn-sm" onclick="this.closest('.setup-guide').remove()">关闭</button>
    </div>
    <div class="setup-guide-body">
      <p class="setup-subtitle">三步完成配置：配置 Provider → 选择模型 → 激活代理。</p>

      <div class="setup-section">
        <div class="setup-section-title"><span class="step-num">1</span> 配置 Provider</div>
        <p class="setup-section-desc">填入 Provider 名称、API Base 和 API Key。可以添加多个 Provider。</p>
        <div class="setup-provider-header"><span>名称</span><span>API 类型</span><span>API Base</span><span>API Key</span><span></span></div>
        <div class="setup-provider-list" id="setupProviderList">
          ${providerRows}
        </div>
        <div class="setup-provider-add-row">
          <button class="btn-plain btn-sm" onclick="addSetupProviderRow()">+ 添加 Provider</button>
        </div>
        <div class="setup-save-row">
          <button class="btn-filled" id="setupSaveBtn" onclick="saveSetupConfig()">保存配置</button>
          <span class="setup-save-status" id="setupSaveStatus"></span>
        </div>
      </div>

      <div class="setup-section setup-section-disabled" id="setupStep2">
        <div class="setup-section-title"><span class="step-num">2</span> 选择模型</div>
        <p class="setup-section-desc">勾选你需要使用的模型，点击"批量添加"一键注册到系统中。</p>
        <p class="setup-section-hint">⚠ 请只选择你已确认可用的模型，不要全部添加。未验证的模型可能导致请求失败。</p>
        <div class="setup-model-flat-header">
          <span></span>
          <button class="btn-plain btn-xs" onclick="toggleAllSetupModels()">全选/取消</button>
        </div>
        <div class="setup-model-catalog setup-model-flat" id="setupModelCatalog">
          ${modelListHtml}
        </div>
        <div class="setup-save-row">
          <button class="btn-filled" id="setupAddModelsBtn" onclick="batchAddSetupModels()">批量添加模型</button>
          <span class="setup-save-status" id="setupModelStatus"></span>
        </div>
      </div>

      <div class="setup-section setup-section-disabled" id="setupStep3">
        <div class="setup-section-title"><span class="step-num">3</span> 激活代理</div>
        <p class="setup-section-desc">点击下方按钮，自动将代理环境变量写入 Shell 配置文件，使 Claude Code 通过 cc-proxy 路由请求。</p>
        <div class="setup-gatekeeper-warning" id="gatekeeperWarning" hidden>
          <strong>⚠ macOS 安全策略阻止了 cc-proxy 运行</strong>
          <p>请前往 <strong>系统设置 → 隐私与安全性</strong>，在底部找到被阻止的 cc-proxy 并点击"仍要打开"，然后返回此页面重试激活。</p>
        </div>
        <div class="setup-save-row">
          <button class="btn-filled" id="setupActivateBtn" onclick="activateProxy()">一键激活</button>
          <span class="setup-save-status" id="setupActivateStatus"></span>
        </div>
        <div class="setup-activate-result" id="setupActivateResult" hidden></div>
      </div>

      <div class="setup-footer">
        <span>配置文件: <code>${escapeHtml(configPath)}</code></span>
      </div>
    </div>`;

  const target = document.getElementById('view-l1');
  if (target) target.prepend(guide);

  checkProxyPreflight();
}

async function checkProxyPreflight() {
  try {
    const ps = await fetchJSON(`${API}/proxy/status`);
    const warn = document.getElementById('gatekeeperWarning');
    const btn = document.getElementById('setupActivateBtn');
    if (ps.preflight === 'blocked') {
      if (warn) warn.hidden = false;
      if (btn) { btn.textContent = '重试激活'; }
    } else if (ps.preflight === 'not_found') {
      if (warn) {
        warn.hidden = false;
        warn.innerHTML = '<strong>⚠ cc-proxy 二进制文件未找到</strong><p>请确认安装完整后重试。</p>';
      }
      if (btn) btn.disabled = true;
    } else if (ps.preflight === 'unsupported') {
      if (warn) {
        warn.hidden = false;
        warn.innerHTML = `<strong>⚠ 不支持当前平台</strong><p>${escapeHtml(ps.error || '')}</p>`;
      }
      if (btn) btn.disabled = true;
    } else if (ps.running) {
      if (btn) { btn.textContent = '已在运行'; btn.disabled = true; }
    }
  } catch (_) {}
}

function toggleAllSetupModels() {
  const checkboxes = document.querySelectorAll('#setupModelCatalog input[type="checkbox"]');
  const allChecked = [...checkboxes].every(c => c.checked);
  checkboxes.forEach(c => c.checked = !allChecked);
}

function _refreshSetupModelCatalog(configuredProviders) {
  const catalog = document.getElementById('setupModelCatalog');
  if (!catalog) return;
  const configuredTypes = new Set((configuredProviders || []).map(p => (p.type || 'openai').toLowerCase()));
  const filtered = SETUP_MODEL_CATALOG.filter(m => configuredTypes.has(m.type));
  if (!filtered.length) {
    catalog.innerHTML = '<p class="setup-section-desc" style="color:var(--text-tertiary)">已配置的 Provider 没有匹配的预置模型，可在模型界面手动添加。</p>';
    return;
  }
  const typeLabel = { anthropic: 'Anthropic 协议', openai: 'OpenAI 协议' };
  let html = '';
  for (const t of ['anthropic', 'openai']) {
    const group = filtered.filter(m => m.type === t);
    if (!group.length) continue;
    html += `<div class="setup-model-type-group"><div class="setup-model-type-label">${typeLabel[t] || t}</div>`;
    html += group.map(m => {
      const badgeHtml = m.badge ? `<span class="setup-model-badge">${escapeHtml(m.badge)}</span>` : '';
      const groupLabel = { premium: '高级', balanced: '均衡', cheap: '经济' }[m.group] || '';
      const groupHtml = groupLabel ? `<span class="setup-model-group-tag">${groupLabel}</span>` : '';
      const cost = `¥${m.input}/¥${m.output} per 1K`;
      const checked = m.default ? ' checked' : '';
      return `<label class="setup-model-item">
        <input type="checkbox"${checked} data-model='${escapeHtml(JSON.stringify(m))}'>
        <div class="setup-model-info">
          <strong>${escapeHtml(m.name)}</strong>${badgeHtml}${groupHtml}
          <span class="setup-model-cost">${escapeHtml(cost)} · ${(m.ctx/1000)}K ctx</span>
        </div>
      </label>`;
    }).join('');
    html += '</div>';
  }
  catalog.innerHTML = html;
}

async function batchAddSetupModels() {
  const checkboxes = document.querySelectorAll('#setupModelCatalog input[type="checkbox"]:checked');
  if (!checkboxes.length) {
    const st = document.getElementById('setupModelStatus');
    if (st) { st.textContent = '请至少选择一个模型'; st.className = 'setup-save-status error'; }
    return;
  }

  const providerTypeMap = {};
  const typeToProvider = {};
  document.querySelectorAll('#setupProviderList .setup-provider-row').forEach(row => {
    const name = (row.querySelector('[data-field="name"]').value || '').trim();
    const type = (row.querySelector('[data-field="type"]').value || 'openai').trim().toLowerCase();
    if (name) {
      providerTypeMap[name.toLowerCase()] = type;
      if (!typeToProvider[type]) typeToProvider[type] = name;
    }
  });

  function inferGroup(m) {
    if (m.group) return m.group;
    const n = (m.name || m).toLowerCase();
    if (/opus|pro\b|max\b/i.test(n)) return 'premium';
    if (/haiku|flash|lite|mini|nano/i.test(n)) return 'cheap';
    return 'balanced';
  }

  const models = [];
  for (const cb of checkboxes) {
    const m = JSON.parse(cb.dataset.model);
    const mType = (m.type || 'openai').toLowerCase();
    const provider = typeToProvider[mType] || '';
    if (!provider) continue;
    const modelType = mType === 'anthropic' ? 'Anthropic' : 'OpenAI';
    models.push({
      model_name: m.name,
      provider,
      model_type: modelType,
      group_name: inferGroup(m),
      input_price_per_1k: m.input || 0,
      output_price_per_1k: m.output || 0,
      cache_price_per_1k: m.cache || 0,
      max_context: m.ctx || 200000,
    });
  }

  const btn = document.getElementById('setupAddModelsBtn');
  const st = document.getElementById('setupModelStatus');
  if (btn) { btn.disabled = true; btn.textContent = '添加中...'; }

  try {
    const resp = await fetch(`${API}/models/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ models }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      if (st) { st.textContent = data.error || '添加失败'; st.className = 'setup-save-status error'; }
      return;
    }
    if (st) { st.textContent = `已添加 ${data.added} 个模型`; st.className = 'setup-save-status success'; }

    const step3 = document.getElementById('setupStep3');
    if (step3) step3.classList.remove('setup-section-disabled');

    invalidateCache('/models');
    invalidateCache('/models/in-use');
    invalidateCache('/models/config-models');
  } catch (e) {
    if (st) { st.textContent = '网络错误: ' + e.message; st.className = 'setup-save-status error'; }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '批量添加模型'; }
  }
}

async function saveSetupConfig() {
  const rows = document.querySelectorAll('#setupProviderList .setup-provider-row');
  const providers = [];
  for (const row of rows) {
    const name = (row.querySelector('[data-field="name"]').value || '').trim();
    const type = (row.querySelector('[data-field="type"]').value || 'openai').trim();
    const base_url = (row.querySelector('[data-field="base_url"]').value || '').trim();
    const api_key = (row.querySelector('[data-field="api_key"]').value || '').trim();
    if (name && api_key && !api_key.startsWith('••')) {
      providers.push({ name, type, base_url, api_key });
    }
  }

  const statusEl = document.getElementById('setupSaveStatus');
  if (!providers.length) {
    if (statusEl) { statusEl.textContent = '请至少填入一个有效的 Provider'; statusEl.className = 'setup-save-status error'; }
    return;
  }

  const btn = document.getElementById('setupSaveBtn');
  if (btn) { btn.disabled = true; btn.textContent = '保存中...'; }
  if (statusEl) { statusEl.textContent = ''; statusEl.className = 'setup-save-status'; }

  try {
    const resp = await fetch(`${API}/models/save-config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providers }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      if (statusEl) { statusEl.textContent = data.error || '保存失败'; statusEl.className = 'setup-save-status error'; }
      return;
    }

    if (statusEl) { statusEl.textContent = `已保存 (${data.updated.join(', ')})`; statusEl.className = 'setup-save-status success'; }

    const step2 = document.getElementById('setupStep2');
    if (step2) step2.classList.remove('setup-section-disabled');

    _refreshSetupModelCatalog(providers);

    // Step 3 stays disabled until the user explicitly adds models via Step 2's
    // batch-add. Don't auto-unlock from /models/in-use — providers may carry
    // pre-populated `models: [...]` from defaults even when the user hasn't
    // confirmed anything yet.

    invalidateCache('/system-status');
    invalidateCache('/models/config-status');
    updateSystemStatus();
  } catch (e) {
    if (statusEl) { statusEl.textContent = '网络错误: ' + e.message; statusEl.className = 'setup-save-status error'; }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '保存配置'; }
  }
}

async function activateProxy() {
  const btn = document.getElementById('setupActivateBtn');
  const st = document.getElementById('setupActivateStatus');
  const result = document.getElementById('setupActivateResult');
  if (btn) { btn.disabled = true; btn.textContent = '激活中...'; }

  // Re-check preflight before activating
  try {
    const ps = await fetchJSON(`${API}/proxy/status`);
    if (ps.preflight === 'blocked') {
      if (st) { st.textContent = 'macOS 安全策略阻止运行，请先在系统设置中允许'; st.className = 'setup-save-status error'; }
      const warn = document.getElementById('gatekeeperWarning');
      if (warn) warn.hidden = false;
      if (btn) { btn.disabled = false; btn.textContent = '重试激活'; }
      return;
    }
  } catch (_) {}

  try {
    invalidateCache('/proxy/status');
    const resp = await fetch(`${API}/proxy/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    const data = await resp.json();
    if (!resp.ok) {
      let errMsg = data.error || '激活失败';
      if (errMsg.includes('priority') && errMsg.includes('configured')) {
        errMsg = '请先在上方添加并保存至少一个模型，再点击激活';
      }
      if (st) { st.textContent = errMsg; st.className = 'setup-save-status error'; }
      return;
    }

    const proxyNote = data.proxy_started ? ' cc-proxy 已启动。' : '';
    if (st) { st.textContent = '激活成功' + proxyNote; st.className = 'setup-save-status success'; }
    if (btn) { btn.textContent = '已激活'; btn.disabled = true; }

    if (result) {
      const rcNote = data.rc_updated
        ? `已写入 <code>${escapeHtml(data.rc_file)}</code>，新终端自动生效。`
        : `<code>${escapeHtml(data.rc_file)}</code> 中已包含激活配置。`;
      result.innerHTML = `
        <div class="setup-activate-cmd"><code>${escapeHtml(data.env)}</code></div>
        <p class="setup-section-desc" style="margin-top:8px">${rcNote}</p>
        <p class="setup-section-desc" style="color:var(--green);font-weight:600">配置完成！环境变量已自动生效，打开新终端即可使用 Claude Code。</p>`;
      result.hidden = false;
    }

    showToast({ severity: 'info', title: '代理已激活', detail: '环境变量已自动生效，打开新终端即可使用' });
  } catch (e) {
    if (st) { st.textContent = '网络错误: ' + e.message; st.className = 'setup-save-status error'; }
  } finally {
    if (btn && btn.textContent === '激活中...') { btn.disabled = false; btn.textContent = '一键激活'; }
  }
}

// ── Update Banner ──

let _updateData = null;

async function checkForUpdates() {
  try {
    const status = await fetchJSON(`${API}/updater/status`);
    if (!status || !status.update_available) return;
    const components = [];
    if (status.observer_latest && status.observer_current && status.observer_latest !== status.observer_current) {
      components.push({ component: 'observer', current: status.observer_current, latest: status.observer_latest });
    }
    if (status.cc_proxy_latest && status.cc_proxy_current && status.cc_proxy_latest !== status.cc_proxy_current) {
      components.push({ component: 'cc_proxy', current: status.cc_proxy_current, latest: status.cc_proxy_latest });
    }
    if (components.length === 0) return;
    let versions = {};
    try { versions = await fetchJSON(`${API}/updater/versions`); } catch (_) {}
    for (const c of components) {
      const comp = versions[c.component] || {};
      const verInfo = (comp.versions || {})[c.latest] || {};
      c.notes = verInfo.notes || '';
    }
    showUpdateBanner(components);
  } catch (_) {}
}

function showUpdateBanner(components) {
  const banner = document.getElementById('updateBanner');
  if (!banner || !components || components.length === 0) return;
  _updateData = components;

  const lines = components.map(c => {
    const name = c.component === 'cc_proxy' ? 'CC-Proxy' : 'Observer';
    return `${name} v${c.current} → v${c.latest}`;
  });
  banner.querySelector('.update-text').textContent = '🔄 新版本可用：' + lines.join('，');

  const notes = components.map(c => c.notes).filter(Boolean);
  const changelogEl = document.getElementById('updateChangelog');
  changelogEl.textContent = notes.length ? notes.join('；') : '';

  const actionsEl = document.getElementById('updateActions');
  const progressEl = document.getElementById('updateProgress');
  actionsEl.hidden = false;
  progressEl.hidden = true;

  banner.querySelector('.install-btn').onclick = () => triggerUpdate();
  banner.querySelector('.dismiss-btn').onclick = () => { banner.hidden = true; _updateData = null; };
  banner.hidden = false;
}

async function triggerUpdate() {
  if (!_updateData || _updateData.length === 0) return;
  const names = _updateData.map(c => c.component === 'cc_proxy' ? 'CC-Proxy' : 'Observer').join(' + ');
  if (!confirm(`确认升级 ${names}？Observer 升级后将自动重启。`)) return;

  const banner = document.getElementById('updateBanner');
  const actionsEl = document.getElementById('updateActions');
  const progressEl = document.getElementById('updateProgress');
  const progressText = document.getElementById('progressText');
  actionsEl.hidden = true;
  progressEl.hidden = false;

  for (const c of _updateData) {
    const name = c.component === 'cc_proxy' ? 'CC-Proxy' : 'Observer';
    progressText.textContent = `正在获取 ${name} v${c.latest} 下载信息...`;

    let url = '', sha256 = '';
    try {
      const versions = await fetchJSON(`${API}/updater/versions`);
      const comp = versions[c.component] || {};
      const verInfo = (comp.versions || {})[c.latest] || {};
      url = verInfo.url || '';
      sha256 = verInfo.sha256 || '';
    } catch (_) {}

    if (!url) {
      alert(`无法获取 ${name} 的下载地址`);
      actionsEl.hidden = false;
      progressEl.hidden = true;
      return;
    }

    progressText.textContent = `正在安装 ${name} v${c.latest}...`;
    try {
      const resp = await fetch(`${API}/updater/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ component: c.component, version: c.latest, url, sha256 }),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        alert(`${name} 升级失败: ${err.error || '未知错误'}`);
        actionsEl.hidden = false;
        progressEl.hidden = true;
        return;
      }
    } catch (e) {
      if (c.component === 'observer') {
        progressText.textContent = 'Observer 正在重启，页面将自动刷新...';
        setTimeout(() => waitForRestart(), 3000);
        return;
      }
      alert(`${name} 升级请求失败: ${e.message}`);
      actionsEl.hidden = false;
      progressEl.hidden = true;
      return;
    }
  }

  const hasObserver = _updateData.some(c => c.component === 'observer');
  if (hasObserver) {
    progressText.textContent = 'Observer 正在重启，页面将自动刷新...';
    setTimeout(() => waitForRestart(), 3000);
  } else {
    progressText.textContent = '升级完成！';
    setTimeout(() => { banner.hidden = true; _updateData = null; }, 3000);
  }
}

function waitForRestart() {
  let attempts = 0;
  const maxAttempts = 30;
  const iv = setInterval(async () => {
    attempts++;
    try {
      const resp = await fetch(`${API}/updater/status`, { signal: AbortSignal.timeout(3000) });
      if (resp.ok) {
        clearInterval(iv);
        location.reload();
      }
    } catch (_) {}
    if (attempts >= maxAttempts) {
      clearInterval(iv);
      const progressText = document.getElementById('progressText');
      if (progressText) progressText.textContent = '服务重启超时，请手动刷新页面';
    }
  }, 2000);
}

// ── Manual Check Update ──

async function manualCheckUpdate() {
  showToast({ severity: 'info', title: '检查更新', detail: '正在检查...' });
  try {
    await fetch(`${API}/updater/check`, { method: 'POST' });
    invalidateCache('/updater/status');
    const status = await fetchJSON(`${API}/updater/status`);
    if (status && status.update_available) {
      checkForUpdates();
      showToast({ severity: 'info', title: '发现新版本', detail: '请查看页面顶部的更新横幅' });
    } else {
      showToast({ severity: 'info', title: '已是最新版本', detail: `当前版本 ${status.observer_current || ''}` });
    }
  } catch (e) {
    showToast({ severity: 'error', title: '检查失败', detail: e.message });
  }
}

// ── Feedback Modal ──

const _FB_MAX_IMG_BYTES = 2 * 1024 * 1024;
let _feedbackImages = [null, null, null];

function updateFeedbackCharCount() {
  const ta = document.querySelector('#feedbackForm textarea[name="message"]');
  const el = document.getElementById('feedbackCharCount');
  if (ta && el) el.textContent = `${ta.value.length} / 2000`;
}

function _handleSlotPaste(e, idx) {
  const items = e.clipboardData && e.clipboardData.items;
  if (!items) return;
  for (const item of items) {
    if (!item.type.startsWith('image/')) continue;
    e.preventDefault();
    e.stopPropagation();
    const blob = item.getAsFile();
    if (!blob) continue;
    if (blob.size > _FB_MAX_IMG_BYTES) {
      showToast({ severity: 'warn', title: '图片过大', detail: `${(blob.size / 1024 / 1024).toFixed(1)}MB，最大 2MB` });
      return;
    }
    const reader = new FileReader();
    reader.onload = () => { _feedbackImages[idx] = reader.result; _renderSlot(idx); };
    reader.readAsDataURL(blob);
    return;
  }
}

function triggerFeedbackSlotPaste(idx) {
  const slot = document.querySelector(`.feedback-img-slot[data-idx="${idx}"]`);
  if (slot) slot.focus();
}

function removeFeedbackImage(idx) {
  _feedbackImages[idx] = null;
  _renderSlot(idx);
}

function _renderSlot(idx) {
  const slot = document.querySelector(`.feedback-img-slot[data-idx="${idx}"]`);
  if (!slot) return;
  if (_feedbackImages[idx]) {
    slot.innerHTML = `<img src="${_feedbackImages[idx]}"><button type="button" class="slot-remove" onclick="event.stopPropagation();removeFeedbackImage(${idx})">&times;</button>`;
    slot.classList.add('has-image');
  } else {
    slot.innerHTML = '<span class="slot-placeholder">粘贴图片</span>';
    slot.classList.remove('has-image');
  }
}

function _resetFeedbackSlots() {
  _feedbackImages = [null, null, null];
  for (let i = 0; i < 3; i++) _renderSlot(i);
}

function openFeedbackModal() {
  const m = document.getElementById('feedbackModal');
  if (m) { m.hidden = false; m.classList.add('visible'); }
}

function closeFeedbackModal() {
  const m = document.getElementById('feedbackModal');
  if (m) { m.classList.remove('visible'); m.hidden = true; }
  const st = document.getElementById('feedbackStatus');
  if (st) { st.textContent = ''; st.className = 'feedback-status'; }
  _resetFeedbackSlots();
}

async function submitFeedback(event) {
  event.preventDefault();
  const form = document.getElementById('feedbackForm');
  const btn = document.getElementById('feedbackSubmitBtn');
  const st = document.getElementById('feedbackStatus');
  const fd = new FormData(form);
  const body = {
    type: fd.get('type') || 'other',
    message: (fd.get('message') || '').trim(),
    contact: (fd.get('contact') || '').trim(),
    images: _feedbackImages.filter(Boolean).length ? _feedbackImages.filter(Boolean) : undefined,
  };
  if (!body.message) {
    if (st) { st.textContent = '请填写反馈内容'; st.className = 'feedback-status error'; }
    return false;
  }
  if (btn) { btn.disabled = true; btn.textContent = '提交中...'; }
  try {
    const resp = await fetch(`${API}/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await resp.json();
    if (!resp.ok) {
      if (st) { st.textContent = data.error || '提交失败'; st.className = 'feedback-status error'; }
      return false;
    }
    showToast({ severity: 'info', title: '感谢反馈', detail: '你的意见已提交' });
    form.reset();
    closeFeedbackModal();
  } catch (e) {
    if (st) { st.textContent = '网络错误: ' + e.message; st.className = 'feedback-status error'; }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '提交'; }
  }
  return false;
}

function openAlertDrawer() {
  document.getElementById('alertDrawer').hidden = false;
  document.getElementById('drawerScrim').hidden = false;
  renderAlertDrawer();
}

function closeAlertDrawer() {
  document.getElementById('alertDrawer').hidden = true;
  document.getElementById('drawerScrim').hidden = true;
}

function renderAlertDrawer() {
  const list = document.getElementById('alertList');
  if (!list) return;
  if (!alertBuffer.length) {
    list.innerHTML = '<div class="empty">暂无告警</div>';
    return;
  }
  list.innerHTML = alertBuffer.map(a => {
    const sev = a.severity || 'info';
    const ts = typeof a.ts === 'number' ? new Date(a.ts).toLocaleTimeString() : new Date(a.ts).toLocaleTimeString();
    return `<div class="alert-row ${sev}">
      <div class="alert-row-head">
        <span class="alert-row-title">${escapeHtml(a.title || a.type || '告警')}</span>
        <span class="alert-row-time">${escapeHtml(ts)}</span>
      </div>
      <div class="alert-row-msg">${escapeHtml(a.detail || a.message || '')}</div>
      ${a.session_id ? `<div class="alert-row-meta">session: ${escapeHtml(String(a.session_id).substring(0, 24))}</div>` : ''}
    </div>`;
  }).join('');
}

// ============ Init ============
function bindUI() {
  // L2 segmented sort
  document.querySelectorAll('#sessionSort .seg').forEach(b => {
    b.addEventListener('click', () => {
      document.querySelectorAll('#sessionSort .seg').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      loadSessionList();
    });
  });

  // L2 date range filter
  document.querySelectorAll('#dateRange .seg').forEach(b => {
    b.addEventListener('click', () => {
      document.querySelectorAll('#dateRange .seg').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      loadSessionList();
    });
  });

  // Debounced search
  let searchTimer;
  const searchEl = document.getElementById('sessionSearch');
  if (searchEl) {
    searchEl.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(loadSessionList, 250);
    });
  }

  // L3 tab clicks
  const tabsEl = document.getElementById('detailTabs');
  if (tabsEl) {
    tabsEl.addEventListener('click', e => {
      const tab = e.target.closest('.tab-seg');
      if (!tab) return;
      switchDetailTab(tab.dataset.dtab);
    });
  }

  // Dark mode chart re-theme
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    applyChartDefaults();
    Object.values(charts).forEach(c => { try { c.update(); } catch (_) {} });
  });
}

// ============ L7: Strategy View ============
let _strategyProfiles = [];

let _strategyModelGroups = {};
let _strategyProfileModels = {};

function _resolveProfileToModels(profile) {
  if (!profile) return '';
  const p = profile.toLowerCase();
  if (_strategyProfileModels[p]) return _strategyProfileModels[p];
  for (const [group, models] of Object.entries(_strategyModelGroups)) {
    if (group === p || p.includes(group) || group.includes(p)) {
      return models;
    }
  }
  return '';
}

const PROFILE_DESC = {
  premium:  '主任务执行 · 代码编写、文件修改、复杂推理',
  balanced: '辅助请求 · 意图识别、中间处理，兼顾质量与成本',
  cheap:    '后台低要求 · 搜索整理、文件探索、标题生成',
};

async function _populateProfileSelect() {
  const sel = document.getElementById('stratProfileInput');
  if (!sel) return;
  const saved = sel.value;
  try {
    const profileData = await fetchJSON(`${API}/strategy/profiles`).catch(() => null);
    let html = '<option value="">选择目标 Profile…</option>';
    if (profileData && profileData.profiles && typeof profileData.profiles === 'object') {
      for (const [name, entries] of Object.entries(profileData.profiles)) {
        const models = (entries || []).map(e => e.model || '').filter(Boolean).slice(0, 3).join(', ');
        const desc = PROFILE_DESC[name.toLowerCase()] || models;
        html += `<option value="${escapeHtml(name)}">${escapeHtml(name)} — ${escapeHtml(desc)}</option>`;
      }
    }
    sel.innerHTML = html;
    if (saved) sel.value = saved;
  } catch (_) {}
}

function _formatTimeAgo(timestamp) {
  if (!timestamp) return '?';
  const diff = (Date.now() - new Date(timestamp).getTime()) / 1000;
  if (diff < 60) return '刚刚';
  if (diff < 3600) return Math.round(diff / 60) + 'min前';
  if (diff < 86400) return Math.round(diff / 3600) + 'h前';
  return Math.round(diff / 86400) + '天前';
}

async function loadStrategyView() {
  const [rulesResp, analytics, profileData, groupsData, templates] = await Promise.all([
    fetchJSON(`${API}/strategy/rules`).catch(() => []),
    fetchJSON(`${API}/strategy/analytics`).catch(() => null),
    fetchJSON(`${API}/strategy/profiles`).catch(() => null),
    fetchJSON(`${API}/models/groups`).catch(() => ({ groups: [] })),
    fetchJSON(`${API}/strategy/templates`).catch(() => []),
  ]);
  const rules = Array.isArray(rulesResp) ? rulesResp : (rulesResp.strategies || rulesResp.rules || []);
  if (profileData && profileData.profiles) {
    if (Array.isArray(profileData.profiles)) _strategyProfiles = profileData.profiles;
    else if (typeof profileData.profiles === 'object') {
      _strategyProfiles = Object.keys(profileData.profiles);
      _strategyProfileModels = {};
      for (const [name, entries] of Object.entries(profileData.profiles)) {
        const models = (entries || []).map(e => e.model || '').filter(Boolean);
        if (models.length) _strategyProfileModels[name.toLowerCase()] = models.join(', ');
      }
    }
  }
  _strategyModelGroups = {};
  (groupsData.groups || []).forEach(g => { _strategyModelGroups[g.group_name] = g.models; });
  _strategyTemplates = templates;
  renderStrategyCards(rules, analytics);
  renderStrategyTable(rules, analytics);
  renderBuiltinRules(rules);
  if (analytics) {
    renderTrafficFlow(analytics.traffic_flow || []);
    renderDispatchChart(analytics.dispatch_source || []);
    renderRuleHitChart(analytics.hit_stats || []);
    renderRoleDistChart(analytics.role_stats || []);
    renderRoleFamilyChart(analytics.role_family_stats || []);
  }
}

function renderStrategyCards(rules, analytics) {
  const total = rules.length;
  const active = rules.filter(r => r.enabled).length;
  let strategyPct = '—', bindingPct = '—';
  let totalEvents = 0;
  if (analytics && analytics.dispatch_source) {
    totalEvents = analytics.dispatch_source.reduce((s, d) => s + (d.cnt || 0), 0);
    const stratHit = analytics.dispatch_source.find(d => d.dispatch_source === 'strategy');
    if (stratHit) strategyPct = stratHit.pct + '%';
    const bindHit = analytics.dispatch_source.find(d => d.dispatch_source === 'session_binding');
    if (bindHit) bindingPct = bindHit.pct + '%';
  }
  const bo = analytics && analytics.binding_override || {};
  const bindNote = bo.session_binding ? `绑定兜底 ${bo.session_binding.pct}%` : '';
  document.getElementById('strategyCards').innerHTML = [
    statCard({icon: ICONS.routing, label: '路由总量', value: totalEvents, accent: 'blue'}),
    statCard({icon: ICONS.check, label: '策略命中', value: strategyPct, accent: 'green', sub: bindNote}),
    statCard({icon: ICONS.sessions, label: 'DB规则', value: `${active}/${total}`, accent: 'orange'}),
    statCard({icon: ICONS.alert, label: '探索预算', value: rules.reduce((s, r) => s + (r.exploration_budget || 0), 0), accent: 'purple'}),
  ].join('');
}

function renderStrategyTable(rules, analytics) {
  const hitStats = analytics ? analytics.hit_stats : [];
  const shadowStats = analytics ? analytics.shadow_stats || [] : [];
  const shadowMap = {};
  shadowStats.forEach(s => { shadowMap[s.rule_id] = s; });
  const tb = document.querySelector('#strategyRuleTable tbody');
  if (!rules.length) {
    tb.innerHTML = `<tr><td colspan="8">
      <div class="guidance-card">
        <h3>尚无策略规则</h3>
        <p>策略规则用于控制不同场景下的模型路由。点击上方"新建规则"按钮创建第一条规则。</p>
        <div class="guidance-actions">
          <button class="btn-filled btn-sm" onclick="openStrategyModal()">+ 新建规则</button>
        </div>
      </div>
    </td></tr>`;
    return;
  }
  const hitMap = {};
  (hitStats || []).forEach(h => {
    const id = h.strategy_rule_id;
    if (!hitMap[id]) hitMap[id] = { count: 0, avg_latency: 0, avg_cost: 0, last_hit: null };
    hitMap[id].count += h.hit_count || 0;
    hitMap[id].avg_latency = h.avg_latency || 0;
    hitMap[id].avg_cost = h.avg_cost || 0;
    if (h.last_hit && (!hitMap[id].last_hit || h.last_hit > hitMap[id].last_hit)) {
      hitMap[id].last_hit = h.last_hit;
    }
  });
  window._strategyRules = {};
  tb.innerHTML = rules.map(r => {
    window._strategyRules[r.id] = r;
    const matchParts = [];
    if (r.cluster_id != null) matchParts.push(`cluster: <code>${r.cluster_id}</code>`);
    if (r.agent_role) matchParts.push(`role: <code>${r.agent_role}</code>`);
    if (r.model_pattern) matchParts.push(`model: <code>${r.model_pattern}</code>`);
    if (r.cel_expr) matchParts.push(`CEL: <code>${r.cel_expr}</code>`);
    if (r.session_id) matchParts.push(`session: <code>${r.session_id.slice(0, 16)}…</code>`);
    if (r.cc_entrypoint) matchParts.push(`入口: <code>${r.cc_entrypoint}</code>`);
    const matchStr = matchParts.length ? matchParts.join('<br>') : '<span style="color:var(--text-tertiary)">通配</span>';
    let action = '';
    if (r.profile) {
      const modelNames = _resolveProfileToModels(r.profile);
      action = modelNames ? `→ ${modelNames}` : `→ <code>${r.profile}</code>`;
    } else if (r.weighted) {
      try {
        const w = typeof r.weighted === 'string' ? JSON.parse(r.weighted) : r.weighted;
        action = w.map(i => {
          const names = _resolveProfileToModels(i.profile);
          return `${names || i.profile}(${i.weight})`;
        }).join(', ');
      } catch (_) { action = r.weighted; }
    }
    const exploStr = r.is_exploration ? `${r.exploration_budget}` : '—';
    const toggleChecked = r.enabled ? 'checked' : '';
    const hit = hitMap[r.id];
    const shadow = shadowMap[r.id];
    let hitCell;
    if (!r.enabled && shadow && shadow.potential_hits > 0) {
      hitCell = `<span class="rule-status rule-shadow">观察中 ~${shadow.potential_hits}次/24h</span>`;
    } else if (!r.enabled) {
      hitCell = '<span class="rule-status rule-disabled">已停用</span>';
    } else if (hit && hit.count > 0) {
      const lastHitAgo = _formatTimeAgo(hit.last_hit);
      hitCell = `<span class="rule-status rule-active"><span class="dot-pulse"></span>${hit.count}次 · ${lastHitAgo}</span>`;
    } else {
      hitCell = '<span class="rule-status rule-idle">暂未命中</span>';
    }
    const isMainRole = (r.agent_role || '').startsWith('main');
    const bindingNote = '';
    const trClass = !r.enabled && shadow && shadow.potential_hits > 0 ? ' class="shadow-row"' : '';
    return `<tr${trClass}>
      <td>${r.id}</td>
      <td>${r.priority_order}</td>
      <td class="strat-match">${matchStr}</td>
      <td>${action}</td>
      <td>${hitCell}${bindingNote}</td>
      <td>${exploStr}</td>
      <td><label class="toggle-switch"><input type="checkbox" ${toggleChecked} onchange="toggleStrategy(${r.id},this.checked)"><span class="toggle-slider"></span></label></td>
      <td class="strat-actions">
        <button onclick="openStrategyModal(window._strategyRules[${r.id}])">编辑</button>
        <button class="btn-danger" onclick="deleteStrategy(${r.id})">删除</button>
        ${r.is_exploration ? `<button onclick="rechargeStrategy(${r.id})">续充</button>` : ''}
      </td>
    </tr>`;
  }).join('');
}

async function renderBuiltinRules(existingRules) {
  const container = document.getElementById('builtinRulesBody');
  if (!container) return;
  const builtins = await fetchJSON(`${API}/strategy/builtin`).catch(() => []);
  if (!builtins.length) { document.getElementById('builtinRulesPanel').style.display = 'none'; return; }

  const existingNames = new Set((existingRules || []).map(r => r.name));
  const allInstalled = builtins.every(b => existingNames.has(b.rule.name));

  const PROFILE_STYLE = { cheap: 'color:var(--green)', balanced: 'color:var(--blue)', premium: 'color:var(--orange)' };

  let html = '<div class="builtin-rules-grid">';
  for (const b of builtins) {
    const installed = existingNames.has(b.rule.name);
    const r = b.rule;
    const profileStyle = PROFILE_STYLE[r.profile] || '';
    html += `<div class="builtin-rule-card ${installed ? 'installed' : ''}">
      <div class="builtin-rule-header">
        <span class="builtin-rule-name">${b.name}</span>
        ${installed
          ? '<span class="builtin-rule-badge installed">已安装</span>'
          : '<span class="builtin-rule-badge">未安装</span>'}
      </div>
      <div class="builtin-rule-desc">${b.description}</div>
      <div class="builtin-rule-meta">
        <span class="builtin-meta-item">角色 <code>${r.agent_role || '—'}</code></span>
        <span class="builtin-meta-item">路由 <code style="${profileStyle}">${r.profile || '—'}</code>${PROFILE_DESC[r.profile] ? `<span style="color:var(--text-tertiary);margin-left:4px">${PROFILE_DESC[r.profile]}</span>` : ''}</span>
        <span class="builtin-meta-item">置信 <code>${r.confidence != null ? r.confidence : '—'}</code></span>
        <span class="builtin-meta-item">优先级 <code>${r.priority_order != null ? r.priority_order : '—'}</code></span>
      </div>
    </div>`;
  }
  html += '</div>';
  if (!allInstalled) {
    html += `<div class="builtin-rules-footer">
      <button class="btn-filled btn-sm" onclick="installBuiltinRules(this)">一键安装保质降本规则</button>
      <span class="builtin-rules-hint">自动跳过已安装规则，安全幂等</span>
    </div>`;
  } else {
    html += `<div class="builtin-rules-footer">
      <span style="color:var(--text-secondary);font-size:13px">✓ 所有内置规则已安装</span>
    </div>`;
  }
  container.innerHTML = html;
}

async function installBuiltinRules(btn) {
  btn.disabled = true;
  btn.textContent = '安装中…';
  try {
    const result = await fetch(`${API}/strategy/install-builtin`, { method: 'POST' }).then(r => r.json());
    if (result._offline) {
      showToast('cc-proxy 未运行，无法安装规则', 'orange');
      btn.disabled = false;
      btn.textContent = '一键安装保质降本规则';
      return;
    }
    const created = (result.created || []).length;
    const skipped = (result.skipped || []).length;
    showToast(`已安装 ${created} 条规则${skipped ? `，跳过 ${skipped} 条已存在` : ''}`, 'green');
    invalidateCache(`${API}/strategy/rules`);
    loadStrategyView();
  } catch (e) {
    showToast('安装失败: ' + e.message, 'red');
    btn.disabled = false;
    btn.textContent = '一键安装保质降本规则';
  }
}

const DISPATCH_LABELS = {
  strategy: '策略规则', session_binding: 'Session绑定', session_override: 'Session锁定',
  local_rule: '本地规则', default: '默认',
};
const DISPATCH_COLORS = {
  strategy: 'var(--green)', session_binding: 'var(--blue)', session_override: 'var(--orange)',
  local_rule: 'var(--purple)', default: 'var(--text-tertiary)',
};

function renderTrafficFlow(data) {
  const panel = document.getElementById('trafficFlowPanel');
  const body = document.getElementById('trafficFlowBody');
  if (!data || !data.length) { panel.style.display = 'none'; return; }
  panel.style.display = '';
  const total = data.reduce((s, d) => s + (d.cnt || 0), 0);
  const sorted = data.sort((a, b) => (b.cnt || 0) - (a.cnt || 0)).slice(0, 20);
  let html = '<table class="fossil-table flow-table"><thead><tr><th>角色</th><th>Profile</th><th>来源</th><th>请求数</th><th>占比</th><th>成本</th></tr></thead><tbody>';
  for (const row of sorted) {
    const pct = total > 0 ? ((row.cnt / total) * 100).toFixed(1) : '0';
    const src = row.dispatch_source || 'unknown';
    const srcLabel = DISPATCH_LABELS[src] || src;
    const srcColor = DISPATCH_COLORS[src] || 'var(--text-tertiary)';
    const cost = (row.total_cost || 0).toFixed(4);
    html += `<tr>
      <td><code>${row.agent_role || '?'}</code></td>
      <td>${row.profile_name || '—'}</td>
      <td><span class="dispatch-tag" style="color:${srcColor};border-color:${srcColor}">${srcLabel}</span></td>
      <td class="tnum">${row.cnt}</td>
      <td class="tnum"><div class="pct-bar"><div class="pct-fill" style="width:${pct}%;background:${srcColor}"></div><span>${pct}%</span></div></td>
      <td class="tnum">¥${cost}</td>
    </tr>`;
  }
  html += '</tbody></table>';
  body.innerHTML = html;
}

function renderDispatchChart(data) {
  if (charts.dispatch) charts.dispatch.destroy();
  const ctx = document.getElementById('dispatchChart');
  if (!ctx || !data.length) return;
  charts.dispatch = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: data.map(d => d.dispatch_source),
      datasets: [{ data: data.map(d => d.cnt), backgroundColor: CHART_PALETTE }],
    },
    options: { plugins: { legend: { position: 'right' } } },
  });
}

function renderRuleHitChart(data) {
  if (charts.ruleHit) charts.ruleHit.destroy();
  const ctx = document.getElementById('ruleHitChart');
  if (!ctx || !data.length) return;
  charts.ruleHit = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: data.map(d => `Rule #${d.strategy_rule_id}`),
      datasets: [{
        label: '命中次数', data: data.map(d => d.hit_count),
        backgroundColor: APPLE_COLORS.blue,
      }, {
        label: 'Avg HVR', data: data.map(d => (d.avg_hvr || 0).toFixed(2)),
        backgroundColor: APPLE_COLORS.green, yAxisID: 'y1',
      }],
    },
    options: {
      scales: {
        y: { beginAtZero: true, title: { display: true, text: '命中数' } },
        y1: { position: 'right', beginAtZero: true, max: 1, title: { display: true, text: 'HVR' }, grid: { display: false } },
      },
    },
  });
}

function renderRoleDistChart(data) {
  if (charts.roleDist) charts.roleDist.destroy();
  const ctx = document.getElementById('roleDistChart');
  if (!ctx || !data.length) return;
  const sorted = data.slice().sort((a, b) => b.total - a.total).slice(0, 12);
  charts.roleDist = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: sorted.map(d => d.agent_role || '?'),
      datasets: [{
        label: '请求数', data: sorted.map(d => d.total),
        backgroundColor: APPLE_COLORS.blue,
      }],
    },
    options: {
      indexAxis: 'y',
      plugins: { legend: { display: false } },
      scales: { x: { beginAtZero: true } },
    },
  });
}

function renderRoleFamilyChart(data) {
  if (charts.roleFamily) charts.roleFamily.destroy();
  const ctx = document.getElementById('roleFamilyChart');
  if (!ctx || !data.length) return;
  const familyColors = { main: APPLE_COLORS.blue, subagent: APPLE_COLORS.orange, sidequery: APPLE_COLORS.green, compaction: APPLE_COLORS.purple, raw_api: APPLE_COLORS.red };
  charts.roleFamily = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: data.map(d => d.role_family),
      datasets: [{ data: data.map(d => d.total_cost || 0), backgroundColor: data.map(d => familyColors[d.role_family] || APPLE_COLORS.gray) }],
    },
    options: { plugins: { legend: { position: 'right' } } },
  });
}

let _strategyTemplates = [];

const STRATEGY_TEMPLATES = {
  economy: {
    label: '省钱模式 (全局)',
    priority_order: 50, source: 'manual', confidence: 1.0,
    agent_role: '', model_pattern: '',
    cel_expr: '', profile: 'cheap', weighted: '',
    is_exploration: false, exploration_budget: 0, enabled: true,
  },
  premium: {
    label: '高质模式 (全局)',
    priority_order: 50, source: 'manual', confidence: 1.0,
    agent_role: '', model_pattern: '',
    cel_expr: '', profile: 'premium', weighted: '',
    is_exploration: false, exploration_budget: 0, enabled: true,
  },
  balanced: {
    label: '均衡模式 (加权)',
    priority_order: 80, source: 'manual', confidence: 1.0,
    agent_role: '', model_pattern: '',
    cel_expr: '', profile: '', weighted: '[{"profile":"cheap","weight":60},{"profile":"premium","weight":40}]',
    is_exploration: false, exploration_budget: 0, enabled: true,
  },
  subagent_cheap: {
    label: '子Agent省钱',
    priority_order: 30, source: 'manual', confidence: 1.0,
    agent_role: 'subagent', model_pattern: '',
    cel_expr: '', profile: 'cheap', weighted: '',
    is_exploration: false, exploration_budget: 0, enabled: true,
  },
  sidequery_cheap: {
    label: '侧查询省钱',
    priority_order: 25, source: 'manual', confidence: 1.0,
    agent_role: 'sidequery', model_pattern: '',
    cel_expr: '', profile: 'cheap', weighted: '',
    is_exploration: false, exploration_budget: 0, enabled: true,
  },
  compaction_cheap: {
    label: '压缩省钱',
    priority_order: 20, source: 'manual', confidence: 1.0,
    agent_role: 'compaction', model_pattern: '',
    cel_expr: '', profile: 'cheap', weighted: '',
    is_exploration: false, exploration_budget: 0, enabled: true,
  },
  mutation_premium: {
    label: '写入操作高质量',
    priority_order: 35, source: 'manual', confidence: 1.0,
    agent_role: 'main:tool:mutation', model_pattern: '',
    cel_expr: '', profile: 'premium', weighted: '',
    is_exploration: false, exploration_budget: 0, enabled: true,
  },
  long_context: {
    label: '长上下文降级',
    priority_order: 40, source: 'manual', confidence: 1.0,
    agent_role: '', model_pattern: '',
    cel_expr: 'msg_count > 20', profile: 'cheap', weighted: '',
    is_exploration: false, exploration_budget: 0, enabled: true,
  },
  retrial_switch: {
    label: '重试换Profile',
    priority_order: 10, source: 'manual', confidence: 1.0,
    agent_role: '', model_pattern: '',
    cel_expr: 'is_retrial == true', profile: 'balanced', weighted: '',
    is_exploration: false, exploration_budget: 0, enabled: true,
  },
};

function applyTemplate(key) {
  // Try API templates first
  const apiTpl = _strategyTemplates.find(t => t.id === key);
  if (apiTpl) {
    const r = apiTpl.rule;
    const form = document.getElementById('strategyForm');
    form.priority_order.value = r.priority_order || 100;
    form.source.value = r.source || 'manual';
    form.confidence.value = r.confidence != null ? r.confidence : 1.0;
    form.agent_role.value = r.agent_role || '';
    form.model_pattern.value = r.model_pattern || '';
    form.cel_expr.value = r.cel_expr || '';
    form.profile.value = r.profile || '';
    form.weighted.value = r.weighted || '';
    form.is_exploration.checked = !!r.is_exploration;
    form.exploration_budget.value = r.exploration_budget || 0;
    form.enabled.checked = r.enabled !== false;
    if (r.cel_expr || r.weighted || r.is_exploration) {
      document.getElementById('strategyAdvanced').setAttribute('open', '');
    }
    showToast(`已应用模板: ${apiTpl.name}`, 'green');
    return;
  }
  // Fallback to legacy hardcoded
  const tpl = STRATEGY_TEMPLATES[key];
  if (!tpl) return;
  const form = document.getElementById('strategyForm');
  form.priority_order.value = tpl.priority_order;
  form.source.value = tpl.source;
  form.confidence.value = tpl.confidence;
  form.agent_role.value = tpl.agent_role;
  form.model_pattern.value = tpl.model_pattern;
  form.cel_expr.value = tpl.cel_expr;
  form.profile.value = tpl.profile;
  form.weighted.value = tpl.weighted;
  form.is_exploration.checked = tpl.is_exploration;
  form.exploration_budget.value = tpl.exploration_budget;
  form.enabled.checked = tpl.enabled;
  if (tpl.cel_expr || tpl.weighted || tpl.is_exploration) {
    document.getElementById('strategyAdvanced').setAttribute('open', '');
  }
  showToast(`已应用模板: ${tpl.label}`, 'green');
}

function fillCel(expr) {
  const input = document.getElementById('celExprInput');
  if (input.value && input.value !== expr) {
    input.value = input.value + ' && ' + expr;
  } else {
    input.value = expr;
  }
  input.focus();
}

function _renderTemplateBar(bar) {
  let html = '<span class="template-label">快速模板:</span>';
  if (_strategyTemplates.length) {
    for (const t of _strategyTemplates) {
      html += `<button type="button" class="btn-tpl" onclick="applyTemplate('${t.id}')">${t.name}</button>`;
    }
  } else {
    for (const [key, tpl] of Object.entries(STRATEGY_TEMPLATES)) {
      html += `<button type="button" class="btn-tpl" onclick="applyTemplate('${key}')">${tpl.label}</button>`;
    }
  }
  bar.innerHTML = html;
}

function openStrategyModal(rule) {
  const modal = document.getElementById('strategyModal');
  const form = document.getElementById('strategyForm');
  const title = document.getElementById('strategyModalTitle');
  const advanced = document.getElementById('strategyAdvanced');
  const tplBar = document.getElementById('templateBar');
  const intentStep = document.getElementById('intentStep');
  const formStep = document.getElementById('formStep');

  form.reset();
  advanced.removeAttribute('open');

  if (rule && typeof rule === 'object') {
    // Edit mode: skip intent, show form directly
    intentStep.style.display = 'none';
    formStep.style.display = '';
    tplBar.style.display = 'none';
    title.textContent = `编辑规则 #${rule.id}`;
    form.rule_id.value = rule.id;
    form.priority_order.value = rule.priority_order || 100;
    form.source.value = rule.source || 'manual';
    form.confidence.value = rule.confidence != null ? rule.confidence : 1.0;
    form.agent_role.value = rule.agent_role || '';
    form.model_pattern.value = rule.model_pattern || '';
    form.cel_expr.value = rule.cel_expr || '';
    form.weighted.value = rule.weighted || '';
    form.is_exploration.checked = !!rule.is_exploration;
    form.exploration_budget.value = rule.exploration_budget || 0;
    form.enabled.checked = rule.enabled !== false;
    if (rule.cel_expr || rule.weighted || rule.is_exploration) {
      advanced.setAttribute('open', '');
    }
  } else {
    // New rule: show intent step
    intentStep.style.display = '';
    formStep.style.display = 'none';
    title.textContent = '新建规则';
    form.rule_id.value = '';
    form.enabled.checked = true;
  }
  modal.hidden = false;
  modal.classList.add('visible');
  _populateProfileSelect().then(() => {
    if (rule && rule.profile) form.profile.value = rule.profile;
  });
  loadStrategySessionOptions(rule && (rule.cc_entrypoint
    ? (rule.cc_entrypoint === 'sdk-cli' ? '__sdk_cli__' : '__sdk__')
    : rule.session_id) || '');
}

async function loadStrategySessionOptions(selectedId) {
  const sel = document.getElementById('strategySessionSelect');
  sel.innerHTML = `
    <option value="">全局（不限）</option>
    <optgroup label="按入口类型">
      <option value="__sdk__">所有 Claude SDK（sdk-cli / sdk-ts）</option>
      <option value="__sdk_cli__">仅 claude -p（sdk-cli）</option>
    </optgroup>
    <optgroup label="具体会话" id="sessionOptgroup">
    </optgroup>`;
  const optgroup = sel.querySelector('#sessionOptgroup');
  const seen = new Set();
  try {
    const [active, known, projects] = await Promise.all([
      fetchJSON(`${API}/cc-proxy/active-sessions`).catch(() => ({})),
      fetchJSON(`${API}/cc-proxy/sessions?limit=80`).catch(() => []),
      fetchJSON(`${API}/cc-proxy/session-projects`).catch(() => ({})),
    ]);
    const bindings = active.session_bindings || active.sessions || [];
    for (const s of bindings) {
      const sid = s.session_id || '';
      if (!sid || seen.has(sid)) continue;
      seen.add(sid);
      const extra = s.bound_profile ? ` [${s.bound_profile}]` : '';
      optgroup.innerHTML += `<option value="${sid}">${_sessionLabel(s, projects)}${extra}</option>`;
    }
    const list = Array.isArray(known) ? known : [];
    for (const s of list) {
      const sid = s.sessionId || s.session_id || s.id || '';
      if (!sid || sid === 'unknown' || seen.has(sid)) continue;
      seen.add(sid);
      optgroup.innerHTML += `<option value="${sid}">${_sessionLabel(s, projects)}</option>`;
    }
  } catch (_) {}
  if (selectedId) sel.value = selectedId;
}

function _sessionLabel(s, projects) {
  const sid = s.sessionId || s.session_id || s.id || '';
  const shortId = sid.slice(0, 8);
  const project = (projects || {})[sid] || '';
  let time = '';
  if (s.startTime) {
    const d = new Date(s.startTime);
    time = `${(d.getMonth()+1).toString().padStart(2,'0')}/${d.getDate().toString().padStart(2,'0')} ${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}`;
  }
  const models = (s.models || []).map(m => m.replace(/^Claude-/,'').replace(/^DeepSeek-/,'DS-').split('-')[0]).slice(0, 2).join('+');
  const reqs = s.spanCount || s.logCount || 0;
  const parts = [project, time, models, reqs ? `${reqs}次` : ''].filter(Boolean);
  return parts.length ? `${parts.join(' · ')} (${shortId})` : shortId;
}

function closeStrategyModal() {
  const modal = document.getElementById('strategyModal');
  modal.classList.remove('visible');
  modal.hidden = true;
}

function selectIntent(intent) {
  const intentStep = document.getElementById('intentStep');
  const formStep = document.getElementById('formStep');
  const form = document.getElementById('strategyForm');
  const tplBar = document.getElementById('templateBar');
  const advanced = document.getElementById('strategyAdvanced');

  intentStep.style.display = 'none';
  formStep.style.display = '';
  form.reset();
  form.enabled.checked = true;
  form.rule_id.value = '';
  advanced.removeAttribute('open');

  _populateProfileSelect().then(() => {
    switch (intent) {
      case 'save':
        form.agent_role.value = 'subagent';
        form.profile.value = 'cheap';
        form.priority_order.value = 30;
        tplBar.style.display = 'flex';
        _renderTemplateBar(tplBar);
        break;
      case 'quality':
        form.agent_role.value = 'main:tool:mutation';
        form.profile.value = 'premium';
        form.priority_order.value = 35;
        tplBar.style.display = 'none';
        break;
      case 'split':
        form.priority_order.value = 80;
        advanced.setAttribute('open', '');
        tplBar.style.display = 'none';
        break;
      case 'custom':
      default:
        tplBar.style.display = 'flex';
        _renderTemplateBar(tplBar);
        break;
    }
  });
  loadStrategySessionOptions('');
}

async function saveStrategy(event) {
  event.preventDefault();
  const form = document.getElementById('strategyForm');
  const fd = new FormData(form);
  const body = {};
  body.priority_order = parseInt(fd.get('priority_order')) || 100;
  body.source = fd.get('source') || 'manual';
  body.confidence = parseFloat(fd.get('confidence')) || 1.0;
  const cid = fd.get('cluster_id');
  if (cid) body.cluster_id = parseInt(cid);
  const role = fd.get('agent_role');
  if (role) body.agent_role = role;
  const mp = fd.get('model_pattern');
  if (mp) body.model_pattern = mp;
  const cel = fd.get('cel_expr');
  if (cel) body.cel_expr = cel;
  const sid = fd.get('session_id');
  if (sid === '__sdk__') {
    body.cc_entrypoint = 'sdk';
  } else if (sid === '__sdk_cli__') {
    body.cc_entrypoint = 'sdk-cli';
  } else if (sid) {
    body.session_id = sid;
  }
  const prof = fd.get('profile');
  if (prof) body.profile = prof;
  const wt = fd.get('weighted');
  if (wt) body.weighted = wt;
  body.is_exploration = form.is_exploration.checked;
  body.exploration_budget = parseInt(fd.get('exploration_budget')) || 0;
  body.enabled = form.enabled.checked;

  const ruleId = fd.get('rule_id');

  // 并行发出冲突检测 + 影响估算（新建时）
  const conflictPromise = fetch(`${API}/strategy/check-conflicts`, {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({
      agent_role: body.agent_role, model_pattern: body.model_pattern,
      cel_expr: body.cel_expr, priority_order: body.priority_order,
      rule_id: ruleId ? parseInt(ruleId) : null,
    }),
  }).then(r => r.json()).catch(() => null);

  const impactPromise = (!ruleId && body.enabled && body.profile)
    ? fetch(`${API}/strategy/estimate-impact`, {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ agent_role: body.agent_role, model_pattern: body.model_pattern, hours: 24 }),
      }).then(r => r.json()).catch(() => null)
    : Promise.resolve(null);

  const [conflicts, impact] = await Promise.all([conflictPromise, impactPromise]);

  if (conflicts && conflicts.is_shadowed) {
    const names = conflicts.shadows.map(s => `#${s.id} (优先级${s.priority}, ${s.agent_role} → ${s.profile})`).join('\n');
    if (!confirm(`此规则会被以下高优先级规则遮蔽:\n${names}\n\n是否仍然保存？`)) return false;
  }

  try {
    if (ruleId) {
      await fetch(`${API}/strategy/rules/${ruleId}`, { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) });
    } else {
      const resp = await fetch(`${API}/strategy/rules`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        alert(err.error || '创建失败'); return false;
      }
    }
    closeStrategyModal();
    invalidateCache('/strategy/');
    loadStrategyView();
    // 保存成功后用 toast 提示影响范围（非阻塞）
    if (impact && impact.matched_count > 0) {
      showToast({ severity: 'info', title: '规则影响范围', detail: `过去24h匹配 ${impact.matched_count} 次请求，历史成本 ¥${impact.current_cost.toFixed(4)}` });
    }
  } catch (e) { alert('保存失败: ' + e.message); }
  return false;
}

async function toggleStrategy(id, enabled) {
  try {
    await fetch(`${API}/strategy/rules/${id}/toggle`, {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ enabled }),
    });
  } catch (_) {}
}

async function deleteStrategy(id) {
  if (!confirm(`确定删除规则 #${id}?`)) return;
  try {
    const resp = await fetch(`${API}/strategy/rules/${id}`, { method: 'DELETE' });
    if (!resp.ok) { showToast({ severity: 'error', title: '删除失败', detail: `HTTP ${resp.status}` }); return; }
    invalidateCache('/strategy/');
    await loadStrategyView();
  } catch (e) {
    showToast({ severity: 'error', title: '删除失败', detail: e.message });
  }
}

async function rechargeStrategy(id) {
  const budget = prompt('设置新的探索预算:', '200');
  if (budget == null) return;
  try {
    await fetch(`${API}/strategy/rules/${id}/recharge`, {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ budget: parseInt(budget) || 0 }),
    });
    invalidateCache('/strategy/');
    loadStrategyView();
  } catch (_) {}
}

// ============ Provider Management Modal ============
let _cachedProviders = [];  // shared cache used by both provider modal and add-model modal

async function _fetchProviders(force = false) {
  if (!force && _cachedProviders.length) return _cachedProviders;
  try {
    const data = await fetchJSON(`${API}/providers`);
    _cachedProviders = data.providers || [];
  } catch (_) { _cachedProviders = []; }
  return _cachedProviders;
}

async function openProviderModal() {
  const modal = document.getElementById('providerModal');
  modal.hidden = false;
  modal.classList.add('visible');
  await _loadProviderList();
}

function closeProviderModal() {
  const modal = document.getElementById('providerModal');
  modal.hidden = true;
  modal.classList.remove('visible');
  _resetProvAddForm();
}

function _resetProvAddForm() {
  ['provNewName','provNewUrl','provNewKey'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  const typeEl = document.getElementById('provNewType');
  if (typeEl) { typeEl.value = 'openai'; onProvTypeChange(); }
  const form = document.getElementById('provAddForm');
  if (form) form.hidden = true;
  const toggle = document.getElementById('provAddToggle');
  if (toggle) toggle.classList.remove('active');
}

function toggleProvAddForm() {
  const form = document.getElementById('provAddForm');
  const toggle = document.getElementById('provAddToggle');
  const open = form.hidden;
  form.hidden = !open;
  toggle.classList.toggle('active', open);
  if (open) {
    onProvTypeChange();
    document.getElementById('provNewName').focus();
  }
}

const PROV_TYPE_DEFAULTS = {
  openai:    { url: 'https://api.openai.com/v1',         key: 'sk-…' },
  anthropic: { url: 'https://api.anthropic.com',         key: 'sk-ant-…' },
};

function onProvTypeChange() {
  const type = document.getElementById('provNewType')?.value || 'openai';
  const urlEl = document.getElementById('provNewUrl');
  const keyEl = document.getElementById('provNewKey');
  const def = PROV_TYPE_DEFAULTS[type] || PROV_TYPE_DEFAULTS.openai;
  if (urlEl && !urlEl.value) urlEl.placeholder = def.url;
  if (urlEl && (!urlEl.value || Object.values(PROV_TYPE_DEFAULTS).some(d => d.url === urlEl.value))) {
    urlEl.value = def.url;
  }
  if (keyEl) keyEl.placeholder = def.key;
}

async function _loadProviderList() {
  const container = document.getElementById('providerList');
  container.innerHTML = '<div style="color:var(--text-tertiary);font-size:12px">加载中…</div>';
  const [providers, monthlyCostAll] = await Promise.all([
    _fetchProviders(true),
    fetchJSON(`${API}/models/monthly-cost`).catch(() => [])
  ]);
  if (!providers.length) {
    container.innerHTML = '<div style="color:var(--text-tertiary);font-size:12px">暂无 Provider，请在下方添加。</div>';
    return;
  }
  // Build provider→cost map from current month
  const nowMonth = new Date().toISOString().slice(0, 7);
  const currentMonth = (monthlyCostAll || []).find(m => m.month === nowMonth) || null;
  const provCostMap = {};
  if (currentMonth && currentMonth.by_provider) {
    for (const bp of currentMonth.by_provider) provCostMap[bp.provider.toLowerCase()] = bp;
  }
  container.innerHTML = providers.map(p => {
    const typeLabel = p.type === 'anthropic' ? 'Anthropic' : 'OpenAI';
    const keyStatus = p.has_key
      ? `<span style="color:var(--green);font-size:11px">${escapeHtml(p.api_key_masked)}</span>`
      : '<span style="color:var(--red);font-size:11px">未配置</span>';
    const pn = escapeJsStr(p.name);
    const modelTags = p.models.length
      ? p.models.map(m => `<span class="model-tag">${escapeHtml(m)}<button class="model-tag-del" onclick="deleteModelFromProvider('${pn}','${escapeJsStr(m)}')" title="删除">×</button></span>`).join('')
      : '<span style="color:var(--text-tertiary);font-size:11px">暂无模型</span>';
    const bp = provCostMap[p.name.toLowerCase()];
    const costBadge = bp
      ? `<span style="margin-left:auto;font-size:11px;color:var(--teal)">当月 ${fmtCost(bp.cost_rmb)} · ${bp.request_count}次</span>`
      : '';
    return `<div class="provider-card">
      <div class="provider-card-header">
        <span class="provider-card-name">${escapeHtml(p.name)}</span>
        <span class="type-badge type-${p.type}">${typeLabel}</span>
        ${keyStatus}
        <span style="color:var(--text-tertiary);font-size:11px;margin-left:4px">${escapeHtml(p.base_url || '')}</span>
        ${costBadge}
        <span class="provider-card-actions">
          <button class="model-action-btn" onclick="openEditProviderModal('${pn}')">编辑</button>
          <button class="model-action-btn danger" onclick="deleteProvider('${pn}')">删除</button>
        </span>
      </div>
      <div class="provider-card-models">
        ${modelTags}
        <button class="model-tag-add" onclick="openAddModelToProviderModal('${pn}')">＋ 添加模型</button>
      </div>
    </div>`;
  }).join('');
}

async function addProvider() {
  const name = document.getElementById('provNewName').value.trim();
  const type = document.getElementById('provNewType').value;
  const base_url = document.getElementById('provNewUrl').value.trim();
  const api_key = document.getElementById('provNewKey').value.trim();
  if (!name || !base_url || !api_key) { alert('名称、Base URL、API Key 均为必填项'); return; }
  try {
    const r = await fetchJSON(`${API}/providers`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, type, base_url, api_key }) });
    if (!r.ok) throw new Error(r.error || '添加失败');
    _resetProvAddForm();
    _cachedProviders = [];
    invalidateCache('/providers');
    invalidateCache('/models/config-status');
    invalidateCache('/models/config-models');
    invalidateCache('/models/monthly-cost');
    await _loadProviderList();
    _syncAddModelProviderSelect();
    loadModelView();
    showToast({ severity: 'ok', title: `Provider "${r.name}" 已添加`, detail: r.proxy_reloaded ? 'cc-proxy 已重载' : 'cc-proxy 未在线，重启后生效' });
  } catch (e) { alert(`添加失败: ${e.message}`); }
}

async function deleteProvider(name) {
  if (!confirm(`确定删除 Provider "${name}"？\n该 Provider 的所有模型将从 profile 中移除。`)) return;
  try {
    const r = await fetchJSON(`${API}/providers/${encodeURIComponent(name)}`, { method: 'DELETE' });
    if (!r.ok) throw new Error(r.error || '删除失败');
    _cachedProviders = [];
    invalidateCache('/providers');
    invalidateCache('/models/config-status');
    invalidateCache('/models/config-models');
    invalidateCache('/models/monthly-cost');
    invalidateCache('/strategy/profiles');
    await _loadProviderList();
    _syncAddModelProviderSelect();
    loadModelView();
    showToast({ severity: 'ok', title: `Provider "${name}" 已删除`, detail: r.proxy_reloaded ? 'cc-proxy 已重载' : 'cc-proxy 未在线，重启后生效' });
  } catch (e) { alert(`删除失败: ${e.message}`); }
}

async function openEditProviderModal(name) {
  const providers = await _fetchProviders(true);
  const prov = providers.find(p => p.name === name);
  if (!prov) return;
  document.getElementById('editProvOrigName').value = prov.name;
  document.getElementById('editProvName').value = prov.name;
  document.getElementById('editProvType').value = prov.type || 'openai';
  document.getElementById('editProvUrl').value = prov.base_url || '';
  document.getElementById('editProvKey').value = '';
  const modal = document.getElementById('editProviderModal');
  modal.hidden = false;
  modal.classList.add('visible');
}

function closeEditProviderModal() {
  const modal = document.getElementById('editProviderModal');
  modal.hidden = true;
  modal.classList.remove('visible');
}

async function saveEditProvider() {
  const origName = document.getElementById('editProvOrigName').value;
  const name = document.getElementById('editProvName').value.trim();
  const type = document.getElementById('editProvType').value;
  const base_url = document.getElementById('editProvUrl').value.trim();
  const api_key = document.getElementById('editProvKey').value.trim();
  if (!name || !base_url) { alert('名称和 Base URL 不能为空'); return; }
  const body = { name, type, base_url };
  if (api_key) body.api_key = api_key;
  try {
    const r = await fetchJSON(`${API}/providers/${encodeURIComponent(origName)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(r.error || '保存失败');
    closeEditProviderModal();
    _cachedProviders = [];
    invalidateCache('/providers');
    invalidateCache('/models/config-status');
    invalidateCache('/models/config-models');
    invalidateCache('/models/monthly-cost');
    await _loadProviderList();
    _syncAddModelProviderSelect();
    loadModelView();
    showToast({ severity: 'ok', title: `Provider "${r.name}" 已更新`, detail: r.proxy_reloaded ? 'cc-proxy 已重载' : 'cc-proxy 未在线，重启后生效' });
  } catch (e) { alert(`保存失败: ${e.message}`); }
}

// --- Add model directly from provider modal ---
function openAddModelToProviderModal(providerName) {
  document.getElementById('addModelToProviderName').textContent = providerName;
  document.getElementById('addModelToProviderName').dataset.prov = providerName;
  document.getElementById('addMtpModelName').value = '';
  document.querySelectorAll('#addMtpProfiles input').forEach(cb => { cb.checked = cb.value === 'premium'; });
  const modal = document.getElementById('addModelToProviderModal');
  modal.hidden = false;
  modal.classList.add('visible');
}

function closeAddModelToProviderModal() {
  const modal = document.getElementById('addModelToProviderModal');
  modal.hidden = true;
  modal.classList.remove('visible');
}

async function saveAddModelToProvider() {
  const provName = document.getElementById('addModelToProviderName').dataset.prov;
  const modelName = document.getElementById('addMtpModelName').value.trim();
  if (!modelName) { alert('请输入模型名称'); return; }
  const groupNames = [...document.querySelectorAll('#addMtpProfiles input:checked')].map(cb => cb.value);
  try {
    const r = await fetchJSON(`${API}/models`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model_name: modelName, provider: provName, group_names: groupNames }) });
    if (!r.ok && r.error) throw new Error(r.error);
    closeAddModelToProviderModal();
    _cachedProviders = [];
    invalidateCache('/providers');
    invalidateCache('/models/config-status');
    invalidateCache('/models/config-models');
    invalidateCache('/strategy/profiles');
    await _loadProviderList();
    loadModelView();
    showToast({ severity: 'ok', title: `模型 "${modelName}" 已添加到 ${provName}` });
  } catch (e) { alert(`添加失败: ${e.message}`); }
}

async function deleteModelFromProvider(providerName, modelName) {
  if (!confirm(`从 Provider "${providerName}" 删除模型 "${modelName}"？`)) return;
  try {
    const r = await fetchJSON(`${API}/models/delete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model_name: modelName, provider: providerName }) });
    if (!r.ok && r.error) throw new Error(r.error);
    _cachedProviders = [];
    invalidateCache('/providers');
    invalidateCache('/models/config-status');
    invalidateCache('/models/config-models');
    invalidateCache('/strategy/profiles');
    await _loadProviderList();
    loadModelView();
  } catch (e) { alert(`删除失败: ${e.message}`); }
}

// ============ Add Model Modal ============
// Populate provider <select> from live provider list
async function _syncAddModelProviderSelect() {
  const sel = document.getElementById('addModelProviderSelect');
  if (!sel) return;
  const providers = await _fetchProviders();
  const prev = sel.value;
  sel.innerHTML = '<option value="">-- 选择 Provider --</option>'
    + providers.map(p => `<option value="${escapeHtml(p.name)}">${escapeHtml(p.name)} (${p.type === 'anthropic' ? 'Anthropic' : 'OpenAI'})</option>`).join('');
  if (prev && providers.find(p => p.name === prev)) sel.value = prev;
  else if (providers.length) sel.value = providers[0].name;
  // auto-fill linked fields for the selected provider
  _applyProviderToForm(sel);
}

function _applyProviderToForm(sel) {
  const form = sel.closest('form');
  if (!form) return;
  const prov = _cachedProviders.find(p => p.name === sel.value);
  if (!prov) return;
  const typeMap = { anthropic: 'Anthropic', openai: 'OpenAI' };
  if (form.model_type) form.model_type.value = typeMap[prov.type] || 'OpenAI';
  if (form.api_base) form.api_base.value = prov.base_url || '';
  if (form.api_key) {
    form.api_key.value = '';
    form.api_key.placeholder = prov.has_key ? (prov.api_key_masked + '（已有供应商可留空）') : 'sk-...';
  }
}

async function openAddModelModal() {
  const modal = document.getElementById('addModelModal');
  const form = document.getElementById('addModelForm');
  form.reset();
  if (form.model_name) form.model_name.value = 'Claude-Opus-4.6';
  await _syncAddModelProviderSelect();
  modal.hidden = false;
  modal.classList.add('visible');
}

function closeAddModelModal() {
  const modal = document.getElementById('addModelModal');
  modal.classList.remove('visible');
  modal.hidden = true;
}

function onAddModelProviderChange(sel) {
  _applyProviderToForm(sel);
}

function onAddModelTypeChange(sel) {
  // type changed manually — only update api_base if it's still a default value
  const form = sel.closest('form');
  if (!form) return;
  const apiBase = form.api_base;
  if (!apiBase) return;
  const curVal = apiBase.value.trim();
  const oldDefaults = Object.values(DEFAULT_API_BASE);
  const provBase = (_cachedProviders.find(p => p.name === (form.provider && form.provider.value)))?.base_url;
  if (!curVal || oldDefaults.includes(curVal) || curVal === provBase) {
    apiBase.value = DEFAULT_API_BASE[sel.value.toLowerCase()] || '';
  }
}

async function saveNewModel(event) {
  event.preventDefault();
  const form = document.getElementById('addModelForm');
  const fd = new FormData(form);
  const body = {
    model_name: fd.get('model_name').trim(),
    provider: fd.get('provider').trim(),
    model_type: fd.get('model_type') || 'OpenAI',
    group_names: [...document.querySelectorAll('#addModelProfiles input:checked')].map(cb => cb.value),
    api_base: (fd.get('api_base') || '').trim(),
    api_key: (fd.get('api_key') || '').trim(),
  };
  if (!body.model_name || !body.provider) return false;
  try {
    const resp = await fetch(`${API}/models`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      alert(err.error || '添加失败');
      return false;
    }
    const result = await resp.json().catch(() => ({}));
    closeAddModelModal();
    invalidateCache('/models');
    invalidateCache('/models/in-use');
    invalidateCache('/models/config-models');
    invalidateCache('/strategy/profiles');
    loadModelView();
    if (result.sync_warning) {
      showToast({ severity: 'warn', title: '模型已添加（同步警告）', detail: result.sync_warning });
    } else {
      showToast({ severity: 'info', title: '模型已添加并同步到 cc-proxy', detail: body.model_name });
    }
  } catch (e) {
    alert('添加失败: ' + e.message);
  }
  return false;
}

function openEditModelModal(encodedData) {
  const m = JSON.parse(decodeURIComponent(encodedData));
  const modal = document.getElementById('editModelModal');
  const form = document.getElementById('editModelForm');
  form.orig_model_name.value = m.model_name;
  form.provider.value = m.provider;
  form.model_name.value = m.model_name;
  form.provider_display.value = m.provider;
  form.model_type.value = m.model_type || 'OpenAI';

  const container = document.getElementById('editModelProfiles');
  const profiles = [
    { key: 'premium', label: '高级' },
    { key: 'balanced', label: '均衡' },
    { key: 'cheap', label: '经济' },
  ];
  const currentGroups = _findModelGroups(m.model_name, m.provider);
  container.innerHTML = profiles.map(p =>
    `<label class="profile-toggle"><input type="checkbox" name="group_name" value="${p.key}"${currentGroups.includes(p.key) ? ' checked' : ''}> ${p.label}</label>`
  ).join('');

  form.api_base.value = m.api_base || '';
  form.api_key.value = '';
  form.api_key.placeholder = m.api_key_masked || '留空则不修改';
  modal.hidden = false;
  modal.classList.add('visible');
}

function closeEditModelModal() {
  const modal = document.getElementById('editModelModal');
  modal.classList.remove('visible');
  modal.hidden = true;
}

async function saveEditModel(event) {
  event.preventDefault();
  const form = document.getElementById('editModelForm');
  const origName = form.orig_model_name.value;
  const provider = form.provider.value;
  const updates = {
    model_name: form.model_name.value.trim(),
    model_type: form.model_type.value,
    group_names: [...document.querySelectorAll('#editModelProfiles input:checked')].map(cb => cb.value),
  };
  const apiBase = form.api_base.value.trim();
  const apiKey = form.api_key.value.trim();
  if (apiBase) updates.api_base = apiBase;
  if (apiKey) updates.api_key = apiKey;
  if (!updates.model_name) { showToast({ severity: 'error', title: '模型名称不能为空' }); return false; }
  try {
    const resp = await fetch(`${API}/models/edit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model_name: origName, provider, updates }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      if (resp.status === 404) {
        const addBody = {
          model_name: updates.model_name,
          provider,
          model_type: updates.model_type || 'OpenAI',
          group_names: updates.group_names || [],
          api_base: apiBase,
          api_key: apiKey,
        };
        const addResp = await fetch(`${API}/models`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(addBody),
        });
        if (!addResp.ok) {
          const addErr = await addResp.json().catch(() => ({}));
          showToast({ severity: 'error', title: '添加失败', detail: addErr.error || '' });
          return false;
        }
        const addResult = await addResp.json().catch(() => ({}));
        closeEditModelModal();
        invalidateCache('/models');
        invalidateCache('/models/in-use');
        invalidateCache('/models/config-models');
        invalidateCache('/strategy/profiles');
        loadModelView();
        if (addResult.sync_warning) {
          showToast({ severity: 'warn', title: '模型已新增（同步警告）', detail: addResult.sync_warning });
        } else {
          showToast({ severity: 'info', title: '模型未找到，已新增', detail: addBody.model_name });
        }
        return false;
      }
      showToast({ severity: 'error', title: '编辑失败', detail: data.error || '' });
      return false;
    }
    closeEditModelModal();
    invalidateCache('/models/config-models');
    invalidateCache('/strategy/profiles');
    loadModelView();
    showToast({ severity: 'info', title: '模型已更新', detail: updates.model_name });
  } catch (e) {
    showToast({ severity: 'error', title: '编辑失败', detail: e.message });
  }
  return false;
}

async function deleteModel(modelName, provider) {
  if (!confirm(`确定删除模型 ${modelName} (${provider})？将从配置文件中移除。`)) return;
  try {
    const resp = await fetch(`${API}/models/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model_name: modelName, provider }),
    });
    const data = await resp.json();
    if (!resp.ok) { showToast({ severity: 'error', title: '删除失败', detail: data.error || '' }); return; }
    invalidateCache('/models/config-models');
    invalidateCache('/strategy/profiles');
    loadModelView();
    showToast({ severity: 'info', title: '模型已删除', detail: modelName });
  } catch (e) {
    showToast({ severity: 'error', title: '删除失败', detail: e.message });
  }
}

// ============ L8: Terminal Log ============
let termAutoScrollEnabled = true;
let _termLogLines = [];
let _termFilterLevel = 'all';
let _termFilterSession = 'all';
const TERM_MAX_LINES = 500;
const _termSessionRe = /\[([a-f0-9]{8})\/\d+\]/;
const _termSessionSet = new Set();

function _extractSession(text) {
  const m = _termSessionRe.exec(text || '');
  return m ? m[1] : null;
}

function _termUpdateSessionSelect() {
  const sel = document.getElementById('termSessionFilter');
  if (!sel) return;
  const prev = sel.value;
  const sessions = [..._termSessionSet].sort();
  sel.innerHTML = '<option value="all">所有 Session</option>' +
    sessions.map(s => `<option value="${s}"${s === prev ? ' selected' : ''}>${s}</option>`).join('');
}

function _termMatchesFilter(entry) {
  if (_termFilterLevel !== 'all' && entry.level !== _termFilterLevel) return false;
  if (_termFilterSession !== 'all') {
    const sid = _extractSession(entry.text);
    if (sid !== _termFilterSession) return false;
  }
  return true;
}

function loadTerminalView() {
  _termUpdateSessionSelect();
  const el = document.getElementById('terminalLog');
  if (!el) return;
  if (!_termLogLines.length) {
    el.innerHTML = '<div class="terminal-empty">等待日志...</div>';
    return;
  }
  _termRenderAll();
}

function _termInitLines(lines) {
  _termLogLines = lines.slice(-TERM_MAX_LINES);
  for (const l of _termLogLines) {
    const sid = _extractSession(l.text);
    if (sid) _termSessionSet.add(sid);
  }
  if (currentView === 'l8') {
    _termUpdateSessionSelect();
    _termRenderAll();
  }
}

function _termAppendLine(entry) {
  _termLogLines.push(entry);
  if (_termLogLines.length > TERM_MAX_LINES) _termLogLines.shift();
  const sid = _extractSession(entry.text);
  if (sid) {
    const hadSession = _termSessionSet.has(sid);
    _termSessionSet.add(sid);
    if (!hadSession && currentView === 'l8') _termUpdateSessionSelect();
  }
  if (currentView !== 'l8') return;
  if (!_termMatchesFilter(entry)) return;
  const el = document.getElementById('terminalLog');
  if (!el) return;
  const empty = el.querySelector('.terminal-empty');
  if (empty) empty.remove();
  el.insertAdjacentHTML('beforeend', _termLineHtml(entry));
  if (termAutoScrollEnabled) el.scrollTop = el.scrollHeight;
}

function _termRenderAll() {
  const el = document.getElementById('terminalLog');
  if (!el) return;
  const filtered = _termLogLines.filter(l => _termMatchesFilter(l));
  if (!filtered.length) {
    el.innerHTML = '<div class="terminal-empty">无匹配日志</div>';
    return;
  }
  el.innerHTML = filtered.map(l => _termLineHtml(l)).join('');
  if (termAutoScrollEnabled) el.scrollTop = el.scrollHeight;
}

function _termLineHtml(entry) {
  const t = new Date(entry.ts).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const lvl = (entry.level || 'info').toLowerCase();
  return `<div class="log-line level-${lvl}"><span class="log-time">${t}</span><span class="log-level">${lvl}</span><span class="log-text">${escapeHtml(entry.text)}</span></div>`;
}

function filterTermLog(level, btn) {
  _termFilterLevel = level;
  document.querySelectorAll('.terminal-filters .filter-pill').forEach(p => p.classList.remove('active'));
  if (btn) btn.classList.add('active');
  _termRenderAll();
}

function filterTermSession(sessionId) {
  _termFilterSession = sessionId;
  _termRenderAll();
}

function clearTermLog() {
  _termLogLines = [];
  const el = document.getElementById('terminalLog');
  if (el) el.innerHTML = '<div class="terminal-empty">已清屏</div>';
}


document.addEventListener('DOMContentLoaded', () => {
  applyChartDefaults();
  bindUI();
  navigate('l1');
  initAlerts();
  updateSystemStatus();
  setTimeout(checkForUpdates, 5000);
  let _refreshTick = 0;
  const _refreshLoop = async () => {
    try {
      invalidateCache('/health-dashboard');
      invalidateCache('/latency');
      invalidateCache('/generations');
      invalidateCache('/models/in-use');
    invalidateCache('/models/config-models');
      invalidateCache('/sessions');
      invalidateCache('/system-status');
      updateSystemStatus();
      if (currentView === 'l1') loadHealthDashboard();
      else if (currentView === 'l2') loadSessionList();
      else if (currentView === 'l5') loadModelView();
    } catch (_) {}
    _refreshTick++;
    setTimeout(_refreshLoop, _refreshTick < 6 ? 5000 : 60000);
  };
  setTimeout(_refreshLoop, 5000);
});
