'use strict';

/**
 * Node-side guard that fronts cc-proxy (127.0.0.1:3456) on the frontend port.
 *
 * Path coverage:
 *   - /v1/*           Anthropic + OpenAI style endpoints exposed by cc-proxy.
 *   - /anthropic/*    aliased path some clients use.
 *
 * Auth: enforced by auth.modelMiddleware before the proxy handler runs.
 *
 * Body handling: this router MUST be mounted before express.json() so the
 * raw request stream is forwarded byte-for-byte (streaming requests, large
 * payloads, and SSE responses all work).
 */

const http = require('http');
const auth = require('./auth');

const CC_PROXY_HOST = '127.0.0.1';
const CC_PROXY_PORT = 3456;
const HOP_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

function _forward(req, res) {
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (HOP_HEADERS.has(k.toLowerCase())) continue;
    headers[k] = v;
  }
  headers['host'] = `${CC_PROXY_HOST}:${CC_PROXY_PORT}`;
  if (auth.isModelEnabled()) {
    headers['x-api-key'] = auth.getModelKey();
    headers['authorization'] = `Bearer ${auth.getModelKey()}`;
  }

  const opts = {
    hostname: CC_PROXY_HOST,
    port: CC_PROXY_PORT,
    method: req.method,
    path: req.originalUrl || req.url,
    headers,
  };

  const upstream = http.request(opts, (upRes) => {
    const outHeaders = {};
    for (const [k, v] of Object.entries(upRes.headers)) {
      if (HOP_HEADERS.has(k.toLowerCase())) continue;
      outHeaders[k] = v;
    }
    res.writeHead(upRes.statusCode || 502, outHeaders);
    upRes.pipe(res);
  });

  upstream.on('error', (e) => {
    if (res.headersSent) {
      try { res.end(); } catch {}
      return;
    }
    res.status(502).json({
      type: 'error',
      error: { type: 'upstream_error', message: `cc-proxy unreachable: ${e.message}` },
    });
  });

  req.on('aborted', () => upstream.destroy());
  req.pipe(upstream);
}

function mount(app) {
  const handler = (req, res, next) => {
    auth.modelMiddleware(req, res, (err) => {
      if (err) return next(err);
      _forward(req, res);
    });
  };
  app.use('/v1', handler);
  app.use('/anthropic', handler);
}

module.exports = { mount };
