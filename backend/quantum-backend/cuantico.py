# cuantico.py
import yfinance as yf
import sys
import json
from qiskit import QuantumCircuit, Aer, execute

symbol = sys.argv[1] if len(sys.argv) > 1 else "AAPL"

qc = QuantumCircuit(1, 1)
qc.h(0)
qc.measure(0, 0)

backend = Aer.get_backend('qasm_simulator')
job = execute(qc, backend, shots=1000)
result = job.result()
counts = result.get_counts()

prob_1 = counts.get('1', 0) / 1000
porcentaje = prob_1 * 10

precio_actual = yf.Ticker(symbol).info.get('regularMarketPrice', None)

output = {
    "symbol": symbol,
    "metodo": "Qiskit básico",
    "tipo": "experimental",
    "probabilidad_alza": round(prob_1 * 100, 2),
    "porcentaje": round(porcentaje, 2),
    "precio_actual": round(float(precio_actual), 2) if precio_actual else None
}

print(json.dumps(output))

