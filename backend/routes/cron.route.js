const express = require('express');
const fs = require('fs');
const path = require('path');
const router = express.Router();

const ejecutarAutoaprendizaje = require('../scripts/autoaprendizaje');
const entrenarLSTM = require('../scripts/entrenamientoLSTM');
const entrenamientoMultiple = require('../scripts/entrenamientoMultiple');
const entrenarVelas = require('../scripts/entrenamientoVelas');
const {
  createTrainingJob,
  pullPendingJob,
  updateJobLogs,
  finalizeJob
} = require('../utils/entrenamientoQueue');

const hybridSymbols = [
  'MSFT', 'AAPL', 'GOOGL', 'AMZN', 'NVDA',
  'BTC-USD', 'ETH-USD', 'SOL-USD', 'DOGE-USD',
  'ADA-USD', 'XRP-USD', 'DOT-USD', 'LINK-USD', 'AVAX-USD', 'LTC-USD', 'HBAR-USD'
];

// Ejecuta solo autoaprendizaje
router.get('/entrenamiento', async (req, res) => {
  try {
    console.log('Autoaprendizaje invocado manualmente');
    await ejecutarAutoaprendizaje();
    res.status(200).json({ mensaje: 'Autoaprendizaje ejecutado correctamente.' });
  } catch (err) {
    console.error('Error en autoaprendizaje:', err);
    res.status(500).json({ error: 'Fallo en autoaprendizaje', detalle: err.message });
  }
});

// Entrenamiento LSTM + autoaprendizaje por símbolo
router.get('/entrenamiento-completo', async (req, res) => {
  try {
    const simbolo = req.query.simbolo || 'MSFT';
    const ciclos = parseInt(req.query.ciclos) || 50;

    console.log(`Entrenamiento completo para ${simbolo}, ciclos: ${ciclos}`);
    await entrenarLSTM(simbolo, ciclos);
    await ejecutarAutoaprendizaje();

    res.status(200).json({ mensaje: 'Entrenamiento completo ejecutado correctamente.' });
  } catch (err) {
    console.error('Error en entrenamiento completo:', err);
    res.status(500).json({ error: 'Fallo en entrenamiento completo', detalle: err.message });
  }
});

// Cron que encola el entrenamiento múltiple
router.get('/entrenamiento-multiple', async (req, res) => {
  try {
    console.log('Encolando entrenamiento múltiple híbrido');
    const jobId = await createTrainingJob(hybridSymbols, { trigger: 'scheduler' });
    console.info('Hybrid training job queued', { jobId });
    res.status(202).json({ message: 'Queued hybrid training job', jobId });
  } catch (err) {
    console.error('Error al encolar el entrenamiento múltiple:', err);
    res.status(500).json({ error: 'Fallo al encolar entrenamiento', detalle: err.message });
  }
});

// Worker que procesa la cola pendiente
router.post('/worker/process-entrenamiento', async (req, res) => {
  try {
    const job = await pullPendingJob();
    if (!job) {
      console.info('No hay jobs pendientes para procesar');
      return res.status(204).send();
    }

    console.log(`Procesando job encolado ${job.id}`);

    const logCallback = async (symbol, payload) => {
      if (!symbol || typeof payload !== 'object' || payload === null) {
        return;
      }
      await updateJobLogs(job.ref, symbol, payload);
    };

    const runTraining = async () => {
      try {
        await entrenamientoMultiple({
          symbols: job.data.symbols,
          logCallback
        });
        await finalizeJob(job.ref, { status: 'done', result: 'completed' });
        console.log('Training job finished', { jobId: job.id });
      } catch (error) {
        console.error('Error ejecutando el entrenamiento encolado:', error);
        await finalizeJob(job.ref, { status: 'failed', error: error.message });
      }
    };

    runTraining().catch(err => {
      console.error('Unexpected error en entrenamiento async:', err);
    });

    return res.status(202).json({ message: 'Training job started', jobId: job.id });
  } catch (err) {
    console.error('Error del worker:', err);
    return res.status(500).json({ error: 'Worker failed', detalle: err.message });
  }
});

// Entrenamiento de velas japonesas por símbolo (GET)
router.get('/entrenamiento-velas', async (req, res) => {
  try {
    const simbolo = req.query.simbolo || 'BTC-USD';

    console.log(`Entrenamiento de velas para ${simbolo}`);
    await entrenarVelas(simbolo);

    res.status(200).json({ mensaje: `Entrenamiento de velas ejecutado para ${simbolo}` });
  } catch (err) {
    console.error('Error en entrenamiento de velas:', err);
    res.status(500).json({ error: 'Fallo en entrenamiento de velas', detalle: err.message });
  }
});

// Lista de modelos LSTM guardados
router.get('/entrenamientos', (req, res) => {
  const modelosPath = path.join(__dirname, '..', 'modelos_lstm');

  fs.readdir(modelosPath, (err, files) => {
    if (err) {
      console.warn('Modelos LSTM no disponibles aún:', err.message);
      return res.json({ modelos: [] });
    }

    const simbolos = files
      .filter(file => file.endsWith('.json'))
      .map(file => file.replace('.json', '').toUpperCase());

    res.json({ modelos: simbolos });
  });
});

module.exports = router;
