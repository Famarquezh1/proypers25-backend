'use strict';

const REGISTRY_VERSION = 'binance_bstocks_registry_2026-09-17';
const LEVERAGED_MAX_ENTRY_USDT = 5;
const LEVERAGED_MIN_OPPORTUNITY_SCORE = 85;
const LEVERAGED_MAX_TIMEOUT_HOURS = 6;

// Binance bStocks listed on Spot through 2026-09-17. Keep discovery broad:
// this registry classifies known tokenized securities but does not exclude
// unknown/new Spot listings from the opportunity engine.
const BSTOCK_BASE_ASSETS = new Set([
  'AAOIB', 'AAPLB', 'ALABB', 'AMATB', 'AMDB', 'AMZNB', 'ARMB', 'ASMLB', 'ASTSB',
  'AVGOB', 'AXTIB', 'BABAB', 'BEB', 'BMNRB', 'BNCB', 'CBRSB', 'COHRB', 'COINB',
  'CRCLB', 'CRDOB', 'CRMB', 'CRWDB', 'CRWVB', 'DELLB', 'DJTB', 'DRAMB', 'EWYB',
  'FLNCB', 'GLWB', 'GMEB', 'GOOGLB', 'GPROB', 'GSB', 'HIMSB', 'HOODB', 'IBMB',
  'INTCB', 'INTWB', 'IRENB', 'KORUB', 'LITEB', 'METAB', 'MRNAB', 'MRVLB', 'MSFTB',
  'MSTRB', 'MUB', 'MUUB', 'MVLLB', 'NBISB', 'NFLXB', 'NOKB', 'NVDAB', 'ORCLB',
  'PLTRB', 'PYPLB', 'QCOMB', 'QNTB', 'QQQB', 'RDDTB', 'RKLBB', 'SKHYB', 'SMCIB',
  'SMHB', 'SNDKB', 'SNXXB', 'SOXLB', 'SOXSB', 'SPCXB', 'SPYB', 'SQQQB', 'STXB',
  'TQQQB', 'TSLAB', 'TSMB', 'USARB', 'WDCB'
]);

const LEVERAGED_BSTOCKS = Object.freeze({
  KORUB: { leverage_multiple: 3, direction: 'LONG', reference: 'South Korea Bull 3X ETF' },
  MUUB: { leverage_multiple: 2, direction: 'LONG', reference: 'Direxion MU Bull 2X ETF' },
  MVLLB: { leverage_multiple: 2, direction: 'LONG', reference: 'GraniteShares 2X Long MRVL ETF' },
  SNXXB: { leverage_multiple: 2, direction: 'LONG', reference: 'Tradr 2X Long SNDK ETF' },
  INTWB: { leverage_multiple: 2, direction: 'LONG', reference: 'GraniteShares 2X Long INTC ETF' },
  TQQQB: { leverage_multiple: 3, direction: 'LONG', reference: 'ProShares UltraPro QQQ' },
  SOXLB: { leverage_multiple: 3, direction: 'LONG', reference: 'Semiconductor Bull 3X ETF' },
  SOXSB: { leverage_multiple: 3, direction: 'SHORT', reference: 'Direxion Semiconductor Bear 3X ETF' },
  SQQQB: { leverage_multiple: 3, direction: 'SHORT', reference: 'ProShares UltraPro Short QQQ' }
});

function normalizeSymbol(symbol) {
  return String(symbol || '').trim().toUpperCase();
}

function baseAssetFromSymbol(symbol) {
  const normalized = normalizeSymbol(symbol);
  return normalized.endsWith('USDT') ? normalized.slice(0, -4) : normalized;
}

function classifySpotAsset(symbol) {
  const normalizedSymbol = normalizeSymbol(symbol);
  const baseAsset = baseAssetFromSymbol(normalizedSymbol);
  const leveraged = LEVERAGED_BSTOCKS[baseAsset] || null;

  if (leveraged) {
    return {
      symbol: normalizedSymbol,
      base_asset: baseAsset,
      asset_class: 'LEVERAGED_TOKENIZED_SECURITY',
      product_family: 'BSTOCK',
      is_tokenized_security: true,
      is_leveraged: true,
      leverage_multiple: leveraged.leverage_multiple,
      direction: leveraged.direction,
      reference: leveraged.reference,
      risk_tier: 'HIGH',
      max_entry_usdt: LEVERAGED_MAX_ENTRY_USDT,
      minimum_opportunity_score: LEVERAGED_MIN_OPPORTUNITY_SCORE,
      max_timeout_hours: LEVERAGED_MAX_TIMEOUT_HOURS,
      registry_version: REGISTRY_VERSION
    };
  }

  if (BSTOCK_BASE_ASSETS.has(baseAsset)) {
    return {
      symbol: normalizedSymbol,
      base_asset: baseAsset,
      asset_class: 'TOKENIZED_SECURITY',
      product_family: 'BSTOCK',
      is_tokenized_security: true,
      is_leveraged: false,
      leverage_multiple: 1,
      direction: null,
      reference: null,
      risk_tier: 'ELEVATED',
      max_entry_usdt: null,
      minimum_opportunity_score: null,
      max_timeout_hours: null,
      registry_version: REGISTRY_VERSION
    };
  }

  return {
    symbol: normalizedSymbol,
    base_asset: baseAsset,
    asset_class: 'UNCLASSIFIED_SPOT',
    product_family: 'GENERIC_SPOT',
    is_tokenized_security: false,
    is_leveraged: false,
    leverage_multiple: 1,
    direction: null,
    reference: null,
    risk_tier: 'STANDARD',
    max_entry_usdt: null,
    minimum_opportunity_score: null,
    max_timeout_hours: null,
    registry_version: REGISTRY_VERSION
  };
}

function buildSpotAssetRiskPolicy({ symbol, requestedEntryUsdt = 0, candidate = {} } = {}) {
  const classification = classifySpotAsset(symbol);
  const requested = Math.max(0, Number(requestedEntryUsdt || 0));
  const score = Number(candidate.opportunityScore ?? candidate.score ?? 0);
  const cappedEntryUsdt = classification.is_leveraged
    ? Math.min(requested, classification.max_entry_usdt)
    : requested;
  const entryAllowed = !classification.is_leveraged || score >= classification.minimum_opportunity_score;

  return {
    classification,
    requested_entry_usdt: requested,
    capped_entry_usdt: Number(cappedEntryUsdt.toFixed(8)),
    entry_allowed: entryAllowed,
    blocker: entryAllowed ? null : 'LEVERAGED_TOKENIZED_SECURITY_SCORE_BELOW_MINIMUM',
    candidate_score: Number.isFinite(score) ? score : 0,
    minimum_opportunity_score: classification.minimum_opportunity_score,
    risk_controls: classification.is_leveraged ? {
      max_entry_usdt: classification.max_entry_usdt,
      max_timeout_hours: classification.max_timeout_hours,
      require_existing_paper_and_technical_gates: true
    } : null
  };
}

module.exports = {
  REGISTRY_VERSION,
  LEVERAGED_MAX_ENTRY_USDT,
  LEVERAGED_MIN_OPPORTUNITY_SCORE,
  LEVERAGED_MAX_TIMEOUT_HOURS,
  BSTOCK_BASE_ASSETS,
  LEVERAGED_BSTOCKS,
  normalizeSymbol,
  baseAssetFromSymbol,
  classifySpotAsset,
  buildSpotAssetRiskPolicy
};
