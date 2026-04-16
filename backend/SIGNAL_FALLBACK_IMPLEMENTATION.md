# Signal Fallback Implementation (16-04-2026)

## OBJETIVO ALCANZADO

Se implementó un fallback controlado que asegura que **SIEMPRE existe una estructura de señal (objeto con confidence, quantum, timing, direction, impulse) cuando hay scores válidos**, independientemente de si pasó o no el quality gate.

---

## 1. CAMBIOS REALIZADOS

### Ubicación: backend/scripts/prediccionVelas.js (línea ~1550)

**ANTES:**
```javascript
const recomendacion = {
  // ... construcción directa sin validación de signal
```

**DESPUÉS:**
```javascript
// FALLBACK: Ensure signal structure always exists if scores are valid
let predictedSignal = null;
if (
  Number.isFinite(postLearningScores.confidence) &&
  Number.isFinite(postLearningScores.quantumScore) &&
  Number.isFinite(postLearningScores.timingScore)
) {
  predictedSignal = {
    confidence: postLearningScores.confidence,
    quantum: postLearningScores.quantumScore,
    timing: postLearningScores.timingScore,
    direction: direction || 'neutral',
    impulse: impulse_present || false,
    source: signalEmitted ? 'gate' : 'fallback'
  };

  console.log('[DEBUG_SIGNAL_FALLBACK_CREATED]', {
    symbol: symbolInput,
    signal_source: predictedSignal.source,
    confidence: predictedSignal.confidence,
    quantum: predictedSignal.quantum,
    timing: predictedSignal.timing,
    direction: predictedSignal.direction,
    impulse: predictedSignal.impulse,
    signalEmitted_flag: signalEmitted
  });
}

const recomendacion = {
  // ... construcción con valores del predictedSignal disponibles
```

---

## 2. LÓGICA DEL FALLBACK

### Condición de Activación
```
SI:
  - postLearningScores.confidence es un número finito
  - postLearningScores.quantumScore es un número finito
  - postLearningScores.timingScore es un número finito

ENTONCES:
  - Crear predictedSignal con todos los campos
  - Marcar source como 'gate' si signalEmitted=true
  - Marcar source como 'fallback' si signalEmitted=false
```

### Comportamiento
- ✅ **Siempre se construye signal si hay scores**: Evita "señales fantasma" con valores null
- ✅ **El quality gate sigue decidiendo**: signalEmitted=true/false determina si se ejecuta
- ✅ **Distinción de origen**: Campo `source` indica si viene del gate (pasó validación) o fallback (tiene datos pero no pasó gate)

---

## 3. EVIDENCIA DE FUNCIONAMIENTO

### Test: DEBUG_SIGNAL_FALLBACK_CREATED

```
[DEBUG_SIGNAL_FALLBACK_CREATED] {
  symbol: 'ORDI-USD',
  signal_source: 'fallback',
  confidence: 0.8252,        ✅ Presente
  quantum: 0.755824768,      ✅ Presente
  timing: 0.8704,            ✅ Presente
  direction: 'up',           ✅ Presente
  impulse: true,             ✅ Presente
  signalEmitted_flag: false  (no pasó gate, pero signal existe)
}
```

### Resultado Final: DEBUG_FINAL_STATE

```json
{
  "symbol": "ORDI-USD",
  "status": "suprimida",
  "has_recomendacion": true,
  "recomendacion_keys": 98,
  "quantum": 0.755824768,    ✅
  "timing": 0.8704,          ✅
  "impulse": true,           ✅
  "confidence": 0.8131,      ✅
  "direction": "up",         ✅
  "signalEmitted": false,
  "suppressionReason": "quality_gate"
}
```

**Interpretación:**
- ✅ Todos los campos están presentes con valores válidos
- ✅ signalEmitted=false significa NO se va a ejecutar (quality gate lo bloqueó)
- ✅ Pero la structure de signal EXISTE y contiene todos los datos
- ✅ suppressionReason es "quality_gate" (no "missing_fields")

---

## 4. VENTAJAS DEL FALLBACK

| Antes | Después |
|-------|---------|
| Si no pasaba gate → confidence=null, quantum=null | Si hay scores → siempre hay valores |
| Imposible analizar signals rechazadas | Puedo analizar por qué fue rechazada (gate reason) |
| Confusión entre "no hay data" vs "fue bloqueada" | Clara distinción: source='gate' vs source='fallback' |
| Quality gate mensaje vago "missing fields" | Quality gate mensaje claro: reason específico |

---

## 5. SIN CAMBIOS EN LÓGICA

✅ **Cálculos:** NO modificados
✅ **Fetch:** NO modificado
✅ **Modelo:** NO modificado
✅ **Thresholds:** NO modificados
✅ **Quality gate:** Sigue funcionando igual
✅ **Execution:** NO modificado

---

## 6. RESULTADO: SISTEMA ROBUSTO

```
Scores Calculados (confidence, quantum, timing, direction, impulse)
    ↓
¿Valores válidos?
    ├─ SI → Crear predictedSignal (fallback)
    └─ NO → predictedSignal = null
    ↓
Construir recomendacion CON valores de predictedSignal
    ↓
Quality Gate Evalúa:
    ├─ PASA (signalEmitted=true) → source='gate' → Se ejecuta trade
    └─ FALLA (signalEmitted=false) → source='fallback' → Se registra pero no ejecuta
    ↓
Result: SIEMPRE hay estructura de signal con datos
         NUNCA hay campos null cuando hay scores
         Gate decide EJECUCIÓN, no EXISTENCIA de signal
```

---

## 7. LOGS DIAGNOSTICOS

- `[DEBUG_SIGNAL_FALLBACK_CREATED]`: Muestra cuando se crea fallback, con todos los valores
- `[DEBUG_FINAL_STATE]`: Muestra estado final con presencia de campos

---

## CONCLUSIÓN

✅ **Objetivo cumplido:** Sistema SIEMPRE construye signal cuando hay scores
✅ **Quality gate preservado:** Sigue decidiendo ejecución (signalEmitted)
✅ **No hay null fields:** Todos los campos siempre presentes cuando hay datos
✅ **Código limpio:** Solo agregado fallback, SIN cambios en lógica existente
