'use strict';

const express = require('express');
const crypto = require('crypto');
const db = require('../firebase-admin-config');
const { getSpotPaperExecutionDiagnostic } = require('../services/binanceSpotPaperExecutor');

const router = express.Router();

function safeEquals(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || !left || !right) return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function validatePrivateSecret(req, res, next) {
  const supplied = req.header('x-investments-secret') || req.header('x-cron-secret');
  const expected = process.env.INVESTMENTS_SUMMARY_SECRET || process.env.CRON_SECRET;
  if (!expected) return res.status(503).json({ ok: false, error: 'PRIVATE_SECRET_NOT_CONFIGURED' });
  if (!safeEquals(supplied, expected)) return res.status(403).json({ ok: false, error: 'FORBIDDEN' });
  return next();
}

router.get('/internal/paper-ranking', validatePrivateSecret, async (req, res) => {
  try {
    const diagnostic = await getSpotPaperExecutionDiagnostic(db, { maxDocs: 250 });
    return res.json({
      ok: true,
      paper_only: true,
      generated_at: new Date().toISOString(),
      diagnostic
    });
  } catch (error) {
    console.error('[PAPER_RANKING] Failed:', error?.message || error);
    return res.status(500).json({
      ok: false,
      error: 'PAPER_RANKING_FAILED',
      details: error?.message || String(error)
    });
  }
});

module.exports = router;
