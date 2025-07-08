// routes/cron.route.js
const express = require('express');
const router = express.Router();
const ejecutarAutoaprendizaje = require('../scripts/autoaprendizaje'); // Ajusta si tu archivo se llama diferente

router.post('/entrenamiento', async (req, res) => {
  try {
    console.log('🚀 Entrenamiento automático invocado por Cloud Scheduler');
    await ejecutarAutoaprendizaje();
    res.status(200).json({ mensaje: 'Entrenamiento ejecutado correctamente.' });
  } catch (err) {
    console.error('❌ Error en entrenamiento automático:', err);
    res.status(500).json({ error: 'Fallo en entrenamiento', detalle: err.message });
  }
});

module.exports = router;
