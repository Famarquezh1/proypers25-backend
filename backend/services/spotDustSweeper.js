'use strict';

const axios = require('axios');
const crypto = require('crypto');
const { getBinanceSpotCredentials } = require('../lib/secretManager');

const DUST_COLLECTION = 'real_spot_dust_residuals';
const RUN_COLLECTION = 'spot_dust_sweeper_runs';
const CONFIG_DOC = 'real_spot_config/dust_sweeper';
const POSITIONS = 'real_spot_positions';
const VERSION = 'spot_dust_sweeper_v1_direct_usdt';
const HARD_PROTECTED_ASSETS = new Set(['XEC']);

const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  target_asset: 'USDT',
  max_residual_value_usdt: 5,
  max_assets_per_cycle: 10,
  require_pure_dust_balance: true,
  balance_tolerance_fraction: 0.02,
  balance_tolerance_absolute: 1e-12
});

function n(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeAsset(value) {
  return String(value || '').trim().toUpperCase();
}

function normalizeConfig(config = {}) {
  return {
    ...DEFAULT_CONFIG,
    ...config,
    enabled: config.enabled !== false,
    target_asset: 'USDT',
    max_residual_value_usdt: Math.min(10, Math.max(0.01, n(config.max_residual_value_usdt, DEFAULT_CONFIG.max_residual_value_usdt))),
    max_assets_per_cycle: Math.min(20, Math.max(1, Math.floor(n(config.max_assets_per_cycle, DEFAULT_CONFIG.max_assets_per_cycle)))),
    require_pure_dust_balance: config.require_pure_dust_balance !== false,
    balance_tolerance_fraction: Math.min(0.1, Math.max(0.001, n(config.balance_tolerance_fraction, DEFAULT_CONFIG.balance_tolerance_fraction))),
    balance_tolerance_absolute: Math.max(1e-12, n(config.balance_tolerance_absolute, DEFAULT_CONFIG.balance_tolerance_absolute)),
    version: VERSION
  };
}

function signedQuery(params, secret) {
  const query = Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join('&');
  const signature = crypto.createHmac('sha256', secret).update(query).digest('hex');
  return `${query}&signature=${signature}`;
}

async function privateRequest(method, path, params = {}) {
  const { apiKey, apiSecret } = await getBinanceSpotCredentials();
  const query = signedQuery({ ...params, recvWindow: 10000, timestamp: Date.now() }, apiSecret);
  const response = await axios({
    method,
    url: `https://api.binance.com${path}?${query}`,
    headers: { 'X-MBX-APIKEY': apiKey },
    timeout: 15000,
    validateStatus: () => true
  });
  if (response.status < 200 || response.status >= 300) {
    const error = new Error(response.data?.msg || `Binance HTTP ${response.status}`);
    error.code = response.data?.code || 'BINANCE_API_ERROR';
    throw error;
  }
  return response.data;
}

function buildClientId(dustDoc = {}) {
  const seed = `${dustDoc.id || dustDoc.position_id || 'dust'}|${normalizeAsset(dustDoc.asset)}|${n(dustDoc.residual_quantity)}`;
  return `px25dust_${crypto.createHash('sha256').update(seed).digest('hex').slice(0, 20)}`;
}

function isBalancePureDust(residualQuantity, freeQuantity, config = {}) {
  const policy = normalizeConfig(config);
  const residual = Math.max(0, n(residualQuantity));
  const free = Math.max(0, n(freeQuantity));
  const tolerance = Math.max(policy.balance_tolerance_absolute, residual * policy.balance_tolerance_fraction);
  return residual > 0 && Math.abs(free - residual) <= tolerance;
}

function convertibleDetailForAsset(response = {}, asset) {
  const normalized = normalizeAsset(asset);
  const details = Array.isArray(response.details) ? response.details : [];
  return details.find((item) => normalizeAsset(item.asset) === normalized) || null;
}

function parseDustConversionResult(response = {}, asset) {
  const normalized = normalizeAsset(asset);
  const rows = Array.isArray(response.transferResult) ? response.transferResult : [];
  const matches = rows.filter((item) => normalizeAsset(item.fromAsset) === normalized);
  if (!matches.length) return null;
  const amount = matches.reduce((sum, item) => sum + n(item.amount), 0);
  const received = matches.reduce((sum, item) => sum + n(item.transferedAmount), 0);
  const serviceCharge = matches.reduce((sum, item) => sum + n(item.serviceChargeAmount), 0);
  return {
    converted_quantity: amount,
    received_usdt: received,
    service_charge_usdt: serviceCharge,
    transaction_ids: matches.map((item) => item.tranId).filter((value) => value !== undefined && value !== null),
    operated_at: matches.length ? new Date(Math.max(...matches.map((item) => n(item.operateTime)))).toISOString() : new Date().toISOString()
  };
}

function classifyDustCandidate(dustDoc = {}, managedAssets = new Set(), balances = new Map(), config = {}) {
  const policy = normalizeConfig(config);
  const asset = normalizeAsset(dustDoc.asset || String(dustDoc.symbol || '').replace(/USDT$/i, ''));
  const residualValue = Math.max(0, n(dustDoc.residual_value_usdt));
  const residualQuantity = Math.max(0, n(dustDoc.residual_quantity));
  const free = Math.max(0, n(balances.get(asset)?.free));
  if (!asset || asset === 'USDT') return { eligible: false, reason: 'INVALID_DUST_ASSET', asset };
  if (HARD_PROTECTED_ASSETS.has(asset)) return { eligible: false, reason: 'PROTECTED_ASSET', asset };
  if (managedAssets.has(asset)) return { eligible: false, reason: 'ASSET_CURRENTLY_MANAGED', asset };
  if (!(residualQuantity > 0)) return { eligible: false, reason: 'NO_RESIDUAL_QUANTITY', asset };
  if (!(residualValue > 0) || residualValue > policy.max_residual_value_usdt) {
    return { eligible: false, reason: 'RESIDUAL_VALUE_OUTSIDE_SWEEPER_LIMIT', asset };
  }
  if (policy.require_pure_dust_balance && !isBalancePureDust(residualQuantity, free, policy)) {
    return { eligible: false, reason: 'BALANCE_NOT_PURE_DUST', asset, free_quantity: free };
  }
  return { eligible: true, reason: 'ELIGIBLE', asset, residual_quantity: residualQuantity, residual_value_usdt: residualValue, free_quantity: free };
}

async function runSpotDustSweeper(db, options = {}, dependencies = {}) {
  if (!db) throw new Error('dust_sweeper_requires_db');
  const configRef = db.doc(CONFIG_DOC);
  const configSnap = await configRef.get();
  const config = normalizeConfig({ ...(configSnap.exists ? configSnap.data() : {}), ...options });
  const now = new Date().toISOString();
  await configRef.set({ ...config, last_cycle_at: now }, { merge: true });
  if (!config.enabled) return { ok: true, enabled: false, converted: 0, outcomes: [], version: VERSION };

  const requestPrivate = dependencies.privateRequest || privateRequest;
  const [dustSnap, managedSnap, account, convertible] = await Promise.all([
    db.collection(DUST_COLLECTION).where('status', '==', 'UNMANAGED_DUST').limit(config.max_assets_per_cycle).get(),
    db.collection(POSITIONS).where('status', '==', 'REAL_OPEN').get(),
    requestPrivate('GET', '/api/v3/account'),
    requestPrivate('POST', '/sapi/v1/asset/dust-convert/query-convertible-assets', { targetAsset: 'USDT' })
  ]);

  const managedAssets = new Set(managedSnap.docs.map((doc) => normalizeAsset(String(doc.data().symbol || '').replace(/USDT$/i, ''))));
  const balances = new Map((account.balances || []).map((item) => [normalizeAsset(item.asset), { free: n(item.free), locked: n(item.locked) }]));
  const outcomes = [];

  for (const doc of dustSnap.docs) {
    const dust = { id: doc.id, ...doc.data() };
    const candidate = classifyDustCandidate(dust, managedAssets, balances, config);
    if (!candidate.eligible) {
      outcomes.push({ dust_id: doc.id, asset: candidate.asset || dust.asset || null, action: 'SKIP', reason: candidate.reason });
      continue;
    }
    const detail = convertibleDetailForAsset(convertible, candidate.asset);
    if (!detail) {
      await doc.ref.set({ last_sweeper_attempt_at: now, dust_sweeper_status: 'NOT_CONVERTIBLE_TO_USDT', dust_sweeper_version: VERSION }, { merge: true });
      outcomes.push({ dust_id: doc.id, asset: candidate.asset, action: 'SKIP', reason: 'NOT_CONVERTIBLE_TO_USDT' });
      continue;
    }

    const detailFree = n(detail.amountFree, candidate.free_quantity);
    if (config.require_pure_dust_balance && !isBalancePureDust(candidate.residual_quantity, detailFree, config)) {
      outcomes.push({ dust_id: doc.id, asset: candidate.asset, action: 'SKIP', reason: 'CONVERTIBLE_BALANCE_NOT_PURE_DUST' });
      continue;
    }

    const clientId = buildClientId(dust);
    try {
      await doc.ref.set({
        dust_sweeper_status: 'CONVERT_PENDING',
        dust_sweeper_client_id: clientId,
        last_sweeper_attempt_at: new Date().toISOString(),
        dust_sweeper_version: VERSION
      }, { merge: true });
      const response = await requestPrivate('POST', '/sapi/v1/asset/dust-convert/convert', {
        asset: candidate.asset,
        targetAsset: 'USDT',
        clientId
      });
      const result = parseDustConversionResult(response, candidate.asset);
      if (!result || !(result.converted_quantity > 0)) throw new Error('DUST_CONVERSION_NOT_CONFIRMED');
      const completedAt = new Date().toISOString();
      await doc.ref.set({
        status: 'CONVERTED_TO_USDT',
        dust_sweeper_status: 'CONVERTED_TO_USDT',
        converted_quantity: result.converted_quantity,
        converted_received_usdt: result.received_usdt,
        converted_service_charge_usdt: result.service_charge_usdt,
        converted_transaction_ids: result.transaction_ids,
        converted_at: completedAt,
        dust_sweeper_client_id: clientId,
        performance_excluded: true,
        performance_exclusion_reason: 'OPERATIONAL_DUST_CLEANUP',
        dust_sweeper_version: VERSION
      }, { merge: true });
      outcomes.push({ dust_id: doc.id, asset: candidate.asset, action: 'CONVERTED_TO_USDT', ...result, client_id: clientId });
    } catch (error) {
      await doc.ref.set({
        dust_sweeper_status: 'CONVERT_FAILED',
        dust_sweeper_error: String(error.message || error).slice(0, 300),
        dust_sweeper_failed_at: new Date().toISOString(),
        dust_sweeper_version: VERSION
      }, { merge: true });
      outcomes.push({ dust_id: doc.id, asset: candidate.asset, action: 'CONVERT_FAILED', error: error.message || String(error) });
    }
  }

  const run = {
    id: `dust_sweeper_${Date.now()}`,
    created_at: new Date().toISOString(),
    enabled: true,
    target_asset: 'USDT',
    evaluated: dustSnap.size,
    converted: outcomes.filter((item) => item.action === 'CONVERTED_TO_USDT').length,
    failed: outcomes.filter((item) => item.action === 'CONVERT_FAILED').length,
    outcomes,
    real_mode: true,
    spot_only: true,
    performance_excluded: true,
    version: VERSION
  };
  await db.collection(RUN_COLLECTION).doc(run.id).set(run);
  return { ok: true, ...run };
}

module.exports = {
  VERSION,
  DEFAULT_CONFIG,
  HARD_PROTECTED_ASSETS,
  normalizeConfig,
  buildClientId,
  isBalancePureDust,
  convertibleDetailForAsset,
  parseDustConversionResult,
  classifyDustCandidate,
  runSpotDustSweeper
};
