'use strict';

const router = require('express').Router();
const { store } = require('../lib/store');
const ccProxyClient = require('../ingest/cc-proxy-client');

let _providerRouter = null;

function getProviderRouter() {
  if (!_providerRouter) {
    try {
      const { ProviderRouteTracker } = require('../analytics/engines');
      _providerRouter = new ProviderRouteTracker(store);
    } catch {
      _providerRouter = {
        providerHealth: () => ({}),
        routingTimeseries: () => ({}),
        failoverAnalysis: () => ({}),
        hvrAnalytics: () => ({}),
        clusterAnalysis: () => ({}),
      };
    }
  }
  return _providerRouter;
}

router.get('/api/routing-health', (req, res) => {
  const pr = getProviderRouter();
  res.json(pr.providerHealth());
});

router.get('/api/routing-timeseries', (req, res) => {
  const bucket = parseInt(req.query.bucket) || 5;
  const hours = parseInt(req.query.hours) || 24;
  const pr = getProviderRouter();
  res.json(pr.routingTimeseries(bucket, hours));
});

router.get('/api/failover-analysis', (req, res) => {
  const pr = getProviderRouter();
  res.json(pr.failoverAnalysis());
});

router.get('/api/hvr-analytics', (req, res) => {
  const model = req.query.model || '';
  const pr = getProviderRouter();
  res.json(pr.hvrAnalytics(model || null));
});

router.get('/api/cluster-analysis', (req, res) => {
  const pr = getProviderRouter();
  res.json(pr.clusterAnalysis());
});

router.get('/api/routing-log', async (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const offset = parseInt(req.query.offset) || 0;
  const result = await ccProxyClient.routingLog(limit, offset);
  res.json(result);
});

router.get('/api/reputation', async (req, res) => {
  const result = await ccProxyClient.reputation();
  res.json(result);
});

module.exports = router;
