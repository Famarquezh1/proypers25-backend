const { exec } = require('child_process');
const path = require('path');

exports.obtenerRecomendacion = (req, res) => {
  const scriptPath = path.join(__dirname, '../inversion_autonoma.js');

  exec(`node ${scriptPath}`, (error, stdout, stderr) => {
    if (error) {
      console.error('❌ Error al ejecutar el script:', stderr);
      return res.status(500).json({ error: 'Error en la recomendación' });
    }

    try {
      const resultado = JSON.parse(stdout.trim());
      res.json(resultado);
    } catch (e) {
      console.error('❌ Error al parsear JSON:', stdout);
      res.status(500).json({ error: 'Error al interpretar la respuesta' });
    }
  });
};


