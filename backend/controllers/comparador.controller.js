const { exec } = require('child_process');
const path = require('path');

exports.compararModelos = (req, res) => {
  const symbol = req.params.symbol;
  const scriptDir = path.join(__dirname, '..', 'quantum-backend');

  const ejecutarPython = (script) =>
    new Promise((resolve, reject) => {
      exec(`py -3.9 ${script} ${symbol}`, { cwd: scriptDir, encoding: 'utf8' }, (error, stdout, stderr) => {
        if (error) {
          console.error(`❌ Error en ${script}:`, stderr || error.message);
          return reject(`Error ejecutando ${script}`);
        }
        try {
          const result = JSON.parse(stdout);
          resolve(result);
        } catch (e) {
          console.error(`❌ Error al parsear JSON en ${script}:`, stdout);
          reject(`Error al interpretar salida de ${script}`);
        }
      });
    });

  Promise.all([
    ejecutarPython('lstm_model.py'),
    ejecutarPython('cuantico.py'),
    ejecutarPython('montecarlo.py')
  ])
    .then(([lstm, cuantico, montecarlo]) => {
      res.json({
        comparacion: {
          LSTM: lstm,
          Qiskit: cuantico,
          MonteCarlo: montecarlo
        }
      });
    })
    .catch(error => {
      res.status(500).json({ error });
    });
};
