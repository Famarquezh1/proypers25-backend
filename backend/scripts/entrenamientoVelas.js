const { exec } = require('child_process');
const path = require('path');
const admin = require('firebase-admin');
const db = require('../firebase-admin-config');

if (!admin.apps.length) {
  const serviceAccount = require('../serviceAccountKey.json');
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

const PYTHON_CMD = 'python';

async function registrarPrediccion(simbolo, rawData) {
  if (!simbolo || !rawData || typeof rawData !== 'object') {
    throw new Error('Datos faltantes para guardar predicción.');
  }

  const data = Object.entries(rawData).reduce((acc, [key, value]) => {
    if (value !== undefined && value !== null) {
      acc[key] = value;
    }
    return acc;
  }, {});

  const coleccion = db.collection('entrenamientos');
  const snapshot = await coleccion
    .where('simbolo', '==', simbolo)
    .where('tipo', '==', 'velas')
    .orderBy('timestamp', 'desc')
    .limit(1)
    .get();

  let mejora = null;
  if (!snapshot.empty) {
    const anterior = snapshot.docs[0].data();
    if (typeof anterior.error === 'number' && typeof data.error === 'number') {
      mejora = anterior.error - data.error;
    }
  }

  const doc = {
    simbolo,
    tipo: 'velas',
    mejora,
    timestamp: new Date().toISOString(),
    ...data
  };

  const ref = await coleccion.add(doc);
  console.log(`[Firestore] ${simbolo} guardado con ID ${ref.id}`);
  return { id: ref.id, data: doc };
}

async function ejecutaScript(simbolo = 'BTC-USD') {
  const scriptPath = path.join(__dirname, '..', 'quantum-backend', 'lstm_velas.py');
  return new Promise((resolve, reject) => {
    exec(`${PYTHON_CMD} ${scriptPath} ${simbolo}`, async (error, stdout, stderr) => {
      console.log(`[Python] ${simbolo} stdout:`, stdout);
      if (error) {
        console.error(`[Python] ${simbolo} stderr:`, stderr || error.message);
        return reject(stderr || error.message);
      }
      try {
        const parsed = JSON.parse(stdout);
        if (parsed.error) {
          return reject(parsed.error);
        }
        resolve(parsed);
      } catch (e) {
        reject(e);
      }
    });
  });
}

async function entrenarVelas(simbolo = 'BTC-USD') {
  const resultado = await ejecutaScript(simbolo);
  const guardado = await registrarPrediccion(simbolo, resultado);
  return guardado;
}

module.exports = entrenarVelas;

if (require.main === module) {
  const simbolo = process.argv[2] || 'BTC-USD';
  entrenarVelas(simbolo)
    .then(() => console.log(`${simbolo} entrenado.`))
    .catch(err => {
      console.error(`Error entrenando ${simbolo}:`, err);
    });
}
