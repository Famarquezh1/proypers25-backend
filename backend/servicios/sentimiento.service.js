// servicios/sentimiento.service.js
const Sentiment = require('sentiment');
const sentiment = new Sentiment();

const generarSentimiento = (texto) => {
  const resultado = sentiment.analyze(texto);
  const puntaje = resultado.comparative;

  let resumen = '🤖 Sentimiento neutral';
  if (puntaje > 0.3) resumen = '📈 Sentimiento positivo';
  else if (puntaje < -0.3) resumen = '📉 Sentimiento negativo';

  return {
    texto: resumen,
    puntaje
  };
};

module.exports = { generarSentimiento };

