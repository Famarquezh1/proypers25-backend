/**
 * PROPUESTA: execution_decision_snapshot
 *
 * Este archivo documenta la estructura y uso recomendado del snapshot
 * para mejorar trazabilidad de decisiones ejecutor.
 *
 * NO ES CÓDIGO EJECUTABLE - Solo referencia de diseño
 */

// =================================================================
// ESTRUCTURA PROPUESTA: execution_decision_snapshot
// =================================================================

/**
 * Campo a agregarse a cada documento en real_spot_positions
 *
 * Se guardaría en el momento de DECISIÓN de ejecutar:
 * - Antes de enviar orden a Binance
 * - Después de evaluar todos los filtros
 */
const EXAMPLE_SNAPSHOT = {
    // ===== DATOS DE ENTRADA (lo que se evaluó)
    execution_decision_snapshot: {

        // SCORE Y THRESHOLD
        score_at_execution: 27.98, // opportunityScore del candidato
        threshold_at_execution: 70, // config.min_opportunity_score al momento
        score_passed: false, // 27.98 >= 70? → FALSE

        // CATEGORÍA
        category_at_execution: "WATCHLIST", // candidate.category
        allowed_categories_at_execution: [
            "BREAKOUT",
            "MOMENTUM",
            "ACCUMULATION"
        ],
        category_passed: false, // WATCHLIST in allowed? → FALSE

        // CAPITAL
        capital_required: 15, // max_position_usdt
        capital_available: 25, // calculated from exposure
        capital_passed: true, // 15 <= 25? → TRUE

        // RESULTADO FINAL
        validation_passed: false, // AND(score, category, capital) = FALSE
        reason: "Score 27.98 < threshold 70 AND Category WATCHLIST not allowed",

        // ===== CONTEXTO (quién y cómo decidió)
        source: "binanceSpotRealExecutor.js", // Módulo que evaluó
        config_id: "real_spot_config/control", // Qué config se consultó
        decision_timestamp: "2026-05-11T15:50:17Z",

        // ===== TRAZABILIDAD (origen de la orden)
        is_forced: false, // ¿Manual override?
        is_by_intent: false, // ¿Vino de intent? (XECUSDT = false)
        intent_id: null, // Si aplica

        decided_by: "system", // "system", "manual", "intent", "api"

        // ===== DEBUGGING (para análisis posterior)
        candidates_considered: 1,
        candidates_filtered: 0,
        cycle_id: "real_execution_cycle_20260511_155017",

        // ===== CONFIRMACIÓN
        order_actually_placed: true, // ¿Se ejecutó a pesar de validation_passed=false?
        order_id: "1504658910",
        client_order_id: "zJDb7UTaAaUvzOXaF1vxoW"
    }
};

// =================================================================
// ANALISIS: QUE REVELARÍA ESTE SNAPSHOT
// =================================================================

/**
 * CASO 1: XECUSDT (Score 27.98, Category WATCHLIST)
 *
 * Snapshot revelaría:
 * {
 *   score_at_execution: 27.98,
 *   threshold_at_execution: 20,  // ← PRUEBA que config era diferente!
 *   score_passed: true,  // 27.98 >= 20? YES
 *   category_at_execution: "WATCHLIST",
 *   allowed_categories_at_execution: ["BREAKOUT","MOMENTUM","ACCUMULATION","WATCHLIST","..."],
 *   category_passed: true,  // WATCHLIST in allowed? YES
 *   validation_passed: true,
 *   reason: "All thresholds passed",
 *   order_actually_placed: true
 * }
 *
 * INTERPRETACIÓN:
 * ✓ XECUSDT fue evaluado CORRECTAMENTE para la config de ese momento
 * ✓ Config era: min_score ~20, allowed WATCHLIST
 * ✓ NO es anomalía, es INCONSISTENCIA temporal entre config antigua y nueva
 */

/**
 * CASO 2: CATIUSDT (Score 62.48, Category NEW_OR_LOW_PRICE)
 *
 * Snapshot revelaría:
 * {
 *   score_at_execution: 62.48,
 *   threshold_at_execution: 60,  // ← Config anterior permitía hasta 60
 *   score_passed: true,  // 62.48 >= 60? YES (barely)
 *   category_at_execution: "NEW_OR_LOW_PRICE",
 *   allowed_categories_at_execution: ["BREAKOUT","MOMENTUM","ACCUMULATION","NEW_OR_LOW_PRICE"],
 *   category_passed: true,  // NEW_OR_LOW_PRICE in allowed? YES
 *   validation_passed: true,
 *   reason: "All thresholds passed (marginal score pass)",
 *   is_by_intent: true,  // Fue via intent
 *   intent_id: "real_spot_intent_spot_scan_1778705104518_CATIUSDT"
 * }
 *
 * INTERPRETACIÓN:
 * ✓ CATIUSDT fue marginal pero pasó config anterior
 * ✓ Config actual (min=70) lo rechazaría
 * ✓ Explica por qué intent fue creado pero execution parece "anómala"
 * ✓ NO es bug, es TIMING: intent creado con config X, ejecutado con config X,
 *   pero ahora comparamos con config Y
 */

// =================================================================
// IMPLEMENTACIÓN SUGERIDA (PSEUDOCÓDIGO)
// =================================================================

/*
En binanceSpotRealExecutor.js, función findBestRealSpotCandidate():

async function findBestRealSpotCandidate(db, config) {
  // ... código existente de filtrado ...

  const candidate = candidateFiltered[0];

  // NEW: Capturar snapshot JUSTO ANTES de ejecutar
  const executionSnapshot = {
    score_at_execution: Number(candidate.opportunityScore || 0),
    threshold_at_execution: Number(config.min_opportunity_score || 0),
    score_passed: candidate.opportunityScore >= config.min_opportunity_score,

    category_at_execution: candidate.category,
    allowed_categories_at_execution: config.allowed_categories,
    category_passed: config.allowed_categories.includes(candidate.category),

    capital_required: config.max_position_usdt,
    capital_available: availableCapital,
    capital_passed: availableCapital >= config.max_position_usdt,

    validation_passed:
      candidate.opportunityScore >= config.min_opportunity_score &&
      config.allowed_categories.includes(candidate.category) &&
      availableCapital >= config.max_position_usdt,

    reason: buildDecisionReason(candidate, config),
    source: "binanceSpotRealExecutor.js",
    config_id: "real_spot_config/control",
    decision_timestamp: new Date().toISOString(),

    is_forced: false,
    is_by_intent: !!candidate.from_intent,
    intent_id: candidate.intent_id || null,
    decided_by: "system"
  };

  // En runRealSpotExecutionCycle(), al guardar position:
  await db.collection(REAL_SPOT_POSITIONS_COLLECTION).doc(positionId).set({
    // ... campos existentes ...
    execution_decision_snapshot: executionSnapshot,  // ← NUEVO
    // ... resto ...
  }, { merge: true });
}
*/

// =================================================================
// BENEFICIOS INMEDIATOS
// =================================================================

/**
 * 1. AUDITORÍA RETROSPECTIVA
 *    User: "¿Por qué ejecutó XECUSDT con score 27.98?"
 *    System: "Snapshot muestra que config en ese momento permitía min_score 20"
 *
 * 2. VALIDACIÓN DE EDGE
 *    "En los últimos 100 trades, todos pasaban validation_passed?
 *     O algunos ejecutaron con validation_passed=false?"
 *
 * 3. DEBUGGING DE ANOMALÍAS
 *    "Encontré 2 trades con validation_passed=false pero order_placed=true"
 *    → Indicaría override o bug en lógica
 *
 * 4. ANÁLISIS DE CONFIG IMPACT
 *    "¿Cuántos trades habrían sido rechazados con config nueva?"
 *    → Ejecutar query: "validation_passed WHERE config_id != current"
 *
 * 5. EVALUACIÓN DE EDGE ESTADÍSTICO
 *    "¿Los trades con validation_passed=true ganaron más que los false?"
 *    → Medir: avg PnL WHERE validation_passed=true vs false
 */

// =================================================================
// IMPLEMENTACIÓN TIMELINE
// =================================================================

/**
 * FASE 1: Inmediato (esta semana)
 * - Agregar execution_decision_snapshot a nuevas positions ejecutadas
 * - No requiere modificar positions históricas
 *
 * FASE 2: Próximas 2 semanas
 * - Ejecutar backfill: reconstruir snapshots para posiciones existentes
 *   (leyendo de candidates + config historial)
 *
 * FASE 3: Largo plazo
 * - Crear config_history collection con timestamp de cada cambio
 * - Permitir "time-travel audit": ¿qué config estaba activa en 2026-05-11?
 */

console.log(`
╔═══════════════════════════════════════════════════════════════════╗
║                                                                   ║
║  PROPUESTA: execution_decision_snapshot                          ║
║                                                                   ║
║  Objetivo: Crear trazabilidad total de decisiones ejecutor       ║
║  Status: READY TO IMPLEMENT                                      ║
║  Urgencia: BAJA (no hay bugs, solo mejora de observabilidad)     ║
║                                                                   ║
║  Beneficio: Auditoría definitiva de por qué cada trade ejecutó   ║
║                                                                   ║
╚═══════════════════════════════════════════════════════════════════╝
`);
