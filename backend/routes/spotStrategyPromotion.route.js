'use strict';

const express = require('express');
const crypto = require('crypto');
const db = require('../firebase-admin-config');
const {
  evaluateStrategyPromotion,
  getStrategyPromotionGate
} = require('../services/spotStrategyPromotionController');

const router = express.Router();

function safeEquals(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || !left || !right) return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function requireSecret(req, res, next) {
  const expected = process.env.INVESTMENTS_SUMMARY_SECRET || process.env.CRON_SECRET;
  const supplied = req.header('x-investments-secret') || req.header('x-cron-secret');
  if (!expected) return res.status(503).json({ ok: false, error: 'STRATEGY_PROMOTION_SECRET_NOT_CONFIGURED' });
  if (!safeEquals(supplied, expected)) return res.status(403).json({ ok: false, error: 'FORBIDDEN' });
  return next();
}

router.post('/internal/cron/binance/spot-strategy-promotion', requireSecret, async (req, res) => {
  try {
    const controlSnap = await db.doc('real_spot_config/control').get();
    const config = controlSnap.exists ? controlSnap.data() : {};
    return res.json({ ok: true, ...(await evaluateStrategyPromotion(db, { ...config, ...(req.body || {}) })) });
  } catch (error) {
    return res.status(500).json({ ok: false, error: 'STRATEGY_PROMOTION_FAILED', details: error.message });
  }
});

router.get('/internal/spot-strategy-promotion/status', requireSecret, async (_req, res) => {
  try {
    return res.json({ ok: true, ...(await getStrategyPromotionGate(db)) });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

module.exports = router;