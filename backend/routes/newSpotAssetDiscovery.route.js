'use strict';

const express = require('express');
const crypto = require('crypto');
const db = require('../firebase-admin-config');
const { runNewSpotAssetDiscovery } = require('../services/newSpotAssetDiscovery');

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
  if (!safeEquals(req.header('x-cron-secret'), expected)) {
    return res.status(403).json({ ok: false, error: 'Forbidden' });
  }
  return next();
}

router.post('/internal/cron/binance/spot-new-assets-discovery', requireCronSecret, async (req, res) => {
  try {
    const result = await runNewSpotAssetDiscovery(db, req.body || {});
    return res.json({ ok: true, ...result });
  } catch (error) {
    return res.status(500).json({ ok: false, error: 'NEW_ASSET_DISCOVERY_FAILED', details: error.message });
  }
});

router.get('/spot-new-assets/status', async (_req, res) => {
  try {
    const snapshot = await db.collection('spot_new_asset_discoveries')
      .orderBy('detected_at', 'desc')
      .limit(30)
      .get();
    const discoveries = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    return res.json({
      ok: true,
      research_only: true,
      real_entry_approved: false,
      discoveries
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

module.exports = router;