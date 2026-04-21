#!/usr/bin/env node

const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccountKey.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: serviceAccount.project_id,
  databaseURL: `https://${serviceAccount.project_id}.firebaseio.com`
});

const db = admin.firestore();

async function analyzeOpenPositions() {
  try {
    console.log('\n=== TRADE VALIDATION (Open Positions Analysis) ===\n');

    // Get open positions
    const posSnap = await db.collection('binance_open_positions')
      .limit(10)
      .get();

    const positions = posSnap.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));

    console.log(`📊 Found ${positions.length} open positions\n`);

    if (positions.length === 0) {
      console.log('❌ No open positions found.\n');
      console.log('Trade validation unavailable - no execution history yet.\n');
      console.log('=== END VALIDATION ===\n');
      process.exit(0);
    }

    // Analyze positions
    let totalWins = 0;
    let totalLosses = 0;
    let breakEven = 0;
    let totalPnl = 0;
    let totalUnrealizedPnl = 0;

    const positionDetails = positions.map((pos, idx) => {
      const entryPrice = pos.entry_price || 0;
      const currentPrice = pos.current_price || entryPrice;
      const exitPrice = pos.exit_price;
      const quantity = pos.quantity || 0;
      const direction = pos.direction || 'unknown';

      // Calculate realized PnL (if position closed)
      let realizedPnl = 0;
      if (exitPrice && entryPrice && quantity > 0) {
        if (direction === 'up' || direction === 'long') {
          realizedPnl = ((exitPrice - entryPrice) / entryPrice) * 100;
        } else if (direction === 'down' || direction === 'short') {
          realizedPnl = ((entryPrice - exitPrice) / entryPrice) * 100;
        }

        if (realizedPnl > 0) totalWins++;
        else if (realizedPnl < 0) totalLosses++;
        else breakEven++;

        totalPnl += realizedPnl;
      }

      // Calculate unrealized PnL
      let unrealizedPnl = 0;
      if (currentPrice && entryPrice && quantity > 0 && !exitPrice) {
        if (direction === 'up' || direction === 'long') {
          unrealizedPnl = ((currentPrice - entryPrice) / entryPrice) * 100;
        } else if (direction === 'down' || direction === 'short') {
          unrealizedPnl = ((entryPrice - currentPrice) / entryPrice) * 100;
        }
        totalUnrealizedPnl += unrealizedPnl;
      }

      // Status
      const status = exitPrice ? 'CLOSED' : 'OPEN';
      const pnl = exitPrice ? realizedPnl : unrealizedPnl;

      return {
        index: idx + 1,
        symbol: pos.symbol,
        direction: direction,
        entryPrice: Number(entryPrice.toFixed(4)),
        exitPrice: exitPrice ? Number(exitPrice.toFixed(4)) : null,
        currentPrice: Number(currentPrice.toFixed(4)),
        quantity: Number(quantity.toFixed(4)),
        pnl: Number(pnl.toFixed(2)),
        result: exitPrice ? (pnl > 0 ? 'WIN' : (pnl < 0 ? 'LOSS' : 'BREAK_EVEN')) : (pnl > 0 ? 'PROFITABLE' : 'LOSING'),
        status: status,
        entryTime: pos.entry_time,
        exitTime: pos.exit_time,
        exitReason: pos.exit_reason || 'open'
      };
    });

    // Report each position
    positionDetails.forEach(pos => {
      console.log(`[${pos.index}] ${pos.symbol} - ${pos.direction.toUpperCase()}`);
      console.log(`    ENTRY_PRICE: ${pos.entryPrice}`);
      console.log(`    EXIT_PRICE: ${pos.exitPrice || 'OPEN'}`);
      console.log(`    CURRENT_PRICE: ${pos.currentPrice}`);
      console.log(`    PNL: ${pos.pnl}%`);
      console.log(`    RESULT: ${pos.result}`);
      console.log(`    STATUS: ${pos.status}`);
      console.log(`    EXIT_REASON: ${pos.exitReason}`);
      console.log('');
    });

    // Summary stats
    const closedPositions = positionDetails.filter(p => p.status === 'CLOSED');
    const openPositions = positionDetails.filter(p => p.status === 'OPEN');

    console.log(`=== RESUMEN ===\n`);
    console.log(`CLOSED_POSITIONS: ${closedPositions.length}`);
    console.log(`OPEN_POSITIONS: ${openPositions.length}`);

    if (closedPositions.length > 0) {
      const closedWins = closedPositions.filter(p => p.pnl > 0).length;
      const closedLosses = closedPositions.filter(p => p.pnl < 0).length;
      const closedWinRate = ((closedWins / closedPositions.length) * 100).toFixed(1);
      const closedAvgPnl = (closedPositions.reduce((sum, p) => sum + p.pnl, 0) / closedPositions.length).toFixed(2);

      console.log(`\nCLOSED TRADES:`);
      console.log(`WIN_RATE: ${closedWinRate}%`);
      console.log(`AVG_PNL: ${closedAvgPnl}%`);
      console.log(`WINS: ${closedWins}`);
      console.log(`LOSSES: ${closedLosses}`);
    }

    if (openPositions.length > 0) {
      const openProfit = openPositions.filter(p => p.pnl > 0).length;
      const openLoss = openPositions.filter(p => p.pnl < 0).length;
      const openAvgPnl = (openPositions.reduce((sum, p) => sum + p.pnl, 0) / openPositions.length).toFixed(2);

      console.log(`\nOPEN POSITIONS:`);
      console.log(`CURRENTLY_PROFITABLE: ${openProfit}`);
      console.log(`CURRENTLY_LOSING: ${openLoss}`);
      console.log(`AVG_UNREALIZED_PNL: ${openAvgPnl}%`);
    }

    // Main issue
    console.log(`\n=== DIAGNOSIS ===\n`);

    let mainIssue = 'Data collection ongoing - no closed trades yet';
    let nextAction = 'Continue monitoring open positions and await trade closures';

    if (closedPositions.length === 0) {
      mainIssue = 'No closed trades yet - system is collecting initial position data';
      nextAction = 'Wait for positions to close naturally or manually close one for validation';
    } else if (closedPositions.length > 0) {
      const winRate = ((closedPositions.filter(p => p.pnl > 0).length / closedPositions.length) * 100);
      const avgPnl = closedPositions.reduce((sum, p) => sum + p.pnl, 0) / closedPositions.length;

      if (winRate < 40) {
        mainIssue = 'Win rate below 40% - signal quality or entry/exit logic needs review';
        nextAction = 'Increase MIN_CONFIDENCE threshold from 0.65 to 0.75';
      } else if (avgPnl < -0.5) {
        mainIssue = 'Negative average PnL - stop loss or exit strategy too aggressive';
        nextAction = 'Review stop-loss ratios and adjust to 2:1 risk/reward minimum';
      } else if (closedPositions.length < 5) {
        mainIssue = 'Sample size insufficient - need minimum 5-10 trades for validation';
        nextAction = 'Collect at least 5 more closed trades before adjusting parameters';
      } else {
        mainIssue = 'Performance within acceptable range - continue monitoring';
        nextAction = 'Maintain current parameters and monitor for 20+ trade sample';
      }
    }

    console.log(`MAIN_ISSUE: ${mainIssue}`);
    console.log(`\nNEXT_ACTION: ${nextAction}\n`);

    console.log('=== END VALIDATION ===\n');

    process.exit(0);
  } catch (error) {
    console.error('❌ Analysis Error:', error.message);
    process.exit(1);
  }
}

analyzeOpenPositions();
