## 🎯 SYSTEM CONFIGURATION: 7-10 DAY 2X AGGRESSIVE STRATEGY

**Effective Date:** May 28, 2026 (~14:00 UTC)

---

## 📊 CAPITAL & GOALS

```
Initial Capital:          400 USDT (operative)
Holdings (hodl):          161.47 USDT (CATI + ANKR)
Total Available:          561.47 USDT

7-Day Target:             800 USDT (2x)
10-Day Target:            800 USDT (2x)
Daily Required Return:    +12% average
Session Strategy:         7DAY_2X_AGGRESSIVE
```

---

## ⚙️ TRADING PARAMETERS

### Position Management
```javascript
max_position_usdt:          55        // Capital per trade
max_open_positions:         5         // Concurrent open trades
min_opportunity_score:      70        // Quality threshold
```

### Take Profit & Stop Loss
```javascript
take_profit_1_pct:          10        // First exit target (+10%)
take_profit_2_pct:          15        // Second exit target (+15%)
stop_loss_pct:              -10       // Loss limit (-10%)
timeout_hours:              12        // Force close after 12h
```

### Capital Allocation
```
Per Position:       55 USDT
Max Simultaneous:   5 positions × 55 = 275 USDT
Always Reserved:    125 USDT (new opportunities)
```

---

## 💰 EXPECTED DAILY PERFORMANCE

```
Scenario: 3 Successful Trades/Day @ 12% Average Return

Day 1:  400 × 1.12 = 448 USDT    (+48)
Day 2:  448 × 1.12 = 501.8 USDT  (+53.8)
Day 3:  501.8 × 1.12 = 562 USDT  (+60.2)
Day 4:  562 × 1.12 = 629.4 USDT  (+67.4)
Day 5:  629.4 × 1.12 = 705 USDT  (+75.6)
Day 6:  705 × 1.12 = 789.6 USDT  (+84.6)
Day 7:  789.6 × 1.12 = 884.4 USDT (+94.8) ✅ EXCEEDS 2x

Result: 884 USDT (2.21x in 7 days)
```

---

## 🔄 TRADING CYCLE

```
1. SCAN (every 5 min via Cloud Scheduler)
   └─ Find 100+ altcoin opportunities
   
2. SELECT (quality score ≥70)
   └─ Pick best candidates (CATIUSDT, ANKRUSDT, etc.)
   
3. OPEN (max 5 concurrent)
   └─ 55 USDT per position
   └─ Use Binance SPOT market orders
   
4. MONITOR (continuous)
   └─ TP1: +10% exit → 60.5 USDT
   └─ TP2: +15% exit → 63.25 USDT
   └─ SL:  -10% exit → 49.5 USDT
   
5. CLOSE (automatic)
   └─ Hit TP1/TP2 → Lock profit
   └─ Hit SL → Cut loss
   └─ Hit 12h timeout → Force close
   
6. REINVEST (compounding)
   └─ Profits → Next trade capital
   └─ Maintain 55 USDT base per position
```

---

## 📈 COMPOUNDING TRACKER

**Firestore Doc:** `real_spot_config/compounding_tracker`

```json
{
  "start_date": "2026-05-28T14:00:00Z",
  "initial_capital": 400,
  "current_capital": 400,
  "target_capital_day_7": 800,
  "target_capital_day_10": 800,
  "trades_completed": 0,
  "cumulative_pnl": 0,
  "daily_returns": [],
  "last_update": "2026-05-28T14:00:00Z"
}
```

**Updates:** Every position close

---

## 🏆 SUCCESS METRICS

```
✅ TARGET HIT if:
   Day 7:   Capital ≥ 800 USDT
   Day 10:  Capital ≥ 800 USDT
   
⚠️ ADJUST if:
   Day 3:   Capital < 480 USDT
   Day 5:   Capital < 650 USDT
   
🔴 STOP if:
   Capital Falls ≤ 320 USDT (20% loss)
   Win Rate < 40% in last 10 trades
```

---

## 🔧 SYSTEM IMPROVEMENTS IMPLEMENTED

✅ **Capital Tracking:**
- Quantity recorded consistently (`quantity` field)
- Capital deducted from `available_usdt` when opening
- Capital returned + profit when closing

✅ **Auto-Fixes:**
- Monitor detects qty=undefined → auto close
- Monitor detects TP1=SL → auto close
- Monitor detects disable flags → auto correct

✅ **Deployment:**
- Code pushed to GitHub (commit 7680d2d)
- Cloud Build deployed to Cloud Run
- Config live in Firestore

---

## 📊 CORE HOLDINGS (Separate from Trading)

```
CATIUSDT:   831.2 tokens  
├─ Current PnL: +$45.38
├─ Strategy: HODL long-term
└─ Not traded (reserved hodl asset)

ANKRUSDT:   10,027.2 tokens
├─ Current PnL: +$45.12
├─ Strategy: HODL long-term
└─ Not traded (reserved hodl asset)
```

**Note:** Trading operates only on 400 USDT operative capital. Holdings remain untouched.

---

## ⚡ EXECUTION STATUS

```
✅ Code:           Deployed to Cloud Run
✅ Config:         Live in Firestore  
✅ Monitor:        Running (checks every 5s)
✅ Cloud Scheduler: Active (executes every 5 min)
✅ Capital:        561.47 USDT total
✅ Strategy:       7DAY_2X_AGGRESSIVE
✅ Status:         READY FOR TRADING
```

**Next Step:** Cloud Scheduler will execute next cycle in ~5 minutes.
System will open first position with corrected parameters.

---

*Configuration: Real-time Spot Trading with Aggressive Compounding*
*Risk Level: HIGH (fast cycling, 2x leverage in gains expectation)*
*Timeline: 7-10 days to double capital*
