/**
 * IMPULSE RISK MANAGER - Phase 6
 *
 * Control centralizado de riesgos
 */

const admin = require('firebase-admin');

const db = admin.firestore();

// Risk configuration
const RISK_CONFIG = {
  MAX_CONCURRENT_TRADES: 2,
  MAX_TRADES_PER_SYMBOL: 1,
  MAX_DAILY_LOSS_PERCENT: -2, // Stop trading if down 2% in a day
  MAX_CONSECUTIVE_LOSSES: 3,
  COOLDOWN_BETWEEN_TRADES_MS: 10 * 60 * 1000, // 10 minutes
  COOLDOWN_PER_SYMBOL_MS: 10 * 60 * 1000,
  MAX_POSITION_SIZE_PERCENT: 0.25
};

function getCooldownThreshold(windowMs) {
  return admin.firestore.Timestamp.fromMillis(Date.now() - windowMs);
}

async function getRecentClosedTradesForSymbol(symbol, windowMs) {
  const threshold = getCooldownThreshold(windowMs);
  const snapshot = await db.collection('active_impulse_trades')
    .where('symbol', '==', symbol)
    .get();

  return snapshot.docs
    .map((doc) => doc.data())
    .filter((trade) => trade?.closed_at && trade.closed_at.toMillis() > threshold.toMillis());
}

/**
 * Get current portfolio metrics
 */
async function getPortfolioMetrics() {
  try {
    const closedThreshold = getCooldownThreshold(24 * 60 * 60 * 1000);
    const openTradesSnapshot = await db.collection('active_impulse_trades')
      .where('status', '==', 'OPEN')
      .get();

    const closedTodaySnapshot = await db.collection('active_impulse_trades')
      .get();

    const closedTodayTrades = closedTodaySnapshot.docs
      .map((doc) => doc.data())
      .filter((trade) => trade?.closed_at && trade.closed_at.toMillis() > closedThreshold.toMillis());

    let totalOpenPnl = 0;
    let totalClosedPnl = 0;
    let winCount = 0;
    let lossCount = 0;

    // Open trades
    openTradesSnapshot.forEach(doc => {
      const trade = doc.data();
      if (trade.pnl_pct) {
        totalOpenPnl += trade.pnl_pct;
      }
    });

    // Closed trades
    closedTodayTrades.forEach((trade) => {
      if (trade.pnl_pct) {
        totalClosedPnl += trade.pnl_pct;
        if (trade.pnl_pct > 0) winCount++;
        else lossCount++;
      }
    });

    const totalPnlToday = totalOpenPnl + totalClosedPnl;
    const winRate = closedTodayTrades.length > 0
      ? (winCount / closedTodayTrades.length) * 100
      : 0;

    return {
      open_trades_count: openTradesSnapshot.size,
      open_trades_pnl: totalOpenPnl,
      closed_today: closedTodayTrades.length,
      closed_today_pnl: totalClosedPnl,
      total_pnl_today: totalPnlToday,
      win_count: winCount,
      loss_count: lossCount,
      win_rate: winRate
    };

  } catch (error) {
    console.error(`[RISK_METRICS] Error:`, error.message);
    return null;
  }
}

/**
 * Check if trading should be halted
 */
async function shouldHaltTrading() {
  try {
    const metrics = await getPortfolioMetrics();
    if (!metrics) return { should_halt: true, reason: 'Failed to get metrics' };

    // Check daily loss limit
    if (metrics.total_pnl_today <= RISK_CONFIG.MAX_DAILY_LOSS_PERCENT) {
      return {
        should_halt: true,
        reason: `Daily loss limit exceeded: ${metrics.total_pnl_today.toFixed(2)}% (threshold: ${RISK_CONFIG.MAX_DAILY_LOSS_PERCENT}%)`
      };
    }

    // Check consecutive losses
    if (metrics.loss_count >= RISK_CONFIG.MAX_CONSECUTIVE_LOSSES) {
      return {
        should_halt: true,
        reason: `Too many consecutive losses: ${metrics.loss_count} (threshold: ${RISK_CONFIG.MAX_CONSECUTIVE_LOSSES})`
      };
    }

    return { should_halt: false };

  } catch (error) {
    console.error(`[HALT_CHECK] Error:`, error.message);
    return { should_halt: true, reason: `Error: ${error.message}` };
  }
}

/**
 * Get symbol-specific risk status
 */
async function getSymbolRiskStatus(symbol) {
  try {
    // Get open trades for symbol
    const openSnapshot = await db.collection('active_impulse_trades')
      .where('symbol', '==', symbol)
      .where('status', '==', 'OPEN')
      .get();

    // Get recent closed trades for symbol
    const recentTrades = await getRecentClosedTradesForSymbol(symbol, RISK_CONFIG.COOLDOWN_PER_SYMBOL_MS);

    let lastTradeTime = null;
    if (recentTrades.length > 0) {
      lastTradeTime = recentTrades.reduce((latest, trade) => {
        const closedAt = trade.closed_at.toMillis();
        return Math.max(latest, closedAt);
      }, 0);
    }

    const cooldownExpired = !lastTradeTime || (Date.now() - lastTradeTime) > RISK_CONFIG.COOLDOWN_PER_SYMBOL_MS;

    return {
      symbol,
      open_trades: openSnapshot.size,
      can_trade: openSnapshot.size < RISK_CONFIG.MAX_TRADES_PER_SYMBOL && cooldownExpired,
      cooldown_expired: cooldownExpired,
      last_trade_time: lastTradeTime
    };

  } catch (error) {
    console.error(`[SYMBOL_RISK] Error for ${symbol}:`, error.message);
    return {
      symbol,
      open_trades: 0,
      can_trade: false,
      reason: `Error: ${error.message}`
    };
  }
}

/**
 * Validate trade can be executed
 */
async function validateTrade(symbol) {
  try {
    // Check global halt
    const haltCheck = await shouldHaltTrading();
    if (haltCheck.should_halt) {
      return { valid: false, reason: `Trading halted: ${haltCheck.reason}` };
    }

    // Check symbol-specific risk
    const symbolStatus = await getSymbolRiskStatus(symbol);
    if (!symbolStatus.can_trade) {
      return { valid: false, reason: `Symbol blocked: max trades reached or cooldown active` };
    }

    // Check global concurrent limit
    const openSnapshot = await db.collection('active_impulse_trades')
      .where('status', '==', 'OPEN')
      .get();

    if (openSnapshot.size >= RISK_CONFIG.MAX_CONCURRENT_TRADES) {
      return { valid: false, reason: `Max concurrent trades (${RISK_CONFIG.MAX_CONCURRENT_TRADES}) reached` };
    }

    return { valid: true };

  } catch (error) {
    console.error(`[VALIDATE_TRADE] Error for ${symbol}:`, error.message);
    return { valid: false, reason: `Validation error: ${error.message}` };
  }
}

/**
 * Log risk metrics
 */
async function logRiskMetrics() {
  try {
    const metrics = await getPortfolioMetrics();
    if (!metrics) return;

    console.log(`
[RISK_METRICS] ========================
Open Trades: ${metrics.open_trades_count}
Open PNL: ${metrics.open_trades_pnl.toFixed(2)}%

Closed Today: ${metrics.closed_today}
Closed PNL: ${metrics.closed_today_pnl.toFixed(2)}%
Win Rate: ${metrics.win_rate.toFixed(1)}%

Total PNL Today: ${metrics.total_pnl_today.toFixed(2)}%
========================
    `);

    // Check halt status
    const haltCheck = await shouldHaltTrading();
    if (haltCheck.should_halt) {
      console.log(`[RISK_HALT] WARNING: ${haltCheck.reason}`);
    }

  } catch (error) {
    console.error(`[LOG_METRICS] Error:`, error.message);
  }
}

module.exports = {
  getPortfolioMetrics,
  shouldHaltTrading,
  getSymbolRiskStatus,
  validateTrade,
  logRiskMetrics,
  RISK_CONFIG
};
