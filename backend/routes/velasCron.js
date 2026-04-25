const express = require('express');
const crypto = require('crypto');
const {
  runPredictionCycle,
  runPreAlertCycle,
  runBinanceManagerCycle,
  runVerificationCycle,
  runLearningCycle,
  runAuditCycle,
  runImpulseCycle
} = require('../tasks/velasScheduler');

const router = express.Router();
const CRON_SECRET = process.env.CRON_SECRET || crypto.randomBytes(24).toString('hex');
if (!process.env.CRON_SECRET) {
  console.warn('[CRON] CRON_SECRET not set. Using random default; set CRON_SECRET for production.');
}

function checkSecret(req, res) {
  if (!CRON_SECRET) {
    res.status(500).json({ ok: false, error: 'CRON_SECRET not configured' });
    return false;
  }
  const provided = req.header('x-cron-secret') || req.query.cron_secret;
  if (!provided || provided !== CRON_SECRET) {
    res.status(403).json({ ok: false, error: 'Forbidden' });
    return false;
  }
  return true;
}

router.post('/internal/cron/velas/predictions', async (req, res) => {
  if (!checkSecret(req, res)) return;
  await runPredictionCycle();
  res.json({ ok: true });
});

router.post('/internal/cron/velas/prealerts', async (req, res) => {
  if (!checkSecret(req, res)) return;
  console.log('[CRON] runPreAlertCycle triggered via velas-prealerts');
  res.status(202).json({ ok: true, source: 'scheduler', job: 'velas-prealerts', accepted: true });
  setImmediate(async () => {
    try {
      const summary = await runPreAlertCycle();
      if (summary?.skipped) {
        console.warn('[CRON] prealert cycle skipped', summary);
      }
    } catch (err) {
      console.error('[CRON] prealert cycle failed', err?.message || err);
    }
  });
});

router.get('/internal/cron/predict', async (req, res) => {
  if (!checkSecret(req, res)) return;
  console.log('[CRON] runPreAlertCycle triggered via /internal/cron/predict');
  res.status(202).json({ ok: true, source: 'scheduler', job: 'predict', accepted: true });
  setImmediate(async () => {
    try {
      const summary = await runPreAlertCycle();
      if (summary?.skipped) {
        console.warn('[CRON] prealert cycle skipped', summary);
      }
    } catch (err) {
      console.error('[CRON] prealert cycle failed', err?.message || err);
    }
  });
});

router.post('/internal/cron/binance/position-manager', async (req, res) => {
  if (!checkSecret(req, res)) return;
  await runBinanceManagerCycle();
  res.json({ ok: true, source: 'scheduler', job: 'binance-position-manager' });
});

router.post('/internal/cron/velas/verifications', async (req, res) => {
  if (!checkSecret(req, res)) return;
  await runVerificationCycle();
  res.json({ ok: true });
});

router.post('/internal/cron/velas/learning', async (req, res) => {
  if (!checkSecret(req, res)) return;
  await runLearningCycle();
  res.json({ ok: true });
});

router.post('/internal/cron/velas/audit', async (req, res) => {
  if (!checkSecret(req, res)) return;
  await runAuditCycle();
  res.json({ ok: true });
});

router.post('/internal/cron/velas/impulse-cycle', async (req, res) => {
  if (!checkSecret(req, res)) return;
  console.log('[CRON] runImpulseCycle triggered via /internal/cron/velas/impulse-cycle');
  res.status(202).json({ ok: true, source: 'scheduler', job: 'velas-impulse-cycle', accepted: true });
  setImmediate(async () => {
    try {
      const summary = await runImpulseCycle();
      console.log('[CRON] impulse-cycle result', summary);
    } catch (err) {
      console.error('[CRON] impulse-cycle failed', err?.message || err);
    }
  });
});

router.post('/internal/cron/velas/full-cycle', async (req, res) => {
  if (!checkSecret(req, res)) return;
  const payload = { ok: true, source: 'scheduler', job: 'velas-full-cycle' };
  res.status(200).json(payload);

  setImmediate(async () => {
    try {
      await runPredictionCycle();
      await runVerificationCycle();
      await runLearningCycle();
      await runAuditCycle();
    } catch (err) {
      console.error('[CRON] full-cycle failed', err?.message || err);
    }
  });
});

router.get('/internal/cron/health', (req, res) => {
  if (!checkSecret(req, res)) return;
  res.json({ ok: true });
});

module.exports = router;
