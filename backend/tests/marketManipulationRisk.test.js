'use strict';

const assert = require('assert');
const { evaluateManipulationRisk } = require('../services/marketManipulationRisk');

function book(bids, asks, at) {
  return { bids, asks, at };
}

function stableBooks() {
  return [
    book([['10.00', '700'], ['9.99', '500']], [['10.01', '650'], ['10.02', '550']], 1),
    book([['10.00', '690'], ['9.99', '510']], [['10.01', '660'], ['10.02', '540']], 2),
    book([['10.00', '710'], ['9.99', '490']], [['10.01', '640'], ['10.02', '560']], 3)
  ];
}

function trades({ buys = 12, sells = 8, price = 10, qty = 20 } = {}) {
  const rows = [];
  for (let i = 0; i < buys; i += 1) rows.push({ p: String(price), q: String(qty), m: false });
  for (let i = 0; i < sells; i += 1) rows.push({ p: String(price), q: String(qty), m: true });
  return rows;
}

{
  const result = evaluateManipulationRisk({
    depthSnapshots: stableBooks(),
    recentTrades: trades(),
    recentKlines: [
      [0, '10.00', '10.05', '9.98', '10.03'],
      [1, '10.03', '10.08', '10.01', '10.06']
    ]
  });
  assert.strictEqual(result.block, false);
  assert.strictEqual(result.band, 'LOW');
  assert(result.score < 0.45);
}

{
  const suspiciousBooks = [
    book([['10.00', '1800'], ['9.99', '150']], [['10.01', '500'], ['10.02', '450']], 1),
    book([['10.00', '120'], ['9.99', '180']], [['10.01', '1700'], ['10.02', '120']], 2),
    book([['10.00', '1600'], ['9.99', '120']], [['10.01', '150'], ['10.02', '180']], 3)
  ];
  const result = evaluateManipulationRisk({
    depthSnapshots: suspiciousBooks,
    recentTrades: trades({ buys: 5, sells: 20, price: 10.2, qty: 20 }),
    recentKlines: [
      [0, '10.00', '10.10', '9.99', '10.08'],
      [1, '10.08', '10.55', '10.05', '10.20']
    ]
  });
  assert.strictEqual(result.block, true);
  assert.strictEqual(result.band, 'HIGH');
  assert(result.score >= 0.65);
  assert(result.reason.includes('UNSTABLE_DOMINANT_WALL'));
  assert(result.reason.includes('PRICE_FLOW_DIVERGENCE'));
}

{
  const oneWallEvent = [
    book([['10.00', '1800'], ['9.99', '150']], [['10.01', '700'], ['10.02', '650']], 1),
    book([['10.00', '150'], ['9.99', '900']], [['10.01', '710'], ['10.02', '640']], 2),
    book([['10.00', '140'], ['9.99', '920']], [['10.01', '690'], ['10.02', '660']], 3)
  ];
  const result = evaluateManipulationRisk({
    depthSnapshots: oneWallEvent,
    recentTrades: trades({ buys: 14, sells: 6 }),
    recentKlines: [[0, '10.00', '10.05', '9.98', '10.03']]
  });
  assert.strictEqual(result.block, false, 'one isolated anomaly should not block by itself');
}

console.log('marketManipulationRisk tests OK');
