# Diagnóstico: Campos Null en Señales (16-04-2026)

## RESUMEN EJECUTIVO

**DESCUBRIMIENTO CLAVE:** Los campos (`confidence`, `quantum`, `timing`, `direction`, `impulse`) **NO son null** en el flujo, pero el quality gate reporta falsamente que "falta:confidence,quantum,timing,direction,impulse".

---

## 1. TRAZABILIDAD DE CAMPOS

### DEBUG_EARLY_EXIT_CHECK_LEARNING (Post-Aprendizaje)

```
[DEBUG_EARLY_EXIT_CHECK_LEARNING] {
  symbol: 'ORDI-USD',
  confidence_from_learning: 0.5511,
  quantum_from_learning: 0.45812416,
  timing_from_learning: 0.5765,
  is_confidence_null: false,
  is_quantum_null: false,
  is_timing_null: false
}
```

✅ **ESTADO:** Valores NO null inmediatamente después de `applyLearningAdjustments()`

### DEBUG_FEATURES_RAW (Pre-Construcción Recomendación)

```
[DEBUG_FEATURES_RAW] {
  symbol: 'ORDI-USD',
  confidence_value: 0.5511,
  quantumScore_value: 0.45812416,
  timingScore_value: 0.5765,
  direction_value: 'neutral',
  impulse_present: false,
  signalEmitted_flag: false
}
```

✅ **ESTADO:** Todos los valores presentes justo antes de construir `recomendacion`

### DEBUG_PRE_SIGNAL_OBJECT (Pre-Quality Gate)

```
[DEBUG_PRE_SIGNAL_OBJECT] {
  symbol: 'ORDI-USD',
  has_confidence: true,
  has_quantumScore: true,
  has_timingScore: true,
  has_direction: true,
  has_impulse_present: true,
  confidence_val: 0.5511,
  quantum_val: 0.45812416,
  timing_val: 0.5765,
  direction_val: 'neutral',
  impulse_val: false
}
```

✅ **ESTADO:** Todos los campos existen y tienen valores válidos

### DEBUG_AFTER_PREDICCION (Objeto Final)

```json
{
  "confidence": 0.5173120...,
  "quantum": 0.45812416,
  "timing": 0.5765,
  "impulse": false,
  "direction": "neutral",
  "status": "suprimida",
  "signal_emitted": false,
  "suppression_reason": "low_confidence"
}
```

✅ **ESTADO:** Todos los campos presentes en objeto final retornado

---

## 2. EL MISTERIO: "missing:confidence,quantum,timing,direction,impulse"

En `decision_pre_learning` y `decision_post_learning` dentro del objeto recomendacion:

```json
"gate_reason": "missing:confidence,quantum,timing,direction,impulse"
```

### ANÁLISIS

**Hipótesis A:** El quality gate está evaluando incorrectamente si los campos existen
- Los campos EXISTEN (confirmado por todos los logs)
- Pero se reporta "missing" como razón de rechazo

**Hipótesis B:** El normalizador (normalizeQualityGateInput) tiene lógica defensiva incorrecta
- Convierte valores a 0 si faltan, luego los evalúa como "missing"
- Esto causa un falso positivo

**Hipótesis C:** El control de validación pre-gate tiene una condición demasiado estricta
- Valida existencia con reglas que reportan "missing" incluso cuando existen

---

## 3. FLUJO COMPLETO (CONFIRMADO POR LOGS)

```
learningResult.confidence (0.5511)
    ↓ [no transformación]
postLearningScores.confidence (0.5511)
    ↓ [no transformación]
reweighted.confidence (aplicado reweighting)
    ↓ [usado en construcción recomendacion]
recomendacion.confidence (0.5173... ← reweighted value)
```

**TODOS LOS PASOS TIENEN VALORES NO-NULL**

---

## 4. CONCLUSIÓN

### ❌ NO ES PROBLEMA DE:
- Null propagation (Los valores propagan correctamente)
- Falta de inicialización (Todos inicializados en puntos correctos)
- Cortocircuito de flujo (Flujo completo ejecutado)

### ✅ ES PROBLEMA DE:
- **Quality Gate Validation Logic** está reportando "missing" falsamente
- La razón de rechazo es **engañosa** (dice falta pero existe)
- El bloqueo real es por **`lowConfidencePenalty`** NO por campos null

---

## 5. RECOMENDACIÓN

### Immediate Fix (ya implementado):
✅ Agregados 5 DEBUG logs estratégicos sin modificar lógica:
1. `DEBUG_EARLY_EXIT_CHECK_LEARNING` - Valida postLearningScores
2. `DEBUG_FEATURES_RAW` - Valida valores raw pre-recomendacion
3. `DEBUG_PRE_SIGNAL_OBJECT` - Valida campo-por-campo
4. `DEBUG_EARLY_EXIT` (x2) - Valida returns tempranos
5. Logs en normalizeQualityGateInput ya existentes

### Root Cause Fix (pendiente investigación):
- Investigar por qué quality gate reporta "missing" falsamente
- Revisar normalizeQualityGateInput y evaluateEventGate/evaluateTimeframeGate
- La razón real de rechazo es `lowConfidencePenalty`, no falta de campos

---

## 6. EVIDENCIA EN LOGS

```
Local Run: $env:ENABLE_BINANCE='true'; $env:LOCAL_MAX_SYMBOLS='1'; npm run local:run
Output: debug_full3.txt
Symbol: ORDI-USD, Timeframe: 5m
Mode: event-driven
Result: Signal suppressed (no emit) - reason: low_confidence (NOT missing fields)
```

---

## 7. MATRIZ DE CAMPOS

| Campo | DEBUG_FEATURES_RAW | DEBUG_PRE_SIGNAL_OBJECT | Final Recomendacion | Estado |
|-------|-------------------|------------------------|---------------------|--------|
| confidence | 0.5511 | true / 0.5511 | 0.5173 | ✅ |
| quantum | 0.4581 | true / 0.4581 | 0.4581 | ✅ |
| timing | 0.5765 | true / 0.5765 | 0.5765 | ✅ |
| direction | neutral | true / neutral | neutral | ✅ |
| impulse | false | true / false | false | ✅ |

**Conclusión:** 0% campos null en trazabilidad end-to-end.
