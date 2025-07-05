// routes/quantum.route.js
const express = require('express');
const router = express.Router();
const { ejecutarLSTM } = require('../controllers/lstm.controller');
const { compararModelos } = require("../controllers/comparador.controller");


const { exec } = require('child_process');
const path = require('path');

// Cuántico (ya existente)
router.get('/cuantic/:symbol', (req, res) => {
  const symbol = req.params.symbol;
  const scriptPath = path.join(__dirname, '..', 'quantum-backend');

  exec(`py -3.9 cuantico.py ${symbol}`, { cwd: scriptPath }, (error, stdout, stderr) => {
    if (error) {
      console.error('❌ Error ejecutando Python:', error);
      return res.status(500).json({ error: 'Error en ejecución cuántica' });
    }

    try {
      const result = JSON.parse(stdout);
      res.json(result);
    } catch (e) {
      console.error('❌ Error al parsear JSON:', stdout);
      res.status(500).json({ error: 'Error en la salida cuántica' });
    }
  });
});


router.get('/lstm/:symbol', ejecutarLSTM);
router.get('/comparar/:symbol', compararModelos);

module.exports = router;

