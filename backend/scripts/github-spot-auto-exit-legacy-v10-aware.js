'use strict';

// Lane-aware wrapper for the existing exit engine. CORE stays unchanged.
// V10_HUNTER buys are identified by their clientOrderId and receive the
// training-aligned +3% take-profit / -1.2% stop / 3h timeout policy.
const fs = require('fs');
const path = require('path');

const sourcePath = path.join(__dirname, 'github-spot-auto-exit-legacy.js');
let source = fs.readFileSync(sourcePath, 'utf8');

function patch(from, to, label) {
  if (!source.includes(from)) throw new Error(`EXIT_PATCH_REFUSED ${label}`);
  source = source.replace(from, to);
}

patch(
  'const buy = managedBuys[managedBuys.length - 1];',
  "const buy = managedBuys[managedBuys.length - 1];\n    const isV10Hunter = String(buy.clientOrderId || '').startsWith('proypers-gh-v10-');",
  'lane detection'
);

patch(
  'const { stopPrice, protection, tickSize } = protectionParams(info, entryPrice, recentHigh);',
  "const baseProtection = protectionParams(info, entryPrice, recentHigh);\n    const v10PriceFilter = info.filters?.find((f) => f.filterType === 'PRICE_FILTER');\n    const v10StopPrice = v10PriceFilter ? floorToStep(entryPrice * (1 - 0.012), v10PriceFilter.tickSize) : baseProtection.stopPrice;\n    const stopPrice = isV10Hunter ? Math.max(baseProtection.stopPrice, v10StopPrice) : baseProtection.stopPrice;\n    const protection = isV10Hunter && stopPrice === v10StopPrice ? 'V10_HARD_STOP' : baseProtection.protection;\n    const tickSize = baseProtection.tickSize;",
  'V10 stop recovery'
);

patch(
  "let reason = null;\n    if (currentPrice <= stopPrice) reason = protection === 'TRAILING' ? 'TRAILING_STOP' : protection === 'BREAK_EVEN' ? 'BREAK_EVEN_STOP' : 'STOP_LOSS';\n    else if (ageHours >= STALE_TIMEOUT_HOURS && gainPct <= STALE_TIMEOUT_MAX_GAIN_PCT) reason = 'TIMEOUT_STALE';",
  "let reason = null;\n    if (isV10Hunter && gainPct >= 0.03) reason = 'V10_TAKE_PROFIT';\n    else if (isV10Hunter && ageHours >= 3) reason = 'V10_TIMEOUT_3H';\n    else if (currentPrice <= stopPrice) reason = protection === 'TRAILING' ? 'TRAILING_STOP' : protection === 'BREAK_EVEN' ? 'BREAK_EVEN_STOP' : 'STOP_LOSS';\n    else if (ageHours >= STALE_TIMEOUT_HOURS && gainPct <= STALE_TIMEOUT_MAX_GAIN_PCT) reason = 'TIMEOUT_STALE';",
  'V10 exit rules'
);

patch(
  "if (openProtect && reason !== 'TIMEOUT_STALE') {",
  "if (openProtect && !['TIMEOUT_STALE', 'V10_TAKE_PROFIT', 'V10_TIMEOUT_3H'].includes(reason)) {",
  'market exit permission'
);

eval(source);
