'use strict';

const express = require('express');
const crypto = require('crypto');
const db = require('../firebase-admin-config');
const { getSpotPaperExecutionDiagnostic } = require('../services/binanceSpotPaperExecutor');

const router = express.Router();
const SCANS = 'spot_opportunity_scans';
const CANDIDATES = 'spot_opportunity_candidates';
const VALIDATIONS = 'spot_opportunity_validations';

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

function numberFrom(item, keys, fallback = 0) {
  for (const key of keys) {
    const value = Number(item?.[key]);
    if (Number.isFinite(value)) return value;
  }
  return fallback;
}

function textFrom(item, keys, fallback = null) {
  for (const key of keys) {
    const value = item?.[key];
    if (value !== undefined && value !== null && String(value).trim()) return String(value);
  }
  return fallback;
}

async function buildLatestRanking() {
  const latestScanSnapshot = await db.collection(SCANS).orderBy('created_at', 'desc').limit(1).get();
  if (latestScanSnapshot.empty) {
    return { scan: null, ranking: [], total_candidates: 0, eligible: 0, discarded: 0, selected: null };
  }

  const scanDoc = latestScanSnapshot.docs[0];
  const scan = { id: scanDoc.id, ...(scanDoc.data() || {}) };
  const [candidateSnapshot, validationSnapshot] = await Promise.all([
    db.collection(CANDIDATES).where('scan_id', '==', scan.id).get(),
    db.collection(VALIDATIONS).where('scan_id', '==', scan.id).get()
  ]);

  const validations = new Map(validationSnapshot.docs.map((doc) => {
    const item = { id: doc.id, ...(doc.data() || {}) };
    return [String(item.symbol || '').toUpperCase(), item];
  }));

  const ranking = candidateSnapshot.docs.map((doc) => {
    const candidate = { id: doc.id, ...(doc.data() || {}) };
    const symbol = String(candidate.symbol || '').toUpperCase();
    const validation = validations.get(symbol) || {};
    const rejected = candidate.rejected === true || ['REJECTED', 'DISCARDED', 'BLOCKED'].includes(String(candidate.status || '').toUpperCase());
    return {
      id: candidate.id,
      symbol,
      score: numberFrom(candidate, ['opportunityScore', 'opportunity_score', 'score', 'final_score']),
      validation_priority: numberFrom(candidate, ['validation_priority', 'validationPriority']),
      quote_volume_24h: numberFrom(candidate, ['quoteVolume24h', 'quote_volume_24h', 'volume24h']),
      category: textFrom(candidate, ['category', 'risk_category'], 'UNKNOWN'),
      risk: textFrom(candidate, ['risk_level', 'risk', 'category'], 'UNKNOWN'),
      recommendation: textFrom(candidate, ['recommendation', 'decision'], null),
      rejected,
      rejection_reason: textFrom(candidate, ['rejection_reason', 'blocked_reason', 'reason'], null),
      reasons: Array.isArray(candidate.reasons) ? candidate.reasons.slice(0, 5) : [],
      validation_positive: validation.positive === true || validation.is_positive === true,
      validation_status: textFrom(validation, ['status', 'result'], null),
      validation_sample_size: numberFrom(validation, ['sample_size', 'completed_count', 'observations'])
    };
  }).sort((left, right) => {
    if (left.rejected !== right.rejected) return left.rejected ? 1 : -1;
    if (Math.abs(right.validation_priority - left.validation_priority) > 0.000001) return right.validation_priority - left.validation_priority;
    if (Math.abs(right.score - left.score) > 0.000001) return right.score - left.score;
    return right.quote_volume_24h - left.quote_volume_24h;
  }).map((item, index) => ({ ...item, rank: index + 1 }));

  return {
    scan: {
      id: scan.id,
      created_at: scan.created_at || null,
      market_regime: scan.market_regime || scan.context || null
    },
    ranking: ranking.slice(0, 50),
    total_candidates: ranking.length,
    eligible: ranking.filter((item) => !item.rejected).length,
    discarded: ranking.filter((item) => item.rejected).length,
    selected: ranking.find((item) => !item.rejected) || null
  };
}

router.get('/internal/paper-ranking', validatePrivateSecret, async (req, res) => {
  try {
    const [diagnostic, latest] = await Promise.all([
      getSpotPaperExecutionDiagnostic(db, { maxDocs: 250 }),
      buildLatestRanking()
    ]);
    return res.json({
      ok: true,
      paper_only: true,
      generated_at: new Date().toISOString(),
      ...latest,
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
