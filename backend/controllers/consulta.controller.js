const yahooFinance = require("yahoo-finance2").default;
const ti = require("technicalindicators");
const { generarSentimiento } = require("../servicios/sentimiento.service");
const { obtenerNoticiasConSentimiento } = require('../servicios/noticias.service.js');
const db = require('../firebase-admin-config');

async function obtenerConfianzaHistorica(simbolo) {
  const snapshot = await db.collection('consultas')
    .where('simbolo', '==', simbolo)
    .get();

  if (snapshot.empty) {
    return null;
  }

  let total = 0;
  let cantidad = 0;

  snapshot.forEach(doc => {
    const val = doc.data().validacion;
    if (val && typeof val.confianza === 'number') {
      total += val.confianza;
      cantidad++;
    }
  });

  return cantidad > 0 ? (total / cantidad) : null;
}

exports.procesarConsulta = async (req, res) => {
  const { simbolo, tipo } = req.body;

  try {
    const quote = await yahooFinance.quote(simbolo);
    const historial = await yahooFinance.historical(simbolo, { period1: "2023-01-01" });

    const preciosCierre = historial.map(d => d.close);
    const preciosApertura = historial.map(d => d.open);
    const preciosMax = historial.map(d => d.high);
    const preciosMin = historial.map(d => d.low);
    const volumenes = historial.map(d => d.volume);

    const precioActual = quote.regularMarketPrice;
    const rsi = ti.RSI.calculate({ values: preciosCierre, period: 14 });
    const rsiActual = rsi[rsi.length - 1];

    const dojiDetectado = historial.slice(-3).some(d => {
      const cuerpo = Math.abs(d.close - d.open);
      const rango = d.high - d.low;
      return cuerpo < rango * 0.1;
    });

    const ultimos5Dias = preciosCierre.slice(-5);
    const cambio = ((ultimos5Dias[4] - ultimos5Dias[0]) / ultimos5Dias[0]) * 100;
    const dispersion = Math.max(...ultimos5Dias) - Math.min(...ultimos5Dias);
    const confianzaCuantica = (100 - (dispersion / precioActual) * 100).toFixed(2);
    const noticias = await obtenerNoticiasConSentimiento(simbolo);
    const sentimiento = await generarSentimiento(simbolo);

    const confianzaHistorica = await obtenerConfianzaHistorica(simbolo);
    const alertaConfianza = confianzaHistorica !== null && confianzaHistorica < 0.4
      ? "⚠️ Confianza histórica baja para este símbolo."
      : "";

    let resultado = "";
    let riesgo = "🔵 Indeterminado";
    let probabilidadAlza = "";

    if (tipo === "largo") {
      if (cambio > 1) resultado = `📈 Tendencia positiva. Considera invertir. Precio actual: $${precioActual}`;
      else if (cambio < -1) resultado = `📉 Tendencia negativa. Espera mejor momento. Precio actual: $${precioActual}`;
      else resultado = `🔄 Mercado estable. No se detectan señales claras. Precio actual: $${precioActual}`;

      resultado += `\n📊 RSI actual: ${rsiActual.toFixed(2)}. ` +
        (rsiActual > 70 ? "Posible sobrecompra." : rsiActual < 30 ? "Posible sobreventa." : "Rango saludable.");
      if (dojiDetectado) resultado += ` Patrón Doji detectado.`;

      if (rsiActual < 30 && cambio < 0) riesgo = "🟢 Oportunidad de entrada";
      else if (rsiActual > 70) riesgo = "🔴 Alto riesgo (sobrecompra)";
      else if (dojiDetectado) riesgo = "🟡 Precaución (Doji detectado)";
      else riesgo = "🟢 Rango saludable";

      const pesos = {
        "Monte Carlo": 40,
        "RSI": 20,
        "Tendencia de precios": 15,
        "Doji": 10,
        "Sentimiento (noticias)": 10,
        "Análisis de sentimiento general": 5
      };

      return res.json({
        resultado,
        riesgo,
        probabilidadAlza,
        confianzaCuantica,
        indiceConfianzaCuantico: parseFloat(confianzaCuantica),
        confianzaHistorica: confianzaHistorica !== null ? confianzaHistorica.toFixed(2) : "Sin datos",
        alertaConfianza,
        sentimiento: sentimiento.texto,
        puntajeSentimiento: sentimiento.puntaje,
        noticias: noticias.articulos || [],
        pesosAnalisis: pesos
      });
    }

    if (tipo === "corto") {
      const sma50 = ti.SMA.calculate({ values: preciosCierre, period: 50 });
      const sma200 = ti.SMA.calculate({ values: preciosCierre, period: 200 });
      const sma50Actual = sma50[sma50.length - 1];
      const sma200Actual = sma200[sma200.length - 1];

      const volumenActual = volumenes[volumenes.length - 1];
      const volumenPromedio = volumenes.slice(-20).reduce((a, b) => a + b, 0) / 20;

      const precioAnterior = preciosCierre[preciosCierre.length - 2];
      const cambioCorto = ((precioActual - precioAnterior) / precioAnterior) * 100;

      const condiciones = {
        cambioNegativo: cambioCorto < -2,
        rsiAlto: rsiActual > 70,
        volumenElevado: volumenActual > volumenPromedio,
        cruceBajista: precioActual < sma50Actual && sma50Actual < sma200Actual
      };

      const cumpleVentaCorta = Object.values(condiciones).every(Boolean);

      const pesos = {
        "Cruce SMA y Volumen": 40,
        "RSI": 20,
        "Tendencia de precios": 15,
        "Monte Carlo": 10,
        "Sentimiento (noticias)": 10,
        "Análisis de sentimiento general": 5
      };

      if (cumpleVentaCorta) {
        resultado = `📉 Señal clara de venta en corto. RSI: ${rsiActual.toFixed(2)}, Volumen alto, cruce bajista. Precio actual: $${precioActual.toFixed(2)}`;
        riesgo = "🟢 Alta probabilidad de caída";
      } else if (cambioCorto > 2 || rsiActual < 50 || precioActual > sma50Actual) {
        resultado = `📈 Precio subiendo o sin señales claras. Precio actual: $${precioActual.toFixed(2)}`;
        riesgo = "🔴 Riesgo alto, mercado posiblemente alcista";
      } else {
        const detalles = Object.entries(condiciones)
          .filter(([_, v]) => !v)
          .map(([k]) => k.replace(/([A-Z])/g, ' $1').toLowerCase());

        resultado = `⏳ Señales mixtas: ${detalles.join(", ")}. Precio: $${precioActual.toFixed(2)}`;
        riesgo = "🟡 Sin confirmación completa";
      }

      return res.json({
        resultado,
        riesgo,
        confianzaHistorica: confianzaHistorica !== null ? confianzaHistorica.toFixed(2) : "Sin datos",
        alertaConfianza,
        variacionPorcentual: cambioCorto.toFixed(2) + "%",
        tendenciaVolumen: `${volumenActual} vs ${volumenPromedio.toFixed(0)}`,
        volatilidadDiaria: Math.abs(cambioCorto).toFixed(2) + "%",
        rsi: rsiActual.toFixed(2),
        resultadoExtendido: `🔍 Detalles:\n- RSI: ${rsiActual.toFixed(2)}\n- Volumen: ${volumenActual} / ${volumenPromedio.toFixed(0)}\n- SMA50: ${sma50Actual.toFixed(2)} / SMA200: ${sma200Actual.toFixed(2)}\n- Variación: ${cambioCorto.toFixed(2)}%`,
        sentimiento: sentimiento.texto,
        puntajeSentimiento: sentimiento.puntaje,
        noticias: noticias.articulos || [],
        pesosAnalisis: pesos
      });
    }

    if (tipo === "intradia") {
      const apertura = quote.regularMarketOpen;

      const pesos = {
        "Variación intradía": 50,
        "Comportamiento histórico": 25,
        "Monte Carlo": 10,
        "Sentimiento (noticias)": 10,
        "Análisis de sentimiento general": 5
      };

      if (!apertura || !precioActual) {
        return res.json({
          resultado: "⚠️ Datos incompletos. Mercado posiblemente cerrado.",
          riesgo: "⚪ Datos insuficientes",
          sentimiento: sentimiento.texto,
          puntajeSentimiento: sentimiento.puntaje,
          confianzaHistorica: confianzaHistorica !== null ? confianzaHistorica.toFixed(2) : "Sin datos",
          alertaConfianza,
          noticias: noticias.articulos || [],
          pesosAnalisis: pesos
        });
      }

      const variacion = ((precioActual - apertura) / apertura) * 100;
      if (variacion > 1.5) {
        resultado = `📈 Intradía en alza (+${variacion.toFixed(2)}%)`;
        riesgo = "🟢 Potencial alza rápida";
      } else if (variacion < -1.5) {
        resultado = `📉 Intradía en baja (${variacion.toFixed(2)}%)`;
        riesgo = "🔴 Riesgo de caída rápida";
      } else {
        resultado = `🔁 Movimiento lateral. Precio actual: $${precioActual}`;
        riesgo = "🟡 Sin señales claras";
      }

      const ultimos20 = historial.slice(-20);
      let casos = 0, exitos = 0;
      for (const d of ultimos20) {
        const v = ((d.close - d.open) / d.open) * 100;
        if (Math.abs(v) > 0.5) {
          casos++;
          if (v > 0) exitos++;
        }
      }

      if (casos > 0) {
        const probabilidad = (exitos / casos) * 100;
        probabilidadAlza = `🧠 En ${exitos}/${casos} días intradía, hubo cierre al alza. Probabilidad: ${probabilidad.toFixed(1)}%`;
      }

      return res.json({
        resultado,
        riesgo,
        probabilidadAlza,
        confianzaHistorica: confianzaHistorica !== null ? confianzaHistorica.toFixed(2) : "Sin datos",
        alertaConfianza,
        sentimiento: sentimiento.texto,
        puntajeSentimiento: sentimiento.puntaje,
        noticias: noticias.articulos || [],
        pesosAnalisis: pesos
      });
    }

    return res.json({ resultado: `❓ Tipo de consulta no reconocido: ${tipo}`, riesgo, sentimiento });

  } catch (error) {
    console.error("❌ Error en /api/consultar:", error);
    res.status(500).json({ error: "Error al procesar la consulta financiera." });
  }
};


