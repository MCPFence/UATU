'use strict';

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const { store } = require('./lib/store');
const { alertManager } = require('./lib/websocket');
const auth = require('./lib/auth');
const proxyGuard = require('./lib/proxy-guard');

auth.init();

const VERSION_FILE = path.join(__dirname, 'version.json');
const INDEX_HTML = path.join(__dirname, 'ui', 'templates', 'index.html');
const startTime = Date.now() / 1000;

const app = express();
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) {
      cb(null, true);
    } else {
      cb(null, false);
    }
  }
}));

proxyGuard.mount(app);

app.use(express.json({ limit: '50mb' }));
app.use('/static', express.static(path.join(__dirname, 'ui', 'static'), { etag: false, maxAge: 0 }));

app.use((req, res, next) => {
  req._startTime = Date.now();
  next();
});

app.use(auth.middleware);

app.get('/', (req, res) => {
  let html;
  try { html = fs.readFileSync(INDEX_HTML, 'utf8'); }
  catch (e) { return res.status(500).send('index.html missing'); }
  html = html.replace(/<meta name="cco-auth-token"[^>]*>\s*/gi, '');
  res.type('html').send(html);
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptime_s: Math.round((Date.now() / 1000 - startTime) * 10) / 10 });
});

app.get('/health', (req, res) => {
  let version = '';
  try {
    if (fs.existsSync(VERSION_FILE)) {
      version = JSON.parse(fs.readFileSync(VERSION_FILE, 'utf8')).observer || '';
    }
  } catch {}
  res.json({
    status: 'ok', version,
    traces: store.countTraces(), metrics: store.countMetrics(), logs: store.countLogs(),
    uptime_s: Math.round((Date.now() / 1000 - startTime) * 10) / 10,
    ws_clients: alertManager.clientCount,
  });
});

const routeModules = [
  'otlp', 'traces', 'sessions', 'generations', 'scores',
  'ccproxy', 'routing', 'models', 'strategy', 'health', 'updater',
];
for (const mod of routeModules) {
  try {
    app.use(require(`./routes/${mod}`));
  } catch (e) {
    console.warn(`[routes] failed to load ${mod}: ${e.message}`);
  }
}

module.exports = { app };
