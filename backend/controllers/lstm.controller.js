// controllers/lstm.controller.js
const { exec } = require('child_process');
const path = require('path');
const { getFirestore, collection, addDoc, serverTimestamp } = require('firebase-admin/firestore');

exports.ejecutarLSTM = async (req, res) => {
  const symbol = req.params.symbol;
  const scriptPath = path.join(__dirname, '..', 'quantum-backend');

  exec(`py -3.9 lstm_model.py ${symbol}`, { cwd: scriptPath }, async (error, stdout, stderr) => {
    if (error) {
      console.error('❌ Error ejecutando LSTM:', error);
      return res.status(500).json({ error: 'Error en ejecución LSTM' });
    }

    try {
      const result = JSON.parse(stdout);
      const db = getFirestore();

      await addDoc(collection(db, 'consultas'), {
        simbolo: result.symbol,
        tipo: 'lstm',
        fecha: serverTimestamp(),
        estado: 'completado',
        resultado: `LSTM ejecutado correctamente`,
        precioEstimado: result.precio_estimado
      });

      res.json(result);
    } catch (e) {
      console.error('❌ Error al parsear JSON o guardar en Firestore:', stdout);
      res.status(500).json({ error: 'Error en salida o guardado LSTM' });
    }
  });
};
