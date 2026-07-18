'use strict';

const express = require('express');
const crypto = require('crypto');
const db = require('../firebase-admin-config');
const {
  runAdaptiveSpotStrategyController,
  getAdaptiveEntryGate
} = require('../services/adaptiveSpotStrategyController');

const router = express.Router();

function safeEquals(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || !left || !right) return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function requireCronSecret(req, res, next) {
  const expected = process.env.CRON_SECRET;
  if (!expected) return res.status(503).json({ ok: false, error: 'CRON_SECRET not configured' });
  if (!safeEquals(req.header('x-cron-secret'), expected)) return res.status(403).json({ ok: false, error: 'Forbidden' });
  return next();
}

router.post('/internal/cron/binance/spot-adaptive-strategy', requireCronSecret, async (_req, res) => {
  try {
    const result = await runAdaptiveSpotStrategyController(db);
    return res.json({ ok: true, ...result });
  } catch (error) {
    return res.status(500).json({ ok: false, error: 'ADAPTIVE_STRATEGY_FAILED', details: error.message });
  }
});

router.get('/spot-adaptive-strategy/status', async (_req, res) => {
  try {
    return res.json({ ok: true, ...(await getAdaptiveEntryGate(db)) });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

module.exports = router;
