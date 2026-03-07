// backend/scripts/sim_clasico.js
function generarProbabilidades(qubits) {
  const base = 0.4 + (qubits % 5) * 0.1;
  const ajuste = Math.random() * 0.2 - 0.1;
  const alza = Math.min(Math.max(base + ajuste, 0), 1);
  return {
    probabilidad_alza: Number(alza.toFixed(3)),
    probabilidad_baja: Number((1 - alza).toFixed(3))
  };
}

async function simClasico(simbolo, qubits) {
  const { probabilidad_alza, probabilidad_baja } = generarProbabilidades(qubits);
  return {
    simbolo,
    metodo: 'clasico',
    qubits: Number(qubits),
    timestamp: new Date().toISOString(),
    decision: probabilidad_alza >= 0.5 ? 'alza' : 'baja',
    probabilidad_alza,
    probabilidad_baja,
    notas: 'Simulación clásica aproximada'
  };
}

module.exports = simClasico;
