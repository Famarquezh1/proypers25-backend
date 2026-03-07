import { Component, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClientModule } from '@angular/common/http';
import { Observable, of } from 'rxjs';
import { finalize, map, shareReplay, switchMap } from 'rxjs/operators';
import { VelasService } from '../../../servicios/velas.service';
import { FirestoreService } from '../../../servicios/firestore.service';

interface WeeklyStability {
  isoWeek: string;
  weekLabel: string;
  total: number;
  wins: number;
  losses: number;
  winRate: number;
}

interface MonitoringTrendItem {
  createdAtLabel: string;
  winRate: number;
}

@Component({
  selector: 'app-predicciones-velas',
  standalone: true,
  imports: [CommonModule, FormsModule, HttpClientModule],
  templateUrl: './predicciones-velas.component.html',
  styleUrls: ['./predicciones-velas.component.css']
})
export class PrediccionesVelasComponent implements OnInit, OnDestroy {
  private readonly defaultSymbols = [
    'BTC-USD',
    'ETH-USD',
    'DOGE-USD',
    'HBAR-USD',
    'SOL-USD',
    'ADA-USD',
    'XRP-USD',
    'BNB-USD',
    'AVAX-USD',
    'LINK-USD',
    'MATIC-USD',
    'DOT-USD',
    'LTC-USD',
    'BCH-USD',
    'TRX-USD',
    'SHIB-USD',
    'TON-USD',
    'NEAR-USD',
    'ATOM-USD',
    'ICP-USD',
    'XLM-USD',
    'OP-USD',
    'ARB-USD',
    'INJ-USD',
    'APT-USD'
  ];
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  predicciones$: Observable<any[]> | undefined;
  oportunidades$: Observable<any[]> | undefined;
  highConvictionSignals$: Observable<any[]> | undefined;
  telegramNotifications$: Observable<any[]> | undefined;
  telegramWinNotifications$: Observable<any[]> | undefined;
  telegramPendingNotifications$: Observable<any[]> | undefined;
  latestTelegramAlert$: Observable<any | null> | undefined;
  monitoringSnapshots$: Observable<any[]> | undefined;
  binanceConfig$: Observable<any | null> | undefined;
  symbols: string[] = [];
  timeframes: string[] = [];
  candidatoSymbol = '';
  selectedTimeframe = '5m';
  monto = 1000;
  executionMode: 'timeframe' | 'event_driven' = 'timeframe';
  executionModes = [
    { value: 'timeframe', label: 'Timeframe (vigilar vela)' },
    { value: 'event_driven', label: 'Event-driven (ventanas)' }
  ];
  cargando = false;
  mensaje = '';
  verificandoId: string | null = null;
  expandedPredictionId: string | null = null;
  highConvictionFilter: 'recent' | '7d' | '30d' | 'custom' = 'recent';
  highConvictionOutcomeFilter: 'all' | 'win' | 'loss' | 'pendiente' | 'suprimida' | 'parcial' = 'all';
  highConvictionFrom = '';
  highConvictionTo = '';
  expandedHighConvictionId: string | null = null;
  highConvictionStats = {
    total: 0,
    wins: 0,
    losses: 0,
    pending: 0,
    suppressed: 0,
    partial: 0,
    winRate: 0,
    winRateEmitted: 0,
    winRateSuppressed: null as number | null,
    avgConfidence: 0,
    avgStability: 0
  };
  weeklyStability: WeeklyStability[] = [];
  monitoringSummary = {
    symbolsTotal: 0,
    processedOk: 0,
    failed: 0,
    emitted: 0,
    suppressed: 0,
    cycleDurationMs: 0,
    suppressionRate: 0,
    certaintyWinRate: 0,
    classification: 'n/a',
    updatedAt: 'â€”'
  };
  monitoringTrend: MonitoringTrendItem[] = [];
  lastEmissionAt = '—';
  lastEmissionCount = 0;
  nowTs = Date.now();
  binanceConfig = {
    mode: 'off',
    use_funds_percent: 35,
    account_capital_usdt: 100,
    dynamic_sizing_enabled: true,
    sizing_low_context_factor: 0.7,
    sizing_high_context_factor: 1.15,
    default_leverage: 5,
    margin_type: 'CROSSED',
    order_type: 'MARKET',
    enable_tp_sl: true,
    tp_buffer_pct: 0,
    sl_buffer_pct: 0,
    max_daily_trades: 1,
    min_confidence: 0.9,
    min_quantum: 0.85,
    min_timing: 0.8,
    min_context_score: 3,
    min_risk_reward: 1.2,
    min_expected_move_pct: 0.4,
    symbols_allowlist_text: '',
    early_exit_enabled: false,
    early_exit_drawdown_pct: 0.25
  };
  binanceConfigSaving = false;
  constructor(
    private velasService: VelasService,
    private firestoreService: FirestoreService
  ) {}

  ngOnInit(): void {
    this.refreshTimer = setInterval(() => {
      this.nowTs = Date.now();
    }, 1000);

    this.velasService.getDisponibles().subscribe((disponibles) => {
      const apiSymbols = Array.isArray(disponibles?.symbols) ? disponibles.symbols : [];
      this.symbols = Array.from(new Set([...apiSymbols, ...this.defaultSymbols]));
      this.timeframes = disponibles.timeframes || [];
      if (!this.candidatoSymbol && this.symbols.length) {
        this.candidatoSymbol = this.symbols[0];
      }
      this.cargarPredicciones();
    });
    this.cargarHighConvictionSignals();
    this.cargarTelegramNotifications();
    this.cargarMonitoringSnapshots();
    this.cargarBinanceConfig();
  }

  ngOnDestroy(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  cargarPredicciones(): void {
    const source$ = this.velasService.obtenerPrediccionesVelas().pipe(
      map((list) =>
        [...list].sort((a, b) => {
          const fechaA = new Date(a.created_at || a.timestamp).getTime();
          const fechaB = new Date(b.created_at || b.timestamp).getTime();
          return fechaB - fechaA;
        })
      ),
      shareReplay(1)
    );
    this.predicciones$ = source$;
    this.oportunidades$ = source$.pipe(
      map((list) => this.computeManualOpportunities(list))
    );
  }

  generarPrediccion(): void {
    if (!this.candidatoSymbol) {
      this.mensaje = 'Selecciona un sÃ­mbolo vÃ¡lido.';
      return;
    }
    this.cargando = true;
    this.mensaje = 'Generando predicciÃ³n...';
    this.velasService
      .generarPrediccion(this.candidatoSymbol, this.selectedTimeframe, this.monto, this.executionMode)
      .pipe(finalize(() => (this.cargando = false)))
      .subscribe({
        next: (prediccion) => {
          this.mensaje = `PredicciÃ³n para ${prediccion.simbolo} registrada.`;
          this.cargarPredicciones();
        },
        error: () => {
          this.mensaje = 'No se pudo generar la predicciÃ³n.';
        }
      });
  }

  verificar(pred: any): void {
    if (!pred?.id || pred.status !== 'pendiente') {
      return;
    }
    this.verificandoId = pred.id;
    this.velasService.verificarPrediccion(pred.id).pipe(
      finalize(() => (this.verificandoId = null))
    ).subscribe({
      next: (resultado) => {
      this.mensaje = resultado.verification?.remarks || 'VerificaciÃ³n completada.';
      this.cargarPredicciones();
    },
    error: () => {
      this.mensaje = 'FallÃ³ la verificaciÃ³n.';
    }
  });
  }

  statusClass(status: string): string {
    switch (status) {
      case 'pendiente':
        return 'badge bg-warning';
      case 'running':
      case 'in-progress':
        return 'badge bg-info text-white';
      case 'lstm_complete':
      case 'candlestick_complete':
      case 'entrenado':
        return 'badge bg-success';
      case 'skipped':
        return 'badge bg-secondary';
      case 'lstm_failed':
      case 'candlestick_failed':
      case 'failed':
      case 'error':
        return 'badge bg-danger';
      case 'validado':
        return 'badge bg-success';
      case 'fallido':
        return 'badge bg-danger';
      default:
        return 'badge bg-secondary';
    }
  }

  formatLocalTime(value: string): string {
    if (!value) return 'â€”';
    const date = new Date(value);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', timeZoneName: 'short' });
  }

  offsetMinutesFromUTC(value: string): number {
    if (!value) return 0;
    const target = new Date(value).getTime();
    const now = Date.now();
    return Math.round((now - target) / 60000);
  }

  eventDrivenOffsetLabel(windowStart?: string): string {
    if (!windowStart) return '';
    const offset = this.offsetMinutesFromUTC(windowStart);
    if (!offset) {
      return 'Tu reloj coincide con UTC para la ventana de ejecuciÃ³n.';
    }
    const sign = offset > 0 ? '+' : '';
    return `Tu reloj estÃ¡ ${sign}${offset} min respecto a UTC para la ventana de entrada.`;
  }

  offsetLabel(value: string): string {
    const offset = this.offsetMinutesFromUTC(value);
    if (!offset) return 'coincide con UTC';
    const sign = offset > 0 ? '+' : '';
    return `Tu reloj estÃ¡ ${sign}${offset} min respecto a UTC`;
  }

  private formatCountdown(ms: number): string {
    const totalSeconds = Math.max(Math.round(ms / 1000), 0);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  }

  windowDayLabel(pred: any, type: 'entry' | 'exit'): string {
    const now = new Date();
    const { entryStart, exitStart, exitEnd } = this.getEventDrivenWindowDates(pred);
    const prefix = type === 'entry' ? 'Entrada' : 'Salida';
    const targetDate = type === 'entry' ? entryStart : exitStart;
    if (!targetDate) {
      return `${prefix} (UTC)`;
    }
    if (exitEnd && exitEnd.getTime() < now.getTime()) {
      return `${prefix} (UTC Â· Expirada)`;
    }
    const dayLabel = this.labelForDay(targetDate, now);
    return `${prefix} (UTC Â· ${dayLabel})`;
  }

  opportunityState(item: any): string {
    if (item.phase === 'entry_open') {
      return item.signal_emitted ? 'lista para entrar' : 'casi lista';
    }
    return item.signal_emitted ? 'emitida' : 'setup';
  }

  opportunityStateClass(item: any): string {
    switch (item.phase) {
      case 'entry_open':
        return 'opp-badge opp-open';
      case 'pre_entry':
        return item.signal_emitted ? 'opp-badge opp-emitted' : 'opp-badge opp-setup';
      default:
        return 'opp-badge opp-muted';
    }
  }

  opportunityWindowLabel(item: any): string {
    if (item.phase === 'entry_open') {
      return 'Ventana abierta';
    }
    return 'Comienza en';
  }

  opportunityCountdown(item: any): string {
    const target = item.phase === 'entry_open' ? item.entryEndMs : item.entryStartMs;
    return this.formatCountdown(Math.max(target - this.nowTs, 0));
  }

  opportunityCountdownClass(item: any): string {
    if (item.phase === 'entry_open') {
      return 'opp-countdown opp-countdown-open';
    }
    return 'opp-countdown opp-countdown-soon';
  }

  opportunityLocalWindow(item: any, key: 'start' | 'end'): string {
    return this.formatUtcClockToLocal(item?.entry_window?.[key], item?.entry_time);
  }

  opportunityPriority(item: any): string {
    if (item.signal_emitted && item.confidence >= 0.9 && item.stability >= 0.85) {
      return 'Alta';
    }
    if (item.signal_emitted || item.stability >= 0.8) {
      return 'Media';
    }
    return 'ObservaciÃ³n';
  }

  private getEventDrivenWindowDates(pred: any): {
    entryStart: Date | null;
    entryEnd: Date | null;
    exitStart: Date | null;
    exitEnd: Date | null;
  } {
    const entryStart = pred.entry_time ? new Date(pred.entry_time) : null;
    const exitEnd = pred.exit_time ? new Date(pred.exit_time) : null;
    const entryEnd = this.parseWindowWithDate(pred.entry_window?.end, entryStart, true);
    const exitStart = this.parseWindowWithDate(pred.exit_window?.start, exitEnd, false);
    return { entryStart, entryEnd, exitStart, exitEnd };
  }

  private computeManualOpportunities(list: any[]): any[] {
    const now = this.nowTs;

    return (list || [])
      .map((pred) => {
        if (pred?.execution_mode !== 'event_driven') {
          return null;
        }

        const status = String(pred?.status || '').toLowerCase();
        if (['suprimida', 'fallido', 'validado', 'validado-parcial'].includes(status)) {
          return null;
        }

        const { entryStart, entryEnd } = this.getEventDrivenWindowDates(pred);
        if (!entryStart || !entryEnd) {
          return null;
        }

        const entryStartMs = entryStart.getTime();
        const entryEndMs = entryEnd.getTime();
        if (entryEndMs <= now) {
          return null;
        }

        const confidence = this.normalizePercent(pred?.confianza);
        const quantum = this.normalizePercent(pred?.quantum_score);
        const timing = this.normalizePercent(pred?.timing_score);
        const stability = this.resolveSignalStability(pred, confidence, quantum, timing);
        const signalEmitted = pred?.signal_emitted === true;

        const qualifiesAsEmitted =
          signalEmitted && confidence >= 0.85 && stability >= 0.8 && quantum >= 0.8 && timing >= 0.75;
        const qualifiesAsPreview =
          !signalEmitted && confidence >= 0.82 && stability >= 0.78 && quantum >= 0.75 && timing >= 0.72;

        if (!qualifiesAsEmitted && !qualifiesAsPreview) {
          return null;
        }

        const phase = now >= entryStartMs ? 'entry_open' : 'pre_entry';
        const urgencyMs = phase === 'entry_open' ? entryEndMs - now : entryStartMs - now;

        return {
          ...pred,
          confidence,
          quantum,
          timing,
          stability,
          phase,
          signal_emitted: signalEmitted,
          entryStartMs,
          entryEndMs,
          urgencyMs
        };
      })
      .filter((item): item is any => !!item)
      .sort((a, b) => {
        if (a.urgencyMs !== b.urgencyMs) {
          return a.urgencyMs - b.urgencyMs;
        }
        if (b.stability !== a.stability) {
          return b.stability - a.stability;
        }
        return b.confidence - a.confidence;
      })
      .slice(0, 6);
  }

  private parseWindowWithDate(value?: string, reference?: Date | null, expectAfter = false): Date | null {
    if (!value) {
      return null;
    }
    const parts = value.split(':').map((segment) => Number(segment));
    if (parts.length !== 3 || parts.some((part) => Number.isNaN(part))) {
      return null;
    }
    const [hours, minutes, seconds] = parts;
    const base = reference ? reference : new Date();
    const candidate = new Date(
      Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), hours, minutes, seconds)
    );
    if (!reference) {
      if (candidate.getTime() < base.getTime()) {
        candidate.setUTCDate(candidate.getUTCDate() + 1);
      }
      return candidate;
    }
    if (expectAfter && candidate.getTime() <= reference.getTime()) {
      candidate.setUTCDate(candidate.getUTCDate() + 1);
    } else if (!expectAfter && candidate.getTime() >= reference.getTime()) {
      candidate.setUTCDate(candidate.getUTCDate() - 1);
    }
    return candidate;
  }

  private labelForDay(date: Date, now: Date): string {
    const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0));
    const tomorrow = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0)
    );
    if (
      date.getUTCFullYear() === today.getUTCFullYear() &&
      date.getUTCMonth() === today.getUTCMonth() &&
      date.getUTCDate() === today.getUTCDate()
    ) {
      return 'Hoy';
    }
    if (
      date.getUTCFullYear() === tomorrow.getUTCFullYear() &&
      date.getUTCMonth() === tomorrow.getUTCMonth() &&
      date.getUTCDate() === tomorrow.getUTCDate()
    ) {
      return 'MaÃ±ana';
    }
    return date.toISOString().slice(0, 10);
  }

  projectionFor(pred: any): { gain: number; loss: number; value: number } {
    const amount = Number(this.monto);
    if (!isFinite(amount) || amount <= 0) {
      return { gain: 0, loss: 0, value: 0 };
    }
    const deltaPct = Number(pred.expected_delta_pct ?? 0);
    const impact = (amount * deltaPct) / 100;
    const absImpact = Math.abs(impact);
    return {
      gain: absImpact,
      loss: absImpact,
      value: amount
    };
  }

  formatCurrency(value: number): string {
    return `$${value.toFixed(2)}`;
  }

  togglePredictionDetails(predId: string): void {
    this.expandedPredictionId = this.expandedPredictionId === predId ? null : predId;
  }

  isPredictionExpanded(predId: string): boolean {
    return this.expandedPredictionId === predId;
  }

  verificationOutcomeLabel(pred: any): string {
    const outcome =
      pred?.verification?.verification_outcome ||
      pred?.verification?.outcome_label ||
      pred?.verification_outcome ||
      null;
    if (!outcome) return 'Sin verificar';
    return String(outcome).toUpperCase();
  }

  cargarHighConvictionSignals(): void {
    let source$: Observable<any[]>;
    if (this.highConvictionFilter === '7d') {
      source$ = this.firestoreService.getHighConvictionSignalsByDateRange({ days: 7, max: 60 });
    } else if (this.highConvictionFilter === '30d') {
      source$ = this.firestoreService.getHighConvictionSignalsByDateRange({ days: 30, max: 120 });
    } else if (this.highConvictionFilter === 'custom' && this.highConvictionFrom && this.highConvictionTo) {
      const from = new Date(`${this.highConvictionFrom}T00:00:00`);
      const to = new Date(`${this.highConvictionTo}T23:59:59`);
      source$ = this.firestoreService.getHighConvictionSignalsByDateRange({
        from,
        to,
        max: 120
      });
    } else {
      source$ = this.firestoreService.getHighConvictionSignals(20);
    }

    this.highConvictionSignals$ = source$.pipe(
      switchMap((signals) => this.enrichHighConvictionSignals(signals)),
      map((signals) => this.applyHighConvictionOutcomeFilter(signals)),
      map((signals) => {
        this.highConvictionStats = this.computeHighConvictionStats(signals);
        this.weeklyStability = this.computeWeeklyStability(signals);
        return signals;
      })
    );
  }

  cargarTelegramNotifications(): void {
    const source$ = this.firestoreService.getTelegramNotifications(20).pipe(
      map((items) =>
        (items || [])
          .filter((item) => item?.['type'] === 'manual_prealert' && item?.['sent'] !== false)
          .sort((a, b) => this.resolveNotificationDate(b).getTime() - this.resolveNotificationDate(a).getTime())
      ),
      switchMap((alerts) => this.enrichTelegramNotifications(alerts)),
      shareReplay(1)
    );

    this.telegramNotifications$ = source$;
    this.latestTelegramAlert$ = source$.pipe(map((alerts) => alerts[0] ?? null));
    this.telegramWinNotifications$ = source$.pipe(
      map((alerts) => (alerts || []).filter((alert) => this.telegramAlertOutcome(alert) === 'WIN'))
    );
    this.telegramPendingNotifications$ = source$.pipe(
      map((alerts) =>
        (alerts || []).filter((alert) => this.telegramAlertOutcome(alert) !== 'WIN')
      )
    );
  }

  cargarMonitoringSnapshots(): void {
    this.monitoringSnapshots$ = this.firestoreService.getMonitoringSnapshots<any>(20).pipe(
      map((items) =>
        (items || []).sort(
          (a, b) => this.resolveMonitoringDate(b).getTime() - this.resolveMonitoringDate(a).getTime()
        )
      ),
      map((items) => {
        this.monitoringSummary = this.computeMonitoringSummary(items);
        this.monitoringTrend = this.computeMonitoringTrend(items);
        return items;
      }),
      shareReplay(1)
    );
  }

  onHighConvictionFilterChange(): void {
    if (this.highConvictionFilter !== 'custom') {
      this.highConvictionFrom = '';
      this.highConvictionTo = '';
    }
    this.expandedHighConvictionId = null;
    this.cargarHighConvictionSignals();
  }

  applyCustomHighConvictionRange(): void {
    if (!this.highConvictionFrom || !this.highConvictionTo) {
      return;
    }
    this.expandedHighConvictionId = null;
    this.cargarHighConvictionSignals();
  }

  onHighConvictionOutcomeFilterChange(): void {
    this.expandedHighConvictionId = null;
    this.cargarHighConvictionSignals();
  }

  toggleHighConvictionDetails(signalId: string): void {
    this.expandedHighConvictionId = this.expandedHighConvictionId === signalId ? null : signalId;
  }

  isHighConvictionExpanded(signalId: string): boolean {
    return this.expandedHighConvictionId === signalId;
  }

  highConvictionOutcome(signal: any): string {
    const raw = (
      signal?.verification_outcome ||
      signal?.verification?.verification_outcome ||
      signal?.verification?.outcome_label ||
      signal?.status ||
      'PENDIENTE'
    ).toString().toUpperCase();

    if (raw.includes('WIN') || raw === 'VALIDADO') return 'WIN';
    if (raw.includes('LOSS') || raw === 'FALLIDO') return 'LOSS';
    if (raw.includes('SUPPRESSED') || raw === 'SUPRIMIDA') return 'SUPRIMIDA';
    if (raw.includes('PARTIAL') || raw.includes('PARCIAL')) return 'PARCIAL';
    return 'PENDIENTE';
  }

  highConvictionStatusClass(signal: any): string {
    switch (this.highConvictionOutcome(signal)) {
      case 'WIN':
        return 'hc-badge hc-win';
      case 'LOSS':
        return 'hc-badge hc-loss';
      case 'SUPRIMIDA':
        return 'hc-badge hc-suppressed';
      case 'PARCIAL':
        return 'hc-badge hc-partial';
      default:
        return 'hc-badge hc-pending';
    }
  }

  normalizePercent(value: any): number {
    const n = Number(value ?? 0);
    if (!isFinite(n)) return 0;
    return n > 1 ? n / 100 : n;
  }

  resolvePrice(signal: any, type: 'spot' | 'estimated' | 'real'): number | null {
    if (type === 'spot') {
      const v =
        signal?.spot_price ??
        signal?.precio_actual ??
        signal?.linkedPrediction?.spot_price ??
        signal?.linkedPrediction?.precio_actual ??
        signal?.linkedPrediction?.precio_estimado ??
        signal?.spot ??
        null;
      return v == null ? null : Number(v);
    }
    if (type === 'estimated') {
      const v =
        signal?.model_price_estimate ??
        signal?.precio_estimado ??
        signal?.linkedPrediction?.model_price_estimate ??
        signal?.linkedPrediction?.precio_estimado ??
        signal?.linkedPrediction?.expected_price ??
        signal?.expected_price ??
        null;
      return v == null ? null : Number(v);
    }
    const v =
      signal?.verification?.final_price ??
      signal?.final_price ??
      signal?.linkedPrediction?.verification?.final_price ??
      signal?.linkedPrediction?.final_price ??
      signal?.real_price ??
      null;
    return v == null ? null : Number(v);
  }

  highConvictionRemarks(signal: any): string {
    return signal?.verification?.remarks || signal?.linkedPrediction?.verification?.remarks || signal?.remarks || 'Sin observaciones';
  }

  highConvictionBinanceExecution(signal: any): any {
    return signal?.binance_execution || signal?.linkedPrediction?.binance_execution || null;
  }

  highConvictionBinanceStatus(signal: any): string {
    const exec = this.highConvictionBinanceExecution(signal);
    if (!exec) return 'Sin intento';
    if (exec.executed) return 'Ejecutada';
    if (exec.dry_run) return 'Dry-run';
    if (exec.attempted) return 'Omitida';
    return 'Sin intento';
  }

  highConvictionBinanceStatusClass(signal: any): string {
    const status = this.highConvictionBinanceStatus(signal);
    if (status === 'Ejecutada') return 'hc-badge hc-win';
    if (status === 'Dry-run') return 'hc-badge hc-partial';
    if (status === 'Omitida') return 'hc-badge hc-suppressed';
    return 'hc-badge hc-pending';
  }

  cargarBinanceConfig(): void {
    this.binanceConfig$ = this.firestoreService.getBinanceBotConfig<any>().pipe(shareReplay(1));
    this.binanceConfig$.subscribe((config) => {
      if (!config) return;
      this.binanceConfig = {
        ...this.binanceConfig,
        mode: config.mode || this.binanceConfig.mode,
        use_funds_percent: Number(config.use_funds_percent ?? this.binanceConfig.use_funds_percent),
        account_capital_usdt: Number(config.account_capital_usdt ?? this.binanceConfig.account_capital_usdt),
        dynamic_sizing_enabled: config.dynamic_sizing_enabled !== false,
        sizing_low_context_factor: Number(
          config.sizing_low_context_factor ?? this.binanceConfig.sizing_low_context_factor
        ),
        sizing_high_context_factor: Number(
          config.sizing_high_context_factor ?? this.binanceConfig.sizing_high_context_factor
        ),
        default_leverage: Number(config.default_leverage ?? this.binanceConfig.default_leverage),
        margin_type: config.margin_type || this.binanceConfig.margin_type,
        order_type: config.order_type || this.binanceConfig.order_type,
        enable_tp_sl: config.enable_tp_sl !== false,
        tp_buffer_pct: Number(config.tp_buffer_pct ?? this.binanceConfig.tp_buffer_pct),
        sl_buffer_pct: Number(config.sl_buffer_pct ?? this.binanceConfig.sl_buffer_pct),
        max_daily_trades: Number(config.max_daily_trades ?? this.binanceConfig.max_daily_trades),
        min_confidence: Number(config.min_confidence ?? this.binanceConfig.min_confidence),
        min_quantum: Number(config.min_quantum ?? this.binanceConfig.min_quantum),
        min_timing: Number(config.min_timing ?? this.binanceConfig.min_timing),
        min_context_score: Number(config.min_context_score ?? this.binanceConfig.min_context_score),
        min_risk_reward: Number(config.min_risk_reward ?? this.binanceConfig.min_risk_reward),
        min_expected_move_pct: Number(config.min_expected_move_pct ?? this.binanceConfig.min_expected_move_pct),
        early_exit_enabled: Boolean(config.early_exit_enabled),
        early_exit_drawdown_pct: Number(
          config.early_exit_drawdown_pct ?? this.binanceConfig.early_exit_drawdown_pct
        ),
        symbols_allowlist_text: Array.isArray(config.symbols_allowlist)
          ? config.symbols_allowlist.join(', ')
          : this.binanceConfig.symbols_allowlist_text
      };
    });
  }

  async guardarBinanceConfig(): Promise<void> {
    if (this.binanceConfigSaving) return;
    this.binanceConfigSaving = true;
    const symbols = this.binanceConfig.symbols_allowlist_text
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter((s) => !!s);

    const payload = {
      mode: this.binanceConfig.mode,
      use_funds_percent: Number(this.binanceConfig.use_funds_percent),
      account_capital_usdt: Number(this.binanceConfig.account_capital_usdt),
      dynamic_sizing_enabled: Boolean(this.binanceConfig.dynamic_sizing_enabled),
      sizing_low_context_factor: Number(this.binanceConfig.sizing_low_context_factor),
      sizing_high_context_factor: Number(this.binanceConfig.sizing_high_context_factor),
      default_leverage: Number(this.binanceConfig.default_leverage),
      margin_type: this.binanceConfig.margin_type,
      order_type: this.binanceConfig.order_type,
      enable_tp_sl: Boolean(this.binanceConfig.enable_tp_sl),
      tp_buffer_pct: Number(this.binanceConfig.tp_buffer_pct),
      sl_buffer_pct: Number(this.binanceConfig.sl_buffer_pct),
      max_daily_trades: Number(this.binanceConfig.max_daily_trades),
      min_confidence: Number(this.binanceConfig.min_confidence),
      min_quantum: Number(this.binanceConfig.min_quantum),
      min_timing: Number(this.binanceConfig.min_timing),
      min_context_score: Number(this.binanceConfig.min_context_score),
      min_risk_reward: Number(this.binanceConfig.min_risk_reward),
      min_expected_move_pct: Number(this.binanceConfig.min_expected_move_pct),
      symbols_allowlist: symbols,
      early_exit_enabled: Boolean(this.binanceConfig.early_exit_enabled),
      early_exit_drawdown_pct: Number(this.binanceConfig.early_exit_drawdown_pct),
      updated_at: new Date().toISOString()
    };

    try {
      await this.firestoreService.saveBinanceBotConfig(payload);
      this.mensaje = 'Configuración Binance guardada.';
    } catch {
      this.mensaje = 'No se pudo guardar configuración Binance.';
    } finally {
      this.binanceConfigSaving = false;
    }
  }

  highConvictionWindowValue(signal: any, key: 'start' | 'end'): string {
    return signal?.estimated_window?.[key] || signal?.entry_window?.[key] || '-';
  }

  highConvictionWindowLocal(signal: any, key: 'start' | 'end'): string {
    const utcClock = this.highConvictionWindowValue(signal, key);
    if (!utcClock || utcClock === '-') return '-';
    const reference = this.firestoreDateToIso(signal?.created_at) || signal?.timestamp;
    return this.formatUtcClockToLocal(utcClock, reference);
  }

  telegramAlertDirection(alert: any): string {
    const direction = String(alert?.direction || '').toLowerCase();
    if (direction === 'up') return 'Alza';
    if (direction === 'down') return 'Baja';
    return 'Neutral';
  }

  telegramAlertOutcome(alert: any): string {
    const raw = (
      alert?.linkedPrediction?.verification?.verification_outcome ||
      alert?.linkedPrediction?.verification?.outcome_label ||
      alert?.linkedPrediction?.status ||
      alert?.status ||
      'PENDIENTE'
    ).toString().toUpperCase();

    if (raw.includes('WIN') || raw === 'VALIDADO') return 'WIN';
    if (raw.includes('LOSS') || raw === 'FALLIDO') return 'LOSS';
    if (raw.includes('SUPRIMIDA') || raw.includes('SUPPRESSED')) return 'SUPRIMIDA';
    if (raw.includes('PARCIAL') || raw.includes('PARTIAL')) return 'PARCIAL';
    return 'PENDIENTE';
  }

  telegramAlertOutcomeClass(alert: any): string {
    switch (this.telegramAlertOutcome(alert)) {
      case 'WIN':
        return 'hc-badge hc-win';
      case 'LOSS':
        return 'hc-badge hc-loss';
      case 'SUPRIMIDA':
        return 'hc-badge hc-suppressed';
      case 'PARCIAL':
        return 'hc-badge hc-partial';
      default:
        return 'hc-badge hc-pending';
    }
  }

  telegramAlertWindow(alert: any): string {
    const start = this.formatFirestoreDate(alert?.created_at || alert?.generated_at);
    const endDate = this.resolveNotificationDate(alert);
    const timeframeMinutes = Number(alert?.timeframe_minutes || 0);
    endDate.setMinutes(endDate.getMinutes() + timeframeMinutes);
    return `${start} - ${endDate.toLocaleString()}`;
  }

  telegramAlertRemarks(alert: any): string {
    return (
      alert?.linkedPrediction?.verification?.remarks ||
      alert?.linkedPrediction?.observaciones ||
      alert?.remarks ||
      'Sin observaciones'
    );
  }

  firestoreDateToIso(value: any): string | null {
    if (!value) return null;
    const date = typeof value.toDate === 'function' ? value.toDate() : new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    return date.toISOString();
  }

  private enrichHighConvictionSignals(signals: any[]): Observable<any[]> {
    const predictionIds = Array.from(
      new Set(
        (signals || [])
          .map((s) => s?.prediction_id)
          .filter((id) => !!id)
      )
    ) as string[];

    if (!predictionIds.length) {
      return of(signals || []);
    }

    return this.firestoreService.getCollectionByIds<any>('velas_predicciones', predictionIds).pipe(
      map((predictions) => {
        const byId = new Map<string, any>();
        predictions.forEach((p) => byId.set(p.id, p));
        return (signals || []).map((signal) => {
          const linkedPrediction = signal?.prediction_id ? byId.get(signal.prediction_id) : null;
          return {
            ...signal,
            linkedPrediction
          };
        });
      })
    );
  }

  private applyHighConvictionOutcomeFilter(signals: any[]): any[] {
    if (this.highConvictionOutcomeFilter === 'all') {
      return signals;
    }
    return (signals || []).filter((signal) => {
      const outcome = this.highConvictionOutcome(signal);
      if (this.highConvictionOutcomeFilter === 'win') return outcome === 'WIN';
      if (this.highConvictionOutcomeFilter === 'loss') return outcome === 'LOSS';
      if (this.highConvictionOutcomeFilter === 'pendiente') return outcome === 'PENDIENTE';
      if (this.highConvictionOutcomeFilter === 'suprimida') return outcome === 'SUPRIMIDA';
      if (this.highConvictionOutcomeFilter === 'parcial') return outcome === 'PARCIAL';
      return true;
    });
  }

  private computeHighConvictionStats(signals: any[]): {
    total: number;
    wins: number;
    losses: number;
    pending: number;
    suppressed: number;
    partial: number;
    winRate: number;
    winRateEmitted: number;
    winRateSuppressed: number | null;
    avgConfidence: number;
    avgStability: number;
  } {
    const total = signals?.length || 0;
    if (!total) {
      return {
        total: 0,
        wins: 0,
        losses: 0,
        pending: 0,
        suppressed: 0,
        partial: 0,
        winRate: 0,
        winRateEmitted: 0,
        winRateSuppressed: null,
        avgConfidence: 0,
        avgStability: 0
      };
    }

    let wins = 0;
    let losses = 0;
    let pending = 0;
    let suppressed = 0;
    let partial = 0;
    let confidenceSum = 0;
    let stabilitySum = 0;
    let suppressedVerified = 0;
    let suppressedWins = 0;

    for (const signal of signals) {
      const outcome = this.highConvictionOutcome(signal);
      const confidence = this.normalizePercent(signal?.confidence);
      const quantum = this.normalizePercent(signal?.quantum_score);
      const timing = this.normalizePercent(signal?.timing_score);
      confidenceSum += confidence;
      stabilitySum += this.resolveSignalStability(signal, confidence, quantum, timing);
      if (outcome === 'WIN') wins += 1;
      else if (outcome === 'LOSS') losses += 1;
      else if (outcome === 'SUPRIMIDA') {
        suppressed += 1;
        if (this.hasSuppressedVerification(signal)) {
          suppressedVerified += 1;
          if (this.isSuppressedWin(signal)) {
            suppressedWins += 1;
          }
        }
      }
      else if (outcome === 'PARCIAL') partial += 1;
      else pending += 1;
    }

    const emittedDenominator = wins + losses;
    const suppressedWinRate = suppressedVerified > 0 ? suppressedWins / suppressedVerified : null;

    return {
      total,
      wins,
      losses,
      pending,
      suppressed,
      partial,
      winRate: total ? wins / total : 0,
      winRateEmitted: emittedDenominator > 0 ? wins / emittedDenominator : 0,
      winRateSuppressed: suppressedWinRate,
      avgConfidence: total ? confidenceSum / total : 0,
      avgStability: total ? stabilitySum / total : 0
    };
  }

  private hasSuppressedVerification(signal: any): boolean {
    return Boolean(
      signal?.linkedPrediction?.verification ||
      signal?.verification ||
      signal?.verification_outcome
    );
  }

  private isSuppressedWin(signal: any): boolean {
    const success = signal?.linkedPrediction?.verification?.success;
    if (typeof success === 'boolean') {
      return success;
    }

    const outcome = (
      signal?.linkedPrediction?.verification?.verification_outcome ||
      signal?.linkedPrediction?.verification?.outcome_label ||
      signal?.verification?.verification_outcome ||
      signal?.verification?.outcome_label ||
      signal?.verification_outcome ||
      ''
    ).toString().toUpperCase();

    return outcome.includes('WIN');
  }

  private computeSignalStability(confidence: number, quantum: number, timing: number): number {
    const avg = (confidence + quantum + timing) / 3;
    const dispersion =
      (Math.abs(confidence - avg) + Math.abs(quantum - avg) + Math.abs(timing - avg)) / 3;
    const stability = avg * (1 - Math.min(dispersion, 0.5));
    return Math.max(0, Math.min(1, stability));
  }

  private resolveSignalStability(
    signal: any,
    confidence: number,
    quantum: number,
    timing: number
  ): number {
    if (signal?.stability != null) {
      return this.normalizePercent(signal.stability);
    }
    return this.computeSignalStability(confidence, quantum, timing);
  }

  private computeWeeklyStability(signals: any[]): WeeklyStability[] {
    const weekly = new Map<string, WeeklyStability>();

    for (const signal of signals || []) {
      const date = this.resolveSignalDate(signal);
      if (!date) continue;

      const { isoWeek, weekLabel } = this.getIsoWeekKey(date);
      const outcome = this.highConvictionOutcome(signal);

      if (!weekly.has(isoWeek)) {
        weekly.set(isoWeek, {
          isoWeek,
          weekLabel,
          total: 0,
          wins: 0,
          losses: 0,
          winRate: 0
        });
      }

      const bucket = weekly.get(isoWeek)!;
      bucket.total += 1;
      if (outcome === 'WIN') bucket.wins += 1;
      if (outcome === 'LOSS') bucket.losses += 1;
    }

    const list = Array.from(weekly.values())
      .map((item) => ({
        ...item,
        winRate: item.wins + item.losses > 0 ? item.wins / (item.wins + item.losses) : 0
      }))
      .sort((a, b) => b.isoWeek.localeCompare(a.isoWeek));

    return list.filter((w) => w.total > 0);
  }

  private resolveSignalDate(signal: any): Date | null {
    const raw =
      signal?.created_at ||
      signal?.timestamp ||
      signal?.linkedPrediction?.created_at ||
      signal?.linkedPrediction?.timestamp ||
      null;
    if (!raw) return null;
    const date = typeof raw?.toDate === 'function' ? raw.toDate() : new Date(raw);
    if (Number.isNaN(date.getTime())) return null;
    return date;
  }

  private getIsoWeekKey(date: Date): { isoWeek: string; weekLabel: string } {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const weekNo = Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
    const isoYear = d.getUTCFullYear();
    const weekPadded = String(weekNo).padStart(2, '0');
    return {
      isoWeek: `${isoYear}-W${weekPadded}`,
      weekLabel: `W${weekPadded}`
    };
  }

  private parseUtcClockWithReference(utcClock?: string, referenceIso?: string): Date | null {
    if (!utcClock) return null;
    const parts = utcClock.split(':').map((segment) => Number(segment));
    if (parts.length !== 3 || parts.some((part) => Number.isNaN(part))) {
      return null;
    }
    const [hours, minutes, seconds] = parts;
    const base = referenceIso ? new Date(referenceIso) : new Date();
    if (Number.isNaN(base.getTime())) {
      return null;
    }
    return new Date(
      Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), hours, minutes, seconds)
    );
  }

  formatUtcClockToLocal(utcClock?: string, referenceIso?: string): string {
    const date = this.parseUtcClockWithReference(utcClock, referenceIso);
    if (!date) return '-';
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }
  formatFirestoreDate(value: any): string {
    if (!value) return 'â€”';
    const date = typeof value.toDate === 'function' ? value.toDate() : new Date(value);
    if (Number.isNaN(date.getTime())) return 'â€”';
    return date.toLocaleString();
  }

  latestTelegramAlertDate(signal: any): string {
    return this.formatFirestoreDate(
      signal?.sent_at || signal?.created_at || signal?.generated_at || signal?.telegram_notification?.sent_at || signal?.timestamp
    );
  }

  formatRateOrNa(rate: number | null | undefined): string {
    if (rate == null) {
      return 'N/A';
    }
    return `${Math.round(rate * 1000) / 10}%`;
  }

  formatSuppressedRate(rate: number | null | undefined, suppressedCount: number): string {
    if (rate == null) {
      return suppressedCount > 0 ? 'Sin verificaciones' : 'N/A';
    }
    return `${Math.round(rate * 1000) / 10}%`;
  }

  spotPriceSourceLabel(source: string | null | undefined): string {
    switch ((source || '').toLowerCase()) {
      case 'binance':
        return 'Binance';
      case 'yahoo':
        return 'Yahoo';
      case 'alpha_vantage':
        return 'Alpha Vantage';
      case 'candles_close':
        return 'Cierre de velas';
      default:
        return 'Sin fuente';
    }
  }

  private enrichTelegramNotifications(alerts: any[]): Observable<any[]> {
    const predictionIds = Array.from(
      new Set(
        (alerts || [])
          .map((item) => item?.prediction_id)
          .filter((id) => !!id)
      )
    ) as string[];

    if (!predictionIds.length) {
      return of(alerts || []);
    }

    return this.firestoreService.getCollectionByIds<any>('velas_predicciones', predictionIds).pipe(
      map((predictions) => {
        const byId = new Map<string, any>();
        predictions.forEach((prediction) => byId.set(prediction.id, prediction));
        return (alerts || []).map((alert) => ({
          ...alert,
          linkedPrediction: alert?.prediction_id ? byId.get(alert.prediction_id) : null
        }));
      })
    );
  }

  private resolveNotificationDate(alert: any): Date {
    const raw = alert?.created_at || alert?.generated_at || alert?.timestamp || new Date().toISOString();
    const date = typeof raw?.toDate === 'function' ? raw.toDate() : new Date(raw);
    return Number.isNaN(date.getTime()) ? new Date(0) : date;
  }

  private resolveMonitoringDate(item: any): Date {
    const raw = item?.created_at || item?.timestamp || new Date().toISOString();
    const date = typeof raw?.toDate === 'function' ? raw.toDate() : new Date(raw);
    return Number.isNaN(date.getTime()) ? new Date(0) : date;
  }

  private computeMonitoringSummary(items: any[]): {
    symbolsTotal: number;
    processedOk: number;
    failed: number;
    emitted: number;
    suppressed: number;
    cycleDurationMs: number;
    suppressionRate: number;
    certaintyWinRate: number;
    classification: string;
    updatedAt: string;
  } {
    const latest = (items || [])[0];
    if (!latest) {
      return {
        symbolsTotal: 0,
        processedOk: 0,
        failed: 0,
        emitted: 0,
        suppressed: 0,
        cycleDurationMs: 0,
        suppressionRate: 0,
        certaintyWinRate: 0,
        classification: 'n/a',
        updatedAt: 'â€”'
      };
    }

    const cycle = latest?.prediction_cycle || latest;
    const latestAuditSnapshot = (items || []).find((item) => {
      const raw = Number(item?.audit?.global?.win_rate);
      return Number.isFinite(raw);
    });
    const audit = latestAuditSnapshot?.audit || latest?.audit || {};
    const processedOk = Number(cycle?.processed_ok || 0);
    const emitted = Number(cycle?.signals_emitted || 0);
    const suppressed = Number(cycle?.signals_suppressed || 0);
    const baseForSuppression = processedOk > 0 ? processedOk : emitted + suppressed;
    const suppressionRate = baseForSuppression > 0 ? suppressed / baseForSuppression : 0;
    const winRatePct = Number(audit?.global?.win_rate ?? 0);
    const latestEmissionSnapshot = (items || []).find((item) => {
      const metrics = this.resolveCycleMetrics(item);
      return Number(metrics?.signals_emitted || 0) > 0;
    });
    const latestEmissionMetrics = this.resolveCycleMetrics(latestEmissionSnapshot);

    this.lastEmissionAt = latestEmissionSnapshot
      ? this.formatFirestoreDate(latestEmissionSnapshot?.created_at || latestEmissionSnapshot?.timestamp)
      : '—';
    this.lastEmissionCount = Number(latestEmissionMetrics?.signals_emitted || 0);

    return {
      symbolsTotal: Number(cycle?.symbols_total || 0),
      processedOk,
      failed: Number(cycle?.failed || 0),
      emitted,
      suppressed,
      cycleDurationMs: Number(cycle?.cycle_duration_ms || 0),
      suppressionRate,
      certaintyWinRate: winRatePct > 1 ? winRatePct / 100 : winRatePct,
      classification: String(audit?.classification || latestAuditSnapshot?.classification || latest?.classification || 'n/a'),
      updatedAt: this.formatFirestoreDate(latest?.created_at || latest?.timestamp)
    };
  }

  private computeMonitoringTrend(items: any[]): MonitoringTrendItem[] {
    return (items || [])
      .map((item) => {
        const audit = item?.audit || {};
        const raw = Number(audit?.global?.win_rate);
        if (!Number.isFinite(raw)) {
          return null;
        }
        return {
          createdAtLabel: this.formatFirestoreDate(item?.created_at || item?.timestamp),
          winRate: raw > 1 ? raw / 100 : raw
        };
      })
      .filter((item): item is MonitoringTrendItem => !!item)
      .slice(0, 8);
  }

  private resolveCycleMetrics(item: any): any {
    if (!item) return null;
    return item?.prediction_cycle || item;
  }
}





