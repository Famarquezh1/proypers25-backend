'use strict';

const express = require('express');
const crypto = require('crypto');
const db = require('../firebase-admin-config');
const { runQuantResearchLab } = require('../services/spotQuantProductiveResearchLab');

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
  if (!expected) return res.status(503).json({ ok: false, error: 'CRON_SECRET not configured' });
  if (!safeEquals(supplied, expected)) return res.status(403).json({ ok: false, error: 'Forbidden' });
  return next();
}

router.post('/internal/cron/binance/spot-quant-research', requireCronSecret, async (req, res) => {
  const startedAt = Date.now();
  try {
    const result = await runQuantResearchLab(db, {
      symbols: req.body?.symbols,
      interval: req.body?.interval || '5m',
      limit: req.body?.limit || 5000,
      feeRate: req.body?.feeRate ?? req.body?.fee_rate,
      slippageRate: req.body?.slippageRate ?? req.body?.slippage_rate
    });
    return res.json({ ok: true, duration_ms: Date.now() - startedAt, ...result });
  } catch (error) {
    console.error(JSON.stringify({
      event: 'SPOT_QUANT_RESEARCH_FAILED',
      error: error.message,
      duration_ms: Date.now() - startedAt
    }));
    return res.status(500).json({
      ok: false,
      error: 'SPOT_QUANT_RESEARCH_FAILED',
      details: error.message,
      duration_ms: Date.now() - startedAt
    });
  }
});

router.get('/spot-quant-research/status', async (_req, res) => {
  try {
    const [champion, runs] = await Promise.all([
      db.collection('spot_quant_champions').doc('current').get(),
      db.collection('spot_quant_research_runs').orderBy('created_at', 'desc').limit(10).get()
    ]);
    return res.json({
      ok: true,
      research_only: true,
      no_order_created: true,
      champion: champion.exists ? champion.data() : null,
      recent_runs: runs.docs.map((doc) => ({ id: doc.id, ...doc.data() }))
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

module.exports = router;
