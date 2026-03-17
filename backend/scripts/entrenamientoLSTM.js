const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const admin = require('firebase-admin');
const db = require('../firebase-admin-config');

// Inicializa Firebase si no está inicializado
if (!admin.apps.length) {
  const serviceAccountPath = path.join(__dirname, '..', 'serviceAccountKey.json');
  const credential = fs.existsSync(serviceAccountPath)
    ? admin.credential.cert(require(serviceAccountPath))
    : admin.credential.applicationDefault();
  admin.initializeApp({
    credential
  });
}

// Detecta si usar python o python3
const getPythonCommand = () => {
  try {
    require('child_process').execSync('python3 --version');
    return 'python3';
  } catch {
    return 'python';
  }
};

const PYTHON_CMD = getPythonCommand();

async function registrarEntrenamiento(simbolo, data) {
  try {
    if (!simbolo || !data || typeof data !== 'object') {
      console.error('❌ Error al registrar entrenamiento: datos incompletos');
      return;
    }

    const sanitized = Object.entries(data).reduce((acc, [key, value]) => {
      if (value !== undefined) {
        acc[key] = value;
      }
      return acc;
    }, {});

    const entrenamientoActual = {
      simbolo,
      ...sanitized,
      timestamp: new Date().toISOString()
    };

    // Buscar el entrenamiento anterior más reciente del mismo símbolo y método
    let query = db.collection('entrenamientos').where('simbolo', '==', simbolo);
    if (sanitized.metodo !== undefined) {
      query = query.where('metodo', '==', sanitized.metodo);
    }
    const snapshot = await query.orderBy('timestamp', 'desc').limit(1).get();

    if (!snapshot.empty) {
      const anterior = snapshot.docs[0].data();
      if (
        anterior.error_entrenamiento != null &&
        sanitized.error_entrenamiento != null
      ) {
        const mejora =
          ((anterior.error_entrenamiento - sanitized.error_entrenamiento) /
            anterior.error_entrenamiento) *
          100;
        entrenamientoActual.mejora = Math.max(mejora, 0);
      }
    }

    await db.collection('entrenamientos').add(entrenamientoActual);
  } catch (e) {
    console.error(`❌ Error al registrar entrenamiento:`, e.message);
  }
}

module.exports = async function entrenarVariasVeces(simbolo = 'MSFT', intentos = 50) {
  console.log(`🧠 Entrenamiento múltiple LSTM para ${simbolo} usando ${PYTHON_CMD}`);

  const scriptPath = path.join(__dirname, '..', 'quantum-backend', 'lstm_model.py');

  for (let i = 1; i <= intentos; i++) {
    await new Promise((resolve) => {
      exec(`${PYTHON_CMD} ${scriptPath} ${simbolo}`, async (error, stdout, stderr) => {
        if (error) {
          console.error(`❌ Error en intento ${i}:`, stderr || error.message);
          return resolve();
        }

        try {
          const data = JSON.parse(stdout);
          console.log(`✔️ Intento ${i}:`, data);
          await registrarEntrenamiento(simbolo, data);
        } catch (e) {
          console.error(`❌ Error al procesar stdout:`, e.message);
        }

        resolve();
      });
    });
  }

  console.log('✅ Entrenamiento completado para', simbolo);
};





