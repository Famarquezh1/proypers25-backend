import sys
import json
from qiskit import QuantumCircuit, Aer, execute
from datetime import datetime

def crear_circuito(qubits):
    qc = QuantumCircuit(qubits, qubits)
    for i in range(qubits):
        qc.h(i)  # superposición
    for i in range(qubits - 1):
        qc.cx(i, i + 1)  # entrelazamiento
    qc.measure(range(qubits), range(qubits))
    return qc

def analizar_resultado(counts, qubits):
    total = sum(counts.values())
    mas_probable = max(counts, key=counts.get)
    probabilidad = (counts[mas_probable] / total) * 100

    return {
        "resultado_cuantico": mas_probable,
        "probabilidad_estado": round(probabilidad, 2),
        "mediciones": counts
    }

def main():
    if len(sys.argv) < 3:
        print(json.dumps({"error": "Uso: python quantum_qn.py SIMBOLO QUBITS"}))
        return

    simbolo = sys.argv[1]
    qubits = int(sys.argv[2])

    if qubits < 1 or qubits > 20:
        print(json.dumps({"error": "Número de qubits fuera de rango (1-20)"}))
        return

    qc = crear_circuito(qubits)
    simulator = Aer.get_backend('qasm_simulator')
    job = execute(qc, simulator, shots=1024)
    result = job.result()
    counts = result.get_counts(qc)
    analisis = analizar_resultado(counts, qubits)

    output = {
        "simbolo": simbolo,
        "qubits": qubits,
        "modelo": "cuántico",
        "fecha": datetime.now().isoformat(),
        **analisis
    }

    print(json.dumps(output))

if __name__ == "__main__":
    main()
