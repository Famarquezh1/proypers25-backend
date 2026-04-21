#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

// Data from actual validation run
const validationData = [
  { index: 1, symbol: 'BNB-USD', direction: 'DOWN', move: -0.02, result: 'correct' },
  { index: 2, symbol: 'ETH-USD', direction: 'DOWN', move: -0.1, result: 'correct' },
  { index: 3, symbol: 'SOL-USD', direction: 'DOWN', move: -0.07, result: 'correct' },
  { index: 4, symbol: 'XRP-USD', direction: 'DOWN', move: -0.06, result: 'correct' },
  { index: 5, symbol: 'BNB-USD', direction: 'UP', move: -0.03, result: 'incorrect' },
  { index: 6, symbol: 'ETH-USD', direction: 'DOWN', move: -0.1, result: 'correct' },
  { index: 7, symbol: 'XRP-USD', direction: 'UP', move: -0.05, result: 'incorrect' },
  { index: 8, symbol: 'ETH-USD', direction: 'DOWN', move: -0.1, result: 'correct' },
  { index: 9, symbol: 'XRP-USD', direction: 'DOWN', move: -0.05, result: 'correct' },
  { index: 10, symbol: 'XRP-USD', direction: 'DOWN', move: -0.05, result: 'correct' }
];

async function profitabilityAnalysis() {
  try {
    console.log('\n=== PROFITABILITY CHECK ===\n');

    // Define profitability threshold
    const MIN_PROFIT_THRESHOLD = 0.25; // 0.25%
    const TRADING_FEE = 0.1; // Binance maker/taker fee ~0.1%

    console.log(`MIN_PROFIT_THRESHOLD: ${MIN_PROFIT_THRESHOLD}%`);
    console.log(`ESTIMATED_TRADING_FEE: ${TRADING_FEE}%`);
    console.log(`NET_PROFIT_NEEDED: ${(MIN_PROFIT_THRESHOLD + TRADING_FEE).toFixed(2)}%\n`);

    // Analyze each signal
    let profitableCount = 0;
    let nonProfitableCount = 0;
    let totalMove = 0;
    let minMove = Infinity;
    let maxMove = -Infinity;

    const detailedResults = [];

    for (const signal of validationData) {
      const movePct = Math.abs(signal.move); // Use absolute value since we care about magnitude
      const isProfitable = movePct >= MIN_PROFIT_THRESHOLD;
      const isFeeProfitable = movePct >= (MIN_PROFIT_THRESHOLD + TRADING_FEE);

      if (isProfitable) {
        profitableCount++;
      } else {
        nonProfitableCount++;
      }

      totalMove += movePct;
      minMove = Math.min(minMove, movePct);
      maxMove = Math.max(maxMove, movePct);

      detailedResults.push({
        index: signal.index,
        symbol: signal.symbol,
        direction: signal.direction,
        move: signal.move,
        absMovePercent: movePct.toFixed(2),
        isProfitable: isProfitable,
        isFeeProfitable: isFeeProfitable,
        accuracy: signal.result
      });

      // Print each signal
      console.log(`[${signal.index}] ${signal.symbol.padEnd(10)} ${signal.direction.padEnd(5)} ${signal.move.toFixed(2)}%  →  ${isProfitable ? '✓ PROFITABLE' : '✗ NON-PROFITABLE'}`);
    }

    const avgMove = totalMove / validationData.length;
    const profitableRate = (profitableCount / validationData.length) * 100;

    console.log('\n---\n');
    console.log('=== SUMMARY ===\n');

    console.log(`TOTAL_SIGNALS:`);
    console.log(`${validationData.length}\n`);

    console.log(`PROFITABLE_MOVES:`);
    console.log(`${profitableCount}\n`);

    console.log(`NON_PROFITABLE:`);
    console.log(`${nonProfitableCount}\n`);

    console.log(`PROFITABLE_RATE:`);
    console.log(`${profitableRate.toFixed(1)}%\n`);

    // Additional metrics
    console.log(`---\n`);
    console.log(`=== MOVEMENT ANALYSIS ===\n`);

    console.log(`Average Move: ${avgMove.toFixed(4)}%`);
    console.log(`Min Move: ${minMove.toFixed(4)}%`);
    console.log(`Max Move: ${maxMove.toFixed(4)}%`);
    console.log(`Median Move: ${getMedian(detailedResults.map(r => parseFloat(r.absMovePercent))).toFixed(4)}%\n`);

    // Fee impact analysis
    console.log(`=== FEE IMPACT ANALYSIS ===\n`);

    let afterFeeCount = 0;
    for (const result of detailedResults) {
      const movePct = parseFloat(result.absMovePercent);
      const afterFee = movePct - TRADING_FEE;
      if (afterFee > 0) {
        afterFeeCount++;
      }
    }

    console.log(`After Trading Fee (${TRADING_FEE}%):`);
    console.log(`  Profitable: ${afterFeeCount}/${validationData.length}`);
    console.log(`  Rate: ${(afterFeeCount / validationData.length * 100).toFixed(1)}%\n`);

    // Classification by symbol
    console.log(`=== PROFITABILITY BY SYMBOL ===\n`);

    const bySymbol = {};
    for (const result of detailedResults) {
      if (!bySymbol[result.symbol]) {
        bySymbol[result.symbol] = { total: 0, profitable: 0, moves: [] };
      }
      bySymbol[result.symbol].total++;
      bySymbol[result.symbol].moves.push(parseFloat(result.absMovePercent));
      if (result.isProfitable) {
        bySymbol[result.symbol].profitable++;
      }
    }

    for (const [symbol, data] of Object.entries(bySymbol)) {
      const rate = (data.profitable / data.total * 100).toFixed(1);
      const avgMove = (data.moves.reduce((a, b) => a + b, 0) / data.moves.length).toFixed(4);
      console.log(`${symbol}: ${data.profitable}/${data.total} (${rate}%) | Avg Move: ${avgMove}%`);
    }

    // Root cause analysis
    console.log(`\n---\n`);
    console.log(`=== ROOT CAUSE ANALYSIS ===\n`);

    if (profitableRate < 40) {
      console.log(`⚠️ PROFITABILITY BELOW 40% - Issues Identified:\n`);
      console.log(`ROOT_CAUSE:\n`);
      console.log(`1. INSUFFICIENT MARKET MOVEMENT`);
      console.log(`   - Average move: ${avgMove.toFixed(4)}% (threshold: ${MIN_PROFIT_THRESHOLD}%)`);
      console.log(`   - Gap: ${(MIN_PROFIT_THRESHOLD - avgMove).toFixed(4)}% below threshold\n`);

      console.log(`2. SHORT VALIDATION WINDOW`);
      console.log(`   - Only 3 minutes observed`);
      console.log(`   - Market needs 15+ minutes to develop full moves\n`);

      console.log(`3. TRADING FEE IMPACT`);
      console.log(`   - Fee: ${TRADING_FEE}%`);
      console.log(`   - Most moves below ${(MIN_PROFIT_THRESHOLD + TRADING_FEE).toFixed(2)}% net threshold\n`);

      console.log(`NEXT_ACTION:\n`);
      console.log(`Option A: EXTEND VALIDATION WINDOW`);
      console.log(`  - Run 15-minute validation instead of 3 minutes`);
      console.log(`  - Expected to show 3-5x larger moves\n`);

      console.log(`Option B: ADJUST PROFITABILITY THRESHOLD`);
      console.log(`  - Lower threshold to match market reality`);
      console.log(`  - Accept smaller profits with higher frequency\n`);

      console.log(`Option C: OPTIMIZE ENTRY/EXIT`);
      console.log(`  - Improve entry timing within signal candle`);
      console.log(`  - Extend hold period for larger moves\n`);

      console.log(`RECOMMENDATION: Run 15-minute validation to get realistic profitability picture\n`);

    } else if (profitableRate < 60) {
      console.log(`⚠️ PROFITABILITY MARGINAL (40-60%)\n`);
      console.log(`ROOT_CAUSE: Limited moves in 3-minute window\n`);
      console.log(`NEXT_ACTION: Extend validation to 15 minutes for full picture\n`);

    } else {
      console.log(`✓ PROFITABILITY ACCEPTABLE (>60%)\n`);
      console.log(`ROOT_CAUSE: NONE - System meets profitability requirements\n`);
      console.log(`NEXT_ACTION: Proceed with execution\n`);
    }

    // Final recommendation
    console.log(`---\n`);
    console.log(`=== FINAL ASSESSMENT ===\n`);

    if (profitableRate >= 40 && avgMove > 0.1) {
      console.log(`Status: ✓ PROCEED WITH TRADING`);
      console.log(`Rationale: Signals show consistent directional accuracy (80%)`);
      console.log(`Even small moves (${avgMove.toFixed(4)}% avg) are valuable`);
      console.log(`with proper position sizing and fee optimization.\n`);
    } else if (avgMove < MIN_PROFIT_THRESHOLD) {
      console.log(`Status: ⚠️ VALIDATE LONGER TIMEFRAME`);
      console.log(`Issue: 3-minute window too short for profitability assessment`);
      console.log(`Action: Run 15-minute validation to see realistic moves\n`);
    } else {
      console.log(`Status: ✓ PROCEED CAUTIOUSLY`);
      console.log(`Monitor: First 10 real trades`);
      console.log(`Adjust: Position sizing if actual moves exceed estimates\n`);
    }

    // Save report
    const report = generateReport(detailedResults, profitableCount, profitableRate, avgMove, MIN_PROFIT_THRESHOLD);
    const reportPath = path.join(process.cwd(), '..', 'PROFITABILITY_CHECK_REPORT.txt');
    fs.writeFileSync(reportPath, report);
    console.log(`Report saved to ${reportPath}\n`);

    process.exit(0);

  } catch (error) {
    console.error('❌ Analysis Error:', error.message);
    process.exit(1);
  }
}

function getMedian(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function generateReport(results, profitableCount, profitableRate, avgMove, threshold) {
  let report = '=== PROFITABILITY CHECK REPORT ===\n\n';

  report += 'CONFIGURATION:\n';
  report += `  MIN_PROFIT_THRESHOLD: ${threshold}%\n`;
  report += `  TRADING_FEE: 0.1%\n`;
  report += `  NET_THRESHOLD: ${(threshold + 0.1).toFixed(2)}%\n\n`;

  report += 'RESULTS:\n';
  for (const result of results) {
    const status = result.isProfitable ? 'PROFITABLE' : 'NON-PROFITABLE';
    report += `[${result.index}] ${result.symbol} ${result.direction} ${result.move.toFixed(2)}% → ${status}\n`;
  }

  report += `\nSUMMARY:\n`;
  report += `TOTAL_SIGNALS: ${results.length}\n`;
  report += `PROFITABLE_MOVES: ${profitableCount}\n`;
  report += `NON_PROFITABLE: ${results.length - profitableCount}\n`;
  report += `PROFITABLE_RATE: ${profitableRate.toFixed(1)}%\n`;
  report += `AVERAGE_MOVE: ${avgMove.toFixed(4)}%\n`;

  report += `\nASSESSMENT:\n`;
  if (profitableRate < 40) {
    report += `Status: Insufficient profitability for trading (${profitableRate.toFixed(1)}%)\n`;
    report += `Action: Extend validation window to 15 minutes\n`;
  } else if (profitableRate < 60) {
    report += `Status: Marginal profitability (${profitableRate.toFixed(1)}%)\n`;
    report += `Action: Proceed cautiously or extend validation\n`;
  } else {
    report += `Status: Acceptable profitability (${profitableRate.toFixed(1)}%)\n`;
    report += `Action: Proceed with trading\n`;
  }

  return report;
}

profitabilityAnalysis();
