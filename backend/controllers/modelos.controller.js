// controllers/modelos.controller.js
const fs = require('fs');
const path = require('path');

exports.listarModelos = (req, res) => {
  const dir = path.join(__dirname, '..', 'modelos_lstm');
  if (!fs.existsSync(dir)) return res.json([]);

  const modelos = fs.readdirSync(dir)
    .filter(file => file.endsWith('.h5'))
    .map(file => file.replace('.h5', ''));

  res.json(modelos);
};
