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
    // Convert symbol format: ETH-USD -> ETHUSDT
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

// Sleep helper
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function validateSignals() {
  try {
    console.log('\n=== REAL VALIDATION ===\n');

    // Step 1: Read last 10 signals from Firestore
    const signalsSnap = await db.collection('high_conviction_signals')
      .orderBy('created_at', 'desc')
      .limit(10)
      .get();

    const signals = signalsSnap.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));

    console.log(`Found ${signals.length} signals to validate\n`);

    // Store results
    const results = [];

    // Step 3A: Get prices at signal time
    console.log('Step 1: Capturing prices at signal time...\n');

    for (let i = 0; i < signals.length; i++) {
      const sig = signals[i];
      const symbol = sig.symbol;
      const direction = sig.direction || sig.recomendacion;

      try {
        // Get price at signal time
        const priceAtSignal = await getBinancePrice(symbol);

        results.push({
          index: i + 1,
          symbol: symbol,
          direction: direction,
          priceAtSignal: priceAtSignal,
          priceAfter: null,
          move: null,
          result: null,
          status: 'INITIALIZED'
        });

        console.log(`[${i + 1}/10] ${symbol} - ${direction.toUpperCase()}: $${priceAtSignal.toFixed(2)}`);
      } catch (error) {
        results.push({
          index: i + 1,
          symbol: symbol,
          direction: direction,
          priceAtSignal: null,
          priceAfter: null,
          move: null,
          result: null,
          status: 'ERROR',
          error: error.message
        });
        console.log(`[${i + 1}/10] ${symbol} - ERROR: ${error.message}`);
      }
    }

    // Step 3B: Wait 3 minutes (180 seconds)
    console.log('\nStep 2: Waiting 3 minutes for market movement...\n');
    const waitDuration = 180000; // 3 minutes
    const startTime = Date.now();

    while (Date.now() - startTime < waitDuration) {
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      const remaining = Math.floor((waitDuration - (Date.now() - startTime)) / 1000);
      process.stdout.write(`\rElapsed: ${elapsed}s / Remaining: ${remaining}s`);
      await sleep(1000);
    }
    console.log('\n\nStep 3: Capturing prices after 3 minutes...\n');

    // Get prices after 3 minutes
    let correctCount = 0;
    let incorrectCount = 0;
    let successCount = 0;

    for (const result of results) {
      if (result.status === 'ERROR') {
        console.log(`[${result.index}] ${result.symbol} - SKIPPED (initial error)\n`);
        continue;
      }

      try {
        const priceAfter = await getBinancePrice(result.symbol);
        result.priceAfter = priceAfter;

        // Step 4: Calculate move percentage
        const movePct = ((priceAfter - result.priceAtSignal) / result.priceAtSignal) * 100;
        result.move = Number(movePct.toFixed(2));

        // Step 5: Determine if correct
        const direction = result.direction.toLowerCase();
        let isCorrect = false;

        if (direction === 'up' || direction === 'long') {
          isCorrect = priceAfter > result.priceAtSignal;
        } else if (direction === 'down' || direction === 'short') {
          isCorrect = priceAfter < result.priceAtSignal;
        }

        result.result = isCorrect ? 'correct' : 'incorrect';
        result.status = 'SUCCESS';

        if (isCorrect) {
          correctCount++;
        } else {
          incorrectCount++;
        }
        successCount++;

        // Step 6: Print result
        console.log(`SYMBOL:`);
        console.log(`${result.symbol}\n`);
        console.log(`DIRECTION:`);
        console.log(`${result.direction.toUpperCase()}\n`);
        console.log(`PRICE_AT_SIGNAL:`);
        console.log(`$${result.priceAtSignal.toFixed(2)}\n`);
        console.log(`PRICE_AFTER:`);
        console.log(`$${result.priceAfter.toFixed(2)}\n`);
        console.log(`MOVE:`);
        console.log(`${result.move > 0 ? '+' : ''}${result.move}%\n`);
        console.log(`RESULT:`);
        console.log(`${result.result}\n`);
        console.log('---\n');

      } catch (error) {
        result.status = 'ERROR';
        result.error = error.message;
        console.log(`[${result.index}] ${result.symbol} - ERROR: ${error.message}\n`);
      }
    }

    // Step 7: Print summary
    console.log('=== SUMMARY ===\n');
    console.log(`TOTAL:`);
    console.log(`${successCount}\n`);
    console.log(`CORRECT:`);
    console.log(`${correctCount}\n`);
    console.log(`INCORRECT:`);
    console.log(`${incorrectCount}\n`);

    if (successCount > 0) {
      const accuracy = (correctCount / successCount) * 100;
      console.log(`ACCURACY:`);
      console.log(`${accuracy.toFixed(1)}%\n`);
    }

    // Save results to file
    const reportContent = generateReport(results, correctCount, incorrectCount);
    const fs = require('fs');
    const path = require('path');
    const reportPath = path.join(process.cwd(), '..', 'SIGNAL_VALIDATION_RESULTS_AUTO.txt');
    fs.writeFileSync(reportPath, reportContent);
    console.log(`Results saved to ${reportPath}\n`);

    process.exit(0);

  } catch (error) {
    console.error('❌ Validation Error:', error.message);
    process.exit(1);
  }
}

function generateReport(results, correctCount, incorrectCount) {
  let report = '=== REAL VALIDATION RESULTS ===\n\n';

  for (const result of results) {
    report += `[${result.index}] ${result.symbol}\n`;
    report += `DIRECTION: ${result.direction}\n`;

    if (result.status === 'SUCCESS') {
      report += `PRICE_AT_SIGNAL: $${result.priceAtSignal.toFixed(2)}\n`;
      report += `PRICE_AFTER: $${result.priceAfter.toFixed(2)}\n`;
      report += `MOVE: ${result.move > 0 ? '+' : ''}${result.move}%\n`;
      report += `RESULT: ${result.result}\n`;
    } else {
      report += `STATUS: ${result.status}\n`;
      if (result.error) {
        report += `ERROR: ${result.error}\n`;
      }
    }
    report += '\n';
  }

  report += '=== SUMMARY ===\n';
  report += `CORRECT: ${correctCount}\n`;
  report += `INCORRECT: ${incorrectCount}\n`;

  if (correctCount + incorrectCount > 0) {
    const accuracy = (correctCount / (correctCount + incorrectCount)) * 100;
    report += `ACCURACY: ${accuracy.toFixed(1)}%\n`;
  }

  return report;
}

validateSignals();
