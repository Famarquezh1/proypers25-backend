const verificarPrediccionVelas = require('./verificacionVelas');
const fs = require('fs');
const path = require('path');

function gatherIds(argv) {
  const ids = [];
  argv.forEach((token) => {
    if (token.startsWith('@')) {
      const filePath = token.slice(1);
      const content = fs.readFileSync(path.resolve(filePath), 'utf8');
      content
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .forEach((line) => ids.push(line));
    } else {
      ids.push(token);
    }
  });
  return ids;
}

const ids = gatherIds(process.argv.slice(2));
if (!ids.length) {
  console.error('Uso: node run-verification.js <id1> [id2 ...] | @ids.txt');
  process.exit(1);
}

async function run() {
  for (const id of ids) {
    try {
      const result = await verificarPrediccionVelas(id);
      console.log(id, '=>', result.verification?.outcome_label || 'Sin etiqueta');
    } catch (err) {
      console.error(id, 'falló:', err.message || err);
    }
  }
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Error en lote:', err);
    process.exit(1);
  });
