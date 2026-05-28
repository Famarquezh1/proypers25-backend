import { Component, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';
import { TradingMonitorService } from '../../servicios/trading-monitor.service';
import { Subscription, Subject } from 'rxjs';
import { takeUntil } from 'rxjs/operators';

@Component({
  selector: 'app-trading-monitor',
  standalone: true,
  imports: [CommonModule, RouterLink],
  templateUrl: './trading-monitor.component.html',
  styleUrls: ['./trading-monitor.component.css']
})
export class TradingMonitorComponent implements OnInit, OnDestroy {
  // Estado de carga
  isLoading = true;
  hasError = false;
  errorMessage = '';
  lastUpdateTime: Date | null = null;

  // Datos del snapshot completo
  realExecution: any = null;
  preflightData: any = null;
  paperExecution: any = null;
  spotOpportunities: any = null;
  hybridMode: any = null;

  // Control de destrucción
  private destroy$ = new Subject<void>();
  private autoRefreshSubscription: Subscription | null = null;

  constructor(private monitorService: TradingMonitorService) {}

  ngOnInit(): void {
    this.loadMonitorData();
    this.startAutoRefresh();
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
    if (this.autoRefreshSubscription) {
      this.autoRefreshSubscription.unsubscribe();
    }
  }

  /**
   * Carga los datos del monitor manualmente
   */
  loadMonitorData(): void {
    this.isLoading = true;
    this.hasError = false;

    this.monitorService.getFullMonitorSnapshot()
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: (snapshot) => {
          this.realExecution = snapshot.real.report;
          this.preflightData = snapshot.preflight.report;
          this.paperExecution = snapshot.paper.report;
          this.spotOpportunities = snapshot.opportunities.report;
          this.lastUpdateTime = snapshot.timestamp;
          this.isLoading = false;
          
          // Load hybrid mode data
          this.loadHybridModeData();
        },
        error: (error) => {
          this.hasError = true;
          this.errorMessage = error.message || 'Error al cargar datos del monitor';
          this.isLoading = false;
          console.error('Monitor error:', error);
        }
      });
  }

  /**
   * Carga datos del hybrid mode (70/30 split)
   */
  loadHybridModeData(): void {
    this.monitorService.getHybridModeStatus()
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: (data) => {
          this.hybridMode = data;
        },
        error: (error) => {
          console.warn('Hybrid mode data unavailable:', error);
          // No es crítico, continúa sin estos datos
        }
      });
  }

  /**
   * Inicia auto-refresh cada 15 segundos
   */
  startAutoRefresh(): void {
    this.autoRefreshSubscription = this.monitorService.startAutoRefresh(15000)
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: (snapshot) => {
          if (snapshot) {
            this.realExecution = snapshot.real.report;
            this.preflightData = snapshot.preflight.report;
            this.paperExecution = snapshot.paper.report;
            this.spotOpportunities = snapshot.opportunities.report;
            this.lastUpdateTime = snapshot.timestamp;
          }
        },
        error: (error) => {
          console.error('Auto-refresh error:', error);
          // No rompe la pantalla, continúa mostrando datos anteriores
        }
      });
  }

  /**
   * Determina clase CSS para estado del sistema
   */
  getSystemStatusClass(): string {
    if (!this.realExecution) return 'bg-secondary';
    
    const { real_spot_enabled, kill_switch, open_real_positions } = this.realExecution;

    // Sistema armado (habilitado + sin kill switch + posición abierta)
    if (real_spot_enabled && !kill_switch && open_real_positions > 0) {
      return 'bg-danger';
    }

    // Sistema armado (habilitado + sin kill switch)
    if (real_spot_enabled && !kill_switch) {
      return 'bg-warning';
    }

    // Sistema bloqueado/seguro
    if (!real_spot_enabled && kill_switch) {
      return 'bg-success';
    }

    return 'bg-secondary';
  }

  /**
   * Obtiene texto del estado del sistema
   */
  getSystemStatusText(): string {
    if (!this.realExecution) return 'CARGANDO';

    const { real_spot_enabled, kill_switch, open_real_positions } = this.realExecution;

    if (real_spot_enabled && !kill_switch && open_real_positions > 0) {
      return 'POSICIÓN REAL ABIERTA';
    }

    if (real_spot_enabled && !kill_switch) {
      return 'SISTEMA ARMADO';
    }

    if (!real_spot_enabled && kill_switch) {
      return 'SISTEMA BLOQUEADO / SEGURO';
    }

    return 'ESTADO DESCONOCIDO';
  }

  /**
   * Formatea número a string de 2 decimales
   */
  formatNumber(num: number | undefined | null): string {
    if (num === undefined || num === null) return 'N/A';
    return num.toFixed(2);
  }

  /**
   * Formatea porcentaje
   */
  formatPercent(num: number | undefined | null): string {
    if (num === undefined || num === null) return 'N/A';
    return (num * 100).toFixed(2) + '%';
  }

  /**
   * Formatea fecha/hora
   */
  formatDateTime(date: Date | string | undefined): string {
    if (!date) return 'N/A';
    try {
      const d = new Date(date);
      return d.toLocaleString('es-AR', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      });
    } catch {
      return 'Formato inválido';
    }
  }

  /**
   * Verifica si hay alerta crítica de balance bajo
   */
  hasLowBalanceAlert(): boolean {
    return this.preflightData?.usdt_balance_free < 10;
  }

  /**
   * Verifica si hay alerta de retiros habilitados
   */
  hasWithdrawalAlert(): boolean {
    return this.preflightData?.enable_withdrawals_api_key === true;
  }

  /**
   * Verifica si hay capital expuesto peligroso
   */
  hasHighCapitalAlert(): boolean {
    return this.realExecution?.total_real_capital_exposed > 10;
  }

  /**
   * Obtiene clase para mostrar alerta de retiros
   */
  getWithdrawalAlertClass(): string {
    if (this.preflightData?.enable_withdrawals_api_key === true) {
      return 'alert alert-danger';
    }
    return 'alert alert-success';
  }

  /**
   * Obtiene clase para mostrar alerta de balance
   */
  getBalanceAlertClass(): string {
    if (this.preflightData?.usdt_balance_free < 10) {
      return 'alert alert-warning';
    }
    return 'alert alert-info';
  }

  /**
   * Obtiene clase para mostrar alerta de capital
   */
  getCapitalAlertClass(): string {
    if (this.realExecution?.total_real_capital_exposed > 10) {
      return 'alert alert-danger';
    }
    return 'alert alert-info';
  }

  /**
   * Verifica si hay candidato seleccionado
   */
  hasSelectedCandidate(): boolean {
    return this.realExecution?.entry_diagnostic?.selected_candidate !== null &&
           this.realExecution?.entry_diagnostic?.selected_candidate !== undefined;
  }

  /**
   * Verifica si el scan está demasiado viejo
   */
  isScanTooOld(): boolean {
    const rejected = this.realExecution?.entry_diagnostic?.rejected_reasons || [];
    return rejected.includes('SCAN_TOO_OLD');
  }

  /**
   * Verifica si hay posiciones reales abiertas
   */
  hasOpenPositions(): boolean {
    return this.realExecution?.open_real_positions > 0;
  }

  /**
   * Obtiene lista de posiciones abiertas
   */
  getOpenPositions(): any[] {
    return this.realExecution?.open_positions || [];
  }

  /**
   * Obtiene lista de trades cerrados
   */
  getClosedTrades(): any[] {
    return this.realExecution?.closed_positions || [];
  }

  /**
   * Obtiene top 20 oportunidades
   */
  getTopOpportunities(): any[] {
    return this.spotOpportunities?.top_opportunities || [];
  }

  /**
   * Obtiene posiciones de papel abiertas
   */
  getPaperOpenPositions(): any[] {
    return this.paperExecution?.open_positions || [];
  }

  /**
   * Obtiene posiciones de papel cerradas
   */
  getPaperClosedPositions(): any[] {
    return this.paperExecution?.closed_positions || [];
  }
}
