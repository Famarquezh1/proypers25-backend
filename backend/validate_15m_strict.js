#!/usr/bin/env node

const admin = require('firebase-admin');
const https = require('https');
const serviceAccount = require('./serviceAccountKey.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: serviceAccount.project_id,
  databaseURL: `https://${serviceAccount.project_id}.firebaseio.com`
});

const db = admin.firestore();

// Get historical price data from Binance klines
async function getHistoricalPrice(symbol, timestamp, offsetMinutes = 0) {
  return new Promise((resolve, reject) => {
    const binanceSymbol = symbol.replace('-USD', 'USDT').toUpperCase();
    const targetTime = new Date(timestamp.toDate ? timestamp.toDate() : timestamp);
    if (offsetMinutes > 0) {
      targetTime.setMinutes(targetTime.getMinutes() + offsetMinutes);
    }

    // Round to nearest minute
    targetTime.setSeconds(0);
    targetTime.setMilliseconds(0);

    const startTime = targetTime.getTime() - 60000; // 1 min before
    const endTime = targetTime.getTime() + 60000;   // 1 min after

    const url = `https://api.binance.com/api/v3/klines?symbol=${binanceSymbol}&interval=1m&startTime=${startTime}&endTime=${endTime}&limit=2`;

    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const klines = JSON.parse(data);
          if (klines.length === 0) {
            reject(new Error(`No kline data for ${symbol} at ${targetTime.toISOString()}`));
            return;
          }
          // Use close price from first kline
          const closePrice = Number(klines[0][4]);
          resolve(closePrice);
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

async function validateStrict() {
  try {
    console.log('\n=== 15 MIN VALIDATION (STRICT - HISTORICAL DATA) ===\n');

    // Read last 10 signals
    const signalsSnap = await db.collection('high_conviction_signals')
      .orderBy('created_at', 'desc')
      .limit(10)
      .get();

    const signals = signalsSnap.docs.map(doc => ({
      id: doc.id,
      timestamp: doc.data().created_at,
      symbol: doc.data().symbol,
      direction: doc.data().direction,
      confidence: doc.data().confidence,
      ...doc.data()
    }));

    console.log(`Found ${signals.length} signals\n`);
    console.log('Fetching historical price data...\n');

    const MIN_THRESHOLD = 0.25; // 0.25%
    const results = [];
    let correctCount = 0;
    let profitableCount = 0;
    let totalMove = 0;
    let minMove = Infinity;
    let maxMove = -Infinity;

    // Get prices for each signal
    for (let i = 0; i < signals.length; i++) {
      const sig = signals[i];

      try {
        // Get price at signal time
        const priceAtSignal = await getHistoricalPrice(sig.symbol, sig.timestamp, 0);

        // Get price 15 minutes later
        const priceAfter15m = await getHistoricalPrice(sig.symbol, sig.timestamp, 15);

        // Calculate move
        const movePct = ((priceAfter15m - priceAtSignal) / priceAtSignal) * 100;
        const absMovePercent = Math.abs(movePct);

        // Check direction accuracy
        const direction = sig.direction.toLowerCase();
        let isCorrect = false;

        if ((direction === 'up' || direction === 'long') && priceAfter15m > priceAtSignal) {
          isCorrect = true;
        } else if ((direction === 'down' || direction === 'short') && priceAfter15m < priceAtSignal) {
          isCorrect = true;
        }

        // Check profitability
        const isProfitable = absMovePercent >= MIN_THRESHOLD;

        if (isCorrect) correctCount++;
        if (isProfitable) profitableCount++;

        totalMove += absMovePercent;
        minMove = Math.min(minMove, absMovePercent);
        maxMove = Math.max(maxMove, absMovePercent);

        results.push({
          index: i + 1,
          symbol: sig.symbol,
          direction: direction.toUpperCase(),
          priceAtSignal: priceAtSignal.toFixed(2),
          priceAfter15m: priceAfter15m.toFixed(2),
          movePct: movePct.toFixed(2),
          absMovePercent: absMovePercent.toFixed(4),
          isCorrect,
          isProfitable,
          confidence: sig.confidence
        });

        console.log(`[${i + 1}] ${sig.symbol.padEnd(10)} ${direction.toUpperCase().padEnd(5)} $${priceAtSignal.toFixed(2)} → $${priceAfter15m.toFixed(2)} (${movePct.toFixed(2)}%)`);

      } catch (error) {
        console.log(`[${i + 1}] ${sig.symbol}: ERROR - ${error.message}`);
      }
    }

    // Calculate metrics
    const avgMove = results.length > 0 ? totalMove / results.length : 0;
    const accuracy = results.length > 0 ? (correctCount / results.length) * 100 : 0;
    const profitableRate = results.length > 0 ? (profitableCount / results.length) * 100 : 0;

    // Output strict format
    console.log('\n---\n');
    console.log('=== 15 MIN VALIDATION ===\n');
    console.log(`TOTAL:`);
    console.log(`${results.length}\n`);
    console.log(`CORRECT:`);
    console.log(`${correctCount}\n`);
    console.log(`ACCURACY:`);
    console.log(`${accuracy.toFixed(1)}%\n`);

    console.log(`AVG_MOVE:`);
    console.log(`${avgMove.toFixed(4)}%\n`);
    console.log(`MIN_MOVE:`);
    console.log(`${minMove === Infinity ? 'N/A' : minMove.toFixed(4)}%\n`);
    console.log(`MAX_MOVE:`);
    console.log(`${maxMove === -Infinity ? 'N/A' : maxMove.toFixed(4)}%\n`);

    console.log(`PROFITABLE_SIGNALS:`);
    console.log(`${profitableCount}\n`);
    console.log(`PROFITABLE_RATE:`);
    console.log(`${profitableRate.toFixed(1)}%\n`);

    // Diagnosis
    console.log('---\n');
    console.log('=== DIAGNOSIS ===\n');

    let rootCause = 'UNKNOWN';
    let systemState = 'noise';

    if (avgMove >= 0.25 && profitableRate >= 40) {
      systemState = 'viable';
      rootCause = 'System generates sufficient market moves for profitable trading';
    } else if (avgMove >= 0.15 && avgMove < 0.25) {
      systemState = 'borderline';
      rootCause = 'Market moves in marginal zone (15-25% profitable, below 40% threshold)';
    } else if (avgMove < 0.10) {
      systemState = 'noise';
      rootCause = 'Market moves insufficient (below 0.10% - trading noise, not signal edge)';
    } else {
      systemState = 'borderline';
      rootCause = 'Market moves exist but profitability rate below 40% threshold';
    }

    console.log(`ROOT_CAUSE:`);
    console.log(`${rootCause}\n`);

    console.log(`SYSTEM_STATE:`);
    console.log(`${systemState}\n`);

    console.log(`NEXT_ACTION:`);
    if (systemState === 'viable') {
      console.log(`Proceed with FULL execution (1.0x position sizing, no limits)\n`);
    } else if (systemState === 'borderline') {
      console.log(`Proceed with CONSERVATIVE execution (0.5x position sizing, monitor closely)\n`);
    } else {
      console.log(`STOP - Do NOT proceed. System generates noise, not tradeable edge.\n`);
    }

    // Save report
    const report = generateReport(results, accuracy, avgMove, profitableRate, systemState, rootCause);
    const fs = require('fs');
    const path = require('path');
    const reportPath = path.join(process.cwd(), '..', 'VALIDATION_15M_STRICT_REPORT.txt');
    fs.writeFileSync(reportPath, report);
    console.log(`Report saved to ${reportPath}\n`);

    process.exit(0);

  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

function generateReport(results, accuracy, avgMove, profitableRate, systemState, rootCause) {
  let report = '=== 15 MIN VALIDATION (STRICT) ===\n\n';

  report += 'SIGNAL DATA:\n';
  for (const r of results) {
    report += `[${r.index}] ${r.symbol} ${r.direction} $${r.priceAtSignal} → $${r.priceAfter15m} (${r.movePct}%) `;
    report += r.isCorrect ? 'CORRECT' : 'INCORRECT';
    report += r.isProfitable ? ' PROFITABLE' : ' NON-PROFITABLE';
    report += `\n`;
  }

  report += `\n=== METRICS ===\n`;
  report += `TOTAL: ${results.length}\n`;
  report += `CORRECT: ${results.filter(r => r.isCorrect).length}\n`;
  report += `ACCURACY: ${accuracy.toFixed(1)}%\n`;
  report += `AVG_MOVE: ${avgMove.toFixed(4)}%\n`;
  report += `MIN_MOVE: ${Math.min(...results.map(r => parseFloat(r.absMovePercent))).toFixed(4)}%\n`;
  report += `MAX_MOVE: ${Math.max(...results.map(r => parseFloat(r.absMovePercent))).toFixed(4)}%\n`;
  report += `PROFITABLE_SIGNALS: ${results.filter(r => r.isProfitable).length}\n`;
  report += `PROFITABLE_RATE: ${profitableRate.toFixed(1)}%\n`;

  report += `\nSYSTEM_STATE: ${systemState}\n`;
  report += `ROOT_CAUSE: ${rootCause}\n`;

  return report;
}

validateStrict();
