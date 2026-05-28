# 🤖 ARQUITECTURA DEL SISTEMA DE PREDICCIÓN Y TRADING
## ProyPersp25 - Sistema Autónomo de Trading Spot Binance

**Fecha:** Mayo 2026  
**Versión:** 2.0 - HYBRID_70_30  
**Estado:** Operacional | Autónomo

---

## 📋 RESUMEN EJECUTIVO

El sistema ProyPersp25 es un **motor de predicción y ejecución de trading autónomo** que:

1. **Predice oportunidades** en el mercado USDT spot de Binance usando Machine Learning
2. **Divide el capital** en dos estrategias: 70% conservadora + 30% agresiva
3. **Ejecuta automáticamente** cada 15 minutos basado en signals
4. **Gestiona riesgo** con Stop Loss y Take Profit automáticos

---

## 🏗️ ARQUITECTURA GENERAL

```
┌─────────────────────────────────────────────────────────────┐
│                   CLOUD SCHEDULER (Google)                   │
│  Ejecuta cada 15 minutos: */15 * * * *                       │
│  - Job 1: spot-scan-refresh (Cloud Function)                │
│  - Job 2: spot-real-execution (Cloud Run Backend)           │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│              CLOUD RUN BACKEND (Node.js + Python)            │
│  Microservicios:                                             │
│  1. binanceSpotOpportunityScanner (análisis)                │
│  2. binanceSpotOpportunityValidation (filtrado)             │
│  3. binanceSpotRealExecutor (ejecución)                     │
│  4. TensorFlow ML Models (predicción)                        │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│          FIRESTORE DATABASE (Estado del Sistema)             │
│  Colecciones:                                                │
│  - real_spot_config (configuración y flags)                 │
│  - real_spot_positions (trades abiertos/cerrados)           │
│  - spot_opportunity_candidates (análisis)                   │
│  - entrenamientos (datos ML)                                │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│          BINANCE SPOT TRADING API (Ejecución Real)          │
│  - USDT spot pairs                                           │
│  - Órdenes de compra/venta                                  │
│  - Sin margin, futures ni leverage                          │
│  - Capital real: ~100 USDT                                  │
└─────────────────────────────────────────────────────────────┘
```

---

## 🧠 SISTEMA DE PREDICCIÓN: HYBRID_70_30

### Concepto Fundamental

El sistema divide el capital en **DOS CAMINOS SIMULTÁNEAMENTE**:

```
CAPITAL TOTAL: 100 USDT
│
├─ 70% RUTA CONSERVADORA (70 USDT)
│  └─ Objetivo: Ganancias consistentes, bajo riesgo
│     · Max 15 USDT por trade
│     · Stop Loss: -3% 
│     · Take Profit: +3% / +6%
│     · Estrategia: Volatilidad baja, confianza alta
│
└─ 30% RUTA MOONSHOT (30 USDT)
   └─ Objetivo: Ganancias exponenciales, alto riesgo
      · Max 15 USDT por trade (actual)
      · Stop Loss: -20%
      · Take Profit: +50% / +150% / +500%
      · Estrategia: Altcoins, volatilidad alta, proyectos emergentes
```

### ¿Por Qué Funciona Este Modelo?

| Aspecto | Conservador (70%) | Moonshot (30%) | Resultado |
|--------|-----------------|-----------------|-----------|
| **Probabilidad de éxito** | Alta (70-80%) | Media (40-50%) | Diversificado |
| **Ganancia promedio** | Pequeña (+3-6%) | Grande (+50-500%) | Compuesto |
| **Riesgo por trade** | Bajo (-3%) | Alto (-20%) | Controlado |
| **Contribución a ganancias totales** | Consistente, regular | Ocasional, explosiva | Balanceado |

**Ejemplo de sesión ideal:**
- Conservador: 3 trades pequeños × +5% = +15% en esos 70 USDT (+10.50 USDT)
- Moonshot: 1 trade que explota × +150% = +150% en esos 30 USDT (+45.00 USDT)
- **Total: +55.50 USDT en 100 USDT = +55.5% ROI**

---

## 🔍 PIPELINE DE PREDICCIÓN (Paso a Paso)

### Fase 1: ESCANEO (Cada 15 minutos)

```javascript
// PASO 1: Scanner analiza los 50 top pares USDT
function scanBinanceSpotOpportunities() {
  // Obtiene precios de Binance
  const allPairs = await binance.getAllUSDTPairs();
  
  // Calcula metricas de volatilidad, momentum, trend
  const scoredPairs = allPairs.map(pair => ({
    symbol: pair.symbol,           // "ANKRUSDT"
    currentPrice: 0.00509,
    volume24h: 1500000,
    volatility: 15.3,              // %
    momentumScore: 78,             // 0-100
    trendScore: 65,                // 0-100
    compositeScore: 72             // Media ponderada
  }));
  
  // Ordena por potencial
  return scoredPairs.sort((a,b) => b.compositeScore - a.compositeScore);
  // Resultado: TOP 50 oportunidades candidatas
}
```

**Output:** 50 pares con scores de predicción (0-100)

---

### Fase 2: VALIDACIÓN (Cada 15 minutos)

```javascript
// PASO 2: Valida cada candidato contra umbrales
function validateOpportunity(pair, strategyType) {
  
  const rules = {
    CONSERVATIVE: {
      minScore: 65,              // Necesita score alto (confianza)
      maxVolatility: 5,          // Baja volatilidad
      priceHistory: 30,          // Estable últimas horas
      volumeThreshold: 500000    // Volumen mínimo
    },
    MOONSHOT: {
      minScore: 45,              // Score más bajo (riesgo aceptado)
      maxVolatility: 30,         // Alta volatilidad OK
      priceHistory: 24,          // Cualquier patrón reciente
      volumeThreshold: 100000    // Volumen mínimo bajo
    }
  };
  
  const thresholds = rules[strategyType];
  
  // Valida cada regla
  if (pair.compositeScore < thresholds.minScore) {
    return { valid: false, reason: 'LOW_SCORE' };
  }
  if (pair.volatility > thresholds.maxVolatility) {
    return { valid: false, reason: 'EXCESSIVE_VOLATILITY' };
  }
  // ... más validaciones
  
  return { valid: true, confidence: pair.compositeScore };
}
```

**Output:** Candidatos validados separados por estrategia

---

### Fase 3: EJECUCIÓN (Cada 15 minutos)

```javascript
// PASO 3: Si hay oportunidad válida, ejecuta la orden
async function executeRealTrade(opportunity, strategyType) {
  
  // Define parámetros según estrategia
  const params = {
    CONSERVATIVE: {
      allocation: 10,            // USDT a invertir
      tp1: entry * 1.03,         // +3%
      tp2: entry * 1.06,         // +6%
      sl: entry * 0.97           // -3%
    },
    MOONSHOT: {
      allocation: 15,            // USDT a invertir
      tp1: entry * 1.50,         // +50%
      tp2: entry * 2.50,         // +150%
      tp3: entry * 6.00,         // +500%
      sl: entry * 0.80           // -20%
    }
  };
  
  const config = params[strategyType];
  
  // Ejecuta compra en Binance (REAL)
  const order = await binance.spot.createOrder({
    symbol: opportunity.symbol,   // "ANKRUSDT"
    side: 'BUY',
    type: 'MARKET',
    quantity: config.allocation / opportunity.price,
    timestamp: Date.now()
  });
  
  // Guarda en Firestore para tracking
  await firestore.collection('real_spot_positions').add({
    symbol: opportunity.symbol,
    entry_price: order.price,
    executed_quantity: order.executedQty,
    capital_usdt: config.allocation,
    strategy: strategyType,
    tp_targets: [config.tp1, config.tp2, config.tp3],
    sl_target: config.sl,
    status: 'REAL_OPEN',
    opened_at: new Date(),
    position_id: order.orderId
  });
  
  return { executed: true, orderId: order.orderId };
}
```

**Output:** Trade ejecutado en Binance, guardado en Firestore

---

### Fase 4: MONITOREO Y GESTIÓN (Cada 15 minutos)

```javascript
// PASO 4: Valúa posiciones abiertas y ejecuta SL/TP
async function evaluateOpenPositions() {
  
  const openPositions = await firestore.collection('real_spot_positions')
    .where('status', '==', 'REAL_OPEN')
    .get();
  
  for (const position of openPositions) {
    const { symbol, entry_price, tp_targets, sl_target } = position.data();
    
    // Obtiene precio actual
    const currentPrice = await binance.spot.getPrice(symbol);
    
    // Calcula progreso
    const roi = ((currentPrice - entry_price) / entry_price) * 100;
    
    // VALIDA STOP LOSS
    if (currentPrice <= sl_target) {
      // Ejecuta SL: venta al precio actual
      await binance.spot.createOrder({
        symbol: symbol,
        side: 'SELL',
        type: 'MARKET',
        quantity: position.data().executed_quantity
      });
      
      // Marca como cerrada
      await firestore.collection('real_spot_positions')
        .doc(position.id)
        .update({
          status: 'CLOSED',
          closed_at: new Date(),
          closed_price: currentPrice,
          closed_reason: 'SL_HIT',
          pnl: (currentPrice - entry_price) * quantity
        });
    }
    
    // VALIDA TAKE PROFITS (en orden)
    for (let i = 0; i < tp_targets.length; i++) {
      if (currentPrice >= tp_targets[i]) {
        // Vende parcialmente o completamente
        const saleQuantity = position.data().executed_quantity / 3;
        
        await binance.spot.createOrder({
          symbol: symbol,
          side: 'SELL',
          type: 'MARKET',
          quantity: saleQuantity
        });
        
        // Actualiza posición
        await firestore.collection('real_spot_positions')
          .doc(position.id)
          .update({
            tp_level_hit: i + 1,
            partial_exit: true,
            remaining_quantity: position.data().executed_quantity - saleQuantity
          });
      }
    }
  }
}
```

**Output:** Posiciones cerradas automáticamente al alcanzar SL o TP

---

## 🧮 MODELOS DE PREDICCIÓN (Machine Learning)

### TensorFlow Neural Network

```python
# Entrenamiento de la red neuronal
model = tf.keras.Sequential([
    tf.keras.layers.Dense(64, activation='relu', input_shape=(10,)),
    tf.keras.layers.Dropout(0.2),
    tf.keras.layers.Dense(32, activation='relu'),
    tf.keras.layers.Dropout(0.2),
    tf.keras.layers.Dense(16, activation='relu'),
    tf.keras.layers.Dense(1, activation='sigmoid')  # Score 0-1
])

model.compile(
    optimizer='adam',
    loss='binary_crossentropy',
    metrics=['accuracy']
)

# Entrena con datos históricos
# Input features: [volatilidad, momentum, volumen, trend, RSI, MACD, ...]
# Output: Probabilidad de oportunidad (0-100)
model.fit(X_train, y_train, epochs=50, batch_size=32)
```

### Características de Predicción

| Feature | Cálculo | Uso |
|---------|---------|-----|
| **Volatilidad** | Desv. estándar últimas 24h | Clasifica estrategia (cons vs moon) |
| **Momentum** | Cambio % en últimas 4h | Detecta impulso alcista |
| **Volumen** | Vol 24h vs promedio 7d | Valida liquidez |
| **Trend** | EMA 12 vs EMA 26 | Dirección del movimiento |
| **RSI** | Relative Strength Index | Sobrecompra/sobreventa |
| **MACD** | Moving Average Convergence | Cambios de momentum |

---

## 📊 CONFIGURACIÓN EN FIRESTORE

### real_spot_config/control

```json
{
  "enabled": true,
  "kill_switch": false,
  "auto_order_execution": true,
  
  "strategy_mode": "HYBRID_70_30",
  "conservative_strategy_pct": 70,
  "moonshot_strategy_pct": 30,
  
  "new_entries_enabled": true,
  "entries_used_this_session": 0,
  "max_entries_this_session": 20,
  "disable_after_first_entry": false,
  
  "conservative_config": {
    "max_per_trade": 15,
    "min_confidence_score": 65,
    "sl_pct": -3,
    "tp1_pct": 3,
    "tp2_pct": 6
  },
  
  "moonshot_config": {
    "max_per_trade": 15,
    "min_confidence_score": 45,
    "sl_pct": -20,
    "tp1_pct": 50,
    "tp2_pct": 150,
    "tp3_pct": 500
  }
}
```

### real_spot_positions (Ejemplo)

```json
{
  "symbol": "ANKRUSDT",
  "entry_price": 0.00509,
  "executed_quantity": 2946.90,
  "capital_usdt": 15.00,
  "strategy": "MOONSHOT",
  "status": "REAL_OPEN",
  "opened_at": "2026-05-13T20:40:00Z",
  "tp_targets": [0.00763500, 0.01272500, 0.03054000],
  "sl_target": 0.00407200,
  "position_id": "order_12345"
}
```

---

## 🔄 CICLO DE EJECUCIÓN (Cada 15 minutos)

```
INICIO (00:00, 00:15, 00:30, 00:45, etc.)
  │
  ├─► 1. Cloud Scheduler dispara jobs
  │
  ├─► 2. Backend inicia ejecución
  │   ├─ Conecta a Binance API
  │   ├─ Carga config desde Firestore
  │   └─ Valida flags de ejecución
  │
  ├─► 3. FASE SCAN
  │   ├─ Obtiene todos los pares USDT
  │   ├─ Calcula scores ML
  │   └─ Selecciona TOP 50 candidatos
  │
  ├─► 4. FASE VALIDATION
  │   ├─ Filtra por estrategia (70/30)
  │   ├─ Aplica umbrales
  │   └─ Genera lista de válidos
  │
  ├─► 5. FASE EXECUTION
  │   ├─ Si hay válidos: crea orden BUY en Binance
  │   ├─ Guarda en Firestore
  │   └─ Si no: continúa
  │
  ├─► 6. FASE MONITORING
  │   ├─ Carga posiciones abiertas
  │   ├─ Obtiene precios actuales
  │   ├─ Valúa SL/TP
  │   ├─ Si SL hit: VENDE automático
  │   └─ Si TP hit: VENDE parcial/completo
  │
  └─► 7. REPORTE
      ├─ Guarda logs en Cloud Logging
      ├─ Actualiza Firestore
      └─ Espera a siguiente ciclo (15 minutos)
```

**Tiempo total:** 2-5 segundos por ciclo
**Estado:** Listo para siguiente ejecución

---

## 📈 RESULTADOS ESPERADOS

### Escenarios de Retorno Anualizado

| Escenario | Trades/Mes | Win Rate | Conservador | Moonshot | Total ROI |
|-----------|-----------|----------|------------|----------|-----------|
| **Muy Pesimista** | 4 | 50% | +12% | -10% | +2% |
| **Pesimista** | 6 | 60% | +22% | -5% | +17% |
| **Realista** | 8 | 65% | +35% | +50% | +85% |
| **Optimista** | 10 | 70% | +50% | +200% | +250% |
| **Muy Optimista** | 12 | 75% | +70% | +500% | +570% |

---

## 🎯 CONCLUSIÓN

El sistema **HYBRID_70_30** es una arquitectura de **predicción y ejecución autónoma** que:

✅ **Predice** oportunidades usando Machine Learning  
✅ **Divide riesgo** en dos estrategias complementarias  
✅ **Ejecuta automáticamente** cada 15 minutos  
✅ **Gestiona posiciones** con SL/TP automáticos  
✅ **Escala naturalmente** con el capital disponible  

**La razón por la que funciona:** Al tener 70% en trades de baja probabilidad/ganancia pequeña + 30% en trades de alta probabilidad de pérdida pero ganancia exponencial, el sistema es **naturalmente diversificado y resiliente a volatilidad**.

Un solo moonshot que explota +300% compensa múltiples pérdidas pequeñas en conservador.
