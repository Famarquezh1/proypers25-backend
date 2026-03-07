// routes/analizar.route.js
const express = require('express');
const router = express.Router();
const simClasico = require('../scripts/sim_clasico');
const simCuantico = require('../scripts/sim_cuantico');

router.get('/analizar', async (req, res) => {
  const { codigo = 'Q0', simbolo = 'MSFT' } = req.query;

  const qubitN = parseInt(codigo.replace('Q', ''));
  if (isNaN(qubitN)) {
    return res.status(400).json({ error: 'Código inválido. Usa formato Q0, Q1, ..., Q15' });
  }

  try {
    let resultado;
    if (qubitN <= 10) {
      resultado = await simClasico(simbolo, qubitN);
      resultado.motor = 'clásico';
    } else {
      resultado = await simCuantico(simbolo, qubitN);
      resultado.motor = 'cuántico';
    }

    return res.status(200).json({ codigo, simbolo, resultado });
  } catch (error) {
    console.error(`❌ Error al procesar ${codigo}:`, error.message);
    return res.status(500).json({ error: 'Fallo durante el análisis', detalle: error.message });
  }
});

module.exports = router;
