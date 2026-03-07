const yahooFinance = require("yahoo-finance2").default;
const ti = require("technicalindicators");
const { generarSentimiento } = require("../servicios/sentimiento.service");
const { obtenerNoticiasConSentimiento } = require('../servicios/noticias.service.js');
const db = require('../firebase-admin-config');

const CACHE_TTL_MS = 2 * 60 * 1000;
const MAX_RETRIES = 3;
const cacheMap = new Map();
const ALPHA_VANTAGE_KEY = process.env.ALPHA_VANTAGE_KEY || null;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function obtenerQuoteConReintentos(simbolo) {
  let intentos = 0;
  while (true) {
    try {
      return await yahooFinance.quote(simbolo);
    } catch (error) {
      intentos += 1;
      console.warn(`[consulta] error quote ${simbolo} intentos ${intentos}:`, error.message);
      if (intentos >= MAX_RETRIES) {
        if (ALPHA_VANTAGE_KEY) {
          console.info(`[consulta] fallback AlphaVantage quote para ${simbolo}`);
          return await obtenerQuoteAlpha(simbolo);
        }
        throw error;
      }
      await sleep(300 * intentos);
    }
  }
}

async function obtenerHistoricoConReintentos(simbolo) {
  const cacheClave = `${simbolo.toUpperCase()}-historico`;
  const cached = cacheMap.get(cacheClave);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.data;
  }

  let intentos = 0;
  while (true) {
    try {
      const historico = await yahooFinance.historical(simbolo, { period1: "2023-01-01" });
      cacheMap.set(cacheClave, { ts: Date.now(), data: historico });
      return historico;
    } catch (error) {
      intentos += 1;
      console.warn(`[consulta] error historico ${simbolo} intentos ${intentos}:`, error.message);
      if (intentos >= MAX_RETRIES) {
        throw error;
      }
      if (ALPHA_VANTAGE_KEY) {
        console.info(`[consulta] usando AlphaVantage para ${simbolo} tras ${intentos} intentos`);
        const alfa = await obtenerHistoricoAlpha(simbolo);
        cacheMap.set(cacheClave, { ts: Date.now(), data: alfa });
        return alfa;
      }
      await sleep(500 * intentos);
    }
  }
}

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

async function obtenerHistoricoAlpha(simbolo) {
  const url = `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY_ADJUSTED&symbol=${encodeURIComponent(
    simbolo
  )}&outputsize=full&apikey=${ALPHA_VANTAGE_KEY}`;
  const response = await fetch(url);
  const data = await response.json();
  const timeseries = data["Time Series (Daily)"] || {};
  if (!Object.keys(timeseries).length) {
    throw new Error("AlphaVantage no devolvió datos");
  }
  return Object.entries(timeseries)
    .map(([date, values]) => ({
      date,
      open: Number(values["1. open"]),
      high: Number(values["2. high"]),
      low: Number(values["3. low"]),
      close: Number(values["4. close"]),
      volume: Number(values["6. volume"] || values["5. volume"])
    }))
    .sort((a, b) => new Date(a.date) - new Date(b.date));
}

async function obtenerQuoteAlpha(simbolo) {
  const historico = await obtenerHistoricoAlpha(simbolo);
  const ultimo = historico[historico.length - 1];
  return {
    regularMarketPrice: ultimo?.close || 0,
    regularMarketOpen: ultimo?.open || 0
  };
}

const HORIZONTE_LABELS = {
  intradia: "Intradia (mismo dia)",
  corto: "Corto plazo (1-3 dias)",
  largo: "Largo plazo (15/30/90 dias)"
};

function normalizarHorizonte(horizonte, tipo) {
  const valor = String(horizonte || tipo || "").toLowerCase().trim();
  if (valor === "intradia") return "intradia";
  if (valor === "corto") return "corto";
  if (valor === "largo") return "largo";
  return "largo";
}

function normalizarDireccion(direccion, horizonteFinal, tipo) {
  const valor = String(direccion || "").toLowerCase().trim();
  if (valor === "alza" || valor === "baja") {
    return valor;
  }

  if (String(tipo || "").toLowerCase().trim() === "corto") {
    return "baja";
  }

  if (horizonteFinal === "intradia") {
    return "alza";
  }

  return "alza";
}

function normalizarDiasLargo(horizonteDias) {
  const dias = Number.parseInt(horizonteDias, 10);
  if ([15, 30, 90].includes(dias)) {
    return dias;
  }
  return 30;
}

exports.procesarConsulta = async (req, res) => {
  const { simbolo, tipo, horizonte, direccion, horizonteDias } = req.body;
  const horizonteFinal = normalizarHorizonte(horizonte, tipo);
  const direccionFinal = normalizarDireccion(direccion, horizonteFinal, tipo);
  const diasLargo = horizonteFinal === "largo" ? normalizarDiasLargo(horizonteDias) : null;
  const horizonteLabel = HORIZONTE_LABELS[horizonteFinal] || "Largo plazo (15/30/90 dias)";
  let confianzaHistorica = null;
  let alertaConfianza = "";
  let sentimiento = "";
  let puntajeSentimiento = null;
  let noticias = [];
  try {
    const quote = await obtenerQuoteConReintentos(simbolo);
    const historial = await obtenerHistoricoConReintentos(simbolo);

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
    noticias = await obtenerNoticiasConSentimiento(simbolo);
    sentimiento = await generarSentimiento(simbolo);

    confianzaHistorica = await obtenerConfianzaHistorica(simbolo);
    alertaConfianza = confianzaHistorica !== null && confianzaHistorica < 0.4
      ? "Confianza historica baja para este simbolo."
      : "";

    let resultado = "";
    let riesgo = "Indeterminado";
    let probabilidadAlza = "";

    if (horizonteFinal === "largo") {
      if (cambio > 1) resultado = `Tendencia positiva. Considera invertir. Precio actual: ${precioActual}`;
      else if (cambio < -1) resultado = `Tendencia negativa. Espera mejor momento. Precio actual: ${precioActual}`;
      else resultado = `Mercado estable. No se detectan senales claras. Precio actual: ${precioActual}`;

      resultado += `\nRSI actual: ${rsiActual.toFixed(2)}. ` +
        (rsiActual > 70 ? "Posible sobrecompra." : rsiActual < 30 ? "Posible sobreventa." : "Rango saludable.");
      if (dojiDetectado) resultado += " Patron Doji detectado.";

      if (rsiActual < 30 && cambio < 0) riesgo = "Oportunidad de entrada";
      else if (rsiActual > 70) riesgo = "Alto riesgo (sobrecompra)";
      else if (dojiDetectado) riesgo = "Precaucion (Doji detectado)";
      else riesgo = "Rango saludable";

      const pesos = {
        "Monte Carlo": 40,
        "RSI": 20,
        "Tendencia de precios": 15,
        "Doji": 10,
        "Sentimiento (noticias)": 10,
        "Analisis de sentimiento general": 5
      };

      return res.json({
        resultado,
        riesgo,
        probabilidadAlza,
        horizonte: horizonteFinal,
        direccion: direccionFinal,
        horizonteDias: diasLargo,
        horizonteLabel,
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

    if (horizonteFinal === "corto") {
      const sma50 = ti.SMA.calculate({ values: preciosCierre, period: 50 });
      const sma200 = ti.SMA.calculate({ values: preciosCierre, period: 200 });
      const sma50Actual = sma50[sma50.length - 1];
      const sma200Actual = sma200[sma200.length - 1];

      const volumenActual = volumenes[volumenes.length - 1];
      const volumenPromedio = volumenes.slice(-20).reduce((a, b) => a + b, 0) / 20;

      const precioAnterior = preciosCierre[preciosCierre.length - 2];
      const cambioCorto = ((precioActual - precioAnterior) / precioAnterior) * 100;

      const condicionesBaja = {
        cambioNegativo: cambioCorto < -2,
        rsiAlto: rsiActual > 70,
        volumenElevado: volumenActual > volumenPromedio,
        cruceBajista: precioActual < sma50Actual && sma50Actual < sma200Actual
      };

      const condicionesAlza = {
        cambioPositivo: cambioCorto > 1,
        rsiBajo: rsiActual < 45,
        volumenElevado: volumenActual > volumenPromedio,
        cruceAlcista: precioActual > sma50Actual && sma50Actual > sma200Actual
      };

      const cumpleVentaCorta = Object.values(condicionesBaja).every(Boolean);
      const cumpleCompraCorta = Object.values(condicionesAlza).every(Boolean);

      const pesos = {
        "Cruce SMA y Volumen": 40,
        "RSI": 20,
        "Tendencia de precios": 15,
        "Monte Carlo": 10,
        "Sentimiento (noticias)": 10,
        "Analisis de sentimiento general": 5
      };

      if (direccionFinal === "baja") {
        if (cumpleVentaCorta) {
          resultado = `Short signal: RSI ${rsiActual.toFixed(2)}, volumen alto, cruce bajista. Precio: $${precioActual.toFixed(2)}`;
          riesgo = "Alta probabilidad de caida";
        } else if (cambioCorto > 1 || rsiActual < 55 || precioActual > sma50Actual) {
          resultado = `Senales mixtas: precio subiendo o rebote probable. Precio: $${precioActual.toFixed(2)}`;
          riesgo = "Riesgo alto de rebote";
        } else {
          const detalles = Object.entries(condicionesBaja)
            .filter(([_, v]) => !v)
            .map(([k]) => k.replace(/([A-Z])/g, " $1").toLowerCase());

          resultado = `Senales mixtas: ${detalles.join(", ")}. Precio: $${precioActual.toFixed(2)}`;
          riesgo = "Sin confirmacion completa";
        }
      } else {
        if (cumpleCompraCorta) {
          resultado = `Buy signal: RSI ${rsiActual.toFixed(2)}, volumen alto, cruce alcista. Precio: $${precioActual.toFixed(2)}`;
          riesgo = "Probabilidad de alza";
        } else if (cambioCorto < -1 || rsiActual > 60 || precioActual < sma50Actual) {
          resultado = `Senales mixtas: presion bajista o debilidad. Precio: $${precioActual.toFixed(2)}`;
          riesgo = "Riesgo de retroceso";
        } else {
          const detalles = Object.entries(condicionesAlza)
            .filter(([_, v]) => !v)
            .map(([k]) => k.replace(/([A-Z])/g, " $1").toLowerCase());

          resultado = `Senales mixtas: ${detalles.join(", ")}. Precio: $${precioActual.toFixed(2)}`;
          riesgo = "Sin confirmacion completa";
        }
      }

      return res.json({
        resultado,
        riesgo,
        horizonte: horizonteFinal,
        direccion: direccionFinal,
        horizonteDias: diasLargo,
        horizonteLabel,
        confianzaHistorica: confianzaHistorica !== null ? confianzaHistorica.toFixed(2) : "Sin datos",
        alertaConfianza,
        variacionPorcentual: cambioCorto.toFixed(2) + "%",
        tendenciaVolumen: `${volumenActual} vs ${volumenPromedio.toFixed(0)}`,
        volatilidadDiaria: Math.abs(cambioCorto).toFixed(2) + "%",
        rsi: rsiActual.toFixed(2),
        resultadoExtendido: `Detalles:\n- RSI: ${rsiActual.toFixed(2)}\n- Volumen: ${volumenActual} / ${volumenPromedio.toFixed(0)}\n- SMA50: ${sma50Actual.toFixed(2)} / SMA200: ${sma200Actual.toFixed(2)}\n- Variacion: ${cambioCorto.toFixed(2)}%`,
        sentimiento: sentimiento.texto,
        puntajeSentimiento: sentimiento.puntaje,
        noticias: noticias.articulos || [],
        pesosAnalisis: pesos
      });
    }

    if (horizonteFinal === "intradia") {
      const apertura = quote.regularMarketOpen;

      const pesos = {
        "Variacion intradia": 50,
        "Comportamiento historico": 25,
        "Monte Carlo": 10,
        "Sentimiento (noticias)": 10,
        "Analisis de sentimiento general": 5
      };

      if (!apertura || !precioActual) {
        return res.json({
          resultado: "Datos incompletos. Mercado posiblemente cerrado.",
          riesgo: "Datos insuficientes",
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
        resultado = `Intradia en alza (+${variacion.toFixed(2)}%)`;
        riesgo = "Potencial alza rapida";
      } else if (variacion < -1.5) {
        resultado = `Intradia en baja (${variacion.toFixed(2)}%)`;
        riesgo = "Riesgo de caida rapida";
      } else {
        resultado = `Movimiento lateral. Precio actual: ${precioActual}`;
        riesgo = "Sin senales claras";
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
        probabilidadAlza = `En ${exitos}/${casos} dias intradia, hubo cierre al alza. Probabilidad: ${probabilidad.toFixed(1)}%`;
      }

      return res.json({
        resultado,
        riesgo,
        horizonte: horizonteFinal,
        direccion: direccionFinal,
        horizonteDias: diasLargo,
        horizonteLabel,
        probabilidadAlza,
        confianzaHistorica: confianzaHistorica !== null ? confianzaHistorica.toFixed(2) : "Sin datos",
        alertaConfianza,
        sentimiento: sentimiento.texto,
        puntajeSentimiento: sentimiento.puntaje,
        noticias: noticias.articulos || [],
        pesosAnalisis: pesos
      });
    }

    return res.json({ resultado: `Tipo de consulta no reconocido: ${tipo}`, riesgo, sentimiento });

  } catch (error) {
    console.error("Error en /api/consultar:", error);
    const mensaje = error?.message || "Error inesperado";
    return res.json({
      resultado: `No se pudieron obtener datos financieros (${mensaje}).`,
      riesgo: "Datos insuficientes",
      horizonte: horizonteFinal,
      direccion: direccionFinal,
      horizonteDias: diasLargo,
      horizonteLabel,
      confianzaHistorica: confianzaHistorica !== null ? confianzaHistorica.toFixed(2) : "Sin datos",
      alertaConfianza,
      sentimiento: "",
      puntajeSentimiento: null,
      noticias: [],
      pesosAnalisis: {
        "Disponibilidad de datos": 100
      }
    });
  }
};




