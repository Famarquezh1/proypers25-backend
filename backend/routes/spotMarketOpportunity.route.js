'use strict';

const express = require('express');
const crypto = require('crypto');
const db = require('../firebase-admin-config');
const { runSpotMarketOpportunityIntelligence } = require('../services/spotMarketOpportunityIntelligence');

const router = express.Router();

function safeEquals(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || !left || !right) return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function requireCronSecret(req, res, next) {
  const expected = process.env.CRON_SECRET;
  const supplied = req.header('x-cron-secret');
  if (!expected) return res.status(503).json({ ok: false, error: 'CRON_SECRET_NOT_CONFIGURED' });
  if (!safeEquals(supplied, expected)) return res.status(403).json({ ok: false, error: 'FORBIDDEN' });
  return next();
}

router.post('/internal/cron/binance/spot-market-opportunity', requireCronSecret, async (req, res) => {
  const startedAt = Date.now();
  try {
    const result = await runSpotMarketOpportunityIntelligence(db, req.body || {});
    return res.json({ ok: true, duration_ms: Date.now() - startedAt, ...result });
  } catch (error) {
    console.error(JSON.stringify({ event: 'SPOT_MARKET_OPPORTUNITY_FAILED', error: error.message }));
    return res.status(500).json({ ok: false, error: 'SPOT_MARKET_OPPORTUNITY_FAILED', details: error.message });
  }
});

router.get('/spot-market-opportunity/status', async (_req, res) => {
  try {
    const snapshot = await db.collection('spot_market_opportunity_current').doc('current').get();
    return res.json({ ok: true, current: snapshot.exists ? snapshot.data() : null });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

module.exports = router;
