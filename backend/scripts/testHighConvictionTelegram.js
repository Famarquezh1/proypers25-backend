const { sendHighConvictionNotification } = require('../lib/highConvictionSignals');

async function run() {
  const sampleSignal = {
    symbol: 'ETH-USD',
    direction: 'up',
    confidence: 0.91,
    quantum_score: 0.88,
    timing_score: 0.84,
    stability: 0.87,
    mode: 'event_driven',
    estimated_window: {
      start: '19:42:00',
      end: '19:48:00'
    }
  };

  const result = await sendHighConvictionNotification(sampleSignal);
  console.log('testHighConvictionTelegram result:', result);
}

run().catch((err) => {
  console.error('testHighConvictionTelegram failed:', err?.message || err);
  process.exit(1);
});
