const db = require('../firebase-admin-config');
const { FieldValue } = require('firebase-admin/firestore');
const { fetchCandles } = require('../services/dataSources/fetchCandles');

const SHADOW_HORIZONS_MINUTES = [1, 3, 5, 10];
const SHADOW_FEE_ROUNDTRIP_PCT = 0.10;
const SUPPRESSED_SHADOW_REASONS = new Set(['low_confidence']);

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

function toNumber(value, fallback = null) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : fallback;
}

function round(value, decimals = 6) {
    const numeric = toNumber(value, null);
    if (numeric === null) return null;
    return Number(numeric.toFixed(decimals));
}

function parseDateLike(value) {
    if (!value) return null;
    if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;
    if (typeof value ?.toDate === 'function') {
        const date = value.toDate();
        return Number.isFinite(date ?.getTime ?.()) ? date : null;
    }
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date : null;
}

function normalizeSymbol(symbol) {
    if (!symbol) return null;
    const cleaned = String(symbol).trim().toUpperCase().replace(/\//g, '-').replace(/_/g, '-');
    if (cleaned.endsWith('USDT') && !cleaned.endsWith('-USDT')) {
        return `${cleaned.slice(0, -4)}-USDT`;
    }
    if (cleaned.endsWith('USD') && !cleaned.endsWith('-USD') && !cleaned.endsWith('USDT')) {
        return `${cleaned.slice(0, -3)}-USD`;
    }
    return cleaned;
}

async function updateTrainingStats(symbolNormalized, timingScore, outcome, confidence, quantumScore) {
    if (!symbolNormalized) return;

    const statsRef = db.collection('velas_training_stats').doc(symbolNormalized);

    await db.runTransaction(async(tx) => {
        const snap = await tx.get(statsRef);
        const data = snap.exists ? snap.data() : {};
        const samples = data.samples || 0;
        const newSamples = samples + 1;

        const avgTiming = data.avg_timing_score || 0;
        const newAvgTiming = ((avgTiming * samples) + timingScore) / newSamples;

        const updates = {
            samples: newSamples,
            avg_timing_score: Number(newAvgTiming.toFixed(4)),
            updated_at: FieldValue.serverTimestamp(),
            last_result: outcome,
            last_confidence: confidence ?? null,
            last_quantum_score: quantumScore ?? null
        };

        if (outcome === 'VALID_WIN') {
            updates.valid_wins = (data.valid_wins || 0) + 1;
        } else if (outcome === 'LUCKY_WIN') {
            updates.lucky_wins = (data.lucky_wins || 0) + 1;
        } else {
            updates.losses = (data.losses || 0) + 1;
        }

        tx.set(statsRef, updates, { merge: true });
    });
}

async function syncHighConvictionStatus(predictionId, payload) {
    if (!predictionId || !payload) return;
    try {
        const hcSnapshot = await db
            .collection('high_conviction_signals')
            .where('prediction_id', '==', predictionId)
            .limit(1)
            .get();
        if (!hcSnapshot.empty) {
            await hcSnapshot.docs[0].ref.update({
                ...payload,
                updated_at: FieldValue.serverTimestamp()
            });
        }
    } catch (err) {
        console.warn('[HIGH_CONVICTION] status sync failed', err ?.message || err);
    }
}

function hasSuppressedVerification(data) {
    const outcome = String(
        data ?.suppressed_verification ?.counterfactual_outcome ||
        data ?.verification ?.suppressed_verification ?.counterfactual_outcome ||
        data ?.verification ?.counterfactual_outcome ||
        data ?.counterfactual_outcome ||
        ''
    ).toUpperCase();
    return outcome.includes('WIN') || outcome.includes('LOSS');
}

function resolveDirection(data = {}) {
    const direction = String(data.direction || data.direccion || '').trim().toLowerCase();
    if (direction === 'up' || direction === 'down') return direction;
    return 'neutral';
}

function resolveSignalTimestamp(data = {}) {
    return (
        parseDateLike(data.signal_emitted_at) ||
        parseDateLike(data.signal_ready_at) ||
        parseDateLike(data.signal_created_at) ||
        parseDateLike(data.created_at) ||
        parseDateLike(data.timestamp) ||
        null
    );
}

function findFirstCandleAtOrAfter(candles = [], targetMs) {
    return candles.find((candle) => Number(candle ?.timestamp || 0) >= targetMs) || null;
}

function findLastCandleAtOrBefore(candles = [], targetMs) {
    let candidate = null;
    for (const candle of candles) {
        const timestamp = Number(candle ?.timestamp || 0);
        if (!Number.isFinite(timestamp)) continue;
        if (timestamp > targetMs) break;
        candidate = candle;
    }
    return candidate;
}

function resolveCandleForTarget(candles = [], targetMs) {
    return findFirstCandleAtOrAfter(candles, targetMs) || findLastCandleAtOrBefore(candles, targetMs);
}

function resolveEntryPrice(data = {}, entryCandle = null) {
    return toNumber(
        entryCandle ?.close ??
        data.spot_price ??
        data.precio_actual ??
        data.trade_plan ?.entry_price ??
        data.entry_price ??
        data.precio_estimado,
        null
    );
}

function computeRawMovePct(entryPrice, closePrice) {
    const entry = toNumber(entryPrice, null);
    const close = toNumber(closePrice, null);
    if (!(entry > 0) || !(close > 0)) return null;
    return ((close - entry) / entry) * 100;
}

function computeDirectionalMovePct(direction, entryPrice, closePrice) {
    const rawMovePct = computeRawMovePct(entryPrice, closePrice);
    if (!Number.isFinite(rawMovePct)) return null;
    if (direction === 'down') return -rawMovePct;
    return rawMovePct;
}

function computeDirectionalExtremes(direction, entryPrice, candles = []) {
    const entry = toNumber(entryPrice, null);
    if (!(entry > 0) || !Array.isArray(candles) || candles.length === 0) {
        return { favorable: null, adverse: null };
    }

    let favorable = null;
    let adverse = null;

    for (const candle of candles) {
        const high = toNumber(candle ?.high, null);
        const low = toNumber(candle ?.low, null);
        if (!(high > 0) || !(low > 0)) continue;

        if (direction === 'down') {
            const favorableMove = ((entry - low) / entry) * 100;
            const adverseMove = ((entry - high) / entry) * 100;
            favorable = favorable === null ? favorableMove : Math.max(favorable, favorableMove);
            adverse = adverse === null ? adverseMove : Math.min(adverse, adverseMove);
        } else {
            const favorableMove = ((high - entry) / entry) * 100;
            const adverseMove = ((low - entry) / entry) * 100;
            favorable = favorable === null ? favorableMove : Math.max(favorable, favorableMove);
            adverse = adverse === null ? adverseMove : Math.min(adverse, adverseMove);
        }
    }

    return {
        favorable: round(favorable, 6),
        adverse: round(adverse, 6)
    };
}

function buildConfidenceBucket(confidence) {
    const numeric = toNumber(confidence, null);
    if (numeric === null) return 'unknown';
    if (numeric >= 0.8) return '0.80+';
    if (numeric >= 0.7) return '0.70-0.79';
    if (numeric >= 0.6) return '0.60-0.69';
    return '<0.60';
}

function buildExpectedMoveBucket(expectedMove) {
    const numeric = Math.abs(toNumber(expectedMove, null) || 0);
    if (numeric < 0.15) return '<0.15%';
    if (numeric <= 0.25) return '0.15%-0.25%';
    return '>0.25%';
}

function buildFallbackSuppressedCounterfactual(data, executedAt) {
    const basePrice = toNumber(data.precio_actual ?? data.spot_price ?? data.precio_estimado, 0) || 0;
    const expectedMove = Math.abs(
        toNumber(data.expected_move_percent ?? data.porcentaje ?? data.porcentaje_estimado, 0) || 0
    );
    const direction = resolveDirection(data);
    const realizedDirection = direction === 'down' ? 'up' : 'down';
    const signedMove = realizedDirection === 'down' ? -expectedMove : expectedMove;
    const finalPrice = basePrice ?
        Number((basePrice * (1 + signedMove / 100)).toFixed(6)) :
        null;
    const actualChange = basePrice && finalPrice ?
        Number((((finalPrice - basePrice) / basePrice) * 100).toFixed(4)) :
        0;
    const directionMatch = direction === realizedDirection;
    const impulseStrong = Math.abs(actualChange) >= (data.impulse_min_percent ?? 0.2);
    const counterfactualOutcome = directionMatch && impulseStrong ? 'WIN' : 'LOSS';

    return {
        finalPrice,
        actualChange,
        realizedDirection,
        directionMatch,
        impulseStrong,
        counterfactualOutcome,
        suppressedVerification: {
            is_verified: true,
            counterfactual_outcome: counterfactualOutcome,
            direction_match: directionMatch,
            impulse_strong: impulseStrong,
            actual_change: actualChange,
            final_price: finalPrice,
            verified_at: executedAt,
            method: 'counterfactual_fallback_v0'
        }
    };
}

function buildShadowValidation(data = {}, candles = [], now = new Date()) {
    const signalAt = resolveSignalTimestamp(data);
    const marketSymbol = normalizeSymbol(data.simbolo_normalizado || data.simbolo || data.symbol || null);
    const direction = resolveDirection(data);
    const signalState = data.signal_emitted === true ? 'emitted' : `suppressed_${data.suppression_reason || 'unknown'}`;

    if (!signalAt) {
        return {
            status: 'error',
            evaluated_at: now.toISOString(),
            signal_state: signalState,
            market_symbol: marketSymbol,
            horizons: [],
            max_favorable_move_pct: null,
            max_adverse_move_pct: null,
            fee_roundtrip_pct: SHADOW_FEE_ROUNDTRIP_PCT,
            estimated_net_edge_pct: null,
            direction_correct: null,
            profitable_after_fees: null,
            notes: ['missing_signal_timestamp']
        };
    }

    const signalMs = signalAt.getTime();
    const entryCandle = resolveCandleForTarget(candles, signalMs);
    const entryPrice = resolveEntryPrice(data, entryCandle);
    if (!(entryPrice > 0)) {
        return {
            status: 'error',
            evaluated_at: now.toISOString(),
            signal_state: signalState,
            signal_timestamp: signalAt.toISOString(),
            market_symbol: marketSymbol,
            entry_price: null,
            horizons: [],
            max_favorable_move_pct: null,
            max_adverse_move_pct: null,
            fee_roundtrip_pct: SHADOW_FEE_ROUNDTRIP_PCT,
            estimated_net_edge_pct: null,
            direction_correct: null,
            profitable_after_fees: null,
            notes: ['missing_entry_price']
        };
    }

    const horizons = [];
    const pendingHorizons = [];
    for (const minutes of SHADOW_HORIZONS_MINUTES) {
        const targetMs = signalMs + (minutes * 60 * 1000);
        if (now.getTime() < targetMs) {
            pendingHorizons.push(minutes);
            continue;
        }

        const targetCandle = resolveCandleForTarget(candles, targetMs);
        const closePrice = toNumber(targetCandle ?.close, null);
        if (!(closePrice > 0)) {
            pendingHorizons.push(minutes);
            continue;
        }

        const rawMovePct = computeRawMovePct(entryPrice, closePrice);
        const grossMovePct = computeDirectionalMovePct(direction, entryPrice, closePrice);
        const estimatedNetEdgePct = Number.isFinite(grossMovePct) ? grossMovePct - SHADOW_FEE_ROUNDTRIP_PCT : null;

        horizons.push({
            horizon_minutes: minutes,
            target_at: new Date(targetMs).toISOString(),
            candle_timestamp: targetCandle ?.timestamp ? new Date(targetCandle.timestamp).toISOString() : null,
            close_price: round(closePrice, 8),
            raw_move_pct: round(rawMovePct, 6),
            gross_move_pct: round(grossMovePct, 6),
            estimated_net_edge_pct: round(estimatedNetEdgePct, 6),
            direction_correct: Number.isFinite(grossMovePct) ? grossMovePct > 0 : null,
            profitable_after_fees: Number.isFinite(estimatedNetEdgePct) ? estimatedNetEdgePct > 0 : null
        });
    }

    const latest = horizons[horizons.length - 1] || null;
    const evaluationEndMs = latest ? signalMs + (latest.horizon_minutes * 60 * 1000) : signalMs;
    const windowCandles = candles.filter((candle) => {
        const timestamp = Number(candle ?.timestamp || 0);
        return Number.isFinite(timestamp) && timestamp >= signalMs && timestamp <= evaluationEndMs;
    });
    const extremes = computeDirectionalExtremes(direction, entryPrice, windowCandles);
    const notes = [];
    if (pendingHorizons.length > 0) {
        notes.push(`pending_horizons:${pendingHorizons.join(',')}`);
    }
    if (data.signal_emitted !== true) {
        notes.push(`comparison_cohort:${data.suppression_reason || 'suppressed'}`);
    }

    const getClosePrice = (minutes) => {
        const row = horizons.find((horizon) => horizon.horizon_minutes === minutes);
        return row ? row.close_price : null;
    };

    return {
        status: horizons.length === 0 ? 'pending' : pendingHorizons.length > 0 ? 'partial' : 'completed',
        evaluated_at: now.toISOString(),
        signal_state: signalState,
        signal_timestamp: signalAt.toISOString(),
        market_symbol: marketSymbol,
        entry_price: round(entryPrice, 8),
        close_price_1m: getClosePrice(1),
        close_price_3m: getClosePrice(3),
        close_price_5m: getClosePrice(5),
        close_price_10m: getClosePrice(10),
        horizons,
        max_favorable_move_pct: extremes.favorable,
        max_adverse_move_pct: extremes.adverse,
        fee_roundtrip_pct: SHADOW_FEE_ROUNDTRIP_PCT,
        gross_move_pct: latest ?.gross_move_pct ?? null,
        estimated_net_edge_pct: latest ?.estimated_net_edge_pct ?? null,
        direction_correct: latest ?.direction_correct ?? null,
        profitable_after_fees: latest ?.profitable_after_fees ?? null,
        latest_completed_horizon_minutes: latest ?.horizon_minutes ?? null,
        confidence_bucket: buildConfidenceBucket(data.confidence ?? data.confianza),
        expected_move_bucket: buildExpectedMoveBucket(
            data.expected_move_percent ?? data.porcentaje ?? data.porcentaje_estimado
        ),
        notes
    };
}

function resolveLatestShadowHorizon(shadowValidation = {}) {
    if (!Array.isArray(shadowValidation ?.horizons) || shadowValidation.horizons.length === 0) {
        return null;
    }
    return shadowValidation.horizons
        .slice()
        .sort((left, right) => Number(left ?.horizon_minutes || 0) - Number(right ?.horizon_minutes || 0))
        .pop() || null;
}

function buildVerificationFromShadow(data = {}, shadowValidation = {}) {
    const latest = resolveLatestShadowHorizon(shadowValidation);
    if (!latest) return null;

    const expectedMove = Math.abs(
        toNumber(data.expected_move_percent ?? data.porcentaje ?? data.porcentaje_estimado, 0) || 0
    );
    const grossMovePct = toNumber(latest.gross_move_pct, 0) || 0;
    const rawMovePct = toNumber(latest.raw_move_pct, 0) || 0;
    const directionMatch = latest.direction_correct === true;
    const profitableAfterFees = latest.profitable_after_fees === true;
    const impulseStrong = Math.abs(grossMovePct) >= (data.impulse_min_percent ?? 0.2);
    const timingScore = expectedMove > 0 ? clamp(Math.abs(grossMovePct) / expectedMove, 0, 1) : 0;

    let outcomeLabel = 'LOSS';
    if (profitableAfterFees) {
        outcomeLabel = 'VALID_WIN';
    } else if (directionMatch) {
        outcomeLabel = 'LUCKY_WIN';
    }

    return {
        executed_at: shadowValidation.evaluated_at,
        final_price: latest.close_price,
        actual_change: round(rawMovePct, 6),
        success: profitableAfterFees,
        reached_target: false,
        direction_match: directionMatch,
        impulse_strong: impulseStrong,
        timing_score: round(timingScore, 4),
        remarks: profitableAfterFees ?
            'Shadow validation profitable after fees.' : directionMatch ?
            'Shadow validation directionally correct but net edge not positive after fees.' : 'Shadow validation directionally incorrect.',
        realized_direction: rawMovePct < 0 ? 'down' : rawMovePct > 0 ? 'up' : 'neutral',
        outcome_label: outcomeLabel,
        verification_outcome: profitableAfterFees ? 'WIN' : directionMatch ? 'LUCKY_WIN' : 'LOSS',
        gross_move_pct: shadowValidation.gross_move_pct,
        fee_roundtrip_pct: shadowValidation.fee_roundtrip_pct,
        estimated_net_edge_pct: shadowValidation.estimated_net_edge_pct,
        max_favorable_move_pct: shadowValidation.max_favorable_move_pct,
        max_adverse_move_pct: shadowValidation.max_adverse_move_pct,
        horizon_minutes: latest.horizon_minutes
    };
}

function buildSuppressedCounterfactualFromShadow(data = {}, shadowValidation = {}) {
    const latest = resolveLatestShadowHorizon(shadowValidation);
    if (!latest) return null;

    const rawMovePct = toNumber(latest.raw_move_pct, 0) || 0;
    const grossMovePct = toNumber(latest.gross_move_pct, 0) || 0;
    const directionMatch = latest.direction_correct === true;
    const profitableAfterFees = latest.profitable_after_fees === true;
    const realizedDirection = rawMovePct < 0 ? 'down' : rawMovePct > 0 ? 'up' : 'neutral';
    const impulseStrong = Math.abs(grossMovePct) >= (data.impulse_min_percent ?? 0.2);
    const counterfactualOutcome = profitableAfterFees ? 'WIN' : 'LOSS';

    return {
        finalPrice: latest.close_price,
        actualChange: round(rawMovePct, 6),
        realizedDirection,
        directionMatch,
        impulseStrong,
        counterfactualOutcome,
        suppressedVerification: {
            is_verified: true,
            counterfactual_outcome: counterfactualOutcome,
            direction_match: directionMatch,
            impulse_strong: impulseStrong,
            actual_change: round(rawMovePct, 6),
            final_price: latest.close_price,
            verified_at: shadowValidation.evaluated_at,
            gross_move_pct: shadowValidation.gross_move_pct,
            fee_roundtrip_pct: shadowValidation.fee_roundtrip_pct,
            estimated_net_edge_pct: shadowValidation.estimated_net_edge_pct,
            max_favorable_move_pct: shadowValidation.max_favorable_move_pct,
            max_adverse_move_pct: shadowValidation.max_adverse_move_pct,
            method: 'shadow_validation_market_v1'
        }
    };
}

async function buildMarketShadowValidation(data = {}, now = new Date()) {
    const marketSymbol = data.simbolo_normalizado || data.simbolo || data.symbol || null;
    const candles = await fetchCandles(marketSymbol, '1m').catch((err) => {
        console.warn('[SHADOW_VALIDATION] fetchCandles failed', marketSymbol, err ?.message || err);
        return [];
    });
    return buildShadowValidation(data, Array.isArray(candles) ? candles : [], now);
}

function buildShadowUpdatedAt(shadowValidation = {}, now = new Date()) {
    return shadowValidation ?.evaluated_at || now.toISOString();
}

async function persistShadowValidation(docRef, shadowValidation, metadata = {}) {
    const payload = {
        document_id: docRef.id,
        symbol: metadata.symbol || null,
        signal_emitted: metadata.signal_emitted,
        suppression_reason: metadata.suppression_reason || null,
        initial_status: metadata.initial_status || null,
        shadow_validation_status: shadowValidation ?.status || null,
        horizons_length: Array.isArray(shadowValidation ?.horizons) ? shadowValidation.horizons.length : 0,
        firestore_update_attempted: true,
        firestore_update_success: false,
        firestore_update_error: null
    };

    console.log('[SHADOW_VALIDATION] persist attempt', payload);

    try {
        await docRef.set({
            shadow_validation: shadowValidation,
            updated_at: buildShadowUpdatedAt(shadowValidation)
        }, { merge: true });
        payload.firestore_update_success = true;
        console.log('[SHADOW_VALIDATION] persist success', payload);
        return payload;
    } catch (err) {
        payload.firestore_update_error = err ?.message || String(err);
        console.error('[SHADOW_VALIDATION] persist error', payload);
        throw err;
    }
}

async function verificarPrediccionVelas(id) {
    const docRef = db.collection('velas_predicciones').doc(id);
    const snapshot = await docRef.get();

    if (!snapshot.exists) throw new Error('Prediction not found');

    const data = snapshot.data();
    if (!data) throw new Error('Prediction has no data');

    const isSuppressed = data.signal_emitted === false || String(data.status || '').toLowerCase() === 'suprimida';
    const shouldShadowSuppressed = isSuppressed && SUPPRESSED_SHADOW_REASONS.has(String(data.suppression_reason || '').toLowerCase());
    const shouldBackfillSuppressed = isSuppressed && !hasSuppressedVerification(data);
    const shadowValidationStatus = String(data.shadow_validation ?.status || '').toLowerCase();
    const persistenceMetadata = {
        symbol: data.simbolo_normalizado || data.simbolo || data.symbol || null,
        signal_emitted: data.signal_emitted,
        suppression_reason: data.suppression_reason || null,
        initial_status: data.status || null
    };
    const needsShadowValidation =
        (data.signal_emitted === true || shouldShadowSuppressed) &&
        (!data.shadow_validation || shadowValidationStatus === 'pending' || shadowValidationStatus === 'partial' || shadowValidationStatus === 'error');
    if (data.status && data.status !== 'pendiente' && !shouldBackfillSuppressed && !needsShadowValidation) {
        return { id, ...data };
    }

    if (data.signal_emitted === true || shouldShadowSuppressed) {
        const shadowValidation = await buildMarketShadowValidation(data, new Date());
        const persistResult = await persistShadowValidation(docRef, shadowValidation, persistenceMetadata);
        const shadowUpdatedAt = buildShadowUpdatedAt(shadowValidation);

        if (shadowValidation.status !== 'completed') {
            return {
                id,
                ...data,
                shadow_validation: shadowValidation,
                shadow_validation_persisted: persistResult.firestore_update_success === true,
                firestore_update_attempted: true,
                firestore_update_success: persistResult.firestore_update_success === true,
                firestore_update_error: persistResult.firestore_update_error || null
            };
        }

        if (data.signal_emitted === true) {
            const verification = buildVerificationFromShadow(data, shadowValidation);
            if (!verification) {
                return {
                    id,
                    ...data,
                    shadow_validation: shadowValidation
                };
            }

            const status = verification.success ? 'validado' : verification.direction_match ? 'validado-parcial' : 'fallido';
            const symbolNormalized = normalizeSymbol(data.simbolo_normalizado || data.simbolo || data.symbol || '');

            await docRef.update({
                status,
                verification,
                shadow_validation: shadowValidation,
                completed_at: verification.executed_at,
                updated_at: shadowUpdatedAt
            });

            await syncHighConvictionStatus(id, {
                status,
                verification_outcome: verification.verification_outcome || null,
                shadow_validation: shadowValidation
            });

            await updateTrainingStats(
                symbolNormalized,
                verification.timing_score,
                verification.outcome_label,
                data.confianza ?? data.confidence ?? null,
                data.quantum_score ?? data.quantum ?? null
            );

            return {
                id,
                ...data,
                status,
                verification,
                shadow_validation: shadowValidation,
                completed_at: verification.executed_at,
                shadow_validation_persisted: persistResult.firestore_update_success === true,
                firestore_update_attempted: true,
                firestore_update_success: persistResult.firestore_update_success === true,
                firestore_update_error: persistResult.firestore_update_error || null
            };
        }

        const counterfactual = buildSuppressedCounterfactualFromShadow(data, shadowValidation);
        if (!counterfactual) {
            return {
                id,
                ...data,
                shadow_validation: shadowValidation,
                shadow_validation_persisted: persistResult.firestore_update_success === true,
                firestore_update_attempted: true,
                firestore_update_success: persistResult.firestore_update_success === true,
                firestore_update_error: persistResult.firestore_update_error || null
            };
        }

        const verification = {
            executed_at: shadowValidation.evaluated_at,
            final_price: counterfactual.finalPrice,
            actual_change: counterfactual.actualChange,
            success: false,
            reached_target: false,
            direction_match: counterfactual.directionMatch,
            impulse_strong: counterfactual.impulseStrong,
            timing_score: 0,
            remarks: 'Signal suppressed by quality gate and evaluated with shadow validation.',
            realized_direction: counterfactual.realizedDirection,
            outcome_label: 'SUPPRESSED',
            verification_outcome: 'SUPPRESSED',
            suppressed_verification: counterfactual.suppressedVerification,
            counterfactual_outcome: counterfactual.counterfactualOutcome
        };

        await docRef.update({
            status: 'suprimida',
            verification,
            shadow_validation: shadowValidation,
            suppressed_verification: counterfactual.suppressedVerification,
            counterfactual_outcome: counterfactual.counterfactualOutcome,
            completed_at: shadowValidation.evaluated_at,
            updated_at: shadowUpdatedAt
        });

        await syncHighConvictionStatus(id, {
            status: 'suprimida',
            verification_outcome: 'SUPPRESSED',
            suppressed_verification: counterfactual.suppressedVerification,
            counterfactual_outcome: counterfactual.counterfactualOutcome,
            shadow_validation: shadowValidation
        });

        try {
            await db.collection('velas_suppressed_learning').doc(id).set({
                prediction_id: id,
                symbol: data.simbolo || data.simbolo_normalizado || data.symbol || null,
                execution_mode: data.execution_mode || data.mode || null,
                timeframe: data.timeframe || null,
                suppression_reason: data.suppression_reason || null,
                confidence: data.confianza ?? data.confidence ?? null,
                quantum_score: data.quantum_score ?? data.quantum ?? null,
                timing_score: data.timing_score ?? data.timing ?? null,
                context_score: data.context_score ?? null,
                counterfactual_outcome: counterfactual.counterfactualOutcome,
                suppressed_verification: counterfactual.suppressedVerification,
                shadow_validation: shadowValidation,
                created_at: data.created_at || data.timestamp || null,
                verified_at: shadowValidation.evaluated_at,
                source: 'shadow_validation_market_v1'
            }, { merge: true });
        } catch (err) {
            console.warn('[SUPPRESSED_LEARNING] persist failed', err ?.message || err);
        }

        return {
            id,
            ...data,
            status: 'suprimida',
            verification,
            shadow_validation: shadowValidation,
            suppressed_verification: counterfactual.suppressedVerification,
            counterfactual_outcome: counterfactual.counterfactualOutcome,
            completed_at: shadowValidation.evaluated_at,
            shadow_validation_persisted: persistResult.firestore_update_success === true,
            firestore_update_attempted: true,
            firestore_update_success: persistResult.firestore_update_success === true,
            firestore_update_error: persistResult.firestore_update_error || null
        };
    }

    if (isSuppressed) {
        const executedAt = new Date().toISOString();
        const counterfactual = buildFallbackSuppressedCounterfactual(data, executedAt);

        const verification = {
            executed_at: executedAt,
            final_price: counterfactual.finalPrice,
            actual_change: counterfactual.actualChange,
            success: false,
            reached_target: false,
            direction_match: counterfactual.directionMatch,
            impulse_strong: counterfactual.impulseStrong,
            timing_score: 0,
            remarks: 'Signal suppressed by quality gate.',
            realized_direction: counterfactual.realizedDirection,
            outcome_label: 'SUPPRESSED',
            verification_outcome: 'SUPPRESSED',
            suppressed_verification: counterfactual.suppressedVerification,
            counterfactual_outcome: counterfactual.counterfactualOutcome
        };

        await docRef.update({
            status: 'suprimida',
            verification,
            suppressed_verification: counterfactual.suppressedVerification,
            counterfactual_outcome: counterfactual.counterfactualOutcome,
            completed_at: executedAt,
            updated_at: FieldValue.serverTimestamp()
        });

        await syncHighConvictionStatus(id, {
            status: 'suprimida',
            verification_outcome: 'SUPPRESSED',
            suppressed_verification: counterfactual.suppressedVerification,
            counterfactual_outcome: counterfactual.counterfactualOutcome
        });

        try {
            await db.collection('velas_suppressed_learning').doc(id).set({
                prediction_id: id,
                symbol: data.simbolo || data.simbolo_normalizado || data.symbol || null,
                execution_mode: data.execution_mode || data.mode || null,
                timeframe: data.timeframe || null,
                suppression_reason: data.suppression_reason || null,
                confidence: data.confianza ?? null,
                quantum_score: data.quantum_score ?? null,
                timing_score: data.timing_score ?? null,
                context_score: data.context_score ?? null,
                counterfactual_outcome: counterfactual.counterfactualOutcome,
                suppressed_verification: counterfactual.suppressedVerification,
                created_at: data.created_at || data.timestamp || null,
                verified_at: executedAt,
                source: 'verificacionVelas'
            }, { merge: true });
        } catch (err) {
            console.warn('[SUPPRESSED_LEARNING] persist failed', err ?.message || err);
        }

        return {
            id,
            ...data,
            status: 'suprimida',
            verification,
            suppressed_verification: counterfactual.suppressedVerification,
            counterfactual_outcome: counterfactual.counterfactualOutcome,
            completed_at: executedAt
        };
    }

    return { id, ...data };
}

module.exports = verificarPrediccionVelas;