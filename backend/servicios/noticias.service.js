// servicios/noticias.service.js
const axios = require('axios');
const Sentiment = require('sentiment');
const sentiment = new Sentiment();

const API_KEY = 'f7ecd4aa1f6042998c784e1af808617e'; // Considera mover esto a variable de entorno

async function obtenerNoticiasConSentimiento(simbolo) {
  const url = `https://newsapi.org/v2/everything?q=${simbolo}&sortBy=publishedAt&language=en&apiKey=${API_KEY}`;

  try {
    const response = await axios.get(url);
    const articulos = response.data.articles.slice(0, 5);

    const analisis = articulos.map((art) => {
      const analisisItem = sentiment.analyze(art.title);
      return {
        titulo: art.title,
        fuente: art.source.name,
        url: art.url,
        fecha: art.publishedAt,
        sentimiento: analisisItem.comparative,
        resumen: analisisItem.comparative > 0.3
          ? 'Positivo'
          : analisisItem.comparative < -0.3
            ? 'Negativo'
            : 'Neutral'
      };
    });

    const promedio = analisis.reduce((acc, a) => acc + a.sentimiento, 0) / analisis.length;

    return {
      resumen: promedio > 0.3
        ? 'Tendencia positiva en noticias'
        : promedio < -0.3
          ? 'Noticias negativas predominan'
          : 'Sentimiento mixto o neutral',
      promedio,
      articulos: analisis
    };
  } catch (err) {
    console.error('Error al obtener noticias:', err.message);
    return { resumen: 'No se pudieron obtener noticias.', articulos: [], promedio: null };
  }
}

module.exports = { obtenerNoticiasConSentimiento };
