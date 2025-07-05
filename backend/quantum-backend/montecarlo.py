# montecarlo.py corregido y blindado
import json
import sys
import numpy as np
import yfinance as yf

def obtener_datos(simbolo):
    data = yf.download(simbolo, period="6mo", interval="1d", progress=False)
    if data.empty or 'Close' not in data:
        raise ValueError(f"No se pudieron obtener datos válidos para {simbolo}")
    precios = data['Close'].dropna().values.flatten()
    if precios.size < 2:
        raise ValueError("Datos insuficientes para simular Monte Carlo")
    return precios

def simulacion_montecarlo(simbolo, precios, dias=15, simulaciones=1000):
    retornos = np.diff(np.log(precios))
    if len(retornos) == 0 or np.isnan(retornos).any():
        raise ValueError("Retornos inválidos para simulación")

    media = np.mean(retornos)
    std_dev = np.std(retornos)
    precio_inicial = precios[-1]

    resultados = []
    for _ in range(simulaciones):
        precio = precio_inicial
        for _ in range(dias):
            shock = np.random.normal(media, std_dev)
            precio *= np.exp(shock)
        resultados.append(precio)

    resultados = np.array(resultados)
    estimado = float(np.mean(resultados))
    prob_alza = 100 * np.sum(resultados > precio_inicial) / simulaciones
    min_conf = np.percentile(resultados, 5)
    max_conf = np.percentile(resultados, 95)
    porcentaje = ((estimado - precio_inicial) / precio_inicial) * 100

    return {
        "symbol": simbolo,
        "metodo": "Monte Carlo",
        "precio_estimado": round(estimado, 2),
        "probabilidad_alza": round(prob_alza, 1),
        "intervalo_confianza": [round(min_conf, 2), round(max_conf, 2)],
        "precio_actual": round(precio_inicial, 2),
        "porcentaje": round(porcentaje, 2)
    }

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Uso: py montecarlo.py <SIMBOLO>"}))
        sys.exit(1)

    simbolo = sys.argv[1]
    try:
        precios = obtener_datos(simbolo)
        resultado = simulacion_montecarlo(simbolo, precios)
        print(json.dumps(resultado, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({"error": str(e)}))


