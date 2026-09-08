'use strict';

const express = require('express');
const crypto = require('crypto');
const db = require('../firebase-admin-config');
const { runNewSpotAssetDiscovery } = require('../services/newSpotAssetDiscovery');
const { runSpotGemRadar } = require('../services/spotGemRadar');
const {
  runLocalQuboShadow,
  evaluateMaturedShadowDecisions,
  computePromotionGate
} = require('../services/spotLocalQuboOptimizer');

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

function quboCandidatesFromRadar(radar = {}) {
  const researchSymbols = new Set(Array.isArray(radar.research_symbols) ? radar.research_symbols : []);
  const laneBySymbol = new Map((Array.isArray(radar.research_lanes) ? radar.research_lanes : [])
    .map((item) => [item.symbol, item.lane]));
  return (Array.isArray(radar.top_candidates) ? radar.top_candidates : [])
    .filter((candidate) => researchSymbols.has(candidate.symbol))
    .map((candidate) => ({ ...candidate, research_lane: laneBySymbol.get(candidate.symbol) || candidate.research_lane || null }));
}

router.post('/internal/cron/binance/spot-new-assets-discovery', requireCronSecret, async (req, res) => {
  const startedAt = Date.now();
  try {
    const options = req.body || {};
    const discovery = await runNewSpotAssetDiscovery(db, { ...options, runQuant: false });
    const radar = await runSpotGemRadar(db, {
      ...options,
      runQuant: options.runQuant !== false,
      maxResearch: options.maxResearch || 10,
      quantLimit: options.quantLimit || 4000
    });

    const quboCandidates = quboCandidatesFromRadar(radar);
    const priceBySymbol = new Map((Array.isArray(radar.top_candidates) ? radar.top_candidates : [])
      .map((candidate) => [candidate.symbol, Number(candidate.price)]));

    const settledNow = await evaluateMaturedShadowDecisions(db, priceBySymbol, Date.now(), options.qubo || {});
    const quboShadow = await runLocalQuboShadow(db, quboCandidates, options.qubo || {});
    const quboPromotion = await computePromotionGate(db, options.qubo || {});

    return res.json({
      ok: true,
      duration_ms: Date.now() - startedAt,
      discovery,
      radar,
      local_qubo: {
        shadow: quboShadow,
        settled_now: settledNow,
        promotion: quboPromotion,
        external_credentials_required: false,
        paid_quantum_service_required: false,
        real_execution_enabled: false
      },
      spot_only: true,
      no_order_created: true,
      real_entry_approved: false
    });
  } catch (error) {
    console.error(JSON.stringify({
      event: 'SPOT_GEM_RADAR_FAILED',
      error: error.message,
      duration_ms: Date.now() - startedAt
    }));
    return res.status(500).json({
      ok: false,
      error: 'NEW_ASSET_DISCOVERY_FAILED',
      details: error.message,
      duration_ms: Date.now() - startedAt
    });
  }
});

router.get('/spot-new-assets/status', async (_req, res) => {
  try {
    const [discoveriesSnapshot, radarSnapshot, catalogSnapshot, quboStatusSnapshot, quboShadowSnapshot] = await Promise.all([
      db.collection('spot_new_asset_discoveries').orderBy('detected_at', 'desc').limit(30).get(),
      db.collection('spot_gem_radar').doc('current').get(),
      db.collection('spot_asset_catalog').orderBy('gem_score', 'desc').limit(50).get(),
      db.collection('spot_qubo_optimizer_status').doc('current').get(),
      db.collection('spot_qubo_shadow_decisions').orderBy('created_at', 'desc').limit(20).get()
    ]);
    return res.json({
      ok: true,
      research_only: true,
      real_entry_approved: false,
      discoveries: discoveriesSnapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() })),
      radar: radarSnapshot.exists ? radarSnapshot.data() : null,
      catalog: catalogSnapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() })),
      local_qubo: {
        status: quboStatusSnapshot.exists ? quboStatusSnapshot.data() : null,
        recent_shadow_decisions: quboShadowSnapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() })),
        external_credentials_required: false,
        paid_quantum_service_required: false,
        real_execution_enabled: false
      }
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

module.exports = router;
