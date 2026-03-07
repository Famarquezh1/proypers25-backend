const express = require('express');
const router = express.Router();
const { ejecutarLSTM } = require('../controllers/lstm.controller');
const { compararModelos } = require('../controllers/comparador.controller');
const { exec } = require('child_process');
const path = require('path');
const yahooFinance = require('yahoo-finance2').default;

async function obtenerPrecio(symbol) {
  try {
    const quote = await yahooFinance.quote(symbol);
    return (
      quote?.regularMarketPrice ??
      quote?.regularMarketPreviousClose ??
      quote?.postMarketPrice ??
      null
    );
  } catch (error) {
    return null;
  }
}

function parseJsonSafe(stdout) {
  if (!stdout) return null;
  const trimmed = stdout.trim();
  try {
    return JSON.parse(trimmed);
  } catch (error) {
    const first = trimmed.indexOf('{');
    const last = trimmed.lastIndexOf('}');
    if (first !== -1 && last !== -1 && last > first) {
      try {
        return JSON.parse(trimmed.slice(first, last + 1));
      } catch (innerError) {
        return null;
      }
    }
    return null;
  }
}

async function simularCuantico(symbol, reason) {
  const precioActual = await obtenerPrecio(symbol);
  const probabilidadAlza = Number((Math.random() * 50 + 30).toFixed(2));
  return {
    symbol,
    metodo: 'cuantico simulado',
    tipo: 'simulado',
    precio_actual: precioActual ?? 0,
    probabilidad_alza: probabilidadAlza,
    warning: reason
  };
}

// Cuantico
router.get('/cuantic/:symbol', async (req, res) => {
  const rawSymbol = (req.params.symbol || '').trim();
  const symbol = rawSymbol.replace(/[^A-Za-z0-9=_.-]/g, '');
  const scriptPath = path.join(__dirname, '..', 'quantum-backend');
  const pythonBin = process.env.PYTHON_BIN || 'python3';
  const precioActual = await obtenerPrecio(symbol);
  const priceArg = Number.isFinite(precioActual) ? `${precioActual}` : '';

  exec(`${pythonBin} cuantico.py ${symbol} ${priceArg}`, { cwd: scriptPath, shell: true }, async (error, stdout, stderr) => {
    if (error) {
      console.warn('[quantum] python failed:', stderr || error.message);
      const fallback = await simularCuantico(symbol, 'python_failed');
      return res.json(fallback);
    }

    const result = parseJsonSafe(stdout);
    if (!result) {
      console.warn('[quantum] parse failed:', stdout);
      const fallback = await simularCuantico(symbol, 'parse_failed');
      return res.json(fallback);
    }

    if (result.tipo === 'error' || result.metodo === 'cuantico fallido') {
      const fallback = await simularCuantico(symbol, 'python_error');
      return res.json(fallback);
    }

    if (Number.isFinite(precioActual) && (!result.precio_actual || result.precio_actual === 0)) {
      result.precio_actual = precioActual;
    }

    return res.json(result);
  });
});

router.get('/lstm/:symbol', ejecutarLSTM);
router.get('/comparar/:symbol', compararModelos);

module.exports = router;
