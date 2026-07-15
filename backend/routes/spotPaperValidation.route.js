'use strict';

const express = require('express');
const crypto = require('crypto');
const db = require('../firebase-admin-config');
const {
  runSpotPaperExecutionCycle,
  getSpotPaperExecutionDiagnostic
} = require('../services/binanceSpotPaperExecutor');

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

async function executePaperValidation(options = {}) {
  return runSpotPaperExecutionCycle(db, {
    maxDocs: 250,
    now: new Date(),
    ...options,
    real_execution: false,
    enableRealTrading: false,
    usePrivateBinanceApi: false,
    signedRequest: false
  });
}

router.post('/internal/cron/binance/spot-paper-validation', requireCronSecret, async (req, res) => {
  const startedAt = Date.now();
  try {
    const result = await executePaperValidation(req.body || {});
    return res.json({
      ok: true,
      paper_only: true,
      no_real_orders: true,
      generated_at: new Date().toISOString(),
      duration_ms: Date.now() - startedAt,
      ...result
    });
  } catch (error) {
    console.error('[SPOT_PAPER_VALIDATION] Failed:', error.message);
    return res.status(500).json({
      ok: false,
      paper_only: true,
      no_real_orders: true,
      error: 'SPOT_PAPER_VALIDATION_FAILED',
      details: error.message,
      duration_ms: Date.now() - startedAt
    });
  }
});

router.get('/internal/cron/binance/spot-paper-diagnostic', requireCronSecret, async (req, res) => {
  try {
    const diagnostic = await getSpotPaperExecutionDiagnostic(db, {
      maxDocs: Math.max(20, Math.min(500, Number(req.query.maxDocs || 250)))
    });
    return res.json({
      ok: true,
      paper_only: true,
      no_real_orders: true,
      generated_at: new Date().toISOString(),
      diagnostic
    });
  } catch (error) {
    console.error('[SPOT_PAPER_DIAGNOSTIC] Failed:', error.message);
    return res.status(500).json({
      ok: false,
      paper_only: true,
      error: 'SPOT_PAPER_DIAGNOSTIC_FAILED',
      details: error.message
    });
  }
});

module.exports = {
  router,
  executePaperValidation
};
