'use strict';

const assert = require('assert');
const {
  evaluateSpotEntryBurstGate,
  returnCorrelationFromBars
} = require('../services/spotEntryBurstGate');

function quality(passCount, norm, detail = {}, freshEnough = true) {
  return {
    passCount,
    norm,
    freshEnough,
    detail: {
      ignition: 0.8,
      confirm: 0.20,
      extension: 0.01,
      r15: 0.01,
      r60: 0.03,
      r24: 0.05,
      ...detail
    }
  };
}

(function normalCoreCadenceIsBlocked() {
  const result = evaluateSpotEntryBurstGate({
    lane: 'CORE',
    symbol: 'AAAUSDT',
    currentPct: 5,
    managedPositions: [],
    v42Quality: quality(2, 0.72)
  });
  assert.strictEqual(result.allow, false);
  assert.strictEqual(result.code, 'CORE_QUALITY_REQUIRED');
})();

(function strictEarlyConfirmationIsAdmitted() {
  const result = evaluateSpotEntryBurstGate({
    lane: 'CORE',
    symbol: 'EARLYUSDT',
    currentPct: 4.5,
    managedPositions: [],
    v42Quality: quality(2, 0.86, {
      ignition: 1.25,
      confirm: 0.36,
      extension: 0.022,
      r15: 0.018,
      r60: 0.055
    })
  });
  assert.strictEqual(result.allow, true);
  assert.strictEqual(result.code, 'EARLY_CONFIRMATION_ADMITTED');
})();

(function earlyConfirmationRejectsLateMove() {
  const result = evaluateSpotEntryBurstGate({
    lane: 'CORE',
    symbol: 'EARLYUSDT',
    currentPct: 9,
    managedPositions: [],
    v42Quality: quality(2, 0.90, {
      ignition: 1.4,
      confirm: 0.40,
      extension: 0.03,
      r15: 0.02,
      r60: 0.05
    })
  });
  assert.strictEqual(result.allow, false);
  assert.strictEqual(result.code, 'CORE_QUALITY_REQUIRED');
})();

(function earlyConfirmationRejectsWeakMomentum() {
  const result = evaluateSpotEntryBurstGate({
    lane: 'CORE',
    symbol: 'EARLYUSDT',
    currentPct: 4,
    managedPositions: [],
    v42Quality: quality(2, 0.88, {
      ignition: 1.2,
      confirm: 0.35,
      extension: 0.02,
      r15: -0.002,
      r60: 0.04
    })
  });
  assert.strictEqual(result.allow, false);
  assert.strictEqual(result.code, 'CORE_QUALITY_REQUIRED');
})();

(function isolatedHighQualityCoreIsAdmitted() {
  const result = evaluateSpotEntryBurstGate({
    lane: 'CORE',
    symbol: 'AAAUSDT',
    currentPct: 5,
    managedPositions: [],
    v42Quality: quality(3, 0.95)
  });
  assert.strictEqual(result.allow, true);
  assert.strictEqual(result.code, 'HIGH_CONVICTION_ADMITTED');
})();

(function blocksSameManagedSymbolImmediately() {
  const now = Date.now();
  const result = evaluateSpotEntryBurstGate({
    lane: 'CORE',
    symbol: 'AAAUSDT',
    currentPct: 4,
    now,
    managedPositions: [{ symbol: 'AAAUSDT', openedAt: now - 20 * 60 * 1000 }],
    v42Quality: quality(3, 1)
  });
  assert.strictEqual(result.allow, false);
  assert.strictEqual(result.code, 'SAME_SYMBOL_OPEN');
})();

(function cooldownRejectsMarginalSignal() {
  const now = Date.now();
  const result = evaluateSpotEntryBurstGate({
    lane: 'CORE',
    symbol: 'BBBUSDT',
    currentPct: 6,
    now,
    managedPositions: [{ symbol: 'AAAUSDT', openedAt: now - 5 * 60 * 1000 }],
    v42Quality: quality(3, 0.94)
  });
  assert.strictEqual(result.allow, false);
  assert.strictEqual(result.code, 'ENTRY_COOLDOWN');
})();

(function cooldownLetsEliteV42Through() {
  const now = Date.now();
  const result = evaluateSpotEntryBurstGate({
    lane: 'CORE',
    symbol: 'BBBUSDT',
    currentPct: 6,
    now,
    managedPositions: [{ symbol: 'AAAUSDT', openedAt: now - 5 * 60 * 1000 }],
    v42Quality: quality(3, 0.985)
  });
  assert.strictEqual(result.allow, true);
  assert.strictEqual(result.code, 'HIGH_CONVICTION_ADMITTED');
})();

(function burstRequiresHigherQuality() {
  const now = Date.now();
  const result = evaluateSpotEntryBurstGate({
    lane: 'CORE',
    symbol: 'CCCUSDT',
    currentPct: 5,
    now,
    managedPositions: [
      { symbol: 'AAAUSDT', openedAt: now - 12 * 60 * 1000 },
      { symbol: 'BBBUSDT', openedAt: now - 22 * 60 * 1000 }
    ],
    v42Quality: quality(2, 0.82)
  });
  assert.strictEqual(result.allow, false);
  assert.strictEqual(result.code, 'BURST_QUALITY');
})();

(function extendedEntryNeedsHighQuality() {
  const result = evaluateSpotEntryBurstGate({
    lane: 'CORE',
    symbol: 'AAAUSDT',
    currentPct: 13.2,
    managedPositions: [],
    v42Quality: quality(2, 0.84)
  });
  assert.strictEqual(result.allow, false);
  assert.strictEqual(result.code, 'EXTENDED_ENTRY');
})();

(function extendedEntryAdmitsStrongContinuationOnly() {
  const result = evaluateSpotEntryBurstGate({
    lane: 'CORE',
    symbol: 'AAAUSDT',
    currentPct: 17.72,
    managedPositions: [],
    v42Quality: quality(3, 0.96, {
      ignition: 2.5,
      confirm: 0.75,
      extension: 0.12,
      r15: 0.02,
      r60: 0.06
    })
  });
  assert.strictEqual(result.allow, true);
  assert.strictEqual(result.code, 'EXTENDED_CONTINUATION_ADMITTED');
})();

(function extendedEntryStillBlocksWeakOrOverextendedMove() {
  const weak = evaluateSpotEntryBurstGate({
    lane: 'CORE',
    symbol: 'AAAUSDT',
    currentPct: 15,
    managedPositions: [],
    v42Quality: quality(3, 0.96, { confirm: 0.2, extension: 0.01, r15: 0.02, r60: 0.06 })
  });
  assert.strictEqual(weak.allow, false);
  assert.strictEqual(weak.code, 'EXTENDED_ENTRY');
  const late = evaluateSpotEntryBurstGate({
    lane: 'CORE',
    symbol: 'AAAUSDT',
    currentPct: 18,
    managedPositions: [],
    v42Quality: quality(3, 0.99, { confirm: 0.8, extension: 0.12, r15: 0.02, r60: 0.06 })
  });
  assert.strictEqual(late.allow, false);
  assert.strictEqual(late.code, 'EXTENDED_ENTRY');
})();

(function correlatedEntryNeedsEliteQuality() {
  const result = evaluateSpotEntryBurstGate({
    lane: 'CORE',
    symbol: 'CCCUSDT',
    currentPct: 7,
    managedPositions: [{ symbol: 'AAAUSDT', openedAt: Date.now() - 60 * 60 * 1000 }],
    v42Quality: quality(3, 0.95),
    peerCorrelations: [{ symbol: 'AAAUSDT', correlation: 0.93 }]
  });
  assert.strictEqual(result.allow, false);
  assert.strictEqual(result.code, 'CORRELATED_ENTRY');
})();

(function eliteQualityCanOverrideCorrelation() {
  const result = evaluateSpotEntryBurstGate({
    lane: 'CORE',
    symbol: 'CCCUSDT',
    currentPct: 7,
    managedPositions: [{ symbol: 'AAAUSDT', openedAt: Date.now() - 60 * 60 * 1000 }],
    v42Quality: quality(3, 0.99),
    peerCorrelations: [{ symbol: 'AAAUSDT', correlation: 0.93 }]
  });
  assert.strictEqual(result.allow, true);
})();

(function nonCoreLaneKeepsExistingBehaviorExceptDuplicates() {
  const now = Date.now();
  const result = evaluateSpotEntryBurstGate({
    lane: 'V10_HUNTER',
    symbol: 'CCCUSDT',
    currentPct: 15,
    now,
    managedPositions: [
      { symbol: 'AAAUSDT', openedAt: now - 2 * 60 * 1000 },
      { symbol: 'BBBUSDT', openedAt: now - 3 * 60 * 1000 }
    ],
    v42Quality: quality(0, 0)
  });
  assert.strictEqual(result.allow, true);
  assert.strictEqual(result.code, 'NON_CORE_UNCHANGED');
})();

(function correlationMathDetectsAlignedReturns() {
  const candidate = [];
  const peer = [];
  let a = 100;
  let b = 50;
  for (let i = 0; i < 30; i += 1) {
    const step = i % 3 === 0 ? 1.01 : (i % 3 === 1 ? 0.995 : 1.004);
    a *= step;
    b *= step;
    candidate.push({ c: a });
    peer.push({ c: b });
  }
  const corr = returnCorrelationFromBars(candidate, peer, 24);
  assert(Number.isFinite(corr));
  assert(corr > 0.999);
})();

console.log('spotEntryBurstGate tests passed');
