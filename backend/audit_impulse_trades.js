/**
 * IMPULSE AUDIT - Phase 10
 *
 * Valida performance después de N trades
 * Entrega reporte con métricas de éxito
 */

const admin = require('firebase-admin');
const fs = require('fs');

const db = admin.firestore();

/**
 * Get closed impulse trades
 */
async function getClosedTrades(limit = 20) {
  try {
    const snapshot = await db.collection('active_impulse_trades')
      .where('status', '==', 'CLOSED')
      .orderBy('closed_at', 'desc')
      .limit(limit)
      .get();

    return snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));

  } catch (error) {
    console.error('[AUDIT] Error fetching trades:', error.message);
    return [];
  }
}

/**
 * Calculate audit metrics
 */
function calculateMetrics(trades) {
  if (trades.length === 0) {
    return {
      total_trades: 0,
      message: 'No closed trades found'
    };
  }

  let winCount = 0;
  let lossCount = 0;
  let totalPnl = 0;
  let totalMoveCaptured = 0;
  let bestTrade = null;
  let worstTrade = null;
  const durations = [];

  trades.forEach(trade => {
    const pnl = trade.pnl_pct || 0;
    totalPnl += pnl;

    if (pnl > 0) {
      winCount++;
    } else if (pnl < 0) {
      lossCount++;
    }

    // Track move captured
    const moveCaptured = Math.abs(trade.exit_price - trade.entry_price) / trade.entry_price * 100;
    totalMoveCaptured += moveCaptured;

    // Track best/worst
    if (!bestTrade || pnl > bestTrade.pnl_pct) {
      bestTrade = { ...trade, pnl };
    }
    if (!worstTrade || pnl < worstTrade.pnl_pct) {
      worstTrade = { ...trade, pnl };
    }

    // Track duration
    if (trade.duration_ms) {
      durations.push(trade.duration_ms);
    }
  });

  const winRate = (winCount / trades.length) * 100;
  const avgPnl = totalPnl / trades.length;
  const avgMoveCaptured = totalMoveCaptured / trades.length;
  const avgDuration = durations.length > 0
    ? durations.reduce((a, b) => a + b, 0) / durations.length
    : 0;

  // Success check
  const viable = winRate >= 55 && avgMoveCaptured >= 0.4;

  return {
    total_trades: trades.length,
    win_count: winCount,
    loss_count: lossCount,
    win_rate: winRate,
    avg_pnl: avgPnl,
    total_pnl: totalPnl,
    avg_move_captured: avgMoveCaptured,
    avg_duration_ms: Math.round(avgDuration),
    best_trade: {
      symbol: bestTrade.symbol,
      direction: bestTrade.direction,
      entry_price: bestTrade.entry_price,
      exit_price: bestTrade.exit_price,
      pnl_pct: bestTrade.pnl,
      reason_exit: bestTrade.reason_exit
    },
    worst_trade: {
      symbol: worstTrade.symbol,
      direction: worstTrade.direction,
      entry_price: worstTrade.entry_price,
      exit_price: worstTrade.exit_price,
      pnl_pct: worstTrade.pnl,
      reason_exit: worstTrade.reason_exit
    },
    viable: viable,
    status: viable ? 'VIABLE' : 'NEEDS_REFINEMENT'
  };
}

/**
 * Generate audit report
 */
async function generateAuditReport(limit = 20) {
  console.log('\n' + '='.repeat(70));
  console.log('IMPULSE TRADING SYSTEM - AUDIT REPORT');
  console.log('='.repeat(70) + '\n');

  try {
    const trades = await getClosedTrades(limit);
    const metrics = calculateMetrics(trades);

    if (metrics.total_trades === 0) {
      console.log('⊘ No closed trades found. System may not have executed yet.\n');
      return metrics;
    }

    console.log(`TOTAL TRADES: ${metrics.total_trades}`);
    console.log(`WIN RATE: ${metrics.win_rate.toFixed(1)}% (${metrics.win_count}W / ${metrics.loss_count}L)`);
    console.log(`AVERAGE PNL: ${metrics.avg_pnl.toFixed(2)}%`);
    console.log(`TOTAL PNL: ${metrics.total_pnl.toFixed(2)}%`);
    console.log(`AVG MOVE CAPTURED: ${metrics.avg_move_captured.toFixed(3)}%`);
    console.log(`AVG DURATION: ${metrics.avg_duration_ms}ms\n`);

    console.log('BEST TRADE:');
    console.log(`  ${metrics.best_trade.symbol} ${metrics.best_trade.direction}`);
    console.log(`  ${metrics.best_trade.entry_price.toFixed(4)} → ${metrics.best_trade.exit_price.toFixed(4)}`);
    console.log(`  PNL: ${metrics.best_trade.pnl_pct.toFixed(2)}% (${metrics.best_trade.reason_exit})\n`);

    console.log('WORST TRADE:');
    console.log(`  ${metrics.worst_trade.symbol} ${metrics.worst_trade.direction}`);
    console.log(`  ${metrics.worst_trade.entry_price.toFixed(4)} → ${metrics.worst_trade.exit_price.toFixed(4)}`);
    console.log(`  PNL: ${metrics.worst_trade.pnl_pct.toFixed(2)}% (${metrics.worst_trade.reason_exit})\n`);

    console.log('VIABILITY:');
    console.log(`  WIN_RATE ≥ 55%: ${metrics.win_rate >= 55 ? '✓ YES' : '✗ NO'} (${metrics.win_rate.toFixed(1)}%)`);
    console.log(`  AVG_MOVE ≥ 0.4%: ${metrics.avg_move_captured >= 0.4 ? '✓ YES' : '✗ NO'} (${metrics.avg_move_captured.toFixed(3)}%)`);
    console.log(`  STATUS: ${metrics.viable ? '✓ VIABLE' : '✗ NEEDS_REFINEMENT'}\n`);

    console.log('NEXT ACTION:');
    if (metrics.viable) {
      console.log('  ✓ System is VIABLE. Continue monitoring and collecting more trades.');
      console.log('  ✓ Consider increasing position size to 0.5x after 20+ trades.');
    } else {
      console.log('  ✗ System needs refinement.');
      if (metrics.win_rate < 55) {
        console.log(`    - Win rate is too low (${metrics.win_rate.toFixed(1)}% < 55%)`);
        console.log('    - Check signal confidence calibration');
        console.log('    - Review TP/SL levels');
      }
      if (metrics.avg_move_captured < 0.4) {
        console.log(`    - Move capture is too small (${metrics.avg_move_captured.toFixed(3)}% < 0.4%)`);
        console.log('    - Check impulse detection thresholds');
        console.log('    - Adjust entry timing');
      }
    }

    console.log('\n' + '='.repeat(70) + '\n');

    return metrics;

  } catch (error) {
    console.error('\n✗ AUDIT ERROR:', error.message);
    process.exit(1);
  }
}

// Run audit
const limit = process.argv[2] ? parseInt(process.argv[2]) : 20;
generateAuditReport(limit);
