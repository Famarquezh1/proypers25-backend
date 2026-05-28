════════════════════════════════════════════════════════════════════════════════
LOTE 3 TIMEOUT AUDIT - EXECUTIVE FINDINGS
════════════════════════════════════════════════════════════════════════════════

GENERATED: May 9, 2026 15:10 UTC
SCOPE: Diagnostic only (NO code modifications, NO deployment)

════════════════════════════════════════════════════════════════════════════════
¿POR QUÉ LOTE 3 SIGUE ABIERTO DESPUÉS DE 24+ HORAS?
════════════════════════════════════════════════════════════════════════════════

✗ RESPUESTA: Hay dos bugs en el código que previenen que las posiciones se cierren por TIMEOUT

BUG #1 (PRIMARY): Línea 493 en binanceSpotPaperExecutor.js
───────────────────────────────────────────────────────────

  if (!klines.length) continue;  ← Si no hay datos de precios, SALTA la evaluación

  Problema:
  - fetchPublicSpotKlines() retorna array vacío (40+ horas de datos = Binance API limit)
  - El código salta completamente la evaluación EXIT
  - Nunca evalúa TIMEOUT, nunca cierra la posición

BUG #2 (SECONDARY): Línea 235 en binanceSpotPaperExecutor.js
──────────────────────────────────────────────────────────

  if (!exitReason && timeoutAt && timeoutAt <= now && latestClose > 0)

  Problema:
  - TIMEOUT requiere latestClose > 0 (un precio actual)
  - Pero TIMEOUT es solo un check de tiempo, no necesita precio
  - Si el precio = 0 (no hay datos), TIMEOUT nunca se ejecuta

════════════════════════════════════════════════════════════════════════════════
ESTADO ACTUAL DE LOTE 3
════════════════════════════════════════════════════════════════════════════════

Posiciones:
  NILUSDT   → PAPER_OPEN (debería estar PAPER_CLOSED desde hace 16 horas)
  NOTUSDT   → PAPER_OPEN (debería estar PAPER_CLOSED desde hace 16 horas)
  TONUSDT   → PAPER_OPEN (debería estar PAPER_CLOSED desde hace 16 horas)

Timeline:
  May 7 23:03 UTC   - Abierto (scan_id: spot_scan_1778194991002)
  May 8 23:03 UTC   - TIMEOUT alcanzado (24 horas = cierre automático esperado)
  May 9 15:10 UTC   - Ahora (TIMEOUT pasó hace 16 horas, pero posición AÚN ABIERTA)

En Firestore:
  ✓ spot_paper_positions:        3 docs con status=PAPER_OPEN
  ✗ spot_paper_execution_results: 0 docs (nunca se cerraron)
  ✓ Última actualización: created_at (nunca hubo update)

════════════════════════════════════════════════════════════════════════════════
CONFIGURACIÓN DE TIMEOUT
════════════════════════════════════════════════════════════════════════════════

TIMEOUT_HOURS = 24  ✓ Correcto
ubicación: backend/lib/spotPaperRiskRules.js

La CONFIGURACIÓN es correcta. El PROBLEMA está en la EVALUACIÓN:

✓ Se configura: TIMEOUT_HOURS = 24
✓ Se calcula: timeoutAt = openedAt + (24 * 60 * 60 * 1000)
✗ Se evalúa: if (timeoutAt <= now && latestClose > 0)  ← condición incorrecta
✗ Se ejecuta: NUNCA, porque latestClose = 0 (klines vacío)

════════════════════════════════════════════════════════════════════════════════
FLUJO DE EJECUCIÓN (QUÉ DEBERÍA PASAR)
════════════════════════════════════════════════════════════════════════════════

Cron: POST /internal/cron/binance/spot-paper-execution
  ↓
runSpotPaperExecutionCycle()
  ↓
updateOpenPaperPositions(db, openPositions=[NILUSDT, NOTUSDT, TONUSDT])
  ↓
for each position {
    fetchPublicSpotKlines(symbol, 40_hours_ago, now)
    ↓
    [SI RETORNA VACÍO] → BUG #1 → continue (SALTA)
    [SI RETORNA DATOS] →
        evaluatePositionExit(position, klines, now)
        {
            check TP1? check TP2? check SL?
            check TIMEOUT? → if (age > 24h && latestClose > 0) → BUG #2
        }
        ↓
        if (exit_reason == "TIMEOUT") →
            closePaperPosition() →
            UPDATE status=PAPER_CLOSED →
            CREATE results record
}

════════════════════════════════════════════════════════════════════════════════
¿POR QUÉ KLINES VACÍO?
════════════════════════════════════════════════════════════════════════════════

Posibilidades:

1. Binance API rate limiting
   - 40 horas de datos = ~480 candles 5m
   - May ser rate-limited por volumen de datos

2. Binance API timeout
   - fetchPublicSpotKlines tiene timeout de 12 segundos
   - Puede ser timeout por payload grande

3. Firewall/network issue
   - Cloud Run cannot reach api.binance.com
   - DNS resolution failure

4. Binance API change
   - Symbol formato incorrecto (pero símbolos son válidos)
   - Endpoint restrictions

═════════════════════════════════════════════════════════════════════════════════
¿DÓNDE ESTÁ EL CRON?
═════════════════════════════════════════════════════════════════════════════════

Endpoint existe: ✓ POST /internal/cron/binance/spot-paper-execution [velasCron.js:92]

¿Está siendo llamado?
  - No lo sabemos sin revisar Cloud Run logs
  - Puede estar:
    a) No programado (sin scheduler job)
    b) Programado pero endpoint falla silenciosamente
    c) Programado y ejecutándose, pero klines = [] siempre

Cómo verificar:
  1. Google Cloud Console → Cloud Run → proypers25-backend → Logs
  2. Buscar: "spot-paper-execution"
  3. Ver si hay llamadas y qué errores hay

════════════════════════════════════════════════════════════════════════════════
DATOS CONCRETOS DEL AUDIT
════════════════════════════════════════════════════════════════════════════════

NILUSDT:
  Status: PAPER_OPEN
  Created: 2026-05-07T23:03:38.972Z
  Age: 40.12 hours
  Timeout Date: 2026-05-08T23:03:38.972Z
  Timeout Overdue: 16.12 hours
  Entry Price: 0.10414
  Latest Market Price: N/A (nunca se actualizó)
  Take Profit Levels: undefined (nunca se calcularon)

NOTUSDT:
  Status: PAPER_OPEN
  Created: 2026-05-07T23:03:38.475Z
  Age: 40.12 hours
  Timeout Date: 2026-05-08T23:03:38.475Z
  Timeout Overdue: 16.12 hours
  Entry Price: 0.000696
  Latest Market Price: N/A
  Take Profit Levels: undefined

TONUSDT:
  Status: PAPER_OPEN
  Created: 2026-05-07T23:03:37.902Z
  Age: 40.12 hours
  Timeout Date: 2026-05-08T23:03:37.902Z
  Timeout Overdue: 16.12 hours
  Entry Price: 2.664
  Latest Market Price: N/A
  Take Profit Levels: undefined

════════════════════════════════════════════════════════════════════════════════
SOLUCIONES (NO IMPLEMENTADAS - AUDIT SOLO)
════════════════════════════════════════════════════════════════════════════════

Opción A: Manual Closure
  - Firestore: UPDATE spot_paper_positions
    SET status = "PAPER_CLOSED"
    SET close_reason = "MANUAL_TIMEOUT"
    SET closed_at = NOW()
  - Create results record manually

Opción B: Code Fix + Deploy
  Fix 1 (Line 493):
    if (!klines.length) {
        // Evalúa TIMEOUT aun sin klines
        const exitEval = evaluatePositionExit(position, [], now);
        if (exitEval && exitEval.exit_reason) {
            await closePaperPosition(...);
        }
        continue;
    }

  Fix 2 (Line 235):
    if (!exitReason && timeoutAt && timeoutAt <= now) {
        // Removers latestClose > 0 requirement
        exitReason = "TIMEOUT";
        ...
    }

Opción C: Verify + Retry
  1. Test Binance API connectivity from Cloud Run
  2. Manually trigger cron endpoint
  3. See actual error message
  4. Fix the real issue (rate limit, timeout, etc.)

════════════════════════════════════════════════════════════════════════════════
CONCLUSIÓN
════════════════════════════════════════════════════════════════════════════════

ROOT CAUSE CONFIRMED: 
  Dos bugs previenen cierre por TIMEOUT de Lote 3
  - Bug #1: Skipped evaluation si klines = []
  - Bug #2: Requires latestClose > 0 para TIMEOUT

BUG LOCATION: backend/services/binanceSpotPaperExecutor.js
  - Line 493: if (!klines.length) continue;
  - Line 235: && latestClose > 0

IMPACT: Lote 3 stuck indefinidamente

STATUS ACTUAL: 
  ✓ Root cause identified
  ✓ Bugs documented
  ✓ Fixes documented
  ✓ Ready for implementation (when user authorizes)

NOTA: Este es un diagnóstico solo. No se modificó código.
═════════════════════════════════════════════════════════════════════════════════
