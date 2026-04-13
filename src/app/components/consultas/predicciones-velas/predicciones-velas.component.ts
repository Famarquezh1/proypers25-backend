import { AfterViewInit, Component, ElementRef, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClientModule } from '@angular/common/http';
import { combineLatest, Observable, of } from 'rxjs';
import { finalize, map, shareReplay, switchMap } from 'rxjs/operators';
import { VelasService } from '../../../servicios/velas.service';
import { FirestoreService } from '../../../servicios/firestore.service';
import { environment } from '../../../../environments/environment';
import { ColorType, CrosshairMode, createChart, IChartApi, ISeriesApi, Time, UTCTimestamp } from 'lightweight-charts';
import { ExploitationPanelComponent } from '../../exploitation-panel/exploitation-panel.component';

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

interface SignalIntelBucket {
  bucket: string;
  total: number;
  win_rate: number | null;
  expectancy: number | null;
}

interface SuppressedSymbolEdgeItem {
  symbol: string;
  total_signals: number;
  win_rate: number | null;
  expectancy: number | null;
  avg_MFE: number | null;
  avg_MAE: number | null;
}

interface RankedSignalItem {
  simbolo: string;
  timestamp: string | null;
  direction: string;
  timeframe: string;
  confidence: number | null;
  context_score: number | null;
  signal_ranking_score: number | null;
  ranking_percentile: number | null;
  top_signal_flag: boolean;
  is_top_signal_global: boolean;
  is_top_signal_symbol: boolean;
  is_top_signal_regime: boolean;
  is_ranked_operable: boolean;
  ranking_regime: string;
  ranking_position_global: number | null;
}

interface HistoryGroupItem {
  dateKey: string;
  label: string;
  total: number;
  items: any[];
}

interface SymbolChipItem {
  symbol: string;
  status: 'activa' | 'suprimida';
  total: number;
}

interface ExecutionBadgeItem {
  label: string;
  className: string;
}

interface LatencyBreakdownItem {
  key: string;
  label: string;
  value: number | null;
}

interface EquityCurveCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

interface EquityCurveTradePoint {
  id: string;
  time: number;
  symbol: string;
  source_profile: string;
  outcome: 'WIN' | 'LOSS' | 'BREAKEVEN';
  pnl_pct: number;
  close_reason: string | null;
  closed_at: string | null;
  open: number;
  high: number;
  low: number;
  close: number;
}

@Component({
  selector: 'app-predicciones-velas',
  standalone: true,
  imports: [CommonModule, FormsModule, HttpClientModule, ExploitationPanelComponent],
  templateUrl: './predicciones-velas.component.html',
  styleUrls: ['./predicciones-velas.component.css']
})
export class PrediccionesVelasComponent implements OnInit, AfterViewInit, OnDestroy {
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
  historialGroups$: Observable<HistoryGroupItem[]> | undefined;
  symbolStatusChips$: Observable<SymbolChipItem[]> | undefined;
  oportunidades$: Observable<any[]> | undefined;
  highConvictionSignals$: Observable<any[]> | undefined;
  neutralSignalCandidates$: Observable<any[]> | undefined;
  latestBinanceExecutions$: Observable<any[]> | undefined;
  telegramNotifications$: Observable<any[]> | undefined;
  telegramWinNotifications$: Observable<any[]> | undefined;
  telegramPendingNotifications$: Observable<any[]> | undefined;
  latestTelegramAlert$: Observable<any | null> | undefined;
  monitoringSnapshots$: Observable<any[]> | undefined;
  binanceConfig$: Observable<any | null> | undefined;
  @ViewChild('equityChartContainer')
  set equityChartContainerRef(ref: ElementRef<HTMLDivElement> | undefined) {
    this.equityChartContainer = ref?.nativeElement || null;
    if (this.equityChartContainer) {
      this.queueEquityChartRender();
    }
  }

  private equityChartContainer: HTMLDivElement | null = null;
  private equityChart: IChartApi | null = null;
  private equityLineSeries: ISeriesApi<'Area'> | null = null;
  private equityResizeObserver: ResizeObserver | null = null;
  private equityViewReady = false;
  private deferredEquityLoadTimer: ReturnType<typeof setTimeout> | null = null;
  private deferredSignalIntelLoadTimer: ReturnType<typeof setTimeout> | null = null;
  equityCurveLoading = false;
  equityCurveError = '';
  equityCurveCandles: EquityCurveCandle[] = [];
  equityCurveTrades: EquityCurveTradePoint[] = [];
  equityHoveredTrade: EquityCurveTradePoint | null = null;
  equityCurveSummary = {
    initialCapital: 0,
    currentCapital: 0,
    curveCapital: 0,
    totalGrowthPct: 0,
    totalTrades: 0,
    wins: 0,
    losses: 0,
    breakevens: 0,
    maxDrawdownPct: 0,
    initialCapitalSource: '',
    currentCapitalSource: ''
  };
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
  expandedBinanceExecutionId: string | null = null;
  compactMode = false;
  readonly uiMobileOptimized = environment.uiMobileOptimized !== false;
  private readonly panelStorageKey = 'predicciones_velas_panel_state_v1';
  private readonly compactStorageKey = 'predicciones_velas_compact_mode_v1';
  openSections: Record<string, boolean> = {
    opportunities: true,
    monitoring: false,
    equityCurve: false,
    signalIntel: false,
    binanceConfig: false,
    highConviction: false,
    neutralSignals: false,
    historial: false
  };
  historyExpandedDates: Record<string, boolean> = {};
  selectedHistorySymbol = '';
  private latestPredictionsCache: any[] = [];
  highConvictionStats = {
    total: 0,
    wins: 0,
    losses: 0,
    open: 0,
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
    symbolsRequested: 0,
    symbolsExcludedCooldown: 0,
    processedOk: 0,
    failed: 0,
    emitted: 0,
    suppressed: 0,
    cycleDurationMs: 0,
    suppressionRate: 0,
    certaintyWinRate: 0,
    classification: 'n/a',
    topFailureSymbols: [] as string[],
    updatedAt: '�'
  };
  monitoringTrend: MonitoringTrendItem[] = [];
  signalIntelLoading = false;
  signalIntelError = '';
  signalIntelUpdatedAt = '�';
  signalIntelSummary = {
    totalSignals: 0,
    emitted: 0,
    suppressed: 0,
    suppressedVerified: 0,
    pending: 0,
    winRateEmitted: null as number | null,
    winRateSuppressed: null as number | null,
    winRateGlobal: null as number | null,
    expectancyEmitted: null as number | null,
    expectancyGlobal: null as number | null
  };
  signalIntelSuppressedSummary = {
    totalSuppressed: 0,
    wins: 0,
    losses: 0,
    winRateSuppressed: null as number | null,
    expectancySuppressed: null as number | null,
    deltaVsEmitted: null as number | null,
    leadTimeAvg: null as number | null
  };
  signalIntelExecutionSummary = {
    signalAdherence: null as number | null,
    manualTradeRate: null as number | null,
    executionDisciplineScore: null as number | null,
    lateExitRate: null as number | null,
    earlyExitRate: null as number | null,
    slViolationRate: null as number | null,
    profitCaptureRatio: null as number | null,
    edgeDecay: null as number | null,
    executionSlippagePct: null as number | null,
    realWinRate: null as number | null,
    realExpectancy: null as number | null,
    modelWinRate: null as number | null,
    dataSource: 'N/A'
  };
  signalIntelExecutionMetaSummary = {
    missedWins: 0,
    missedLosses: 0,
    executionRate: null as number | null,
    lateEntryRate: null as number | null,
    executionDelayAvgMs: null as number | null,
    lateEntrySoftExecuted: 0,
    lateEntrySoftBlocked: 0,
    softLateRatio: null as number | null,
    hardLateRatio: null as number | null,
    missedWinRate: null as number | null,
    missedLossRate: null as number | null
  };
  signalIntelLatencySummary = {
    avgTotalLatency: null as number | null,
    p50Latency: null as number | null,
    p95Latency: null as number | null,
    maxLatency: null as number | null,
    topBottleneckStage: 'N/A',
    entryWindowSeconds: 30,
    criticalDelayCount: 0,
    lateEntryBlockedCount: 0
  };
  signalIntelLatencyBreakdown: LatencyBreakdownItem[] = [];
  signalIntelExecutionTopSymbols: SuppressedSymbolEdgeItem[] = [];
  signalIntelTopSymbols: Array<{
    symbol: string;
    total_signals: number;
    win_rate: number | null;
    expectancy: number | null;
  }> = [];
  signalIntelSuppressedTopSymbols: SuppressedSymbolEdgeItem[] = [];
  signalIntelContextQualityBuckets: SignalIntelBucket[] = [];
  signalIntelSuppressedContextBuckets: Array<SignalIntelBucket & { mfe: number | null }> = [];
  signalIntelRankedSignals: RankedSignalItem[] = [];
  signalIntelRankingSummary = {
    enabled: true,
    avgRankingPercentile: null as number | null,
    operableCount: 0,
    topGlobalCount: 0,
    topSymbolCount: 0,
    topRegimeCount: 0,
    minRankingRecommended: null as number | null,
    minContextQualityRecommended: null as number | null
  };
  signalIntelRankingRegimes: Array<{
    regime: string;
    total: number;
    operable: number;
    avg_score: number | null;
  }> = [];
  signalIntelContextSummary = {
    enabled: false,
    mode: 'observe',
    bestBucket: 'N/A',
    bestBucketWinRate: null as number | null,
    bestBucketExpectancy: null as number | null
  };
  signalIntelContextRegimes: Array<{
    regime: string;
    total: number;
    win_rate: number | null;
    expectancy: number | null;
  }> = [];
  signalIntelAdaptiveProfile = {
    adaptiveTp: null as number | null,
    adaptiveSl: null as number | null,
    adaptiveHorizon: null as number | null,
    learningStatus: 'N/A',
    lastCalibrationTime: '�',
    edgeQualityScore: null as number | null,
    recalibrated: false
  };
  signalIntelAdaptiveRankingProfile = {
    minRankingScoreRecommended: null as number | null,
    minContextQualityRecommended: null as number | null,
    calibrationVersion: 'N/A'
  };
  signalIntelAdaptiveContextProfile = {
    bestBucket: 'N/A',
    bestBucketWinRate: null as number | null,
    bestBucketExpectancy: null as number | null
  };
  signalIntelLearningSummary = {
    expectancyStabilityScore: null as number | null,
    expectancyVariance: null as number | null,
    counterfactualExpectancy: null as number | null,
    counterfactualWinRate: null as number | null,
    missedAlpha: null as number | null,
    falseNegativeRate: null as number | null,
    alphaDecayRate: null as number | null,
    rollingExpectancyDelta: null as number | null,
    expectancyTrend: 'N/A',
    walkforwardExpectancy: null as number | null,
    walkforwardWinRate: null as number | null,
    walkforwardEdgeDecay: null as number | null
  };
  signalIntelLearningRegimes: Array<{
    regime: string;
    total: number;
    win_rate: number | null;
    expectancy: number | null;
    signal_density: number | null;
  }> = [];
  signalIntelConfidenceCalibration: Array<{
    bucket: string;
    total: number;
    win_rate: number | null;
    expectancy: number | null;
  }> = [];
  signalIntelMatrixCells: Array<{
    symbol: string;
    regime: string;
    rank_bucket: string;
    total: number;
    expectancy: number | null;
    win_rate: number | null;
  }> = [];
  signalIntelSymbolSurvivorship: Array<{
    symbol: string;
    total: number;
    recent_expectancy: number | null;
    trend: number | null;
    edge_decay: number | null;
    degraded: boolean;
  }> = [];
  signalIntelWeeklyExpectancy: Array<{
    iso_week: string;
    total: number;
    expectancy: number | null;
    win_rate: number | null;
  }> = [];
  lastEmissionAt = '�';
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
    min_context_quality: 0,
    min_risk_reward: 1.2,
    min_expected_move_pct: 0.4,
    allow_unlisted_symbols: false,
    symbols_allowlist_text: '',
    early_exit_enabled: false,
    early_exit_drawdown_pct: 0.25
  };
  binanceConfigSaving = false;
  readonly executionOperatingProfiles = [
    {
      label: 'High Conviction',
      mode: 'LIVE',
      detail: 'Es la única ruta que hoy puede abrir posiciones reales en Binance.'
    },
    {
      label: 'Event Emitted',
      mode: 'OBSERVE',
      detail: 'Se observa y registra, pero no debería ejecutar capital real.'
    },
    {
      label: 'Manual Prealert',
      mode: 'OBSERVE',
      detail: 'Se mantiene visible para diagnóstico, no para trading real.'
    }
  ];
  readonly hcExecutionSafetyHints = [
    'HC live usa un piso efectivo más alto de confidence, quantum, timing y R:R que el config global.',
    'Si Binance exige más notional, el backend eleva HC al mínimo real del exchange para evitar fallos por -4164.',
    'Si no queda SL real en Binance, la posición se cierra de inmediato y no se deja viva sin protección.'
  ];
  constructor(
    private velasService: VelasService,
    private firestoreService: FirestoreService
  ) {}

  ngOnInit(): void {
    this.restoreUiState();
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
    this.cargarNeutralSignalCandidates();
    this.cargarLatestBinanceExecutions();
    this.cargarTelegramNotifications();
    this.cargarMonitoringSnapshots();
    this.cargarBinanceConfig();
    this.deferredEquityLoadTimer = setTimeout(() => {
      this.cargarEquityCurve();
      this.deferredEquityLoadTimer = null;
    }, 1200);
    this.deferredSignalIntelLoadTimer = setTimeout(() => {
      this.cargarSignalIntelligence();
      this.deferredSignalIntelLoadTimer = null;
    }, 3200);
  }

  ngAfterViewInit(): void {
    this.equityViewReady = true;
    this.queueEquityChartRender();
  }

  ngOnDestroy(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    if (this.deferredEquityLoadTimer) {
      clearTimeout(this.deferredEquityLoadTimer);
      this.deferredEquityLoadTimer = null;
    }
    if (this.deferredSignalIntelLoadTimer) {
      clearTimeout(this.deferredSignalIntelLoadTimer);
      this.deferredSignalIntelLoadTimer = null;
    }
    this.destroyEquityChart();
  }

  toggleSection(section: keyof PrediccionesVelasComponent['openSections']): void {
    const isMobile = this.uiMobileOptimized && typeof window !== 'undefined' && window.innerWidth <= 991;
    if (isMobile) {
      const nextState = !this.openSections[section];
      this.openSections = {
        opportunities: false,
        monitoring: false,
        equityCurve: false,
        signalIntel: false,
        binanceConfig: false,
        highConviction: false,
        neutralSignals: false,
        historial: false
      };
      this.openSections[section] = nextState;
    } else {
      this.openSections[section] = !this.openSections[section];
    }
    this.persistUiState();
    if (section === 'equityCurve' && this.openSections[section]) {
      this.queueEquityChartRender();
    }
  }

  isSectionOpen(section: keyof PrediccionesVelasComponent['openSections']): boolean {
    return Boolean(this.openSections[section]);
  }

  shouldRenderSection(section: keyof PrediccionesVelasComponent['openSections']): boolean {
    const isMobile = this.uiMobileOptimized && typeof window !== 'undefined' && window.innerWidth <= 991;
    return isMobile ? this.isSectionOpen(section) : true;
  }

  toggleCompactMode(): void {
    this.compactMode = !this.compactMode;
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(this.compactStorageKey, this.compactMode ? 'compact' : 'full');
    }
  }

  toggleHistoryDate(dateKey: string): void {
    this.historyExpandedDates[dateKey] = !this.historyExpandedDates[dateKey];
  }

  isHistoryDateExpanded(dateKey: string): boolean {
    return Boolean(this.historyExpandedDates[dateKey]);
  }

  visibleHistoryItems(group: HistoryGroupItem): any[] {
    return this.isHistoryDateExpanded(group.dateKey) ? group.items : group.items.slice(0, 5);
  }

  trackById(_index: number, item: any): string {
    return String(item?.id || item?.prediction_id || item?.symbol || item?.simbolo || _index);
  }

  trackByDateKey(_index: number, item: HistoryGroupItem): string {
    return item.dateKey;
  }

  trackBySymbol(_index: number, item: SymbolChipItem | any): string {
    return String(item?.symbol || item?.simbolo || _index);
  }

  trackByBadge(_index: number, item: ExecutionBadgeItem): string {
    return `${item.className}-${item.label}`;
  }

  private restoreUiState(): void {
    if (typeof localStorage === 'undefined') return;
    const compact = localStorage.getItem(this.compactStorageKey);
    this.compactMode = compact === 'compact';

    const raw = localStorage.getItem(this.panelStorageKey);
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw);
      this.openSections = {
        ...this.openSections,
        ...parsed
      };
    } catch {
      // ignore invalid persisted panel state
    }
  }

  private persistUiState(): void {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(this.panelStorageKey, JSON.stringify(this.openSections));
  }

  private applyHistorySymbolFilter(list: any[]): any[] {
    if (!this.selectedHistorySymbol) return list || [];
    return (list || []).filter(
      (item) => String(item?.simbolo || item?.symbol || '').toUpperCase() === this.selectedHistorySymbol
    );
  }

  toggleHistorySymbolFilter(symbol: string): void {
    this.selectedHistorySymbol = this.selectedHistorySymbol === symbol ? '' : symbol;
    this.historialGroups$ = of(
      this.groupPredictionsByDate(this.applyHistorySymbolFilter(this.latestPredictionsCache))
    );
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
      map((list) => {
        this.latestPredictionsCache = list;
        return list;
      }),
      shareReplay(1)
    );
    this.predicciones$ = source$;
    this.historialGroups$ = source$.pipe(
      map((list) => this.groupPredictionsByDate(this.applyHistorySymbolFilter(list)))
    );
    this.symbolStatusChips$ = source$.pipe(
      map((list) => this.buildSymbolStatusChips(list))
    );
    this.oportunidades$ = source$.pipe(
      map((list) => this.computeManualOpportunities(list))
    );
  }

  generarPrediccion(): void {
    if (!this.candidatoSymbol) {
      this.mensaje = 'Selecciona un s�mbolo v�lido.';
      return;
    }
    this.cargando = true;
    this.mensaje = 'Generando predicci�n...';
    this.velasService
      .generarPrediccion(this.candidatoSymbol, this.selectedTimeframe, this.monto, this.executionMode)
      .pipe(finalize(() => (this.cargando = false)))
      .subscribe({
        next: (prediccion) => {
          this.mensaje = `Predicci�n para ${prediccion.simbolo} registrada.`;
          this.cargarPredicciones();
        },
        error: () => {
          this.mensaje = 'No se pudo generar la predicci�n.';
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
      this.mensaje = resultado.verification?.remarks || 'Verificaci�n completada.';
      this.cargarPredicciones();
    },
    error: () => {
      this.mensaje = 'Fall� la verificaci�n.';
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
    if (!value) return '�';
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
      return 'Tu reloj coincide con UTC para la ventana de ejecuci�n.';
    }
    const sign = offset > 0 ? '+' : '';
    return `Tu reloj est� ${sign}${offset} min respecto a UTC para la ventana de entrada.`;
  }

  offsetLabel(value: string): string {
    const offset = this.offsetMinutesFromUTC(value);
    if (!offset) return 'coincide con UTC';
    const sign = offset > 0 ? '+' : '';
    return `Tu reloj est� ${sign}${offset} min respecto a UTC`;
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
      return `${prefix} (UTC � Expirada)`;
    }
    const dayLabel = this.labelForDay(targetDate, now);
    return `${prefix} (UTC � ${dayLabel})`;
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
    return 'Observaci�n';
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

  private groupPredictionsByDate(list: any[]): HistoryGroupItem[] {
    const groups = new Map<string, HistoryGroupItem>();

    for (const item of list || []) {
      const rawDate = item?.created_at || item?.timestamp;
      const date = rawDate ? new Date(rawDate) : null;
      if (!date || Number.isNaN(date.getTime())) continue;
      const dateKey = date.toISOString().slice(0, 10);
      if (!groups.has(dateKey)) {
        groups.set(dateKey, {
          dateKey,
          label: date.toLocaleDateString(),
          total: 0,
          items: []
        });
      }
      const group = groups.get(dateKey)!;
      group.items.push(item);
      group.total += 1;
    }

    return Array.from(groups.values())
      .sort((a, b) => b.dateKey.localeCompare(a.dateKey))
      .map((group) => ({
        ...group,
        items: group.items.sort((a, b) => {
          const aTime = new Date(a.created_at || a.timestamp || 0).getTime();
          const bTime = new Date(b.created_at || b.timestamp || 0).getTime();
          return bTime - aTime;
        })
      }));
  }

  private buildSymbolStatusChips(list: any[]): SymbolChipItem[] {
    const latestBySymbol = new Map<string, any>();
    for (const item of list || []) {
      const symbol = String(item?.simbolo || item?.symbol || '').trim();
      if (!symbol || latestBySymbol.has(symbol)) continue;
      latestBySymbol.set(symbol, item);
    }

    return Array.from(latestBySymbol.entries())
      .map(([symbol, item]) => ({
        symbol,
        status: (item?.signal_emitted ? 'activa' : 'suprimida') as 'activa' | 'suprimida',
        total: 1
      }))
      .sort((a, b) => a.symbol.localeCompare(b.symbol));
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
      return 'Ma�ana';
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

  cargarLatestBinanceExecutions(): void {
    this.latestBinanceExecutions$ = this.firestoreService.getBinanceExecutionIntents<any>(60).pipe(
      switchMap((items) => this.enrichBinanceExecutionIntents(items)),
      map((items) => (items || []).slice(0, 20)),
      shareReplay(1)
    );
  }

  cargarNeutralSignalCandidates(): void {
    this.neutralSignalCandidates$ = this.firestoreService
      .getNeutralSignalCandidates<any>(20)
      .pipe(shareReplay(1));
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

  cargarSignalIntelligence(refresh = false): void {
    this.signalIntelLoading = true;
    this.signalIntelError = '';
    this.velasService
      .obtenerSignalIntelligenceDashboard({
        refresh,
        days: 30,
        maxDocs: 8000,
        suppressedMaxDocs: 150,
        executionMaxDocs: 150,
        concurrency: 2,
        matchWindowMinutes: 5
      })
      .pipe(finalize(() => (this.signalIntelLoading = false)))
      .subscribe({
        next: (dashboard) => {
          const snapshot = dashboard?.snapshot || {};
          const intelligence = snapshot?.intelligence || {};
          const suppressed = snapshot?.suppressed || {};
          const execution = snapshot?.execution || {};
          const executionDisciplineSnapshot = snapshot?.execution_discipline?.report || {};
          const report = intelligence?.report || {};
          const totals = report?.totals || {};
          const winRates = report?.win_rates || {};
          const states = report?.states || {};
          const suppressedReport = suppressed?.report || {};
          const suppressedSummary = suppressedReport?.suppressed_summary || {};
          const suppressedComparative = suppressedReport?.comparative_analysis || {};
          const suppressedLeadTime = suppressedReport?.lead_time || {};
          const executionReport = execution?.report || {};
          const executionQuality = executionReport?.execution_quality || {};
          const executionDiscipline = executionReport?.execution_discipline || {};
          const executionLatency = snapshot?.execution_latency?.report || {};
          const modelEdge = executionReport?.model_edge || {};
          const adaptiveProfile = report?.adaptive_calibration || {};
          const adaptiveProfiles = report?.adaptive_profiles || {};
          const rankingSummary = report?.ranking_summary || {};
          const contextIntelligenceSummary = report?.context_intelligence_summary || {};
          const rankingProfile = adaptiveProfiles?.ranking_profile || {};
          const contextProfile = adaptiveProfiles?.context_profile || {};
          const learning = snapshot?.learning?.report || {};
          const expectancyStability = learning?.expectancy_stability || {};
          const counterfactualLearning = learning?.counterfactual_learning || {};
          const alphaDecay = learning?.alpha_decay || {};
          const walkforward = learning?.walkforward_validation || {};
          const regimeLearning = learning?.regime_learning || {};
          const confidenceCalibration = learning?.confidence_calibration || {};
          const matrix = learning?.expectancy_stability_matrix || {};
          const survivorship = learning?.symbol_survivorship || {};

          this.signalIntelUpdatedAt = this.formatFirestoreDate(
            dashboard?.fetched_at ||
              intelligence?.fetched_at ||
              execution?.fetched_at ||
              suppressed?.fetched_at ||
              executionReport?.generated_at ||
              report?.generated_at ||
              suppressedReport?.generated_at
          );
          this.signalIntelSummary = {
            totalSignals: Number(totals?.total_signals || 0),
            emitted: Number(totals?.emitted || 0),
            suppressed: Number(totals?.suppressed || 0),
            suppressedVerified: Number(totals?.suppressed_verified || 0),
            pending: Number(totals?.pending || 0),
            winRateEmitted: this.toRate(winRates?.win_rate_emitidas),
            winRateSuppressed: this.toRate(winRates?.win_rate_suprimidas),
            winRateGlobal: this.toRate(winRates?.win_rate_global),
            expectancyEmitted: this.toNullableNum(states?.emitidas?.expectancy?.expectancy),
            expectancyGlobal: this.toNullableNum(states?.global?.expectancy?.expectancy)
          };
          this.signalIntelSuppressedSummary = {
            totalSuppressed: Number(suppressedSummary?.total_suppressed || 0),
            wins: Number(suppressedSummary?.wins || 0),
            losses: Number(suppressedSummary?.losses || 0),
            winRateSuppressed: this.toRate(suppressedSummary?.win_rate_suprimidas),
            expectancySuppressed: this.toNullableNum(suppressedSummary?.expectancy_suprimidas),
            deltaVsEmitted: this.toNullableNum(suppressedComparative?.delta_expectancy),
            leadTimeAvg: this.toNullableNum(suppressedLeadTime?.lead_time_avg)
          };
          this.signalIntelExecutionSummary = {
              signalAdherence: this.toRate(
                executionDisciplineSnapshot?.metrics?.signal_adherence ??
                  executionDiscipline?.signal_adherence ??
                  executionQuality?.signal_adherence
              ),
              manualTradeRate: this.toRate(
                executionDisciplineSnapshot?.metrics?.manual_trade_rate ??
                  executionDiscipline?.manual_trade_rate ??
                  executionQuality?.manual_trade_rate
              ),
              executionDisciplineScore: this.toNullableNum(
                executionDisciplineSnapshot?.current_execution_score ??
                  executionDiscipline?.execution_discipline_score
              ),
              lateExitRate: this.toRate(
                executionDisciplineSnapshot?.metrics?.late_exit_rate ??
                  executionDiscipline?.late_exit_rate ??
                  executionQuality?.late_exit_rate
              ),
              earlyExitRate: this.toRate(
                executionDisciplineSnapshot?.metrics?.early_exit_rate ??
                  executionDiscipline?.early_exit_rate ??
                  executionQuality?.early_exit_rate
              ),
              slViolationRate: this.toRate(
                executionDisciplineSnapshot?.metrics?.sl_violation_rate ??
                  executionDiscipline?.sl_violation_rate ??
                  executionQuality?.sl_violation_rate
              ),
              profitCaptureRatio: this.toNullableNum(
                executionDisciplineSnapshot?.metrics?.profit_capture_ratio ??
                  executionDiscipline?.profit_capture_ratio ??
                  executionQuality?.profit_capture_ratio
              ),
            edgeDecay: this.toNullableNum(executionDiscipline?.edge_decay ?? executionQuality?.edge_decay),
            executionSlippagePct: this.toNullableNum(executionQuality?.execution_slippage_pct),
            realWinRate: this.toRate(executionQuality?.real_win_rate),
            realExpectancy: this.toNullableNum(executionQuality?.real_expectancy),
            modelWinRate: this.toRate(modelEdge?.matched_model_win_rate ?? modelEdge?.model_win_rate),
            dataSource: String(executionReport?.config?.trades_source || 'N/A')
          };
          this.signalIntelExecutionMetaSummary = {
            missedWins: Number(executionDisciplineSnapshot?.signal_metrics?.missed_wins || 0),
            missedLosses: Number(executionDisciplineSnapshot?.signal_metrics?.missed_losses || 0),
            executionRate: this.toRate(executionDisciplineSnapshot?.signal_metrics?.execution_rate),
            lateEntryRate: this.toRate(executionDisciplineSnapshot?.signal_metrics?.late_entry_block_rate),
            executionDelayAvgMs: this.toNullableNum(executionDisciplineSnapshot?.signal_metrics?.execution_delay_avg_ms),
            lateEntrySoftExecuted: Number(executionDisciplineSnapshot?.signal_metrics?.late_entry_soft_executed || 0),
            lateEntrySoftBlocked: Number(executionDisciplineSnapshot?.signal_metrics?.late_entry_soft_blocked || 0),
            softLateRatio: this.toRate(executionDisciplineSnapshot?.signal_metrics?.soft_late_ratio),
            hardLateRatio: this.toRate(executionDisciplineSnapshot?.signal_metrics?.hard_late_ratio),
            missedWinRate: this.toRate(executionDisciplineSnapshot?.signal_metrics?.missed_win_rate),
            missedLossRate: this.toRate(executionDisciplineSnapshot?.signal_metrics?.missed_loss_rate)
          };
          this.signalIntelLatencySummary = {
            avgTotalLatency: this.toNullableNum(executionLatency?.avg_total_latency),
            p50Latency: this.toNullableNum(executionLatency?.p50_latency),
            p95Latency: this.toNullableNum(executionLatency?.p95_latency),
            maxLatency: this.toNullableNum(executionLatency?.max_latency),
            topBottleneckStage: String(executionLatency?.top_bottleneck_stage || 'N/A'),
            entryWindowSeconds: Number(executionLatency?.entry_window_seconds || 30),
            criticalDelayCount: Number(executionLatency?.critical_delay_count || 0),
            lateEntryBlockedCount: Number(executionLatency?.late_entry_blocked_count || 0)
          };
          this.signalIntelLatencyBreakdown = [
            {
              key: 'signal_to_emit_ms',
              label: this.latencyStageLabel('signal_to_emit_ms'),
              value: this.toNullableNum(executionLatency?.breakdown?.signal_to_emit_ms)
            },
            {
              key: 'emit_to_intent_ms',
              label: this.latencyStageLabel('emit_to_intent_ms'),
              value: this.toNullableNum(executionLatency?.breakdown?.emit_to_intent_ms)
            },
            {
              key: 'intent_to_process_ms',
              label: this.latencyStageLabel('intent_to_process_ms'),
              value: this.toNullableNum(executionLatency?.breakdown?.intent_to_process_ms)
            },
            {
              key: 'process_to_attempt_ms',
              label: this.latencyStageLabel('process_to_attempt_ms'),
              value: this.toNullableNum(executionLatency?.breakdown?.process_to_attempt_ms)
            },
            {
              key: 'attempt_to_order_ms',
              label: this.latencyStageLabel('attempt_to_order_ms'),
              value: this.toNullableNum(executionLatency?.breakdown?.attempt_to_order_ms)
            }
          ];
          this.signalIntelAdaptiveProfile = {
            adaptiveTp: this.toNullableNum(adaptiveProfile?.adaptive_tp),
            adaptiveSl: this.toNullableNum(adaptiveProfile?.adaptive_sl),
            adaptiveHorizon: this.toNullableNum(
              adaptiveProfile?.adaptive_horizon_seconds ?? adaptiveProfile?.adaptive_horizon
            ),
            learningStatus: String(adaptiveProfile?.learning_status || 'N/A'),
            lastCalibrationTime: this.formatFirestoreDate(
              adaptiveProfile?.last_calibration_time || adaptiveProfile?.updated_at
            ),
            edgeQualityScore: this.toNullableNum(adaptiveProfile?.edge_quality_score),
            recalibrated: Boolean(adaptiveProfile?.recalibrated)
          };
          this.signalIntelAdaptiveRankingProfile = {
            minRankingScoreRecommended: this.toNullableNum(rankingProfile?.min_signal_ranking_score_recommended),
            minContextQualityRecommended: this.toNullableNum(rankingProfile?.min_context_quality_recommended),
            calibrationVersion: String(adaptiveProfiles?.calibration_version || rankingProfile?.calibration_version || 'N/A')
          };
          this.signalIntelAdaptiveContextProfile = {
            bestBucket: String(contextProfile?.best_context_bucket || 'N/A'),
            bestBucketWinRate: this.toRate(contextProfile?.best_context_bucket_win_rate),
            bestBucketExpectancy: this.toNullableNum(contextProfile?.best_context_bucket_expectancy)
          };
          this.signalIntelRankingSummary = {
            enabled: Boolean(rankingSummary?.enabled ?? true),
            avgRankingPercentile: this.toNullableNum(rankingSummary?.avg_ranking_percentile),
            operableCount: Number(rankingSummary?.operable_count || 0),
            topGlobalCount: Number(rankingSummary?.top_global_count || 0),
            topSymbolCount: Number(rankingSummary?.top_symbol_count || 0),
            topRegimeCount: Number(rankingSummary?.top_regime_count || 0),
            minRankingRecommended: this.toNullableNum(rankingProfile?.min_signal_ranking_score_recommended),
            minContextQualityRecommended: this.toNullableNum(rankingProfile?.min_context_quality_recommended)
          };
          this.signalIntelRankingRegimes = Array.isArray(rankingSummary?.regime_summary)
            ? rankingSummary.regime_summary.map((item: any) => ({
                regime: String(item?.regime || 'unknown'),
                total: Number(item?.total || 0),
                operable: Number(item?.operable || 0),
                avg_score: this.toNullableNum(item?.avg_score)
              }))
            : [];
          this.signalIntelContextSummary = {
            enabled: Boolean(contextIntelligenceSummary?.enabled),
            mode: String(contextIntelligenceSummary?.mode || 'observe'),
            bestBucket: String(contextIntelligenceSummary?.best_context_bucket?.bucket || 'N/A'),
            bestBucketWinRate: this.toRate(contextIntelligenceSummary?.best_context_bucket?.win_rate),
            bestBucketExpectancy: this.toNullableNum(contextIntelligenceSummary?.best_context_bucket?.expectancy)
          };
          this.signalIntelContextRegimes = Array.isArray(contextIntelligenceSummary?.regime_performance)
            ? contextIntelligenceSummary.regime_performance.map((item: any) => ({
                regime: String(item?.regime || 'unknown'),
                total: Number(item?.total || 0),
                win_rate: this.toRate(item?.win_rate),
                expectancy: this.toNullableNum(item?.expectancy)
              }))
            : [];

          this.signalIntelTopSymbols = Array.isArray(report?.symbol_performance)
            ? report.symbol_performance
                .slice(0, 8)
                .map((item: any) => ({
                  symbol: String(item?.symbol || 'UNKNOWN'),
                  total_signals: Number(item?.total_signals || 0),
                  win_rate: this.toRate(item?.win_rate),
                  expectancy: this.toNullableNum(item?.expectancy)
                }))
            : [];
          this.signalIntelSuppressedTopSymbols = Array.isArray(suppressedReport?.performance_by_symbol)
            ? suppressedReport.performance_by_symbol.slice(0, 8).map((item: any) => ({
                symbol: String(item?.symbol || 'UNKNOWN'),
                total_signals: Number(item?.total_signals || 0),
                win_rate: this.toRate(item?.win_rate),
                expectancy: this.toNullableNum(item?.expectancy),
                avg_MFE: this.toNullableNum(item?.avg_MFE),
                avg_MAE: this.toNullableNum(item?.avg_MAE)
              }))
            : [];
          this.signalIntelExecutionTopSymbols = Array.isArray(executionReport?.performance_by_symbol)
            ? executionReport.performance_by_symbol.slice(0, 8).map((item: any) => ({
                symbol: String(item?.symbol || 'UNKNOWN'),
                total_signals: Number(item?.total_signals || 0),
                win_rate: this.toRate(item?.win_rate),
                expectancy: this.toNullableNum(item?.expectancy),
                avg_MFE: this.toNullableNum(item?.avg_MFE),
                avg_MAE: this.toNullableNum(item?.avg_MAE)
              }))
            : [];
          this.signalIntelRankedSignals = Array.isArray(report?.ranked_signals)
            ? report.ranked_signals.slice(0, 8).map((item: any) => ({
                simbolo: String(item?.simbolo || item?.symbol || 'UNKNOWN'),
                timestamp: item?.timestamp || null,
                direction: String(item?.direction || 'neutral'),
                timeframe: String(item?.timeframe || 'unknown'),
                confidence: this.toRate(item?.confidence),
                context_score: this.toNullableNum(item?.context_score),
                signal_ranking_score: this.toNullableNum(item?.signal_ranking_score),
                ranking_percentile: this.toNullableNum(item?.ranking_percentile),
                top_signal_flag: Boolean(item?.top_signal_flag),
                is_top_signal_global: Boolean(item?.is_top_signal_global),
                is_top_signal_symbol: Boolean(item?.is_top_signal_symbol),
                is_top_signal_regime: Boolean(item?.is_top_signal_regime),
                is_ranked_operable: Boolean(item?.is_ranked_operable),
                ranking_regime: String(item?.ranking_regime || 'unknown'),
                ranking_position_global: this.toNullableNum(item?.ranking_position_global)
              }))
            : [];

          this.signalIntelContextQualityBuckets = Array.isArray(report?.context_quality_buckets)
            ? report.context_quality_buckets.map((item: any) => ({
                bucket: String(item?.bucket || 'unknown'),
                total: Number(item?.total || 0),
                win_rate: this.toRate(item?.win_rate),
                expectancy: this.toNullableNum(item?.expectancy)
              }))
            : [];
          this.signalIntelSuppressedContextBuckets = Array.isArray(suppressedReport?.context_quality?.buckets)
            ? suppressedReport.context_quality.buckets.map((item: any) => ({
                bucket: String(item?.bucket || 'unknown'),
                total: Number(item?.total_signals || 0),
                win_rate: this.toRate(item?.win_rate),
                expectancy: this.toNullableNum(item?.expectancy),
                mfe: this.toNullableNum(item?.MFE)
              }))
            : [];
          this.signalIntelLearningSummary = {
            expectancyStabilityScore: this.toNullableNum(expectancyStability?.expectancy_stability_score),
            expectancyVariance: this.toNullableNum(expectancyStability?.expectancy_variance),
            counterfactualExpectancy: this.toNullableNum(counterfactualLearning?.counterfactual_expectancy),
            counterfactualWinRate: this.toRate(counterfactualLearning?.counterfactual_win_rate),
            missedAlpha: this.toNullableNum(counterfactualLearning?.missed_alpha),
            falseNegativeRate: this.toRate(counterfactualLearning?.false_negative_rate),
            alphaDecayRate: this.toNullableNum(alphaDecay?.alpha_decay_rate),
            rollingExpectancyDelta: this.toNullableNum(alphaDecay?.rolling_expectancy_delta),
            expectancyTrend: String(alphaDecay?.expectancy_trend || 'N/A'),
            walkforwardExpectancy: this.toNullableNum(walkforward?.walkforward_expectancy),
            walkforwardWinRate: this.toRate(walkforward?.walkforward_win_rate),
            walkforwardEdgeDecay: this.toNullableNum(walkforward?.walkforward_edge_decay)
          };
          this.signalIntelLearningRegimes = Array.isArray(regimeLearning?.regimes)
            ? regimeLearning.regimes.map((item: any) => ({
                regime: String(item?.regime || 'unknown'),
                total: Number(item?.total || 0),
                win_rate: this.toRate(item?.win_rate),
                expectancy: this.toNullableNum(item?.expectancy),
                signal_density: this.toRate(item?.signal_density)
              }))
            : [];
          this.signalIntelConfidenceCalibration = Array.isArray(confidenceCalibration?.confidence_bucket_accuracy)
            ? confidenceCalibration.confidence_bucket_accuracy.map((item: any) => ({
                bucket: String(item?.bucket || 'unknown'),
                total: Number(item?.total || 0),
                win_rate: this.toRate(item?.real_winrate_per_confidence_bucket),
                expectancy: this.toNullableNum(item?.expectancy)
              }))
            : [];
          this.signalIntelMatrixCells = Array.isArray(matrix?.cells)
            ? matrix.cells.slice(0, 10).map((item: any) => ({
                symbol: String(item?.symbol || 'UNKNOWN'),
                regime: String(item?.regime || 'unknown'),
                rank_bucket: String(item?.rank_bucket || 'unknown'),
                total: Number(item?.total || 0),
                expectancy: this.toNullableNum(item?.expectancy),
                win_rate: this.toRate(item?.win_rate)
              }))
            : [];
          this.signalIntelSymbolSurvivorship = Array.isArray(survivorship?.symbols)
            ? survivorship.symbols.slice(0, 8).map((item: any) => ({
                symbol: String(item?.symbol || 'UNKNOWN'),
                total: Number(item?.total || 0),
                recent_expectancy: this.toNullableNum(item?.recent_expectancy),
                trend: this.toNullableNum(item?.symbol_expectancy_trend),
                edge_decay: this.toNullableNum(item?.symbol_edge_decay),
                degraded: Boolean(item?.symbol_degraded)
              }))
            : [];
          this.signalIntelWeeklyExpectancy = Array.isArray(expectancyStability?.weekly_windows)
            ? expectancyStability.weekly_windows.slice(-8).reverse().map((item: any) => ({
                iso_week: String(item?.iso_week || 'unknown'),
                total: Number(item?.total || 0),
                expectancy: this.toNullableNum(item?.expectancy),
                win_rate: this.toRate(item?.win_rate)
              }))
            : [];
        },
        error: (err) => {
          this.signalIntelError = err?.error?.error || err?.message || 'No se pudo cargar Signal Intelligence.';
        }
      });
  }

  cargarEquityCurve(refresh = false): void {
    this.equityCurveLoading = true;
    this.equityCurveError = '';
    this.velasService
      .obtenerEquityCurve({ refresh, maxTrades: 1000 })
      .pipe(finalize(() => (this.equityCurveLoading = false)))
      .subscribe({
        next: (response) => {
          const report = response?.report || {};
          const summary = report?.summary || {};
          this.equityCurveCandles = Array.isArray(report?.candles)
            ? report.candles.map((item: any) => ({
                time: Number(item?.time || 0),
                open: Number(item?.open || 0),
                high: Number(item?.high || 0),
                low: Number(item?.low || 0),
                close: Number(item?.close || 0)
              }))
            : [];
          this.equityCurveTrades = Array.isArray(report?.trades)
            ? report.trades.map((item: any) => ({
                id: String(item?.id || item?.time || item?.symbol || Math.random()),
                time: Number(item?.time || 0),
                symbol: String(item?.symbol || 'N/A'),
                source_profile: String(item?.source_profile || 'unknown'),
                outcome: this.normalizeEquityOutcome(item?.outcome),
                pnl_pct: Number(item?.pnl_pct || 0),
                close_reason: item?.close_reason || null,
                closed_at: item?.closed_at || null,
                open: Number(item?.open || 0),
                high: Number(item?.high || 0),
                low: Number(item?.low || 0),
                close: Number(item?.close || 0)
              }))
            : [];
          this.equityCurveSummary = {
            initialCapital: Number(summary?.initial_capital || 0),
            currentCapital: Number(summary?.current_capital || 0),
            curveCapital: Number(summary?.curve_capital || summary?.current_capital || 0),
            totalGrowthPct: Number(summary?.total_growth_pct || 0),
            totalTrades: Number(summary?.total_trades || 0),
            wins: Number(summary?.wins || 0),
            losses: Number(summary?.losses || 0),
            breakevens: Number(summary?.breakevens || 0),
            maxDrawdownPct: Number(summary?.max_drawdown_pct || 0),
            initialCapitalSource: String(summary?.initial_capital_source || ''),
            currentCapitalSource: String(summary?.current_capital_source || '')
          };
          this.equityHoveredTrade = null;
          this.queueEquityChartRender();
        },
        error: (err) => {
          this.equityCurveError = err?.error?.error || err?.message || 'No se pudo cargar la curva de equity.';
          this.equityCurveCandles = [];
          this.equityCurveTrades = [];
          this.equityHoveredTrade = null;
          this.destroyEquityChart();
        }
      });
  }

  equityOutcomeClass(item: EquityCurveTradePoint | null | undefined): string {
    const outcome = this.normalizeEquityOutcome(item?.outcome);
    if (outcome === 'WIN') return 'hc-badge hc-win';
    if (outcome === 'LOSS') return 'hc-badge hc-loss';
    return 'hc-badge hc-partial';
  }

  equitySourceLabel(item: EquityCurveTradePoint | null | undefined): string {
    return this.binanceExecutionSourceLabel({ source_profile: item?.source_profile });
  }

  equityPnlClass(item: EquityCurveTradePoint | null | undefined): string {
    const pnl = Number(item?.pnl_pct || 0);
    if (pnl > 0) return 'equity-pnl-positive';
    if (pnl < 0) return 'equity-pnl-negative';
    return 'equity-pnl-neutral';
  }

  private normalizeEquityOutcome(value: any): 'WIN' | 'LOSS' | 'BREAKEVEN' {
    const raw = String(value || '').toUpperCase();
    if (raw.includes('WIN')) return 'WIN';
    if (raw.includes('LOSS')) return 'LOSS';
    return 'BREAKEVEN';
  }

  private queueEquityChartRender(): void {
    if (!this.equityViewReady) return;
    setTimeout(() => this.renderEquityChart(), 0);
  }

  private renderEquityChart(): void {
    if (!this.equityViewReady || !this.equityChartContainer || !this.equityCurveCandles.length) {
      return;
    }

    const isDark = typeof document !== 'undefined' && document.body.classList.contains('theme-dark');
    const containerWidth = this.equityChartContainer.clientWidth || 320;
    const chartHeight = 320;
    const lineData = this.buildEquityTimelineData();

    if (!this.equityChart) {
      this.equityChart = createChart(this.equityChartContainer, {
        width: containerWidth,
        height: chartHeight,
        layout: {
          background: { type: ColorType.Solid, color: isDark ? '#0b1220' : '#fbfbfd' },
          textColor: isDark ? '#dbe7f5' : '#334155'
        },
        rightPriceScale: {
          borderColor: isDark ? '#334155' : '#cbd5e1'
        },
        timeScale: {
          borderColor: isDark ? '#334155' : '#cbd5e1',
          timeVisible: true,
          secondsVisible: false,
          rightOffset: 4
        },
        grid: {
          vertLines: { color: isDark ? 'rgba(148, 163, 184, 0.12)' : 'rgba(148, 163, 184, 0.18)' },
          horzLines: { color: isDark ? 'rgba(148, 163, 184, 0.12)' : 'rgba(148, 163, 184, 0.18)' }
        },
        crosshair: {
          mode: CrosshairMode.Magnet
        }
      });

      this.equityLineSeries = this.equityChart.addAreaSeries({
        lineColor: isDark ? '#7dd3fc' : '#2563eb',
        topColor: isDark ? 'rgba(56, 189, 248, 0.28)' : 'rgba(37, 99, 235, 0.22)',
        bottomColor: isDark ? 'rgba(11, 18, 32, 0.02)' : 'rgba(37, 99, 235, 0.03)',
        lineWidth: 3,
        crosshairMarkerVisible: true,
        crosshairMarkerRadius: 4,
        crosshairMarkerBorderColor: isDark ? '#dff7ff' : '#1d4ed8',
        crosshairMarkerBackgroundColor: isDark ? '#0b1220' : '#ffffff',
        lastValueVisible: false,
        priceLineVisible: false
      });

      this.equityChart.subscribeCrosshairMove((param) => {
        const hoveredTime = this.normalizeChartTime(param?.time);
        this.equityHoveredTrade = hoveredTime == null ? null : this.findClosestEquityTrade(hoveredTime);
      });

      if (typeof ResizeObserver !== 'undefined') {
        this.equityResizeObserver = new ResizeObserver((entries) => {
          const entry = entries[0];
          const width = Math.round(entry?.contentRect?.width || 0);
          if (width > 0 && this.equityChart) {
            this.equityChart.applyOptions({ width });
          }
        });
        this.equityResizeObserver.observe(this.equityChartContainer);
      }
    } else {
      this.equityChart.applyOptions({
        width: containerWidth,
        height: chartHeight,
        layout: {
          background: { type: ColorType.Solid, color: isDark ? '#0b1220' : '#fbfbfd' },
          textColor: isDark ? '#dbe7f5' : '#334155'
        },
        rightPriceScale: {
          borderColor: isDark ? '#334155' : '#cbd5e1'
        },
        timeScale: {
          borderColor: isDark ? '#334155' : '#cbd5e1',
          rightOffset: 4
        }
      });
      this.equityLineSeries?.applyOptions({
        lineColor: isDark ? '#7dd3fc' : '#2563eb',
        topColor: isDark ? 'rgba(56, 189, 248, 0.28)' : 'rgba(37, 99, 235, 0.22)',
        bottomColor: isDark ? 'rgba(11, 18, 32, 0.02)' : 'rgba(37, 99, 235, 0.03)',
        crosshairMarkerBorderColor: isDark ? '#dff7ff' : '#1d4ed8',
        crosshairMarkerBackgroundColor: isDark ? '#0b1220' : '#ffffff'
      });
    }

    this.equityLineSeries?.setData(lineData);
    this.equityLineSeries?.setMarkers([]);
    this.equityChart.timeScale().fitContent();
  }

  private buildEquityTimelineData(): Array<{ time: UTCTimestamp; value: number }> {
    return this.equityCurveCandles.map((item) => ({
      time: item.time as UTCTimestamp,
      value: item.close
    }));
  }

  private findClosestEquityTrade(hoveredTime: number | null): EquityCurveTradePoint | null {
    if (!this.equityCurveTrades.length) {
      return null;
    }
    if (hoveredTime == null) return null;

    let closest = this.equityCurveTrades[0];
    let smallestDelta = Math.abs(closest.time - hoveredTime);

    for (let i = 1; i < this.equityCurveTrades.length; i += 1) {
      const trade = this.equityCurveTrades[i];
      const delta = Math.abs(trade.time - hoveredTime);
      if (delta < smallestDelta) {
        closest = trade;
        smallestDelta = delta;
      }
    }

    return closest;
  }

  private normalizeChartTime(time: Time | undefined): number | null {
    if (time == null) return null;
    if (typeof time === 'number') return Number(time);
    if (typeof time === 'string') {
      const parsed = Date.parse(time);
      return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
    }
    if (typeof time === 'object' && 'year' in time && 'month' in time && 'day' in time) {
      return Math.floor(Date.UTC(time.year, time.month - 1, time.day) / 1000);
    }
    return null;
  }

  private destroyEquityChart(): void {
    if (this.equityResizeObserver) {
      this.equityResizeObserver.disconnect();
      this.equityResizeObserver = null;
    }
    if (this.equityChart) {
      this.equityChart.remove();
      this.equityChart = null;
      this.equityLineSeries = null;
    }
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

  toggleBinanceExecutionDetails(executionId: string): void {
    this.expandedBinanceExecutionId = this.expandedBinanceExecutionId === executionId ? null : executionId;
  }

  isBinanceExecutionExpanded(executionId: string): boolean {
    return this.expandedBinanceExecutionId === executionId;
  }

  highConvictionOutcome(signal: any): string {
    const linkedOutcome = this.resolveTradeOutcome(
      signal?.linkedPosition?.win_exchange_net ||
      signal?.linkedPosition?.win_exchange ||
      signal?.linkedIntent?.win_exchange_net ||
      signal?.linkedIntent?.win_exchange ||
      signal?.linkedIntent?.execution_audit?.win_exchange_net ||
      signal?.linkedIntent?.execution_audit?.win_exchange,
      signal?.linkedPosition?.net_close_pnl_pct ??
        signal?.linkedPosition?.close_pnl_pct ??
        signal?.linkedIntent?.net_close_pnl_pct ??
        signal?.linkedIntent?.close_pnl_pct ??
        signal?.linkedIntent?.execution_audit?.net_close_pnl_pct ??
        signal?.linkedIntent?.execution_audit?.close_pnl_pct
    );
    if (linkedOutcome) return linkedOutcome;

    const linkedPositionStatus = String(signal?.linkedPosition?.status || '').toLowerCase();
    if (linkedPositionStatus === 'open') return 'ABIERTA';

    const raw = (
      signal?.verification_outcome ||
      signal?.linkedPrediction?.verification?.verification_outcome ||
      signal?.linkedPrediction?.verification_outcome ||
      signal?.verification?.verification_outcome ||
      signal?.verification?.outcome_label ||
      signal?.status ||
      'PENDIENTE'
    ).toString().toUpperCase();

    if (raw.includes('WIN') || raw === 'VALIDADO') return 'WIN';
    if (raw.includes('LOSS') || raw === 'FALLIDO') return 'LOSS';
    if (raw.includes('BREAKEVEN')) return 'BREAKEVEN';
    if (raw.includes('SUPPRESSED') || raw === 'SUPRIMIDA') return 'SUPRIMIDA';
    if (raw.includes('PARTIAL') || raw.includes('PARCIAL')) return 'PARCIAL';
    const exec = this.highConvictionBinanceExecution(signal);
    const execStatus = String(exec?.status || exec?.intent_status || '').toLowerCase();
    const execReason = this.highConvictionBinanceReason(signal);
    if (execStatus === 'executed') return 'ABIERTA';
    if (execStatus === 'failed' || execStatus === 'blocked') return 'LOSS';
    const omittedByBinance =
      execStatus === 'skipped' ||
      (
        Boolean(exec) &&
        !exec?.executed &&
        !exec?.dry_run &&
        !execReason.startsWith('error:') &&
        execReason !== 'already_processed' &&
        execReason !== 'not_attempted' &&
        execReason !== 'signal_not_emitted' &&
        execReason !== 'neutral_direction'
      );
    if (omittedByBinance) return 'SUPRIMIDA';
    if (execStatus === 'dry_run' || exec?.dry_run || execReason === 'already_processed') return 'PARCIAL';
    return 'PENDIENTE';
  }

  highConvictionStatusClass(signal: any): string {
    switch (this.highConvictionOutcome(signal)) {
      case 'WIN':
        return 'hc-badge hc-win';
      case 'LOSS':
        return 'hc-badge hc-loss';
      case 'BREAKEVEN':
        return 'hc-badge hc-partial';
      case 'ABIERTA':
        return 'hc-badge hc-partial';
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
    return (
      signal?.linkedPosition?.close_reason ||
      signal?.linkedIntent?.execution_audit?.close_reason ||
      signal?.verification?.remarks ||
      signal?.linkedPrediction?.verification?.remarks ||
      signal?.remarks ||
      'Sin observaciones'
    );
  }

  highConvictionBinanceExecution(signal: any): any {
    const linkedIntent = signal?.linkedIntent || null;
    const base = signal?.binance_execution || signal?.linkedPrediction?.binance_execution || null;
    if (!linkedIntent) return base;
    return {
      ...base,
      ...linkedIntent,
      attempted: linkedIntent?.status ? linkedIntent.status !== 'unknown' : Boolean(base?.attempted),
      executed: String(linkedIntent?.status || '').toLowerCase() === 'executed' || Boolean(base?.executed),
      dry_run: String(linkedIntent?.status || '').toLowerCase() === 'dry_run' || Boolean(base?.dry_run),
      reason: linkedIntent?.reason || base?.reason || null,
      order_id:
        linkedIntent?.exchange_response?.order?.orderId ||
        linkedIntent?.order_id ||
        base?.order_id ||
        null,
      exits: {
        tp_order_id:
          linkedIntent?.tp_order_id ||
          linkedIntent?.exchange_response?.exits?.tp?.algoId ||
          base?.exits?.tp_order_id ||
          null,
        sl_order_id:
          linkedIntent?.sl_order_id ||
          linkedIntent?.exchange_response?.exits?.sl?.algoId ||
          base?.exits?.sl_order_id ||
          null
      }
    };
  }

  highConvictionExecutionMeta(signal: any): any {
    return signal?.execution_meta || signal?.linkedPrediction?.execution_meta || null;
  }

  private highConvictionBinanceReason(signal: any): string {
    const exec = this.highConvictionBinanceExecution(signal);
    return String(exec?.reason || exec?.error_message || exec?.failure_stage || '').toLowerCase();
  }

  highConvictionBinanceStatus(signal: any): string {
    const linkedPositionStatus = String(signal?.linkedPosition?.status || '').toLowerCase();
    if (linkedPositionStatus === 'closed') return 'Cerrada';
    if (linkedPositionStatus === 'open') return 'Abierta';
    const exec = this.highConvictionBinanceExecution(signal);
    if (!exec) return 'Sin intento';
    const execStatus = String(exec?.status || exec?.intent_status || '').toLowerCase();
    if (execStatus === 'executed' || exec.executed) return 'Ejecutada';
    if (execStatus === 'failed') return 'Falló ejecución';
    if (execStatus === 'blocked') return 'Bloqueada';
    if (execStatus === 'skipped') return 'Omitida';
    if (exec.dry_run) return 'Dry-run';
    const reason = this.highConvictionBinanceReason(signal);
    if (reason === 'already_processed') return 'Ya procesada';
    if (reason === 'not_attempted' || reason === 'signal_not_emitted' || reason === 'neutral_direction') {
      return 'Sin intento';
    }
    if (reason.startsWith('error:')) return 'Fall� ejecuci�n';
    if (exec.attempted) return 'Omitida';
    return 'Sin intento';
  }

  highConvictionBinanceStatusClass(signal: any): string {
    const status = this.highConvictionBinanceStatus(signal);
    if (status === 'Cerrada') {
      const outcome = this.highConvictionOutcome(signal);
      if (outcome === 'WIN') return 'hc-badge hc-win';
      if (outcome === 'LOSS') return 'hc-badge hc-loss';
      return 'hc-badge hc-partial';
    }
    if (status === 'Abierta' || status === 'Ejecutada') return 'hc-badge hc-partial';
    if (status === 'Ejecutada') return 'hc-badge hc-win';
    if (status === 'Dry-run') return 'hc-badge hc-partial';
    if (status.startsWith('Fall')) return 'hc-badge hc-loss';
    if (status === 'Ya procesada') return 'hc-badge hc-partial';
    if (status === 'Omitida') return 'hc-badge hc-suppressed';
    return 'hc-badge hc-pending';
  }

  binanceExecutionSourceLabel(item: any): string {
    const source = String(item?.source_profile || item?.source || 'unknown').toLowerCase();
    if (source === 'high_conviction') return 'HC';
    if (source === 'event_emitted') return 'Event';
    if (source === 'manual_prealert') return 'Prealert';
    return source || 'N/A';
  }

  binanceExecutionSourceClass(item: any): string {
    const source = String(item?.source_profile || item?.source || 'unknown').toLowerCase();
    if (source === 'high_conviction') return 'hc-badge hc-win';
    if (source === 'event_emitted') return 'hc-badge hc-partial';
    if (source === 'manual_prealert') return 'hc-badge hc-suppressed';
    return 'hc-badge hc-pending';
  }

  binanceExecutionStatusLabel(item: any): string {
    const linkedPositionStatus = String(item?.linkedPosition?.status || '').toLowerCase();
    if (linkedPositionStatus === 'closed') return 'Cerrada';
    if (linkedPositionStatus === 'open') return 'Abierta';
    const status = String(item?.status || '').toLowerCase();
    if (status === 'executed') return 'Ejecutada';
    if (status === 'skipped') return 'Omitida';
    if (status === 'failed') return 'Fall�';
    if (status === 'dry_run') return 'Dry-run';
    if (status === 'blocked') return 'Bloqueada';
    return item?.reason ? 'Procesada' : 'Pendiente';
  }

  binanceExecutionStatusClass(item: any): string {
    const status = this.binanceExecutionStatusLabel(item);
    if (status === 'Cerrada') {
      const outcome = this.binanceExecutionOutcomeLabel(item);
      if (outcome === 'WIN') return 'hc-badge hc-win';
      if (outcome === 'LOSS') return 'hc-badge hc-loss';
      return 'hc-badge hc-partial';
    }
    if (status === 'Abierta' || status === 'Ejecutada') return 'hc-badge hc-partial';
    if (status.startsWith('Fall') || status === 'Bloqueada') return 'hc-badge hc-loss';
    if (status === 'Omitida') return 'hc-badge hc-suppressed';
    if (status === 'Dry-run') return 'hc-badge hc-partial';
    return 'hc-badge hc-pending';
  }

  binanceExecutionOutcomeLabel(item: any): string {
    const resolved = this.resolveTradeOutcome(
      item?.linkedPosition?.win_exchange_net ||
      item?.linkedPosition?.win_exchange ||
      item?.win_exchange_net ||
      item?.win_exchange ||
      item?.execution_audit?.win_exchange_net ||
      item?.execution_audit?.win_exchange ||
      item?.linkedPrediction?.verification?.verification_outcome ||
      item?.linkedPrediction?.verification_outcome,
      item?.linkedPosition?.net_close_pnl_pct ??
        item?.linkedPosition?.close_pnl_pct ??
        item?.net_close_pnl_pct ??
        item?.close_pnl_pct ??
        item?.execution_audit?.net_close_pnl_pct ??
        item?.execution_audit?.close_pnl_pct
    );
    if (resolved) return resolved;
    if (String(item?.linkedPosition?.status || '').toLowerCase() === 'closed') return 'CERRADA';
    const outcome = String(
      item?.linkedPosition?.win_exchange ||
      item?.linkedPrediction?.verification?.verification_outcome ||
      item?.linkedPrediction?.verification_outcome ||
      ''
    ).toUpperCase();
    if (outcome.includes('WIN') || outcome === 'VALIDADO') return 'WIN';
    if (outcome.includes('LOSS') || outcome === 'FALLIDO') return 'LOSS';
    if (outcome.includes('BREAKEVEN')) return 'BREAKEVEN';
    if (String(item?.status || '').toLowerCase() === 'executed') return 'ABIERTA';
    return '�';
  }

  binanceExecutionOutcomeClass(item: any): string {
    const outcome = this.binanceExecutionOutcomeLabel(item);
    if (outcome === 'WIN') return 'hc-badge hc-win';
    if (outcome === 'LOSS') return 'hc-badge hc-loss';
    if (outcome === 'BREAKEVEN') return 'hc-badge hc-partial';
    return 'hc-badge hc-pending';
  }

  binanceExecutionReason(item: any): string {
    return String(item?.reason || item?.error_message || item?.linkedPosition?.close_reason || '�');
  }

  binanceExecutionDelayMs(item: any): number | null {
    const value =
      item?.execution_discipline?.execution_delay_ms ??
      item?.execution_trace_metrics?.total_latency_ms ??
      item?.linkedPrediction?.execution_meta?.execution_delay_ms ??
      null;
    return this.toNullableNum(value);
  }

  private resolveBinanceExecutionDate(item: any): Date {
    const raw =
      item?.created_at ||
      item?.opened_at ||
      item?.closed_at ||
      item?.updated_at ||
      item?.timestamp ||
      null;
    if (!raw) return new Date(0);
    if (typeof raw?.toDate === 'function') {
      return raw.toDate();
    }
    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? new Date(0) : parsed;
  }

  private resolveBinanceExecutionActivityDate(item: any): Date {
    const raw =
      item?.linkedPosition?.closed_at ||
      item?.execution_audit?.closed_at ||
      item?.linkedPosition?.updated_at ||
      item?.updated_at ||
      item?.created_at ||
      item?.opened_at ||
      item?.timestamp ||
      null;
    return this.resolveBinanceExecutionDate({ created_at: raw });
  }

  private resolveTradeOutcome(rawOutcome: any, pnlValue?: any): 'WIN' | 'LOSS' | 'BREAKEVEN' | null {
    const outcome = String(rawOutcome || '').toUpperCase();
    if (outcome.includes('WIN') || outcome === 'VALIDADO') return 'WIN';
    if (outcome.includes('LOSS') || outcome === 'FALLIDO') return 'LOSS';
    if (outcome.includes('BREAKEVEN')) return 'BREAKEVEN';

    const pnl = this.toNullableNum(pnlValue);
    if (pnl == null) return null;
    if (pnl > 0.000001) return 'WIN';
    if (pnl < -0.000001) return 'LOSS';
    return 'BREAKEVEN';
  }

  private sanitizeIntentDocIdPart(value: any): string {
    return String(value || '')
      .replace(/[^a-zA-Z0-9_-]/g, '_')
      .slice(0, 120);
  }

  private buildIntentDocId(predictionId: string | null, sourceProfile: string): string | null {
    if (!predictionId) return null;
    return `${this.sanitizeIntentDocIdPart(predictionId)}__${this.sanitizeIntentDocIdPart(sourceProfile || 'default')}`;
  }

  executionBadges(signal: any): ExecutionBadgeItem[] {
    const meta = signal?.execution_meta || signal?.linkedPrediction?.execution_meta || null;
    if (!meta) return [];

    const badges: ExecutionBadgeItem[] = [];
    const exec = this.highConvictionBinanceExecution(signal);
    if (meta.override_applied && exec?.executed) {
      badges.push({ label: 'Executed (soft override)', className: 'exec-badge exec-badge-override' });
    }
    if (meta.late_entry_type === 'soft') {
      badges.push({ label: 'Late (soft)', className: 'exec-badge exec-badge-soft' });
    } else if (meta.late_entry_type === 'hard') {
      badges.push({ label: 'Late (hard)', className: 'exec-badge exec-badge-hard' });
    }

    if (meta.would_have_been_win) {
      badges.push({ label: 'Missed WIN', className: 'exec-badge exec-badge-win' });
    } else if (meta.would_have_been_loss) {
      badges.push({ label: 'Missed LOSS', className: 'exec-badge exec-badge-loss' });
    }

    return badges;
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
        min_context_quality: Number(config.min_context_quality ?? this.binanceConfig.min_context_quality),
        min_risk_reward: Number(config.min_risk_reward ?? this.binanceConfig.min_risk_reward),
        min_expected_move_pct: Number(config.min_expected_move_pct ?? this.binanceConfig.min_expected_move_pct),
        allow_unlisted_symbols: Boolean(config.allow_unlisted_symbols),
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
      min_context_quality: Number(this.binanceConfig.min_context_quality),
      min_risk_reward: Number(this.binanceConfig.min_risk_reward),
      min_expected_move_pct: Number(this.binanceConfig.min_expected_move_pct),
      allow_unlisted_symbols: Boolean(this.binanceConfig.allow_unlisted_symbols),
      symbols_allowlist: symbols,
      early_exit_enabled: Boolean(this.binanceConfig.early_exit_enabled),
      early_exit_drawdown_pct: Number(this.binanceConfig.early_exit_drawdown_pct),
      updated_at: new Date().toISOString()
    };

    try {
      await this.firestoreService.saveBinanceBotConfig(payload);
      this.mensaje = 'Configuraci�n Binance guardada.';
    } catch {
      this.mensaje = 'No se pudo guardar configuraci�n Binance.';
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

    const intentIds = predictionIds.map((id) => this.buildIntentDocId(id, 'high_conviction')).filter(Boolean) as string[];
    return combineLatest([
      this.firestoreService.getCollectionByIds<any>('velas_predicciones', predictionIds),
      this.firestoreService.getCollectionByIds<any>('binance_execution_intents', intentIds)
    ]).pipe(
      switchMap(([predictions, intents]) => {
        const linkedPositionIds = Array.from(
          new Set(
            (intents || [])
              .map((item) => item?.linked_position_id)
              .filter((id) => !!id)
          )
        ) as string[];

        return combineLatest([
          of(predictions),
          of(intents),
          this.firestoreService.getCollectionByFieldIn<any>('binance_open_positions', 'prediction_id', predictionIds),
          linkedPositionIds.length
            ? this.firestoreService.getCollectionByIds<any>('binance_open_positions', linkedPositionIds)
            : of([] as any[])
        ]);
      }),
      map(([predictions, intents, positionsByPrediction, positionsById]) => {
        const byId = new Map<string, any>();
        predictions.forEach((p) => byId.set(p.id, p));
        const intentMap = new Map<string, any>();
        (intents || []).forEach((item) => {
          if (item?.prediction_id) {
            intentMap.set(item.prediction_id, item);
          }
        });
        const positionByIdMap = new Map<string, any>();
        (positionsById || []).forEach((position) => positionByIdMap.set(position.id, position));
        const positionByPredictionMap = new Map<string, any>();
        (positionsByPrediction || []).forEach((position: any) => {
          const key = `${position?.prediction_id || 'none'}__${position?.source_profile || position?.source || 'unknown'}`;
          const current = positionByPredictionMap.get(key);
          const currentTs = this.resolveBinanceExecutionDate(current).getTime();
          const nextTs = this.resolveBinanceExecutionDate(position).getTime();
          if (!current || nextTs >= currentTs) {
            positionByPredictionMap.set(key, position);
          }
        });
        return (signals || []).map((signal) => {
          const linkedPrediction = signal?.prediction_id ? byId.get(signal.prediction_id) : null;
          const linkedIntent = signal?.prediction_id ? intentMap.get(signal.prediction_id) : null;
          const linkedPosition =
            linkedIntent?.linked_position_id
              ? positionByIdMap.get(linkedIntent.linked_position_id) || null
              : (signal?.prediction_id
                  ? positionByPredictionMap.get(`${signal.prediction_id}__high_conviction`) || null
                  : null);
          return {
            ...signal,
            linkedPrediction,
            linkedIntent,
            linkedPosition
          };
        });
      })
    );
  }

  private enrichBinanceExecutionIntents(items: any[]): Observable<any[]> {
    const predictionIds = Array.from(
      new Set(
        (items || [])
          .map((item) => item?.prediction_id)
          .filter((id) => !!id)
      )
    ) as string[];

    if (!predictionIds.length) {
      return of(items || []);
    }

    const linkedPositionIds = Array.from(
      new Set(
        (items || [])
          .map((item) => item?.linked_position_id)
          .filter((id) => !!id)
      )
    ) as string[];

    return combineLatest([
      this.firestoreService.getCollectionByIds<any>('velas_predicciones', predictionIds),
      this.firestoreService.getCollectionByFieldIn<any>('binance_open_positions', 'prediction_id', predictionIds),
      linkedPositionIds.length
        ? this.firestoreService.getCollectionByIds<any>('binance_open_positions', linkedPositionIds)
        : of([] as any[])
    ]).pipe(
      map(([predictions, positions, positionsById]) => {
        const predictionMap = new Map<string, any>();
        predictions.forEach((item: any) => predictionMap.set(item.id, item));

        const positionMap = new Map<string, any>();
        (positions || []).forEach((position: any) => {
          const key = `${position?.prediction_id || 'none'}__${position?.source_profile || position?.source || 'unknown'}`;
          const current = positionMap.get(key);
          const currentTs = this.resolveBinanceExecutionDate(current).getTime();
          const nextTs = this.resolveBinanceExecutionDate(position).getTime();
          if (!current || nextTs >= currentTs) {
            positionMap.set(key, position);
          }
        });
        const linkedPositionMap = new Map<string, any>();
        (positionsById || []).forEach((position: any) => {
          linkedPositionMap.set(position.id, position);
        });

        return (items || [])
          .map((item) => {
          const predictionId = item?.prediction_id || null;
          const sourceProfile = item?.source_profile || item?.source || 'unknown';
          const linkedPrediction = predictionId ? predictionMap.get(predictionId) : null;
          const linkedPosition = item?.linked_position_id
            ? linkedPositionMap.get(item.linked_position_id) || null
            : predictionId
              ? positionMap.get(`${predictionId}__${sourceProfile}`) || null
              : null;
          return {
            ...item,
            linkedPrediction,
            linkedPosition
          };
        })
          .sort((a, b) => this.resolveBinanceExecutionActivityDate(b).getTime() - this.resolveBinanceExecutionActivityDate(a).getTime());
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
    open: number;
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
        open: 0,
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
    let open = 0;
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
      else if (outcome === 'ABIERTA') open += 1;
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
      open,
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
    const outcome = (
      signal?.suppressed_verification?.counterfactual_outcome ||
      signal?.linkedPrediction?.suppressed_verification?.counterfactual_outcome ||
      signal?.linkedPrediction?.verification?.suppressed_verification?.counterfactual_outcome ||
      signal?.verification?.suppressed_verification?.counterfactual_outcome ||
      signal?.verification?.counterfactual_outcome ||
      signal?.counterfactual_outcome ||
      ''
    ).toString().toUpperCase();
    return outcome.includes('WIN') || outcome.includes('LOSS');
  }

  private isSuppressedWin(signal: any): boolean {
    const outcome = (
      signal?.suppressed_verification?.counterfactual_outcome ||
      signal?.linkedPrediction?.suppressed_verification?.counterfactual_outcome ||
      signal?.linkedPrediction?.verification?.suppressed_verification?.counterfactual_outcome ||
      signal?.verification?.suppressed_verification?.counterfactual_outcome ||
      signal?.verification?.counterfactual_outcome ||
      signal?.counterfactual_outcome ||
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
    if (!value) return '�';
    const date = typeof value.toDate === 'function' ? value.toDate() : new Date(value);
    if (Number.isNaN(date.getTime())) return '�';
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

  formatPctOrNA(value: number | null | undefined): string {
    if (value == null || !isFinite(value)) return 'N/A';
    return `${(value * 100).toFixed(1)}%`;
  }

  formatEdge(value: number | null | undefined): string {
    if (value == null || !isFinite(value)) return 'N/A';
    return `${value.toFixed(3)}%`;
  }

  formatScoreOrNA(value: number | null | undefined): string {
    if (value == null || !isFinite(value)) return 'N/A';
    return `${Math.round(value)}`;
  }

  formatSecondsOrNA(value: number | null | undefined): string {
    if (value == null || !isFinite(value)) return 'N/A';
    return `${Math.round(value)}s`;
  }

  formatMsOrNA(value: number | null | undefined): string {
    if (value == null || !isFinite(value)) return 'N/A';
    return `${Math.round(value)} ms`;
  }

  latencyStageLabel(stage: string | null | undefined): string {
    switch (stage) {
      case 'signal_to_emit_ms':
        return 'Signal ? Emit';
      case 'emit_to_intent_ms':
        return 'Emit ? Intent';
      case 'intent_to_process_ms':
        return 'Intent ? Process';
      case 'process_to_attempt_ms':
        return 'Process ? Attempt';
      case 'attempt_to_order_ms':
        return 'Attempt ? Order';
      default:
        return 'N/A';
    }
  }

  latencyWarningActive(): boolean {
    const threshold = Number(this.signalIntelLatencySummary.entryWindowSeconds || 0) * 1000;
    const p95 = Number(this.signalIntelLatencySummary.p95Latency || 0);
    return threshold > 0 && p95 > threshold;
  }

  private toRate(value: any): number | null {
    const n = Number(value);
    return Number.isFinite(n) ? (n > 1 ? n / 100 : n) : null;
  }

  private toNullableNum(value: any): number | null {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
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
    symbolsRequested: number;
    symbolsExcludedCooldown: number;
    processedOk: number;
    failed: number;
    emitted: number;
    suppressed: number;
    cycleDurationMs: number;
    suppressionRate: number;
    certaintyWinRate: number;
    classification: string;
    topFailureSymbols: string[];
    updatedAt: string;
  } {
    const latest = (items || [])[0];
    if (!latest) {
      return {
        symbolsTotal: 0,
        symbolsRequested: 0,
        symbolsExcludedCooldown: 0,
        processedOk: 0,
        failed: 0,
        emitted: 0,
        suppressed: 0,
        cycleDurationMs: 0,
        suppressionRate: 0,
        certaintyWinRate: 0,
        classification: 'n/a',
        topFailureSymbols: [],
        updatedAt: '�'
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
    const topFailureSymbols = Array.isArray(cycle?.failure_reasons_top)
      ? cycle.failure_reasons_top
          .slice(0, 4)
          .map((item: any) => String(item?.symbol || '').trim())
          .filter((item: string) => !!item)
      : [];
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
      : '�';
    this.lastEmissionCount = Number(latestEmissionMetrics?.signals_emitted || 0);

    return {
      symbolsTotal: Number(cycle?.symbols_total || 0),
      symbolsRequested: Number(cycle?.symbols_requested || cycle?.symbols_total || 0),
      symbolsExcludedCooldown: Number(cycle?.symbols_excluded_cooldown || 0),
      processedOk,
      failed: Number(cycle?.failed || 0),
      emitted,
      suppressed,
      cycleDurationMs: Number(cycle?.cycle_duration_ms || 0),
      suppressionRate,
      certaintyWinRate: winRatePct > 1 ? winRatePct / 100 : winRatePct,
      classification: String(audit?.classification || latestAuditSnapshot?.classification || latest?.classification || 'n/a'),
      topFailureSymbols,
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






