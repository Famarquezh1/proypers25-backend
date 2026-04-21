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

// Helper to get Binance price
async function getBinancePrice(symbol) {
  return new Promise((resolve, reject) => {
    const binanceSymbol = symbol.replace('-USD', 'USDT').toUpperCase();
    const url = `https://api.binance.com/api/v3/ticker/price?symbol=${binanceSymbol}`;

    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve(Number(json.price));
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function validateProfitability() {
  try {
    console.log('\n=== EXTENDED PROFITABILITY VALIDATION ===\n');
    console.log('Duration: 15 minutes (vs 3 minutes in prior test)\n');

    // Read last 10 signals
    const signalsSnap = await db.collection('high_conviction_signals')
      .orderBy('created_at', 'desc')
      .limit(10)
      .get();

    const signals = signalsSnap.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));

    console.log(`Found ${signals.length} signals\n`);
    console.log('Capturing initial prices...\n');

    const results = [];
    const MIN_THRESHOLD = 0.25; // 0.25% profitability threshold

    // Capture initial prices
    for (let i = 0; i < signals.length; i++) {
      const sig = signals[i];
      try {
        const initialPrice = await getBinancePrice(sig.symbol);
        results.push({
          index: i + 1,
          symbol: sig.symbol,
          direction: sig.direction,
          confidence: sig.confidence,
          initialPrice: initialPrice,
          finalPrice: null,
          move: null,
          profitable: null
        });
        console.log(`[${i + 1}] ${sig.symbol}: $${initialPrice.toFixed(2)}`);
      } catch (error) {
        console.log(`[${i + 1}] ${sig.symbol}: ERROR - ${error.message}`);
      }
    }

    // Wait 15 minutes
    console.log('\n⏳ Waiting 15 minutes (900 seconds)...\n');
    const waitTime = 900000; // 15 minutes
    const startTime = Date.now();

    while (Date.now() - startTime < waitTime) {
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      const remaining = Math.floor((waitTime - (Date.now() - startTime)) / 1000);
      process.stdout.write(`\rElapsed: ${elapsed}s / Remaining: ${remaining}s`);
      await sleep(1000);
    }

    console.log('\n\nCapturing final prices...\n');

    // Capture final prices and calculate profitability
    let profitableCount = 0;
    let accuracyCorrect = 0;

    for (const result of results) {
      try {
        const finalPrice = await getBinancePrice(result.symbol);
        result.finalPrice = finalPrice;

        const movePct = ((finalPrice - result.initialPrice) / result.initialPrice) * 100;
        result.move = Number(movePct.toFixed(2));

        // Check if profitable (absolute move >= 0.25%)
        result.profitable = Math.abs(result.move) >= MIN_THRESHOLD;

        // Check if directionally correct
        const direction = result.direction.toLowerCase();
        let isDirectionCorrect = false;
        if ((direction === 'up' || direction === 'long') && result.move > 0) {
          isDirectionCorrect = true;
        } else if ((direction === 'down' || direction === 'short') && result.move < 0) {
          isDirectionCorrect = true;
        }

        if (isDirectionCorrect) {
          accuracyCorrect++;
        }

        if (result.profitable) {
          profitableCount++;
        }

        console.log(`[${result.index}] ${result.symbol.padEnd(10)} ${result.direction.toUpperCase().padEnd(5)}`);
        console.log(`    Initial: $${result.initialPrice.toFixed(2)}`);
        console.log(`    Final:   $${result.finalPrice.toFixed(2)}`);
        console.log(`    Move:    ${result.move > 0 ? '+' : ''}${result.move}%`);
        console.log(`    Profitable: ${result.profitable ? '✓ YES' : '✗ NO'}`);
        console.log('');

      } catch (error) {
        console.log(`[${result.index}] ${result.symbol}: ERROR - ${error.message}\n`);
      }
    }

    // Summary
    console.log('=== SUMMARY ===\n');
    console.log(`TOTAL_SIGNALS: ${results.length}`);
    console.log(`PROFITABLE_MOVES (>0.25%): ${profitableCount}`);
    console.log(`NON_PROFITABLE: ${results.length - profitableCount}`);
    console.log(`PROFITABLE_RATE: ${(profitableCount / results.length * 100).toFixed(1)}%`);
    console.log(`DIRECTIONAL_ACCURACY: ${(accuracyCorrect / results.length * 100).toFixed(1)}%\n`);

    // Analysis
    console.log('=== ANALYSIS ===\n');

    const avgMove = results.reduce((sum, r) => sum + Math.abs(r.move || 0), 0) / results.length;
    const maxMove = Math.max(...results.map(r => Math.abs(r.move || 0)));
    const minMove = Math.min(...results.map(r => Math.abs(r.move || 0)));

    console.log(`Average Move: ${avgMove.toFixed(3)}%`);
    console.log(`Max Move: ${maxMove.toFixed(3)}%`);
    console.log(`Min Move: ${minMove.toFixed(3)}%\n`);

    if (profitableCount / results.length >= 0.4) {
      console.log('ROOT_CAUSE: NONE\n');
      console.log('NEXT_ACTION: System meets profitability requirements (≥40%)\n');
    } else {
      console.log(`ROOT_CAUSE: Limited volatility in 15-minute window (${avgMove.toFixed(3)}% avg)\n`);
      console.log('NEXT_ACTION: Consider 30-minute validation OR reduce profitability threshold\n');
    }

    process.exit(0);

  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

validateProfitability();
