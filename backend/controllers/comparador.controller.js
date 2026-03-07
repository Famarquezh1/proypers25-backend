const { exec } = require('child_process');
const path = require('path');
const db = require('../firebase-admin-config');
const { simularLSTM, simularMonteCarlo } = require('../utils/modelosFallback');

exports.compararModelos = (req, res) => {
  const symbol = req.params.symbol;
  const scriptDir = path.join(__dirname, '..', 'quantum-backend');
  const pythonBin = process.env.PYTHON_BIN || 'python3';

  const ejecutarPython = (script) =>
    new Promise((resolve, reject) => {
      exec(
        `${pythonBin} ${script} ${symbol}`,
        {
          cwd: scriptDir,
          encoding: 'utf8',
          env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
        },
      (error, stdout, stderr) => {
        const trimmed = (stdout || '').trim();
        if (error) {
          console.error(`[comparador] Error en ${script}:`, stderr || error.message);
          console.error(`[comparador] STDERR: ${stderr}`);
          console.error(`[comparador] STDOUT: ${stdout}`);
          if (trimmed) {
            try {
              const result = JSON.parse(trimmed);
              result.warning = result.warning || `Error ejecutando ${script}`;
              return resolve(result);
            } catch (e) {
              console.error(`[comparador] JSON parcial fallido (${script}):`, e.message);
              // fall through to reject below
            }
          }
            return reject(`Error ejecutando ${script}`);
          }
          if (!trimmed) {
            return reject(`Salida vacia de ${script}`);
          }
          try {
            const result = JSON.parse(trimmed);
            resolve(result);
          } catch (e) {
            console.error(`[comparador] Error al parsear JSON en ${script}:`, stdout);
            reject(`Error al interpretar salida de ${script}`);
          }
        }
      );
    });

  const obtenerFallbackEntrenamiento = async (metodo) => {
    try {
      const snapshot = await db
        .collection('entrenamientos')
        .where('simbolo', '==', symbol)
        .where('metodo', '==', metodo)
        .orderBy('timestamp', 'desc')
        .limit(1)
        .get();

      if (snapshot.empty) {
        return null;
      }

      return snapshot.docs[0].data();
    } catch (error) {
      console.error(`[comparador] Error en fallback ${metodo}:`, error.message);
      return null;
    }
  };

  console.info('[comparador] iniciando comparación para', symbol);
  Promise.allSettled([
    ejecutarPython('lstm_model.py'),
    ejecutarPython('cuantico.py'),
    ejecutarPython('montecarlo.py')
  ]).then(async (resultados) => {
    const [lstmRes, cuanticoRes, montecarloRes] = resultados;

    let lstm = lstmRes.status === 'fulfilled' ? lstmRes.value : null;
    let cuantico = cuanticoRes.status === 'fulfilled' ? cuanticoRes.value : null;
    let montecarlo = montecarloRes.status === 'fulfilled' ? montecarloRes.value : null;

    if (lstm && lstm.error) {
      console.warn('[comparador] LSTM script devolvió error:', lstm.error);
      lstm = null;
    }
    if (montecarlo && montecarlo.error) {
      console.warn('[comparador] Monte Carlo script devolvió error:', montecarlo.error);
      montecarlo = null;
    }

    if (!lstm) {
      const fallback = await obtenerFallbackEntrenamiento('LSTM');
      if (fallback) {
        console.info('[comparador] Usando fallback Firestore LSTM para', symbol);
        lstm = fallback;
      } else {
        console.info('[comparador] Ejecutando fallback simularLSTM para', symbol);
        try {
          lstm = await simularLSTM(symbol);
        } catch (fallbackError) {
          console.error('[comparador] Fallback LSTM fallido:', fallbackError.message);
          lstm = { error: `LSTM sin datos disponibles (${fallbackError.message})` };
        }
      }
      if (!lstm) {
        lstm = { error: lstmRes.reason || 'LSTM sin datos disponibles' };
      }
    }

    if (!montecarlo) {
      const fallback =
        (await obtenerFallbackEntrenamiento('Monte Carlo')) ||
        (await obtenerFallbackEntrenamiento('MonteCarlo'));
      if (fallback) {
        console.info('[comparador] Usando fallback Firestore Monte Carlo para', symbol);
        montecarlo = fallback;
      } else {
        console.info('[comparador] Ejecutando fallback simularMonteCarlo para', symbol);
        try {
          montecarlo = await simularMonteCarlo(symbol);
        } catch (fallbackError) {
          console.error('[comparador] Fallback Monte Carlo fallido:', fallbackError.message);
          montecarlo = { error: `Monte Carlo sin datos disponibles (${fallbackError.message})` };
        }
      }
      if (!montecarlo) {
        montecarlo = { error: montecarloRes.reason || 'Monte Carlo sin datos disponibles' };
      }
    }

    if (!cuantico) {
      cuantico = { error: cuanticoRes.reason || 'Qiskit sin datos disponibles' };
    }

    res.json({
      comparacion: {
        LSTM: lstm,
        Qiskit: cuantico,
        MonteCarlo: montecarlo
      }
    });
  });
};
