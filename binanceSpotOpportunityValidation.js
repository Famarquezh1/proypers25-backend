const SPOT_KLINES_URL = 'https://api.binance.com/api/v3/klines';

const VALIDATION_COLLECTION = 'spot_opportunity_validations';
const VALIDATION_TOP_LIMIT = 20;
const VALIDATION_FETCH_TIMEOUT_MS = Math.max(5000, Number(process.env.BINANCE_SPOT_VALIDATION_TIMEOUT_MS || 12000));
const VALIDATION_INTERVAL = process.env.BINANCE_SPOT_VALIDATION_INTERVAL || '5m';
const VALIDATION_HORIZONS = [
    { key: 'h1', label: '1h', hours: 1 },
    { key: 'h4', label: '4h', hours: 4 },
    { key: 'h12', label: '12h', hours: 12 },
    { key: 'h24', label: '24h', hours: 24 }
];

function round(value, decimals = 4) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return null;
    return Number(numeric.toFixed(decimals));
}

function average(values = []) {
    const finite = values.map((value) => Number(value)).filter(Number.isFinite);
    if (!finite.length) return null;
    return finite.reduce((sum, value) => sum + value, 0) / finite.length;
}

function parseDateLike(value) {
    if (!value) return null;
    if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;
    if (typeof value?.toDate === 'function') {
        const date = value.toDate();
        return Number.isFinite(date?.getTime?.()) ? date : null;
    }
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date : null;
}

function sortByMetric(items = [], key, direction = 'desc') {
    const factor = direction === 'asc' ? 1 : -1;
    return [...items].sort((left, right) => {
        const leftValue = Number(left?.[key] || 0);
        const rightValue = Number(right?.[key] || 0);
        const diff = (leftValue - rightValue) * factor;
        if (Math.abs(diff) > 0.000001) return diff;
        return String(left?.symbol || '').localeCompare(String(right?.symbol || ''));
    });
}

function buildRate(numerator, denominator) {
    if (!denominator) return 0;
    return round((Number(numerator || 0) / Number(denominator || 0)) * 100, 2);
}

function buildValidationDocId(scanId, symbol) {
    return `${scanId}_${String(symbol || '').toUpperCase()}`;
}

function buildValidationHorizons(observedAt) {
    const observedDate = parseDateLike(observedAt) || new Date();
    return VALIDATION_HORIZONS.reduce((acc, horizon) => {
        acc[horizon.key] = {
            key: horizon.key,
            label: horizon.label,
            hours: horizon.hours,
            status: 'pending',
            target_at: new Date(observedDate.getTime() + (horizon.hours * 60 * 60 * 1000)).toISOString()
        };
        return acc;
    }, {});
}

function buildValidationProgress(horizons = {}) {
    const values = VALIDATION_HORIZONS.map((horizon) => horizons?.[horizon.key]).filter(Boolean);
    const completed = values.filter((item) => item.status === 'completed');
    const pending = values.filter((item) => item.status !== 'completed');
    const lastCompleted = completed.sort((left, right) => Number(right?.hours || 0) - Number(left?.hours || 0))[0] || null;

    return {
        validation_progress: {
            completed_horizons_count: completed.length,
            pending_horizons_count: pending.length,
            last_completed_horizon: lastCompleted?.label || null,
            last_completed_at: lastCompleted?.completed_at || null,
            fully_validated: pending.length === 0
        }
    };
}

async function fetchJson(url) {
    const response = await fetch(url, { signal: AbortSignal.timeout(VALIDATION_FETCH_TIMEOUT_MS) });
    if (!response.ok) {
        throw new Error(`spot_validation_status_${response.status}`);
    }
    return response.json();
}

async function fetchSpotRangeKlines(symbol, startTime, endTime, interval = VALIDATION_INTERVAL) {
    const query = new URLSearchParams({
        symbol: String(symbol || '').toUpperCase(),
        interval,
        startTime: String(Number(startTime || 0)),
        endTime: String(Number(endTime || 0)),
        limit: '1000'
    });
    const rows = await fetchJson(`${SPOT_KLINES_URL}?${query.toString()}`);
    if (!Array.isArray(rows)) return [];
    return rows.map((row) => ({
        openTime: Number(row[0]),
        open: Number(row[1]),
        high: Number(row[2]),
        low: Number(row[3]),
        close: Number(row[4]),
        closeTime: Number(row[6]),
        quoteVolume: Number(row[7])
    })).filter((row) => Number.isFinite(row.close) && Number.isFinite(row.high) && Number.isFinite(row.low));
}

function resolveMovePct(initialPrice, price) {
    const base = Number(initialPrice);
    const observed = Number(price);
    if (!Number.isFinite(base) || base <= 0 || !Number.isFinite(observed) || observed <= 0) return null;
    return ((observed - base) / base) * 100;
}

function evaluateValidationHorizon(initialPrice, klines = []) {
    const base = Number(initialPrice);
    if (!Number.isFinite(base) || base <= 0 || !Array.isArray(klines) || !klines.length) {
        return null;
    }

    const endPrice = Number(klines[klines.length - 1]?.close);
    const favorableMoves = klines
        .map((row) => resolveMovePct(base, row?.high))
        .filter(Number.isFinite);
    const adverseMoves = klines
        .map((row) => resolveMovePct(base, row?.low))
        .filter(Number.isFinite);
    const maxFavorableMovePct = favorableMoves.length ? Math.max(...favorableMoves) : null;
    const maxAdverseMovePct = adverseMoves.length ? Math.min(...adverseMoves) : null;
    const variationPct = resolveMovePct(base, endPrice);

    return {
        end_price: round(endPrice, 8),
        variation_pct: round(variationPct, 4),
        max_favorable_move_pct: round(maxFavorableMovePct, 4),
        max_adverse_move_pct: round(maxAdverseMovePct, 4),
        hit_plus_3_pct: Number(maxFavorableMovePct || 0) >= 3,
        hit_plus_5_pct: Number(maxFavorableMovePct || 0) >= 5,
        hit_plus_10_pct: Number(maxFavorableMovePct || 0) >= 10,
        hit_plus_20_pct: Number(maxFavorableMovePct || 0) >= 20,
        drop_below_minus_5_pct: Number(maxAdverseMovePct || 0) <= -5,
        drop_below_minus_10_pct: Number(maxAdverseMovePct || 0) <= -10,
        candle_samples: klines.length
    };
}

function isHorizonDue(horizonState = {}, now = new Date()) {
    if (!horizonState || horizonState.status === 'completed') return false;
    const targetAt = parseDateLike(horizonState.target_at);
    if (!targetAt) return false;
    return targetAt.getTime() <= now.getTime();
}

function pickLongestCompletedObservation(observation = {}) {
    const horizons = observation?.horizons || {};
    const completed = VALIDATION_HORIZONS
        .map((horizon) => ({...horizons?.[horizon.key], key : horizon.key, label: horizon.label, hours: horizon.hours }))
        .filter((item) => item?.status === 'completed');
    if (!completed.length) return null;
    const longest = completed.sort((left, right) => Number(right?.hours || 0) - Number(left?.hours || 0))[0];
    return {
        validation_id: observation.id,
        scan_id: observation.scan_id,
        symbol: observation.symbol,
        initial_category: observation.initial_category,
        initial_score: Number(observation.initial_score || 0),
        initial_price: Number(observation.initial_price || 0),
        observed_at: observation.observed_at,
        horizon: longest.label,
        horizon_hours: Number(longest.hours || 0),
        variation_pct: Number(longest.variation_pct || 0),
        max_favorable_move_pct: Number(longest.max_favorable_move_pct || 0),
        max_adverse_move_pct: Number(longest.max_adverse_move_pct || 0),
        hit_plus_3_pct: longest.hit_plus_3_pct === true,
        hit_plus_5_pct: longest.hit_plus_5_pct === true,
        hit_plus_10_pct: longest.hit_plus_10_pct === true,
        hit_plus_20_pct: longest.hit_plus_20_pct === true,
        drop_below_minus_5_pct: longest.drop_below_minus_5_pct === true,
        drop_below_minus_10_pct: longest.drop_below_minus_10_pct === true,
        end_price: Number(longest.end_price || 0)
    };
}

function isFalsePositive(observation = {}) {
    return Number(observation.max_favorable_move_pct || 0) < 3 && (
        Number(observation.variation_pct || 0) <= 0 ||
        Number(observation.max_adverse_move_pct || 0) <= -5
    );
}

function isUsefulObservation(observation = {}) {
    return Number(observation.max_favorable_move_pct || 0) >= 5 || Number(observation.variation_pct || 0) >= 3;
}

function summarizeGroupedPerformance(items = [], keyName, keyResolver) {
    const groups = new Map();
    for (const item of items) {
        const key = String(keyResolver(item) || 'unknown');
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(item);
    }

    return Array.from(groups.entries()).map(([key, group]) => ({
        [keyName]: key,
        observations: group.length,
        avg_variation_pct: round(average(group.map((item) => item.variation_pct)), 4),
        avg_max_favorable_move_pct: round(average(group.map((item) => item.max_favorable_move_pct)), 4),
        avg_max_adverse_move_pct: round(average(group.map((item) => item.max_adverse_move_pct)), 4),
        hit_plus_3_rate: buildRate(group.filter((item) => item.hit_plus_3_pct).length, group.length),
        hit_plus_5_rate: buildRate(group.filter((item) => item.hit_plus_5_pct).length, group.length),
        hit_plus_10_rate: buildRate(group.filter((item) => item.hit_plus_10_pct).length, group.length),
        false_positive_rate: buildRate(group.filter((item) => isFalsePositive(item)).length, group.length),
        min_score: round(Math.min(...group.map((item) => Number(item.initial_score || 0))), 2),
        max_score: round(Math.max(...group.map((item) => Number(item.initial_score || 0))), 2)
    }));
}

function buildHorizonSummary(observations = []) {
    return VALIDATION_HORIZONS.map((horizon) => {
        const completed = observations
            .map((observation) => observation?.horizons?.[horizon.key])
            .filter((item) => item?.status === 'completed');
        return {
            horizon: horizon.label,
            completed_count: completed.length,
            avg_variation_pct: round(average(completed.map((item) => item?.variation_pct)), 4),
            avg_max_favorable_move_pct: round(average(completed.map((item) => item?.max_favorable_move_pct)), 4),
            avg_max_adverse_move_pct: round(average(completed.map((item) => item?.max_adverse_move_pct)), 4),
            hit_plus_3_rate: buildRate(completed.filter((item) => item?.hit_plus_3_pct === true).length, completed.length),
            hit_plus_5_rate: buildRate(completed.filter((item) => item?.hit_plus_5_pct === true).length, completed.length),
            hit_plus_10_rate: buildRate(completed.filter((item) => item?.hit_plus_10_pct === true).length, completed.length),
            hit_plus_20_rate: buildRate(completed.filter((item) => item?.hit_plus_20_pct === true).length, completed.length),
            drop_below_minus_5_rate: buildRate(completed.filter((item) => item?.drop_below_minus_5_pct === true).length, completed.length),
            drop_below_minus_10_rate: buildRate(completed.filter((item) => item?.drop_below_minus_10_pct === true).length, completed.length)
        };
    });
}

function buildSummaryConclusion(topCategory, scoreMinimumUseful, completedCount) {
    if (!completedCount) {
        return 'No completed Spot opportunity validations yet.';
    }
    if (topCategory?.hit_plus_10_rate >= 25) {
        return `Category ${topCategory.category} is leading the strongest swing reactions.`;
    }
    if (Number(scoreMinimumUseful || 0) > 0) {
        return `Useful swing reactions are appearing from scores above approximately ${scoreMinimumUseful}.`;
    }
    return 'Spot validation is running, but the current sample still needs more completed horizons.';
}

async function seedSpotOpportunityValidations(db, scanDoc = {}, candidates = []) {
    if (!db || !scanDoc?.id || !Array.isArray(candidates) || !candidates.length) {
        return { observations_saved: 0 };
    }

    const observedAt = scanDoc.created_at || new Date().toISOString();
    const topCandidates = candidates.slice(0, VALIDATION_TOP_LIMIT);
    const batch = db.batch();

    for (const candidate of topCandidates) {
        const docId = buildValidationDocId(scanDoc.id, candidate.symbol);
        const ref = db.collection(VALIDATION_COLLECTION).doc(docId);
        const horizons = buildValidationHorizons(observedAt);
        batch.set(ref, {
            id: docId,
            scan_id: scanDoc.id,
            symbol: String(candidate.symbol || '').toUpperCase(),
            observed_at: observedAt,
            scanner_version: scanDoc.scanner_version || null,
            initial_price: Number(candidate.price || 0),
            initial_quote_volume_24h: Number(candidate.quoteVolume24h || 0),
            initial_score: Number(candidate.opportunityScore || 0),
            initial_category: candidate.category || 'WATCHLIST',
            initial_recommendation: candidate.recommendation || 'WATCH',
            initial_reasons: Array.isArray(candidate.reasons) ? candidate.reasons : [],
            paper_only: true,
            horizons,
            created_at: observedAt,
            updated_at: observedAt,
            ...buildValidationProgress(horizons)
        }, { merge: true });
    }

    await batch.commit();
    return { observations_saved: topCandidates.length };
}

async function processSpotOpportunityValidations(db, options = {}) {
    if (!db) {
        throw new Error('spot_validation_requires_db');
    }

    const maxDocs = Math.max(20, Math.min(500, Number(options.maxDocs || 200)));
    const now = parseDateLike(options.now) || new Date();
    const snapshot = await db.collection(VALIDATION_COLLECTION).orderBy('observed_at', 'desc').limit(maxDocs).get();
    if (snapshot.empty) {
        return {
            validations_seen: 0,
            validations_updated: 0,
            horizons_completed: 0
        };
    }

    let validationsUpdated = 0;
    let horizonsCompleted = 0;

    for (const doc of snapshot.docs) {
        const current = { id: doc.id, ...(doc.data() || {}) };
        const dueHorizons = VALIDATION_HORIZONS.filter((horizon) => isHorizonDue(current?.horizons?.[horizon.key], now));
        if (!dueHorizons.length) continue;

        const observedAt = parseDateLike(current.observed_at);
        const initialPrice = Number(current.initial_price || 0);
        if (!observedAt || !(initialPrice > 0) || !current.symbol) continue;

        const longestHours = Math.max(...dueHorizons.map((item) => item.hours));
        const rangeKlines = await fetchSpotRangeKlines(
            current.symbol,
            observedAt.getTime(),
            observedAt.getTime() + (longestHours * 60 * 60 * 1000)
        );
        if (!rangeKlines.length) continue;

        const nextHorizons = {...(current.horizons || {}) };
        let updatedInThisDoc = 0;

        for (const horizon of dueHorizons) {
            const horizonEndMs = observedAt.getTime() + (horizon.hours * 60 * 60 * 1000);
            const horizonKlines = rangeKlines.filter((row) => Number(row?.openTime || 0) < horizonEndMs);
            const evaluation = evaluateValidationHorizon(initialPrice, horizonKlines);
            if (!evaluation) continue;

            nextHorizons[horizon.key] = {
                ...(nextHorizons[horizon.key] || {}),
                ...evaluation,
                key: horizon.key,
                label: horizon.label,
                hours: horizon.hours,
                status: 'completed',
                completed_at: now.toISOString(),
                evaluated_until: new Date(horizonEndMs).toISOString()
            };
            updatedInThisDoc += 1;
        }

        if (!updatedInThisDoc) continue;

        await doc.ref.set({
            horizons: nextHorizons,
            updated_at: now.toISOString(),
            ...buildValidationProgress(nextHorizons)
        }, { merge: true });

        validationsUpdated += 1;
        horizonsCompleted += updatedInThisDoc;
    }

    return {
        validations_seen: snapshot.docs.length,
        validations_updated: validationsUpdated,
        horizons_completed: horizonsCompleted
    };
}

async function getSpotOpportunityValidationDiagnostic(db, options = {}) {
    if (!db) {
        throw new Error('spot_validation_requires_db');
    }

    if (options.refresh !== 'false') {
        await processSpotOpportunityValidations(db, options);
    }

    const maxDocs = Math.max(20, Math.min(500, Number(options.maxDocs || 200)));
    const snapshot = await db.collection(VALIDATION_COLLECTION).orderBy('observed_at', 'desc').limit(maxDocs).get();
    if (snapshot.empty) {
        return {
            observations_tracked: 0,
            completed_observations: 0,
            pending_observations: 0,
            top_risers: [],
            false_positives: [],
            category_effectiveness: [],
            best_symbol_reactions: [],
            score_minimum_useful_for_5pct_move: null,
            summary_conclusion: 'No Spot opportunity validations available yet.'
        };
    }

    const observations = snapshot.docs.map((doc) => ({ id: doc.id, ...(doc.data() || {}) }));
    const longestCompleted = observations.map((item) => pickLongestCompletedObservation(item)).filter(Boolean);
    const fullyValidated = observations.filter((item) => item?.validation_progress?.fully_validated === true).length;
    const pending = observations.filter((item) => item?.validation_progress?.fully_validated !== true).length;
    const topRisers = sortByMetric(longestCompleted, 'max_favorable_move_pct', 'desc').slice(0, 20);
    const falsePositives = sortByMetric(longestCompleted.filter((item) => isFalsePositive(item)), 'variation_pct', 'asc').slice(0, 20);
    const categoryEffectiveness = summarizeGroupedPerformance(longestCompleted, 'category', (item) => item.initial_category)
        .sort((left, right) => {
            const hitDiff = Number(right.hit_plus_5_rate || 0) - Number(left.hit_plus_5_rate || 0);
            if (Math.abs(hitDiff) > 0.000001) return hitDiff;
            return Number(right.avg_max_favorable_move_pct || 0) - Number(left.avg_max_favorable_move_pct || 0);
        });
    const bestSymbolReactions = summarizeGroupedPerformance(longestCompleted, 'symbol', (item) => item.symbol)
        .sort((left, right) => {
            const favorableDiff = Number(right.avg_max_favorable_move_pct || 0) - Number(left.avg_max_favorable_move_pct || 0);
            if (Math.abs(favorableDiff) > 0.000001) return favorableDiff;
            return Number(right.hit_plus_5_rate || 0) - Number(left.hit_plus_5_rate || 0);
        })
        .slice(0, 20);
    const usefulObservations = longestCompleted.filter((item) => isUsefulObservation(item));
    const usefulScores = usefulObservations.map((item) => Number(item.initial_score || 0)).filter(Number.isFinite);
    const scoreMinimumUseful = usefulScores.length ? Math.min(...usefulScores) : null;
    const scoreAverageUseful = usefulScores.length ? average(usefulScores) : null;
    const topCategory = categoryEffectiveness[0] || null;

    return {
        observations_tracked: observations.length,
        completed_observations: longestCompleted.length,
        fully_validated_observations: fullyValidated,
        pending_observations: pending,
        last_observation_at: observations[0]?.observed_at || null,
        horizon_summary: buildHorizonSummary(observations),
        top_risers: topRisers,
        false_positives: falsePositives,
        most_effective_category: topCategory,
        category_effectiveness: categoryEffectiveness,
        best_symbol_reactions: bestSymbolReactions,
        score_minimum_useful_for_5pct_move: round(scoreMinimumUseful, 2),
        useful_score_average: round(scoreAverageUseful, 2),
        useful_observations_count: usefulObservations.length,
        summary_conclusion: buildSummaryConclusion(topCategory, scoreMinimumUseful, longestCompleted.length)
    };
}

module.exports = {
    VALIDATION_COLLECTION,
    VALIDATION_HORIZONS,
    seedSpotOpportunityValidations,
    processSpotOpportunityValidations,
    getSpotOpportunityValidationDiagnostic
};