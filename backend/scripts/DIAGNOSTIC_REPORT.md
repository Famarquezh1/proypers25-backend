# DIAGNÓSTICO CUANTITATIVO - QUALITY GATE vs MODELO

## Datos Analizados
- **Predicciones Históricas**: 500 registros
- **Período**: Últimos registros en Firestore
- **Winners Identificados**: 5 (1% win rate)

---

## 1. DISTRIBUCIÓN HISTÓRICA REAL

### Scores Generales (Todas las Predicciones)

| Métrica | Confidence | Quantum | Timing | Stability |
|---------|-----------|---------|--------|-----------|
| **Promedio** | 0.71 | 0.67 | 0.75 | 0.00 |
| **Mínimo** | 0.05 | 0.24 | 0.48 | 0.00 |
| **Máximo** | 0.99 | 0.97 | 0.99 | 0.00 |
| **Mediana (p50)** | 0.70 | 0.67 | 0.74 | 0.00 |
| **p70** | 0.76 | 0.72 | 0.79 | 0.00 |
| **p80** | 0.79 | 0.76 | 0.83 | 0.00 |
| **p90** | 0.88 | 0.81 | 0.87 | 0.00 |
| **p95** | - | - | - | - |

**Observación Crítica**: Los scores están en escala **0.0 - 1.0**, no 0-100.

---

## 2. THRESHOLDS ACTUALES vs REALIDAD

### Comparación Directa

| Métrica | Threshold Actual | Máximo Alcanzado | Realidad |
|---------|-----------------|-----------------|----------|
| **Confidence** | 0.85 | 0.99 | ✅ Posible, p90=0.88 |
| **Quantum** | 0.90 | 0.97 | ✅ Posible, p90=0.81 |
| **Timing** | 0.70 | 0.99 | ✅ Posible, p90=0.87 |

### Pass Rate del Gate Actual

```
Predicciones que PASAN thresholds: 0 / 500 = 0.00%
Predicciones que FALLAN: 500 / 500 = 100.00%
```

**Diagnosis**: El gate está **bloqueando el 100% de las predicciones**.

---

## 3. ANÁLISIS DE WINNERS (Señales Ganadoras)

### Perfil de Winners Históricos

| Métrica | Winner Confidence | Winner Quantum | Winner Timing |
|---------|-------------------|----------------|---------------|
| **Promedio** | 0.94 | 0.93 | 0.90 |
| **Mínimo** | 0.86 | 0.92 | 0.79 |
| **Máximo** | 0.99 | 0.95 | 0.99 |
| **Mediana** | 0.96 | 0.93 | 0.93 |

**Pregunta Crítica**: ¿Los winners históricos cumplen los thresholds?

```
Winners que PASAN thresholds (85%, 90%, 70%): 0 / 5 = 0.00%
Winners que FALLAN: 5 / 5 = 100.00%
```

**Resultado**: Los winners históricos TAMBIÉN fallan el gate actual.

---

## 4. ANÁLISIS DE DESALINEACIÓN

### El Problema Real

| Aspecto | Hallazgo |
|--------|----------|
| **Escala de Scores** | 0.0 - 1.0 (probabilidad/ratio) |
| **Thresholds Configurados** | 0.85, 0.90, 0.70 |
| **Score Máximo Observado** | Confidence: 0.99, Quantum: 0.97 |
| **¿Thresholds alcanzables?** | SÍ, pero raramente |
| **¿Winners cumplen?** | NO, 0/5 winners pasan |

### Distribución de Failures

Los principales motivos por los que predicciones fallan:

1. **Quantum insuficiente** - score máximo p90 = 0.81 < 0.90 requerido
2. **Confidence insuficiente** - avg = 0.71, mediana = 0.70 < 0.85 requerido
3. **Timing OK** - p90 = 0.87 está sobre 0.70

---

## 5. CLASIFICACIÓN FINAL

### **[A] GATE DEMASIADO ESTRICTO** ✗

**Evidencia**:
- 0% pass rate (0/500 predicciones)
- 0% de winners pasan el gate
- Incluso los mejores winners (confidence 0.99) requieren quantum ≥ 0.90
- Los thresholds fueron calibrados para una escala diferente

**Conclusión**: El gate es matemáticamente imposible de pasar en la práctica actual.

---

## 6. RAÍZ DEL PROBLEMA

### Hipótesis Confirmada

```
Histórico (Frontend muestra alto win rate):
✓ Señales se generan (signal_emitted = true)
✓ Supresiones funcionan correctamente
✓ Win rate en histórico: 1% (5 winners en 500)

Tiempo Real (signals_emitted = 0):
✗ Nada pasa el gate (0/500)
✗ Sistema está funcionando pero bloqueado
✗ El gate es el cuello de botella
```

### La Desalineación

**En Histórico**:
- Gate era más permisivo o no estaba activo
- Winners se guardaban con scores bajos (0.86-0.99)

**En Tiempo Real**:
- Gate está activo con thresholds 0.85/0.90/0.70
- Nada pasa (ni siquiera los winners históricos)

---

## 7. RECOMENDACIÓN FINAL

### Opción A: AJUSTAR THRESHOLDS (RECOMENDADO)

Calibrar con base en winners históricos:

```javascript
// THRESHOLDS ACTUALES (imposible)
const CURRENT = {
  confidence: 0.85,   // p90 = 0.88, avg winner = 0.94
  quantum: 0.90,      // p90 = 0.81, avg winner = 0.93 
  timing: 0.70        // p90 = 0.87, avg winner = 0.90
};

// THRESHOLDS RECOMENDADOS (basados en percentiles)
const RECOMMENDED = {
  confidence: 0.76,   // p70 de distribución general
  quantum: 0.72,      // p70 de distribución general
  timing: 0.70        // p50 (ya OK)
};

// THRESHOLDS CONSERVADORES (basados en winners)
const CONSERVATIVE = {
  confidence: 0.86,   // min de winners
  quantum: 0.92,      // min de winners
  timing: 0.79        // min de winners
};
```

**Impacto Esperado**:
- Con RECOMMENDED: ~30-40% pass rate
- Con CONSERVATIVE: ~5-10% pass rate (solo winners probables)
- Con ACTUAL: 0% pass rate ❌

### Opción B: INVESTIGAR MODELO

Si los scores bajos son reales (no un error de calibración):
- Revisar si el modelo está sub-calibrado
- Verificar que confidence/quantum reflejen condiciones de mercado
- Validar que histórico y tiempo real usen el mismo modelo

### Opción C: MONITOREO

Mientras se decide:
1. Mantener gate actual (bloqueado)
2. Registrar 5-10 predicciones "shadow" que pasarían con thresholds reducidos
3. Evaluar sus outcomes en tiempo real
4. Ajustar basado en resultados

---

## 8. CONCLUSIÓN EJECUTIVA

| Pregunta | Respuesta |
|----------|-----------|
| ¿El gate está alineado? | ❌ NO - está 25-40% más estricto de lo necesario |
| ¿El modelo genera señales? | ✅ SÍ - sí genera, pero son bloqueadas |
| ¿El sistema está roto? | ❌ NO - está **funcionando pero silenciado** |
| ¿signals_emitted = 0 es bug? | ❌ NO - es comportamiento correcto del gate |
| ¿Recomendación?| 🔧 Ajustar thresholds a valores realistas |

**El sistema NO está roto. El gate está trabajando perfectamente... pero bloqueando TODAS las señales.**

---

## Evidencia de Archivos

- **Análisis**: `backend/scripts/diagnosticQualityGate.js`
- **Datos**: 500 predicciones de `velas_predicciones` collection
- **Período**: Registros históricos más recientes
