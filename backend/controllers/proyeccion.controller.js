const yahooFinance = require("yahoo-finance2").default;
const { evaluarConfianza } = require("../utils/evaluarConfianza");

exports.calcularProyeccion = async (req, res) => {
  const symbol = req.params.symbol;

  try {
    const historial = await yahooFinance.historical(symbol, {
      period1: "2023-01-01",
    });

    const preciosCierre = historial.map((d) => d.close);
    if (preciosCierre.length < 30) {
      return res.status(400).json({ error: "Datos insuficientes para proyección." });
    }

    const dias = 15;
    const simulaciones = 1000;
    const ultimoPrecio = preciosCierre[preciosCierre.length - 1];

    const retornos = preciosCierre.slice(1).map((c, i) => Math.log(c / preciosCierre[i]));
    const media = retornos.reduce((a, b) => a + b, 0) / retornos.length;
    const desviacion = Math.sqrt(
      retornos.map((r) => Math.pow(r - media, 2)).reduce((a, b) => a + b, 0) /
        retornos.length
    );

    const resultados = [];

    for (let i = 0; i < simulaciones; i++) {
      let precio = ultimoPrecio;
      for (let d = 0; d < dias; d++) {
        const cambio = Math.exp(media + desviacion * normalAleatorio());
        precio *= cambio;
      }
      resultados.push(precio);
    }

    const mediaProyeccion = promedio(resultados);
    const intervalo = [
      Math.min(...resultados).toFixed(2),
      Math.max(...resultados).toFixed(2),
    ];
    const dispersion = intervalo[1] - intervalo[0];
    const confianzaCuantica = (100 - (dispersion / mediaProyeccion) * 100).toFixed(2);
    const mensajeConfianza = evaluarConfianza(confianzaCuantica);

    const probabilidadAlza =
      (resultados.filter((p) => p > ultimoPrecio).length / simulaciones) * 100;

    res.json({
      symbol,
      metodo: "Simulación Monte Carlo",
      proyeccion: `Probabilidad de alza del ${probabilidadAlza.toFixed(1)}% en ${dias} días`,
      precio_estimado: mediaProyeccion.toFixed(2),
      intervalo_confianza: intervalo,
      simulaciones: resultados.map((p) => Number(p.toFixed(2))),
      confianza_cuantica: `${confianzaCuantica}%`,
      mensaje_confianza: mensajeConfianza,
    });

  } catch (error) {
    console.error("❌ Error en proyección:", error);
    res.status(500).json({ error: "Error al calcular proyección." });
  }
};

function normalAleatorio() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

function promedio(arr) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}
