# Edge Consolidation Diagnostic - Documentación

## Endpoint: GET /api/analizar/diagnostico/edge-consolidation

### Descripción
Diagnóstico consolidado que unifica evidencia de trades reales y shadow para determinar si el problema económico es específico de símbolos, fees, timing, salidas, expected_move sobreestimado, o un problema general de la estrategia (broad_no_edge).

### Uso
```bash
curl -X GET "http://localhost:8080/api/analizar/diagnostico/edge-consolidation"
# o con parámetros opcionales:
curl -X GET "http://localhost:8080/api/analizar/diagnostico/edge-consolidation?hours=48"
```

### Respuesta
```json
{
  "ok": true,
  "report": {
    "executive_summary": {
      "real_trades": 0,
      "shadow_trades": 25,
      "pnl_neto_real": 0,
      "pnl_neto_shadow": -5.442695,
      "diagnostico_principal": "fees_dominate",
      "reactivar_bot": "no",
      "accion_recomendada": "revisar_sizing_y_fees",
      "tipo": "fees_dominate",
      "que_no_tocar": "model, thresholds, quality, handoff, sizing, capital, leverage, margin_type, max_concurrent_trades, order_submit",
      "condicion_minima_reactivacion": "PnL neto positivo sostenido en real y shadow, muestra n>=20"
    },
    "by_source": {
      "real": {
        "trades_count": 0,
        "pnl_bruto_total": 0,
        "fees_total": 0,
        "pnl_neto_total": 0,
        "win_rate_bruto": 0,
        "win_rate_neto": 0,
        "avg_entry_delay_ms": 0,
        "avg_duration_ms": 0,
        "close_reason_breakdown": [],
        "symbol_breakdown": []
      },
      "shadow": {
        "trades_count": 25,
        "pnl_bruto_total": -0.542695,
        "fees_total": 4.9,
        "pnl_neto_total": -5.442695,
        "win_rate_bruto": 40,
        "win_rate_neto": 8,
        "avg_entry_delay_ms": 0,
        "avg_duration_ms": 600000,
        "close_reason_breakdown": [
          {
            "close_reason": "max_hold_reached",
            "count": 25,
            "pnl_neto_total": -5.442695
          }
        ],
        "symbol_breakdown": [
          {
            "symbol": "BTCUSDT",
            "count": 5,
            "pnl_neto_total": -0.863397
          }
        ]
      }
    },
    "by_symbol": {
      "BTCUSDT": {
        "real_count": 0,
        "shadow_count": 5,
        "pnl_neto_real": 0,
        "pnl_neto_shadow": -0.863397,
        "pnl_neto_combined": -0.863397
      },
      "SOLUSDT": {
        "real_count": 0,
        "shadow_count": 7,
        "pnl_neto_real": 0,
        "pnl_neto_shadow": -1.837116,
        "pnl_neto_combined": -1.837116
      }
    },
    "analysis": {
      "fees": {
        "avg_fee_per_trade": 0.196,
        "avg_gross_move": 0.185109,
        "avg_net_move": -0.217708,
        "trades_bruto_positivo_neto_negativo": 10,
        "gap_to_break_even": 0.02979
      },
      "timing": [
        {
          "delay_bucket": "0-30s",
          "count": 0,
          "pnl_neto_total": 0,
          "avg_pnl_neto": 0
        }
      ],
      "exit_logic": [
        {
          "close_reason": "max_hold_reached",
          "count": 25,
          "pnl_neto_total": -5.442695,
          "avg_pnl_neto": -0.217708
        }
      ],
      "expected_vs_realized": {
        "avg_expected_move_at_entry": 0,
        "avg_realized_move": 0,
        "overestimation_ratio": 1,
        "expected_move_bins": []
      }
    },
    "diagnosis": ["fees_dominate"],
    "generated_at": "2026-05-02T19:27:37.644Z"
  }
}
```

### Clasificaciones de Diagnóstico

1. **broad_no_edge**: Real y shadow son negativos en BTC y SOL
2. **fees_dominate**: Muchos trades brutos positivos se vuelven netos negativos
3. **expected_move_overestimation**: Ratio de sobreestimación > 1.5x
4. **timing_delay_issue**: Pérdidas concentradas en delays altos (>90s)
5. **symbol_specific_issue**: Un símbolo negativo, otro positivo
6. **insufficient_sample**: Muestra < 10 trades total

### Reglas de Decisión para Reactivación

- **NO reactivar** si:
  - `broad_no_edge` o `fees_dominate` detectado
  - PnL neto real Y shadow son negativos
  - Muestra total < 15 trades

- **Considerar reactivación** solo si:
  - PnL neto real > 0 Y shadow > 0
  - No hay `broad_no_edge` ni `fees_dominate`
  - Muestra total >= 15 trades

### Acciones Recomendadas

- **continuar_shadow_sampling**: Muestra insuficiente
- **mantener_halted_indefinido**: Broad no edge
- **revisar_sizing_y_fees**: Fees dominan
- **filtrar_simbolos_problematicos**: Problema específico de símbolos
- **implementar_filtros_delay**: Problema de timing
- **monitorear_antes_reactivar**: Edge marginal detectado

### Qué NO Tocar (Siempre)

- model
- thresholds 
- quality
- handoff
- sizing
- capital
- leverage
- margin_type
- max_concurrent_trades
- order_submit

### Uso en Monitoreo

Este endpoint está diseñado para ser llamado regularmente para monitoreo del performance económico del sistema sin afectar la operación real del bot (que debe permanecer HALTED hasta evidencia clara de edge positivo).
