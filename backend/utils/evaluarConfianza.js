exports.evaluarConfianza = (confianza) => {
  const valor = parseFloat(confianza);
  if (valor >= 90) return '📈 Alta confianza. Recomendación sólida.';
  if (valor >= 75) return '⚖️ Confianza media. Requiere seguimiento.';
  return '⚠️ Baja confianza. Se sugiere precaución o espera.';
};
