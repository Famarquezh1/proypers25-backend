'use strict';

const express = require('express');
const crypto = require('crypto');
const { getSpotQuboDashboardData } = require('../services/spotQuboDashboardData');

const router = express.Router();

function safeEquals(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || !left || !right) return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function requireSecret(req, res, next) {
  const supplied = req.header('x-investments-secret') || req.header('x-cron-secret');
  const expected = process.env.INVESTMENTS_SUMMARY_SECRET || process.env.CRON_SECRET;
  if (!expected) return res.status(503).json({ ok: false, error: 'QUBO_DASHBOARD_SECRET_NOT_CONFIGURED' });
  if (!safeEquals(supplied, expected)) return res.status(403).json({ ok: false, error: 'FORBIDDEN' });
  return next();
}

router.get('/internal/investments/qubo-status', requireSecret, async (_req, res) => {
  try {
    const data = await getSpotQuboDashboardData();
    return res.json(data);
  } catch (error) {
    console.error('[QUBO_DASHBOARD] failed:', error?.message || error);
    return res.status(500).json({ ok: false, error: 'QUBO_DASHBOARD_READ_FAILED', details: error?.message || String(error) });
  }
});

module.exports = router;
