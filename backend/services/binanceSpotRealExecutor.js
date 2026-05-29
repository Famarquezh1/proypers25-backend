/**
 * BINANCE SPOT REAL EXECUTOR
 *
 * Controlado, aislado y seguro.
 * - NO Futures
 * - NO Margin
 * - NO Leverage
 * - SOLO Spot real
 * - Kill switch bloqueante
 * - Guardias contra misuse
 * - Credenciales vía Google Secret Manager
 *
 * Estado inicial: BLOQUEADO (enabled=false, kill_switch=true)
 * Config vía Firestore: real_spot_config/control
 */

const crypto = require('crypto');
const { getBinanceSpotCredentials, checkBinanceSpotCredentials } = require('../lib/secretManager');

const REAL_SPOT_CONFIG_PATH = 'real_spot_config/control';
const REAL_SPOT_INTENTS_COLLECTION = 'real_spot_execution_intents';
const REAL_SPOT_POSITIONS_COLLECTION = 'real_spot_positions';
const REAL_SPOT_RESULTS_COLLECTION = 'real_spot_execution_results';

const PAPER_SCANS_COLLECTION = 'spot_opportunity_scans';
const PAPER_CANDIDATES_COLLECTION = 'spot_opportunity_candidates';
const PAPER_POSITIONS_COLLECTION = 'spot_paper_positions';
const PAPER_RESULTS_COLLECTION = 'spot_paper_execution_results';

const EXECUTOR_VERSION = '1.0.0';
const SAFETY_VERSION = 'real_spot_controlled_v1';

// Guardias contra misuse
const FORBIDDEN_KEYWORDS = [
    'binanceFuturesExecutor',
    'futures',
    'leverage',
    'margin',
    'short',
    'positionSide',
    'reduceOnly'
];

/**
 * Assert that real spot trading is allowed
 * Must pass ALL checks before any order can be signed
 */
function assertRealSpotTradingAllowed(config) {
    const reasons = [];

    if (config.enabled !== true) {
        reasons.push('REAL_SPOT_NOT_ENABLED');
    }

    if (config.kill_switch === true) {
        reasons.push('KILL_SWITCH_ACTIVE');
    }

    if (config.mode !== 'REAL_SPOT_CONTROLLED_V1') {
        reasons.push('INVALID_SAFETY_MODE');
    }

    if (!Number.isFinite(config.max_position_usdt) || config.max_position_usdt <= 0) {
        reasons.push('INVALID_POSITION_LIMIT');
    }

    if (!Number.isFinite(config.max_total_capital_usdt) || config.max_total_capital_usdt <= 0) {
        reasons.push('INVALID_TOTAL_CAPITAL');
    }

    if (!Number.isFinite(config.max_open_positions) || config.max_open_positions <= 0) {
        reasons.push('INVALID_MAX_OPEN_POSITIONS');
    }

    // Strict limits for initial rollout
    if (config.max_position_usdt > 10) {
        reasons.push('POSITION_LIMIT_TOO_HIGH');
    }

    if (config.max_open_positions > 1) {
        reasons.push('TOO_MANY_OPEN_POSITIONS_ALLOWED');
    }

    if (config.max_total_capital_usdt > 100) {
        reasons.push('TOTAL_CAPITAL_TOO_HIGH');
    }

    if (reasons.length > 0) {
        throw new Error(`REAL_SPOT_TRADING_NOT_ALLOWED: ${reasons.join(', ')}`);
    }
}

/**
 * Create signed request for Binance Spot API
 * ONLY call after assertRealSpotTradingAllowed() passes
 */
async function createSignedBinanceSpotRequest(method, endpoint, params = {}) {
    try {
        const credentials = await getBinanceSpotCredentials();
        const { apiKey, apiSecret } = credentials;

        const timestamp = Date.now();
        const baseParams = {...params, timestamp };

        // Create query string
        const queryString = Object.entries(baseParams)
            .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
            .join('&');

        // Create signature using HMAC SHA256
        const signature = crypto
            .createHmac('sha256', apiSecret)
            .update(queryString)
            .digest('hex');

        // Never log signature or credentials
        const signedUrl = `${endpoint}?${queryString}&signature=${signature}`;

        return {
            headers: {
                'X-MBX-APIKEY': apiKey,
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            url: signedUrl,
            timestamp
            // Never return apiSecret or signature in normal flow
        };
    } catch (error) {
        if (error.message.includes('BINANCE_SPOT_SECRET')) {
            throw error;
        }
        throw new Error(`SIGNED_REQUEST_FAILED: ${error.message}`);
    }
}

/**
 * Get Binance Spot account info
 * ONLY callable if trading is allowed
 */
async function getSpotAccountInfo(config) {
    try {
        assertRealSpotTradingAllowed(config);

        // In real implementation, would call:
        // GET https://api.binance.com/api/v3/account

        // For now, just verify credentials exist
        const credentials = await getBinanceSpotCredentials();

        return {
            ok: true,
            has_credentials: !!credentials,
            account_fetched: false,
            note: 'Credentials verified but order execution not yet enabled in this phase'
        };
    } catch (error) {
        if (error.message.includes('REAL_SPOT_TRADING_NOT_ALLOWED')) {
            return {
                ok: false,
                has_credentials: false,
                account_fetched: false,
                reason: 'TRADING_NOT_ALLOWED'
            };
        }
        throw error;
    }
}

/**
 * Validate spot order (NOT executed, just validation)
 */
async function validateSpotOrder(symbol, quantity, side, config) {
    try {
        // Validate trading is allowed
        assertRealSpotTradingAllowed(config);

        // Validate symbol
        if (!isValidSpotSymbol(symbol)) {
            return { valid: false, reason: 'INVALID_SPOT_SYMBOL' };
        }

        // Validate quantity
        if (!Number.isFinite(quantity) || quantity <= 0) {
            return { valid: false, reason: 'INVALID_QUANTITY' };
        }

        // Validate side
        if (side !== 'BUY' && side !== 'SELL') {
            return { valid: false, reason: 'INVALID_SIDE' };
        }

        return { valid: true, note: 'Order validation passed (NOT executed)' };
    } catch (error) {
        return {
            valid: false,
            reason: 'VALIDATION_FAILED',
            error_msg: error.message.split(':')[0]
        };
    }
}

/**
 * Place Spot Market Buy (REAL IMPLEMENTATION)
 * Makes actual POST to Binance /api/v3/order with strict safety gates
 */
async function placeSpotMarketBuy(symbol, quoteOrderQty, config, preflight) {
    try {
        // VALIDATION GATE 1: Config must allow real trading
        if (config.enabled !== true) {
            return { ok: false, blocked: true, reason: 'REAL_SPOT_NOT_ENABLED' };
        }

        if (config.kill_switch === true) {
            return { ok: false, blocked: true, reason: 'KILL_SWITCH_ACTIVE' };
        }

        if (config.new_entries_enabled !== true) {
            return { ok: false, blocked: true, reason: 'NEW_ENTRIES_DISABLED' };
        }

        if (config.auto_order_execution !== true) {
            return { ok: false, blocked: true, reason: 'AUTO_ORDER_EXECUTION_DISABLED' };
        }

        if (config.spot_only !== true) {
            return { ok: false, blocked: true, reason: 'NOT_SPOT_ONLY' };
        }

        if (config.futures_allowed === true) {
            return { ok: false, blocked: true, reason: 'FUTURES_NOT_ALLOWED' };
        }

        if (config.margin_allowed === true) {
            return { ok: false, blocked: true, reason: 'MARGIN_NOT_ALLOWED' };
        }

        if (config.leverage_allowed === true) {
            return { ok: false, blocked: true, reason: 'LEVERAGE_NOT_ALLOWED' };
        }

        if (config.withdrawals_allowed !== false) {
            return { ok: false, blocked: true, reason: 'WITHDRAWALS_MUST_BE_DISABLED' };
        }

        // VALIDATION GATE 2: Preflight must pass
        if (!preflight || !preflight.credentials_valid) {
            return { ok: false, blocked: true, reason: 'CREDENTIALS_INVALID' };
        }

        if (preflight.can_trade !== true) {
            return { ok: false, blocked: true, reason: 'ACCOUNT_CANNOT_TRADE' };
        }

        if (preflight.enable_withdrawals_api_key !== false) {
            return { ok: false, blocked: true, reason: 'WITHDRAWALS_MUST_BE_LOCKED_AT_API_KEY_LEVEL' };
        }

        if (preflight.usdt_balance_free < quoteOrderQty) {
            return { ok: false, blocked: true, reason: 'INSUFFICIENT_BALANCE', available: preflight.usdt_balance_free, required: quoteOrderQty };
        }

        // VALIDATION GATE 3: Position limits
        if (quoteOrderQty > Number(config.max_position_usdt || 10)) {
            return { ok: false, blocked: true, reason: 'ORDER_EXCEEDS_POSITION_LIMIT', limit: config.max_position_usdt, requested: quoteOrderQty };
        }

        if (quoteOrderQty > Number(config.max_total_capital_usdt || 10)) {
            return { ok: false, blocked: true, reason: 'ORDER_EXCEEDS_TOTAL_CAPITAL_LIMIT', limit: config.max_total_capital_usdt, requested: quoteOrderQty };
        }

        // VALIDATION GATE 4: Symbol validation
        if (!symbol || typeof symbol !== 'string') {
            return { ok: false, blocked: true, reason: 'INVALID_SYMBOL' };
        }

        const symbolUpper = String(symbol).toUpperCase();
        if (!symbolUpper.endsWith('USDT')) {
            return { ok: false, blocked: true, reason: 'NOT_USDT_PAIR' };
        }

        // Get credentials (throws if unavailable)
        const credentials = await getBinanceSpotCredentials();
        const { apiKey, apiSecret } = credentials;

        // Create signed request
        const timestamp = Date.now();
        const params = {
            symbol: symbolUpper,
            side: 'BUY',
            type: 'MARKET',
            quoteOrderQty: Number(quoteOrderQty).toFixed(2),
            timestamp,
            recvWindow: 5000
        };

        const queryString = Object.entries(params)
            .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
            .join('&');

        const signature = crypto
            .createHmac('sha256', apiSecret)
            .update(queryString)
            .digest('hex');

        const signedUrl = `https://api.binance.com/api/v3/order?${queryString}&signature=${signature}`;

        // Make real POST request
        const https = require('https');
        const url = require('url');

        return new Promise((resolve) => {
            const urlObj = new url.URL(signedUrl);
            const options = {
                hostname: urlObj.hostname,
                path: urlObj.pathname + urlObj.search,
                method: 'POST',
                headers: {
                    'X-MBX-APIKEY': apiKey,
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Content-Length': 0
                },
                timeout: 5000
            };

            const req = https.request(options, (res) => {
                let data = '';

                res.on('data', (chunk) => {
                    data += chunk;
                });

                res.on('end', () => {
                    try {
                        if (res.statusCode === 200 || res.statusCode === 201) {
                            const order = JSON.parse(data);
                            resolve({
                                ok: true,
                                order_created: true,
                                orderId: order.orderId,
                                clientOrderId: order.clientOrderId,
                                symbol: order.symbol,
                                side: order.side,
                                type: order.type,
                                executedQty: Number(order.executedQty || 0),
                                cummulativeQuoteQty: Number(order.cummulativeQuoteQty || 0),
                                status: order.status,
                                transactTime: order.transactTime,
                                fills: order.fills || []
                            });
                        } else {
                            const error = JSON.parse(data);
                            resolve({
                                ok: false,
                                blocked: false,
                                reason: 'BINANCE_API_ERROR',
                                status_code: res.statusCode,
                                error_code: error.code,
                                error_message: error.msg
                            });
                        }
                    } catch (err) {
                        resolve({
                            ok: false,
                            blocked: false,
                            reason: 'RESPONSE_PARSE_ERROR',
                            error: err.message,
                            raw_data: data.substring(0, 200)
                        });
                    }
                });
            });

            req.on('timeout', () => {
                req.destroy();
                resolve({
                    ok: false,
                    blocked: false,
                    reason: 'REQUEST_TIMEOUT'
                });
            });

            req.on('error', (err) => {
                resolve({
                    ok: false,
                    blocked: false,
                    reason: 'REQUEST_ERROR',
                    error: err.message
                });
            });

            req.end();
        });

    } catch (error) {
        if (error.message.includes('BINANCE_SPOT_SECRET')) {
            return { ok: false, blocked: true, reason: 'CREDENTIALS_ERROR' };
        }
        return {
            ok: false,
            blocked: false,
            reason: 'EXCEPTION',
            error: error.message
        };
    }
}

/**
 * PLACEHOLDER: Place Spot Market Sell (NOT ACTIVE IN THIS PHASE)
 */
async function placeSpotMarketSell(symbol, quantity, config) {
    try {
        assertRealSpotTradingAllowed(config);

        // IMPORTANT: This function validates but does NOT execute
        // Real order execution will be implemented in Phase 3+

        const validation = await validateSpotOrder(symbol, quantity, 'SELL', config);
        if (!validation.valid) {
            return { ok: false, reason: validation.reason };
        }

        return {
            ok: false,
            reason: 'ORDER_EXECUTION_NOT_ENABLED',
            note: 'Real order execution disabled in this phase. Credentials verified but no orders placed.'
        };
    } catch (error) {
        if (error.message.includes('REAL_SPOT_TRADING_NOT_ALLOWED')) {
            return { ok: false, reason: 'TRADING_NOT_ALLOWED' };
        }
        throw error;
    }
}

/**
 * PLACEHOLDER: Get order status (NOT ACTIVE IN THIS PHASE)
 */
async function getOrderStatus(symbol, orderId, config) {
    try {
        assertRealSpotTradingAllowed(config);

        // IMPORTANT: Would fetch order from Binance API
        // Disabled in this phase

        return {
            ok: false,
            reason: 'ORDER_STATUS_NOT_ENABLED',
            note: 'Order status queries disabled in this phase'
        };
    } catch (error) {
        if (error.message.includes('REAL_SPOT_TRADING_NOT_ALLOWED')) {
            return { ok: false, reason: 'TRADING_NOT_ALLOWED' };
        }
        throw error;
    }
}

/**
 * Get real spot config from Firestore
 */
async function getRealSpotConfig(db) {
    if (!db) {
        throw new Error('real_executor_requires_db');
    }

    try {
        const configSnap = await db.collection('real_spot_config')
            .doc('control')
            .get();

        if (!configSnap.exists) {
            // Return safe defaults if not configured
            return {
                enabled: false,
                kill_switch: true,
                mode: 'REAL_SPOT_CONTROLLED_V1',
                max_total_capital_usdt: 100,
                max_position_usdt: 15,
                max_open_positions: 2,
                allow_symbols_from_paper_scanner_only: true,
                allowed_categories: ['BREAKOUT', 'MOMENTUM', 'ACCUMULATION'],
                min_opportunity_score: 70,
                take_profit_1_pct: 5,
                take_profit_2_pct: 10,
                stop_loss_pct: -5,
                timeout_hours: 24,
                require_recent_scan: true,
                max_scan_age_minutes: 60,
                require_paper_pattern_confirmed: true,
                notes: 'Real Spot controlado. Sin futures, sin margin, sin leverage.'
            };
        }

        const config = configSnap.data() || {};

        // Ensure kill_switch exists and is respected
        if (config.kill_switch === undefined) {
            config.kill_switch = true;
        }

        return config;
    } catch (error) {
        console.warn('[REAL_EXECUTOR] Failed to load config:', error.message);
        // Return safe defaults on error
        return {
            enabled: false,
            kill_switch: true
        };
    }
}

/**
 * Validate config before execution
 */
function validateRealSpotConfig(config) {
    if (!config) {
        return { valid: false, reason: 'NO_CONFIG' };
    }

    if (config.enabled !== true) {
        return { valid: false, reason: 'NOT_ENABLED' };
    }

    if (config.kill_switch === true) {
        return { valid: false, reason: 'KILL_SWITCH_ACTIVE' };
    }

    if (!Number.isFinite(config.max_total_capital_usdt) || config.max_total_capital_usdt <= 0) {
        return { valid: false, reason: 'INVALID_MAX_TOTAL_CAPITAL' };
    }

    if (!Number.isFinite(config.max_position_usdt) || config.max_position_usdt <= 0) {
        return { valid: false, reason: 'INVALID_MAX_POSITION_CAPITAL' };
    }

    if (!Number.isFinite(config.max_open_positions) || config.max_open_positions <= 0) {
        return { valid: false, reason: 'INVALID_MAX_OPEN_POSITIONS' };
    }

    return { valid: true };
}

/**
 * Parse date-like values
 */
function parseDateLike(value) {
    if (!value) return null;
    if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;
    if (typeof value.toDate === 'function') {
        const date = value.toDate();
        return Number.isFinite(date?.getTime?.()) ? date : null;
    }
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date : null;
}

/**
 * Validate symbol is Spot-only
 */
function isValidSpotSymbol(symbol) {
    if (typeof symbol !== 'string') return false;
    if (!symbol.toUpperCase().endsWith('USDT')) return false;

    const forbidden = ['UP', 'DOWN', 'PERP', 'BULL', 'BEAR'];
    const normalized = symbol.toUpperCase();

    for (const forbidden_suffix of forbidden) {
        if (normalized.endsWith(forbidden_suffix)) {
            return false;
        }
    }

    return true;
}

/**
 * Get current capital exposure
 */
async function getRealSpotCapitalExposure(db) {
    if (!db) {
        return { total: 0, by_symbol: {} };
    }

    try {
        const snapshot = await db.collection(REAL_SPOT_POSITIONS_COLLECTION)
            .where('status', '==', 'REAL_OPEN')
            .get();

        let total = 0;
        const by_symbol = {};

        for (const doc of snapshot.docs) {
            const pos = doc.data();
            const capital = Number(pos.capital_usdt || 0);
            total += capital;
            by_symbol[pos.symbol] = (by_symbol[pos.symbol] || 0) + capital;
        }

        return { total, by_symbol };
    } catch (error) {
        console.warn('[REAL_EXECUTOR] Failed to get capital exposure:', error.message);
        return { total: 0, by_symbol: {} };
    }
}

/**
 * Check if symbol has open position
 */
async function hasOpenRealPosition(db, symbol) {
    if (!db || !symbol) return false;

    try {
        const snapshot = await db.collection(REAL_SPOT_POSITIONS_COLLECTION)
            .where('symbol', '==', String(symbol || '').toUpperCase())
            .where('status', '==', 'REAL_OPEN')
            .limit(1)
            .get();

        return !snapshot.empty;
    } catch (error) {
        console.warn('[REAL_EXECUTOR] Failed to check open position:', error.message);
        return false;
    }
}

/**
 * Create execution intent (before order)
 */
async function createRealExecutionIntent(db, candidate, capital_usdt, config) {
    if (!db || !candidate) {
        return null;
    }

    const intentId = `real_spot_intent_${candidate.scan_id}_${String(candidate.symbol || '').toUpperCase()}`;

    try {
        await db.collection(REAL_SPOT_INTENTS_COLLECTION).doc(intentId).set({
            id: intentId,
            symbol: String(candidate.symbol || '').toUpperCase(),
            scan_id: candidate.scan_id || null,
            candidate_id: candidate.id || null,
            category: candidate.category || 'UNKNOWN',
            opportunity_score: Number(candidate.opportunityScore || 0),
            status: 'REAL_PENDING',
            rejection_reason: null,
            intended_capital_usdt: capital_usdt,
            created_at: new Date().toISOString(),
            real_mode: true,
            safety_version: SAFETY_VERSION
        }, { merge: true });

        return { id: intentId, created: true };
    } catch (error) {
        console.error('[REAL_EXECUTOR] Failed to create intent:', error.message);
        return null;
    }
}

/**
 * Validate Binance Spot order filters
 */
function validateSpotOrderFilters(symbol, quantity, exchangeInfo) {
    if (!exchangeInfo) {
        return { valid: false, reason: 'NO_EXCHANGE_INFO' };
    }

    const symbolInfo = exchangeInfo.symbols?.find((s) => s.symbol === symbol);
    if (!symbolInfo) {
        return { valid: false, reason: 'SYMBOL_NOT_FOUND' };
    }

    if (symbolInfo.status !== 'TRADING') {
        return { valid: false, reason: 'SYMBOL_NOT_TRADING' };
    }

    // Verify Spot only
    if (symbolInfo.isSpotTradingAllowed !== true) {
        return { valid: false, reason: 'NOT_SPOT_ALLOWED' };
    }

    if (String(symbolInfo.quoteAsset || '').toUpperCase() !== 'USDT') {
        return { valid: false, reason: 'NOT_USDT_PAIR' };
    }

    return { valid: true };
}

function createBaseEntryDiagnostic(overrides = {}) {
    return {
        latest_scan_id: null,
        latest_scan_age_minutes: null,
        recent_scan_ok: null,
        candidates_seen: 0,
        candidates_after_score_filter: 0,
        candidates_after_category_filter: 0,
        candidates_after_capital_filter: 0,
        selected_candidate: null,
        rejected_reasons: [],
        order_creation_path_reached: false,
        order_created: false,
        ...overrides
    };
}

async function buildRealSpotEntryDiagnostic(db, config, exposure = { total: 0 }, openPositionsCount = 0) {
    const diagnostic = createBaseEntryDiagnostic();

    if (!db) {
        diagnostic.rejected_reasons.push('NO_DATABASE');
        return diagnostic;
    }

    try {
        const latestScanSnapshot = await db.collection(PAPER_SCANS_COLLECTION)
            .orderBy('created_at', 'desc')
            .limit(1)
            .get();

        if (latestScanSnapshot.empty) {
            diagnostic.rejected_reasons.push('NO_SCAN_AVAILABLE');
            return diagnostic;
        }

        const latestScanDoc = latestScanSnapshot.docs[0];
        const latestScan = latestScanDoc.data() || {};
        const latestScanId = latestScan.scan_id || latestScanDoc.id;
        const scanCreatedAt = parseDateLike(latestScan.created_at || latestScan.createdAt);
        const scanAgeMinutes = scanCreatedAt ?
            (Date.now() - scanCreatedAt.getTime()) / (60 * 1000) :
            null;

        diagnostic.latest_scan_id = latestScanId;
        diagnostic.latest_scan_age_minutes = Number.isFinite(scanAgeMinutes) ?
            Number(scanAgeMinutes.toFixed(2)) :
            null;
        diagnostic.recent_scan_ok = config.require_recent_scan === true ?
            Number.isFinite(scanAgeMinutes) && scanAgeMinutes <= Number(config.max_scan_age_minutes || 0) :
            true;

        const candidateSnapshot = await db.collection(PAPER_CANDIDATES_COLLECTION)
            .where('scan_id', '==', latestScanId)
            .get();

        const candidates = candidateSnapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
        const sortedCandidates = [...candidates].sort((left, right) => Number(right.opportunityScore || 0) - Number(left.opportunityScore || 0));
        const scoreFiltered = sortedCandidates.filter((candidate) => Number(candidate.opportunityScore || 0) >= Number(config.min_opportunity_score || 0));
        const categoryFiltered = scoreFiltered.filter((candidate) => Array.isArray(config.allowed_categories) && config.allowed_categories.includes(candidate.category));

        const availableCapital = Math.max(0, Number(config.max_total_capital_usdt || 0) - Number(exposure.total || 0));
        const capitalAllowed = openPositionsCount < Number(config.max_open_positions || 0) &&
            availableCapital >= Number(config.max_position_usdt || 0);
        const capitalFiltered = capitalAllowed ? categoryFiltered : [];

        diagnostic.candidates_seen = candidates.length;
        diagnostic.candidates_after_score_filter = scoreFiltered.length;
        diagnostic.candidates_after_category_filter = categoryFiltered.length;
        diagnostic.candidates_after_capital_filter = capitalFiltered.length;
        diagnostic.selected_candidate = capitalFiltered[0] ? {
                symbol: String(capitalFiltered[0].symbol || '').toUpperCase(),
                score: Number(capitalFiltered[0].opportunityScore || 0),
                category: capitalFiltered[0].category || null,
                scan_id: capitalFiltered[0].scan_id || latestScanId
            } :
            null;

        if (diagnostic.recent_scan_ok === false) {
            diagnostic.rejected_reasons.push('SCAN_TOO_OLD');
        }
        if (!candidates.length) {
            diagnostic.rejected_reasons.push('NO_CANDIDATES_IN_LATEST_SCAN');
        }
        if (!scoreFiltered.length) {
            diagnostic.rejected_reasons.push('NO_CANDIDATES_MEET_SCORE');
        }
        if (!categoryFiltered.length) {
            diagnostic.rejected_reasons.push('NO_CANDIDATES_MEET_CATEGORY');
        }
        if (!capitalAllowed) {
            diagnostic.rejected_reasons.push('CAPITAL_OR_POSITION_LIMIT_REACHED');
        }

        return diagnostic;
    } catch (error) {
        diagnostic.rejected_reasons.push('ENTRY_DIAGNOSTIC_READ_FAILED');
        return diagnostic;
    }
}

/**
 * Evaluate open positions for exit (TP1, TP2, SL, TIMEOUT)
 */
async function evaluateOpenRealPositions(db, config, currentPrices = {}) {
    if (!db) {
        return { closed: 0 };
    }

    try {
        const snapshot = await db.collection(REAL_SPOT_POSITIONS_COLLECTION)
            .where('status', '==', 'REAL_OPEN')
            .get();

        let closedCount = 0;
        const now = new Date();

        // Get current prices from Binance if not provided
        let prices = { ...currentPrices };
        if (Object.keys(prices).length === 0 && snapshot.size > 0) {
            try {
                const symbols = snapshot.docs.map(doc => doc.data().symbol);
                for (const symbol of symbols) {
                    const priceResult = await createSignedBinanceSpotRequest('GET', '/api/v3/ticker/price', { symbol });
                    if (priceResult.price) {
                        prices[symbol] = parseFloat(priceResult.price);
                    }
                }
                console.log(`[REAL_EXECUTOR] Fetched ${Object.keys(prices).length} current prices from Binance`);
            } catch (priceErr) {
                console.warn('[REAL_EXECUTOR] Failed to fetch current prices:', priceErr.message);
            }
        }

        for (const doc of snapshot.docs) {
            const position = { id: doc.id, ...doc.data() };
            const currentPrice = prices[position.symbol] || null;

            // Check TP1
            if (currentPrice && currentPrice >= position.tp1_price) {
                await closeRealPosition(db, position, currentPrice, 'TP1');
                closedCount++;
                continue;
            }

            // Check TP2
            if (currentPrice && currentPrice >= position.tp2_price) {
                await closeRealPosition(db, position, currentPrice, 'TP2');
                closedCount++;
                continue;
            }

            // Check SL
            if (currentPrice && currentPrice <= position.sl_price) {
                await closeRealPosition(db, position, currentPrice, 'SL');
                closedCount++;
                continue;
            }

            // Check TIMEOUT
            const timeoutAt = parseDateLike(position.timeout_at);
            if (timeoutAt && timeoutAt.getTime() <= now.getTime()) {
                const exitPrice = currentPrice || position.entry_price;
                await closeRealPosition(db, position, exitPrice, 'TIMEOUT');
                closedCount++;
            }
        }

        return { closed: closedCount };
    } catch (error) {
        console.error('[REAL_EXECUTOR] Failed to evaluate positions:', error.message);
        return { closed: 0 };
    }
}

/**
 * Close real position
 */
async function closeRealPosition(db, position, exitPrice, closeReason) {
    if (!db || !position) {
        return { closed: false };
    }

    try {
        const resultId = `real_spot_result_${position.id}`;
        const now = new Date();
        const openedAt = parseDateLike(position.opened_at) || new Date();
        const durationHours = (now.getTime() - openedAt.getTime()) / (60 * 60 * 1000);

        const grossPnlUsdt = position.quantity * (exitPrice - position.entry_price);
        const estimatedFeeUsdt = position.capital_usdt * 0.001; // 0.1% fee estimate
        const netPnlUsdt = grossPnlUsdt - estimatedFeeUsdt;
        const netPnlPct = (netPnlUsdt / position.capital_usdt) * 100;

        // Update position to closed
        await db.collection(REAL_SPOT_POSITIONS_COLLECTION).doc(position.id).update({
            status: 'REAL_CLOSED',
            closed_at: now.toISOString(),
            closing_reason: closeReason,
            exit_price: exitPrice,
            pnl_usdt: netPnlUsdt
        });

        // Update balance: return capital from position back to available (add pnl if positive)
        const balanceRef = db.collection('real_spot_config').doc('balance');
        const currentBalance = await balanceRef.get();
        const balData = currentBalance.data() || {};
        const positionCapital = position.capital_usdt || 0;
        const returnedCapital = positionCapital + netPnlUsdt;
        
        await balanceRef.update({
            available_usdt: (balData.available_usdt || 0) + returnedCapital,
            in_positions_usdt: Math.max(0, (balData.in_positions_usdt || 0) - positionCapital),
            total_usdt: (balData.total_usdt || 561.47) + (netPnlUsdt > 0 ? netPnlUsdt : 0)
        });
        console.log(`[REAL_EXECUTOR] Capital returned: ${returnedCapital.toFixed(2)} USDT (original: ${positionCapital}, pnl: ${netPnlUsdt.toFixed(2)})`)

        // Create result record
        await db.collection(REAL_SPOT_RESULTS_COLLECTION).doc(resultId).set({
            id: resultId,
            position_id: position.id,
            symbol: position.symbol,
            entry_price: position.entry_price,
            exit_price: exitPrice,
            quantity: position.quantity,
            gross_pnl_usdt: grossPnlUsdt,
            estimated_fee_usdt: estimatedFeeUsdt,
            net_pnl_usdt: netPnlUsdt,
            net_pnl_pct: netPnlPct,
            closing_reason: closeReason,
            opened_at: position.opened_at,
            closed_at: now.toISOString(),
            duration_hours: durationHours,
            real_mode: true,
            safety_version: SAFETY_VERSION
        }, { merge: true });

        console.log(`[REAL_EXECUTOR] Closed ${position.symbol} by ${closeReason}: ${netPnlUsdt > 0 ? '+' : ''}${netPnlUsdt.toFixed(2)} USDT (${netPnlPct.toFixed(2)}%)`);

        return { closed: true, result_id: resultId };
    } catch (error) {
        console.error('[REAL_EXECUTOR] Failed to close position:', error.message);
        return { closed: false };
    }
}

/**
 * Build execution decision snapshot for forensic traceability
 * Captures exactly what config and data was used to decide execution
 *
 * FORENSIC ONLY - Does not change decision logic
 */
function buildExecutionDecisionSnapshot(candidate, config, diagnostic, options = {}) {
    if (!candidate || !config) return null;

    const snapshot = {
        // TIMING
        executed_at: new Date().toISOString(),

        // WHAT WAS EVALUATED
        symbol: String(candidate.symbol || '').toUpperCase(),
        score_at_execution: Number(candidate.opportunityScore || 0) || null,
        category_at_execution: candidate.category || null,

        // CONFIG THRESHOLDS USED
        min_score_required: Number(config.min_opportunity_score || 0),
        allowed_categories_at_execution: config.allowed_categories || [],

        // FILTER RESULTS
        passed_score_filter: Number(candidate.opportunityScore || 0) >= Number(config.min_opportunity_score || 0),
        passed_category_filter: Array.isArray(config.allowed_categories) && config.allowed_categories.includes(candidate.category),

        // TRACE
        source_module: 'binanceSpotRealExecutor.js::findBestRealSpotCandidate',
        intent_id: candidate.intent_id || options.intent_id || null,
        is_forced: options.is_forced === true,

        // REASON
        validation_reason: buildValidationReason({
            score: Number(candidate.opportunityScore || 0),
            threshold: Number(config.min_opportunity_score || 0),
            category: candidate.category,
            allowedCategories: config.allowed_categories
        }),

        // CONFIG STATE
        config_source: 'real_spot_config/control',
        config_updated_at: config.updated_at || config.updatedAt || null,

        // STRATEGY
        strategy_mode: options.strategy || 'CONSERVATIVE'
    };

    return snapshot;
}

/**
 * Helper to build human-readable validation reason
 */
function buildValidationReason(filters) {
    const reasons = [];

    if (filters.score >= filters.threshold) {
        reasons.push(`Score ${filters.score.toFixed(2)} >= ${filters.threshold}`);
    } else {
        reasons.push(`Score ${filters.score.toFixed(2)} < ${filters.threshold} [FAILED]`);
    }

    if (filters.allowedCategories && filters.allowedCategories.includes(filters.category)) {
        reasons.push(`Category ${filters.category} allowed`);
    } else {
        reasons.push(`Category ${filters.category} not in ${JSON.stringify(filters.allowedCategories)} [FAILED]`);
    }

    return reasons.join(' | ');
}

/**
 * Log near-miss opportunities when no candidate is selected
 * Captures candidates that almost passed filters, to audit if system is too restrictive
 *
 * FORENSIC ONLY - No execution impact, only observability
 */
async function logNearMissOpportunities(db, candidates, config, rejectionReason) {
    if (!db || !candidates || !config) return;

    try {
        const minScore = Number(config.min_opportunity_score || 70);
        const scoreBuffer = 10; // Consider near-miss if within 10 points of threshold

        // Find candidates that were close to passing
        const nearMisses = candidates
            .filter(c => {
                const score = Number(c.opportunityScore || 0);
                return score >= (minScore - scoreBuffer) && score < minScore;
            })
            .sort((a, b) => Number(b.opportunityScore || 0) - Number(a.opportunityScore || 0))
            .slice(0, 10); // Top 10 near-misses only

        if (nearMisses.length === 0) {
            return; // Nothing to log
        }

        const cycleId = `near_miss_${Date.now()}`;
        const nearMissLog = {
            cycle_id: cycleId,
            created_at: new Date().toISOString(),
            rejection_reason: rejectionReason || 'NO_CANDIDATE_PASSED_FILTERS',
            min_score_required: minScore,
            total_candidates_evaluated: candidates.length,
            near_miss_count: nearMisses.length,
            config_updated_at: config.updated_at || config.updatedAt || null,
            near_misses: nearMisses.map(candidate => ({
                symbol: String(candidate.symbol || '').toUpperCase(),
                score: Number(candidate.opportunityScore || 0),
                category: candidate.category || null,
                distance_to_threshold: Number(candidate.opportunityScore || 0) - minScore,
                passed_score_filter: Number(candidate.opportunityScore || 0) >= minScore,
                passed_category_filter: Array.isArray(config.allowed_categories) && config.allowed_categories.includes(candidate.category),
                volume_signal: candidate.volumeChangeScore || null,
                momentum_signal: candidate.weeklyMomentumScore || null,
                source_module: 'binanceSpotRealExecutor.js::logNearMissOpportunities'
            }))
        };

        // Save to Firestore
        await db.collection('near_miss_opportunity_log').doc(cycleId).set(nearMissLog);

        console.log(`[REAL_EXECUTOR::NEAR_MISS] Logged ${nearMisses.length} near-miss opportunities`);
        console.log(`  Reason: ${rejectionReason}`);
        console.log(`  Best near-miss: ${nearMisses[0].symbol} (score: ${Number(nearMisses[0].opportunityScore || 0).toFixed(2)}, ${minScore - Number(nearMisses[0].opportunityScore || 0)} points away)`);

    } catch (error) {
        console.error('[REAL_EXECUTOR::NEAR_MISS] Error logging near-miss:', error.message);
    }
}

/**
 * Find best real spot candidate from latest scan
 * Returns { candidate, diagnostic } with full filtering logic
 */
async function findBestRealSpotCandidate(db, config) {
    const diagnostic = createBaseEntryDiagnostic();

    if (!db) {
        diagnostic.rejected_reasons.push('NO_DATABASE');
        return { candidate: null, diagnostic };
    }

    try {
        // Get candidates from spot_opportunity_candidates (real-time collection)
        const candidateSnapshot = await db.collection('spot_opportunity_candidates')
            .orderBy('opportunityScore', 'desc')
            .limit(100)
            .get();

        const candidates = candidateSnapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
        
        diagnostic.latest_scan_id = 'REAL_TIME_SPOT_SCAN';
        diagnostic.latest_scan_age_minutes = 0;

        if (!candidates.length) {
            diagnostic.candidates_seen = 0;
            diagnostic.rejected_reasons.push('NO_CANDIDATES_AVAILABLE');
            return { candidate: null, diagnostic };
        }

        diagnostic.candidates_seen = candidates.length;

        // Filter by score
        const sortedCandidates = [...candidates].sort((left, right) =>
            Number(right.opportunityScore || 0) - Number(left.opportunityScore || 0)
        );
        const scoreFiltered = sortedCandidates.filter((candidate) =>
            Number(candidate.opportunityScore || 0) >= Number(config.min_opportunity_score || 0)
        );

        if (!scoreFiltered.length) {
            diagnostic.candidates_after_score_filter = 0;
            diagnostic.rejected_reasons.push('NO_CANDIDATES_MEET_SCORE');

            // Log near-miss opportunities for audit
            await logNearMissOpportunities(db, candidates, config, 'NO_CANDIDATES_MEET_SCORE');

            return { candidate: null, diagnostic };
        }

        diagnostic.candidates_after_score_filter = scoreFiltered.length;

        // Filter by category (only if allowed_categories is configured)
        let categoryFiltered = scoreFiltered;
        if (Array.isArray(config.allowed_categories) && config.allowed_categories.length > 0) {
            categoryFiltered = scoreFiltered.filter((candidate) =>
                config.allowed_categories.includes(candidate.category)
            );
            
            if (!categoryFiltered.length) {
                diagnostic.candidates_after_category_filter = 0;
                diagnostic.rejected_reasons.push('NO_CANDIDATES_MEET_CATEGORY');

                // Log near-miss opportunities for audit
                await logNearMissOpportunities(db, scoreFiltered, config, 'NO_CANDIDATES_MEET_CATEGORY');

                return { candidate: null, diagnostic };
            }
        } else {
            // No category filter configured, use all score-filtered candidates
            categoryFiltered = scoreFiltered;
        }

        diagnostic.candidates_after_category_filter = categoryFiltered.length;

        // Filter by capital and position limits
        const exposure = await getRealSpotCapitalExposure(db);
        const availableCapital = Math.max(0, Number(config.max_total_capital_usdt || 0) - Number(exposure.total || 0));

        // Check position limit
        const openSnapshot = await db.collection(REAL_SPOT_POSITIONS_COLLECTION)
            .where('status', '==', 'REAL_OPEN')
            .get();
        const openPositionsCount = openSnapshot.size;

        if (openPositionsCount >= Number(config.max_open_positions || 1)) {
            diagnostic.candidates_after_capital_filter = 0;
            diagnostic.rejected_reasons.push('MAX_OPEN_POSITIONS_REACHED');
            return { candidate: null, diagnostic };
        }

        if (availableCapital < Number(config.max_position_usdt || 10)) {
            diagnostic.candidates_after_capital_filter = 0;
            diagnostic.rejected_reasons.push('INSUFFICIENT_AVAILABLE_CAPITAL');
            return { candidate: null, diagnostic };
        }

        // Filter candidates by symbol uniqueness (no open position for same symbol)
        const capitalFiltered = [];
        for (const candidate of categoryFiltered) {
            const hasOpen = await hasOpenRealPosition(db, candidate.symbol);
            if (!hasOpen) {
                capitalFiltered.push(candidate);
            }
        }

        diagnostic.candidates_after_capital_filter = capitalFiltered.length;

        if (!capitalFiltered.length) {
            diagnostic.rejected_reasons.push('ALL_SYMBOLS_ALREADY_OPEN');

            // Log near-miss opportunities for audit
            await logNearMissOpportunities(db, categoryFiltered, config, 'ALL_SYMBOLS_ALREADY_OPEN');

            return { candidate: null, diagnostic };
        }

        // Select best candidate
        const selected = capitalFiltered[0];
        diagnostic.selected_candidate = {
            symbol: String(selected.symbol || '').toUpperCase(),
            score: Number(selected.opportunityScore || 0),
            category: selected.category || null,
            scan_id: selected.scan_id || 'REAL_TIME_SPOT_SCAN',
            id: selected.id || null
        };

        // BUILD EXECUTION DECISION SNAPSHOT FOR FORENSICS
        const executionDecisionSnapshot = buildExecutionDecisionSnapshot(selected, config, diagnostic);

        // LOG EXECUTION DECISION
        console.log(`[REAL_EXECUTOR::FORENSIC] Symbol: ${selected.symbol}`);
        console.log(`  Score Used: ${Number(selected.opportunityScore || 0).toFixed(2)} vs Threshold: ${Number(config.min_opportunity_score || 0)}`);
        console.log(`  Category: ${selected.category} vs Allowed: ${JSON.stringify(config.allowed_categories)}`);
        console.log(`  Reason: ${executionDecisionSnapshot.validation_reason}`);

        return {
            candidate: {
                ...selected,
                symbol: String(selected.symbol || '').toUpperCase(),
                execution_decision_snapshot: executionDecisionSnapshot // FORENSIC FIELD
            },
            diagnostic
        };

    } catch (error) {
        console.error('[REAL_EXECUTOR] Error finding best candidate:', error.message);
        diagnostic.rejected_reasons.push('CANDIDATE_SEARCH_FAILED');
        return { candidate: null, diagnostic };
    }
}

/**
 * MAIN: Run real spot execution cycle
 */
async function runRealSpotExecutionCycle(db, options = {}) {
    const cycleStart = new Date();

    console.log('[REAL_EXECUTOR] Starting real spot execution cycle...');

    // Get config
    const config = await getRealSpotConfig(db);

    // Validate config
    const configValidation = validateRealSpotConfig(config);
    if (!configValidation.valid) {
        console.log(`[REAL_EXECUTOR] Execution blocked: ${configValidation.reason}`);
        return {
            ok: true,
            real_mode: true,
            blocked: true,
            blocked_reason: configValidation.reason,
            config: { enabled: config.enabled, kill_switch: config.kill_switch },
            positions_closed: 0,
            positions_opened: 0,
            entry_diagnostic: createBaseEntryDiagnostic({
                rejected_reasons: [configValidation.reason],
                order_creation_path_reached: false,
                order_created: false
            }),
            duration_ms: new Date().getTime() - cycleStart.getTime()
        };
    }

    console.log('[REAL_EXECUTOR] Config valid, proceeding...');

    // Evaluate open positions for exits
    const exitResults = await evaluateOpenRealPositions(db, config, options.currentPrices || {});

    // Check if can open new positions
    const exposure = await getRealSpotCapitalExposure(db);
    const openPositions = await db.collection(REAL_SPOT_POSITIONS_COLLECTION)
        .where('status', '==', 'REAL_OPEN')
        .get();

    let openedCount = 0;
    let orderCreated = false;
    let selectedSymbol = null;

    // Try to find and execute a new position if allowed
    if (openPositions.size < config.max_open_positions && exposure.total < config.max_total_capital_usdt) {
        console.log('[REAL_EXECUTOR] Attempting to find and execute new position...');

        // Find best candidate
        const { candidate, diagnostic: findDiagnostic } = await findBestRealSpotCandidate(db, config);

        if (candidate) {
            console.log(`[REAL_EXECUTOR] Found candidate: ${candidate.symbol} (score: ${candidate.opportunityScore})`);

            // Get preflight for order validation
            const preflight = await runRealSpotPreflightCheck(db, config);

            if (!preflight.ok || !preflight.credentials_valid) {
                console.log('[REAL_EXECUTOR] Preflight failed, skipping order placement');
            } else {
                // Attempt order placement
                const orderResult = await placeSpotMarketBuy(
                    candidate.symbol,
                    config.max_position_usdt || 10,
                    config,
                    preflight
                );

                if (orderResult.ok && orderResult.order_created) {
                    console.log(`[REAL_EXECUTOR] Order created successfully: ${orderResult.orderId}`);

                    // Create intent
                    const intentResult = await createRealExecutionIntent(db, candidate, config.max_position_usdt || 10, config);
                    console.log(`[REAL_EXECUTOR] Intent created: ${intentResult?.id}`);

                    // Create position document
                    try {
                        const positionId = `real_spot_pos_${Date.now()}_${candidate.symbol}`;
                        const now = new Date();

                        // Calculate entry price
                        let entryPrice = 0;
                        if (orderResult.fills && orderResult.fills.length > 0) {
                            const totalQuote = orderResult.fills.reduce((sum, fill) => sum + parseFloat(fill.price || 0) * parseFloat(fill.qty || 0), 0);
                            const totalQty = orderResult.fills.reduce((sum, fill) => sum + parseFloat(fill.qty || 0), 0);
                            entryPrice = totalQty > 0 ? totalQuote / totalQty : orderResult.cummulativeQuoteQty / orderResult.executedQty;
                        } else {
                            entryPrice = orderResult.cummulativeQuoteQty / orderResult.executedQty;
                        }

                        // Calculate TP and SL prices
                        const tp1Price = entryPrice * (1 + (Number(config.take_profit_1_pct || 5) / 100));
                        const tp2Price = entryPrice * (1 + (Number(config.take_profit_2_pct || 10) / 100));
                        const slPrice = entryPrice * (1 + (Number(config.stop_loss_pct || -5) / 100));

                        // Extract strategy from options if available
                        const strategyMetadata = options.strategy_metadata || { strategy: 'CONSERVATIVE' };

                        // PREPARE FORENSIC SNAPSHOT
                        const positionData = {
                            id: positionId,
                            symbol: candidate.symbol,
                            scan_id: candidate.scan_id || findDiagnostic.latest_scan_id,
                            intent_id: intentResult?.id || null,
                            order_id: orderResult.orderId,
                            client_order_id: orderResult.clientOrderId || null,
                            status: 'REAL_OPEN',
                            entry_price: entryPrice,
                            quantity: orderResult.executedQty || 0,
                            capital_usdt: config.max_position_usdt || 10,
                            take_profit_1_pct: Number(config.take_profit_1_pct || 5),
                            take_profit_2_pct: Number(config.take_profit_2_pct || 10),
                            stop_loss_pct: Number(config.stop_loss_pct || -5),
                            tp1_price: tp1Price,
                            tp2_price: tp2Price,
                            sl_price: slPrice,
                            timeout_at: new Date(now.getTime() + (Number(config.timeout_hours || 24) * 60 * 60 * 1000)).toISOString(),
                            opened_at: now.toISOString(),
                            paper_only: false,
                            real_mode: true,
                            spot_only: true,
                            futures: false,
                            margin: false,
                            leverage: false,
                            // HYBRID MODE FIELDS
                            strategy: strategyMetadata.strategy || 'CONSERVATIVE',
                            strategy_info: strategyMetadata.strategy !== 'CONSERVATIVE' ? {
                                decision_reason: strategyMetadata.decision_reason,
                                tp_targets: strategyMetadata.tp_targets,
                                sl_target: strategyMetadata.sl_target,
                                timeout_hours: strategyMetadata.timeout_hours,
                                partial_exit: strategyMetadata.partial_exit
                            } : null,
                            safety_version: SAFETY_VERSION,

                            // FORENSIC FIELD - EXECUTION DECISION SNAPSHOT
                            execution_decision_snapshot: candidate.execution_decision_snapshot || null
                        };

                        await db.collection(REAL_SPOT_POSITIONS_COLLECTION).doc(positionId).set(positionData, { merge: true });

                        console.log(`[REAL_EXECUTOR] Position created: ${positionId}`);
                        console.log(`[REAL_EXECUTOR::FORENSIC] Snapshot saved - Score: ${positionData.execution_decision_snapshot?.score_at_execution || 'N/A'}, Threshold: ${positionData.execution_decision_snapshot?.min_score_required || 'N/A'}`);

                        // Update balance: move capital from available to in_positions
                        const balanceRef = db.collection('real_spot_config').doc('balance');
                        const currentBalance = await balanceRef.get();
                        const balData = currentBalance.data() || {};
                        const positionCapital = config.max_position_usdt || 10;
                        
                        await balanceRef.update({
                            available_usdt: Math.max(0, (balData.available_usdt || 0) - positionCapital),
                            in_positions_usdt: (balData.in_positions_usdt || 0) + positionCapital
                        });
                        console.log(`[REAL_EXECUTOR] Capital tracked: ${positionCapital} USDT moved to position`);

                        openedCount = 1;
                        orderCreated = true;
                        selectedSymbol = candidate.symbol;

                        // Update config with entry tracking (but DO NOT disable new entries)
                        await db.collection('real_spot_config').doc('control').update({
                            entries_used_this_session: (config.entries_used_this_session || 0) + 1,
                            last_entry_symbol: candidate.symbol,
                            last_entry_at: now.toISOString()
                        });

                        console.log('[REAL_EXECUTOR] Entry tracked, system remains ENABLED for new positions');

                    } catch (posErr) {
                        console.error('[REAL_EXECUTOR] Failed to create position:', posErr.message);
                    }

                } else {
                    console.log('[REAL_EXECUTOR] Order placement failed:', orderResult.reason);
                }
            }
        } else {
            console.log('[REAL_EXECUTOR] No suitable candidate found');
        }
    } else {
        console.log('[REAL_EXECUTOR] Cannot open new positions: limits reached');
    }

    // Rebuild entry diagnostic for output
    const exposure2 = await getRealSpotCapitalExposure(db);
    const openPositions2 = await db.collection(REAL_SPOT_POSITIONS_COLLECTION)
        .where('status', '==', 'REAL_OPEN')
        .get();
    const entryDiagnostic = await buildRealSpotEntryDiagnostic(db, config, exposure2, openPositions2.size);

    const cycleDuration = new Date().getTime() - cycleStart.getTime();

    return {
        ok: true,
        real_mode: true,
        blocked: false,
        positions_closed: exitResults.closed,
        positions_opened: openedCount,
        open_positions_count: openPositions2.size,
        total_capital_exposed: exposure2.total,
        selected_symbol: selectedSymbol || (entryDiagnostic.selected_candidate ? entryDiagnostic.selected_candidate.symbol : null),
        order_created: orderCreated,
        entry_diagnostic: entryDiagnostic,
        duration_ms: cycleDuration
    };
}

/**
 * Get real execution diagnostic
 */
async function getRealSpotExecutionDiagnostic(db) {
    if (!db) {
        return { real_spot_enabled: false, error: 'no_db' };
    }

    try {
        const config = await getRealSpotConfig(db);

        // Check credential status without exposing values
        const credentialStatus = await checkBinanceSpotCredentials();

        const openSnapshot = await db.collection(REAL_SPOT_POSITIONS_COLLECTION)
            .where('status', '==', 'REAL_OPEN')
            .get();

        const closedSnapshot = await db.collection(REAL_SPOT_RESULTS_COLLECTION).get();

        let totalNetPnl = 0;
        let wins = 0;
        let losses = 0;

        for (const doc of closedSnapshot.docs) {
            const result = doc.data();
            const pnl = Number(result.net_pnl_usdt || 0);
            totalNetPnl += pnl;

            if (pnl > 0) wins++;
            else if (pnl < 0) losses++;
        }

        const totalTrades = wins + losses;
        const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;

        let totalCapital = 0;
        const positionsBySymbol = {};

        for (const doc of openSnapshot.docs) {
            const pos = doc.data();
            totalCapital += Number(pos.capital_usdt || 0);
            positionsBySymbol[pos.symbol] = (positionsBySymbol[pos.symbol] || 0) + 1;
        }

        const recentTrades = [];
        for (const doc of closedSnapshot.docs) {
            const result = doc.data();
            recentTrades.push({
                symbol: result.symbol,
                close_reason: result.close_reason,
                net_pnl_usdt: result.net_pnl_usdt,
                net_pnl_pct: result.net_pnl_pct,
                closed_at: result.closed_at
            });
        }
        recentTrades.sort((a, b) => new Date(b.closed_at) - new Date(a.closed_at));
        const entryDiagnostic = await buildRealSpotEntryDiagnostic(db, config, { total: totalCapital }, openSnapshot.size);

        // Determine safety status
        let safety_status = 'UNKNOWN';
        if (config.enabled !== true) {
            safety_status = 'DISABLED';
        } else if (config.kill_switch === true) {
            safety_status = 'KILL_SWITCH_ACTIVE';
        } else {
            safety_status = 'ARMED';
        }

        return {
            ok: true,
            real_spot_enabled: config.enabled === true,
            kill_switch: config.kill_switch === true,
            mode: config.mode || 'REAL_SPOT_CONTROLLED_V1',
            safety_status,
            credentials_configured: credentialStatus.both_present,
            credentials_accessible: credentialStatus.both_accessible,
            api_key_present: credentialStatus.api_key_present,
            api_key_accessible: credentialStatus.api_key_accessible,
            api_secret_present: credentialStatus.api_secret_present,
            api_secret_accessible: credentialStatus.api_secret_accessible,
            open_real_positions: openSnapshot.size,
            closed_real_positions: closedSnapshot.size,
            total_real_capital_exposed: totalCapital,
            total_net_pnl_usdt: totalNetPnl,
            total_net_pnl_pct: totalTrades > 0 ? (totalNetPnl / (totalCapital || 1)) * 100 : 0,
            win_rate: winRate,
            positions_by_symbol: positionsBySymbol,
            recent_trades: recentTrades.slice(0, 20),
            entry_diagnostic: entryDiagnostic,
            config_summary: {
                max_total_capital_usdt: config.max_total_capital_usdt,
                max_position_usdt: config.max_position_usdt,
                max_open_positions: config.max_open_positions,
                take_profit_1_pct: config.take_profit_1_pct,
                take_profit_2_pct: config.take_profit_2_pct,
                stop_loss_pct: config.stop_loss_pct,
                timeout_hours: config.timeout_hours
            }
        };
    } catch (error) {
        console.error('[REAL_EXECUTOR] Failed to get diagnostic:', error.message);
        return {
            ok: false,
            error: error.message
        };
    }
}

/**
 * runRealSpotPreflightCheck
 *
 * Executes read-only signed call to Binance Spot /api/v3/account
 * WITHOUT creating any orders or positions.
 *
 * SAFETY:
 * - enabled and kill_switch must both be safe
 * - Only GET /api/v3/account is called
 * - No POST /api/v3/order
 * - No DELETE /api/v3/order
 * - No Futures, Margin, Leverage
 *
 * Returns:
 * {
 *   ok: true/false,
 *   credentials_valid: true/false,
 *   account_accessible: true/false,
 *   can_trade: true/false,
 *   can_withdraw: true/false,
 *   can_deposit: true/false,
 *   usdt_balance_free: number,
 *   usdt_balance_locked: number,
 *   non_zero_assets_count: number,
 *   real_spot_enabled: false,
 *   kill_switch: true,
 *   order_test_executed: false,
 *   real_order_created: false,
 *   safety_status: "PREFLIGHT_ONLY"
 * }
 */

/**
 * fetchBinanceApiRestrictions
 *
 * Fetch actual API key permissions from Binance /sapi/v1/account/apiRestrictions
 * This endpoint shows REAL API key restrictions, not just account capabilities.
 *
 * @param {string} apiKey - API key
 * @param {string} apiSecret - API secret
 * @returns {Promise<Object>} API restrictions or null on error
 */
async function fetchBinanceApiRestrictions(apiKey, apiSecret) {
    try {
        const axios = require('axios');
        const timestamp = Date.now();
        const queryString = `timestamp=${timestamp}&recvWindow=5000`;

        // Sign the request
        const signature = crypto
            .createHmac('sha256', apiSecret)
            .update(queryString)
            .digest('hex');

        const headers = {
            'X-MBX-APIKEY': apiKey,
            'Content-Type': 'application/json'
        };

        const url = `https://api.binance.com/sapi/v1/account/apiRestrictions?${queryString}&signature=${signature}`;

        const response = await axios.get(url, { headers, timeout: 10000 });
        const data = response.data;

        return {
            api_restrictions_accessible: true,
            enable_reading: data.enableReading === true,
            enable_spot_and_margin_trading: data.enableSpotAndMarginTrading === true,
            enable_withdrawals: data.enableWithdrawals === true,
            enable_internal_transfer: data.enableInternalTransfer === true,
            permits_universal_transfer: data.permitsUniversalTransfer === true,
            ip_restrict: data.ipRestrict === true,
            raw_permission_check_source: 'sapi_apiRestrictions'
        };
    } catch (error) {
        // If endpoint not accessible, return null - will use fallback to /api/v3/account
        return null;
    }
}

async function runRealSpotPreflightCheck(db) {
    if (!db) {
        return {
            ok: false,
            error: 'no_database',
            credentials_valid: false,
            account_accessible: false,
            real_order_created: false
        };
    }

    try {
        // Step 1: Load config (informational only - preflight always runs)
        const config = await getRealSpotConfig(db);

        // Step 2: Get credentials from Secret Manager
        let apiKey, apiSecret;
        try {
            const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');
            const client = new SecretManagerServiceClient();
            const PROJECT_ID = process.env.GCP_PROJECT || 'proypers2025';

            const apiKeyResource = client.secretVersionPath(PROJECT_ID, 'binance-spot-api-key', 'latest');
            const [apiKeyVersion] = await client.accessSecretVersion({ name: apiKeyResource });
            apiKey = apiKeyVersion.payload.data.toString('utf8');

            const apiSecretResource = client.secretVersionPath(PROJECT_ID, 'binance-spot-api-secret', 'latest');
            const [apiSecretVersion] = await client.accessSecretVersion({ name: apiSecretResource });
            apiSecret = apiSecretVersion.payload.data.toString('utf8');

            // AGGRESSIVE CLEANING
            apiKey = apiKey
                .replace(/^\uFEFF/, '')
                .replace(/[\x00-\x1F\x7F-\x9F]/g, '')
                .trim();

            apiSecret = apiSecret
                .replace(/^\uFEFF/, '')
                .replace(/[\x00-\x1F\x7F-\x9F]/g, '')
                .trim();

            if (!apiKey || !apiSecret || apiKey === '' || apiSecret === '') {
                return {
                    ok: false,
                    error: 'credentials_empty',
                    credentials_valid: false,
                    account_accessible: false,
                    real_spot_enabled: false,
                    kill_switch: true,
                    real_order_created: false,
                    safety_status: 'CREDENTIALS_EMPTY'
                };
            }
        } catch (credError) {
            return {
                ok: false,
                error: credError.message || 'credentials_fetch_failed',
                credentials_valid: false,
                account_accessible: false,
                real_spot_enabled: false,
                kill_switch: true,
                real_order_created: false,
                safety_status: 'CREDENTIALS_FETCH_ERROR'
            };
        }

        // Step 3: Get account info from /api/v3/account
        const axios = require('axios');
        let accountData;
        try {
            const timestamp = Date.now();
            const queryString = `recvWindow=5000&timestamp=${timestamp}`;

            const signature = crypto
                .createHmac('sha256', apiSecret)
                .update(queryString)
                .digest('hex');

            const headers = {
                'X-MBX-APIKEY': apiKey,
                'Content-Type': 'application/json'
            };

            const url = `https://api.binance.com/api/v3/account?${queryString}&signature=${signature}`;
            const response = await axios.get(url, { headers, timeout: 10000 });
            accountData = response.data;
        } catch (accountError) {
            return {
                ok: false,
                error: accountError.response?.data?.msg || accountError.message || 'account_fetch_failed',
                credentials_valid: false,
                account_accessible: false,
                real_spot_enabled: false,
                kill_switch: true,
                real_order_created: false,
                safety_status: 'PREFLIGHT_ERROR'
            };
        }

        // Step 4: Get API restrictions from /sapi/v1/account/apiRestrictions
        const restrictions = await fetchBinanceApiRestrictions(apiKey, apiSecret);

        if (!restrictions) {
            console.warn('[PREFLIGHT] Could not fetch API restrictions');
            return {
                ok: false,
                error: 'api_restrictions_not_accessible',
                credentials_valid: true,
                account_accessible: true,
                api_restrictions_accessible: false,
                can_trade: accountData.canTrade === true,
                can_withdraw_account_level: accountData.canWithdraw === true,
                enable_withdrawals_api_key: null,
                withdrawal_permission_safe: null,
                real_spot_enabled: false,
                kill_switch: true,
                real_order_created: false,
                safety_status: 'API_RESTRICTIONS_ERROR'
            };
        }

        // Step 5: Extract safe data from account
        const usdtBalance = accountData.balances?.find((b) => b.asset === 'USDT') || { free: 0, locked: 0 };
        const nonZeroAssets = accountData.balances?.filter((b) => parseFloat(b.free) > 0 || parseFloat(b.locked) > 0).length || 0;

        return {
            ok: true,
            credentials_valid: true,
            account_accessible: true,
            api_restrictions_accessible: restrictions.api_restrictions_accessible,
            can_trade: accountData.canTrade === true,
            can_withdraw_account_level: accountData.canWithdraw === true,
            enable_withdrawals_api_key: restrictions.enable_withdrawals,
            withdrawal_permission_safe: restrictions.enable_withdrawals === false,
            can_deposit: accountData.canDeposit === true,
            account_type: accountData.accountType || 'unknown',
            usdt_balance_free: parseFloat(usdtBalance.free || 0),
            usdt_balance_locked: parseFloat(usdtBalance.locked || 0),
            non_zero_assets_count: nonZeroAssets,
            real_spot_enabled: config.enabled === true,
            kill_switch: config.kill_switch === true,
            order_test_executed: false,
            real_order_created: false,
            safety_status: config.enabled === true && config.kill_switch === false ? 'READY_FOR_EXECUTION' : 'PREFLIGHT_ONLY'
        };

    } catch (error) {
        const errorMsg = error.response?.data?.msg || error.message || 'unknown_error';

        return {
            ok: false,
            error: errorMsg,
            credentials_valid: false,
            account_accessible: false,
            real_spot_enabled: false,
            kill_switch: true,
            order_test_executed: false,
            real_order_created: false,
            safety_status: 'PREFLIGHT_ERROR'
        };
    }
}

module.exports = {
    EXECUTOR_VERSION,
    SAFETY_VERSION,
    REAL_SPOT_INTENTS_COLLECTION,
    REAL_SPOT_POSITIONS_COLLECTION,
    REAL_SPOT_RESULTS_COLLECTION,
    getRealSpotConfig,
    validateRealSpotConfig,
    assertRealSpotTradingAllowed,
    createSignedBinanceSpotRequest,
    getSpotAccountInfo,
    validateSpotOrder,
    placeSpotMarketBuy,
    placeSpotMarketSell,
    getOrderStatus,
    isValidSpotSymbol,
    validateSpotOrderFilters,
    getRealSpotCapitalExposure,
    hasOpenRealPosition,
    createRealExecutionIntent,
    evaluateOpenRealPositions,
    closeRealPosition,
    findBestRealSpotCandidate,
    buildRealSpotEntryDiagnostic,
    runRealSpotExecutionCycle,
    getRealSpotExecutionDiagnostic,
    fetchBinanceApiRestrictions,
    runRealSpotPreflightCheck
};
