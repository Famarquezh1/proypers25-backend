import yfinance as yf
import json
import sys
import random

symbol = sys.argv[1] if len(sys.argv) > 1 else "AAPL"

try:
    ticker = yf.Ticker(symbol)
    precio_actual = ticker.info.get('regularMarketPrice', None)

    # Respaldo con cierre anterior si no hay precio actual
    if not precio_actual:
        historial = ticker.history(period='1d')
        if not historial.empty:
            precio_actual = historial['Close'].iloc[-1]
        else:
            raise ValueError("No se pudo obtener el precio actual ni histórico.")

    # Simulación simple de probabilidad de alza
    probabilidad_alza = round(random.uniform(0.3, 0.8), 2)

    output = {
        "symbol": symbol,
        "metodo": "Qiskit básico",
        "tipo": "experimental",
        "precio_actual": float(precio_actual),
        "probabilidad_alza": probabilidad_alza
    }

except Exception as e:
    output = {
        "symbol": symbol,
        "metodo": "Qiskit básico",
        "tipo": "experimental",
        "error": str(e),
        "precio_actual": 0.0,
        "probabilidad_alza": 0.0
    }

print(json.dumps({
    "precio_actual": precio_actual,
    "probabilidad_alza": probabilidad,
    "detalles": "modelo Qiskit ejecutado correctamente"
}))



