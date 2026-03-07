// backend/scripts/sim_cuantico.js
function generarDistribucion(qubits) {
  const base = 0.45 + (qubits % 3) * 0.05;
  const ajuste = Math.random() * 0.1 - 0.05;
  const probAlza = Math.min(Math.max(base + ajuste, 0.1), 0.95);
  const amplitud = Number((probAlza * (1 + qubits * 0.01)).toFixed(3));
  return {
    probabilidad_alza: Number(amplitud.toFixed(3)),
    probabilidad_baja: Number((1 - amplitud).toFixed(3)),
    coherencia: Number((Math.random() * 0.2 + 0.8).toFixed(3))
  };
}

async function simCuantico(simbolo, qubits) {
  const distribucion = generarDistribucion(qubits);
  return {
    simbolo,
    metodo: 'cuantico',
    qubits: Number(qubits),
    timestamp: new Date().toISOString(),
    estado: `Q${qubits}`,
    recomendacion: distribucion.probabilidad_alza >= 0.5 ? 'Mantener' : 'Reducción',
    ...distribucion
  };
}

module.exports = simCuantico;
