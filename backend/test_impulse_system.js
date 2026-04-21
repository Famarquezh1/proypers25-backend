/**
 * IMPULSE SYSTEM TEST
 *
 * Validación local del sistema antes de deployment
 */

const impulseDetector = require('./services/impulseDetector');
const noiseFilter = require('./services/noiseFilter');
const { generateImpulseSignal } = require('./services/impulseSignalGenerator');

const SYMBOLS = [
  'BNBUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'ADAUSDT'
];

/**
 * Test impulse detection
 */
async function testImpulseDetection() {
  console.log('\n=== TESTING IMPULSE DETECTION ===\n');

  for (const symbol of SYMBOLS) {
    try {
      console.log(`Testing ${symbol}...`);
      const impulse = await impulseDetector.detectImpulse(symbol);

      if (impulse.detected) {
        console.log(`✓ IMPULSE DETECTED: ${symbol} ${impulse.direction}`);
        console.log(`  Move: ${impulse.move_pct.toFixed(3)}%`);
        console.log(`  Velocity: ${impulse.velocity.toFixed(3)}%`);
        console.log(`  Volume: ${impulse.volume_ratio.toFixed(2)}x`);
        console.log(`  Continuity: ${impulse.continuity_candles} candles`);
        console.log(`  Strength: ${impulse.strength_score.toFixed(3)}`);
      } else {
        console.log(`✗ NO IMPULSE: ${impulse.reason}`);
      }
      console.log();

    } catch (error) {
      console.error(`✗ ERROR for ${symbol}:`, error.message);
    }

    // Rate limiting
    await new Promise(resolve => setTimeout(resolve, 500));
  }
}

/**
 * Test noise filter
 */
async function testNoiseFilter() {
  console.log('\n=== TESTING NOISE FILTER ===\n');

  for (const symbol of SYMBOLS) {
    try {
      console.log(`Testing ${symbol}...`);

      // First detect impulse
      const impulse = await impulseDetector.detectImpulse(symbol);
      if (!impulse.detected) {
        console.log(`⊘ No impulse to filter for ${symbol}`);
        console.log();
        continue;
      }

      // Apply noise filter
      const filter = await noiseFilter.filterNoise(symbol, impulse);

      if (filter.is_noisy) {
        console.log(`✗ NOISE FILTER BLOCKS: ${symbol}`);
        filter.reasons.forEach(r => console.log(`  - ${r}`));
      } else {
        console.log(`✓ PASSES FILTER: ${symbol}`);
        console.log(`  15m move: ${filter.metrics.move_15m.toFixed(3)}%`);
        console.log(`  Volatility: ${filter.metrics.volatility.toFixed(3)}%`);
        console.log(`  Spread: ${filter.metrics.spread.toFixed(3)}%`);
      }
      console.log();

    } catch (error) {
      console.error(`✗ ERROR for ${symbol}:`, error.message);
    }

    await new Promise(resolve => setTimeout(resolve, 500));
  }
}

/**
 * Test signal generation
 */
async function testSignalGeneration() {
  console.log('\n=== TESTING SIGNAL GENERATION ===\n');

  for (const symbol of SYMBOLS) {
    try {
      console.log(`Testing ${symbol}...`);
      const signal = await generateImpulseSignal(symbol);

      if (signal) {
        console.log(`✓ SIGNAL GENERATED: ${symbol}`);
        console.log(`  Type: ${signal.signal_type}`);
        console.log(`  Direction: ${signal.direction}`);
        console.log(`  Confidence: ${signal.confidence.toFixed(3)}`);
        console.log(`  Strength: ${signal.strength_score.toFixed(3)}`);
        console.log(`  Expected move: ${signal.expected_move.min}% - ${signal.expected_move.max}%`);
      } else {
        console.log(`✗ NO SIGNAL: ${symbol}`);
      }
      console.log();

    } catch (error) {
      console.error(`✗ ERROR for ${symbol}:`, error.message);
    }

    await new Promise(resolve => setTimeout(resolve, 500));
  }
}

/**
 * Run all tests
 */
async function runAllTests() {
  console.log('\n' + '='.repeat(70));
  console.log('IMPULSE TRADING ENGINE - LOCAL TEST');
  console.log('='.repeat(70));

  try {
    await testImpulseDetection();
    await testNoiseFilter();
    await testSignalGeneration();

    console.log('\n' + '='.repeat(70));
    console.log('TEST COMPLETED');
    console.log('='.repeat(70) + '\n');

  } catch (error) {
    console.error('\nTEST FAILED:', error.message);
    process.exit(1);
  }
}

// Run tests
runAllTests();
