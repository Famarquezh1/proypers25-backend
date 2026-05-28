import { Injectable } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Observable, throwError, interval, of, catchError, switchMap, forkJoin, map, BehaviorSubject } from 'rxjs';

export interface RealExecutionReport {
  real_spot_enabled: boolean;
  kill_switch: boolean;
  safety_status: string;
  open_real_positions: number;
  closed_real_positions: number;
  total_real_capital_exposed: number;
  total_net_pnl_usdt: number;
  total_net_pnl_pct: number;
  win_rate: number;
  config_summary: {
    max_position_usdt: number;
    max_total_capital_usdt: number;
    max_open_positions: number;
  };
  open_positions: any[];
  closed_positions: any[];
  entry_diagnostic: any;
}

export interface PreflightReport {
  credentials_valid: boolean;
  account_accessible: boolean;
  api_restrictions_accessible: boolean;
  can_trade: boolean;
  enable_withdrawals_api_key: boolean;
  withdrawal_permission_safe: boolean;
  usdt_balance_free: number;
  real_order_created: boolean;
}

export interface PaperExecutionReport {
  open_paper_positions: number;
  closed_paper_positions: number;
  total_net_pnl_usdt: number;
  total_net_pnl_pct: number;
  win_rate: number;
  positions_by_status: any;
  open_positions: any[];
  closed_positions: any[];
}

export interface SpotOpportunitiesReport {
  total_symbols_scanned: number;
  candidates_saved: number;
  top_opportunities: any[];
}

@Injectable({
  providedIn: 'root'
})
export class TradingMonitorService {
  private apiBaseUrl = 'https://proypers25-backend-h4put26qmq-tl.a.run.app/api';
  private lastUpdate$ = new BehaviorSubject<Date>(new Date());

  constructor(private http: HttpClient) {}

  /**
   * GET /api/diagnostico/spot-real-execution
   * Obtiene estado completo del sistema real Spot
   */
  getRealExecution(): Observable<{ report: RealExecutionReport }> {
    return this.http.get<{ report: RealExecutionReport }>(
      `${this.apiBaseUrl}/diagnostico/spot-real-execution`
    ).pipe(
      catchError(this.handleError)
    );
  }

  /**
   * GET /api/diagnostico/spot-real-preflight
   * Obtiene estado de credenciales y permisos
   * Backend devuelve: { ok: true, preflight: {...} }
   * Convertimos a: { report: {...} } para mantener consistencia
   */
  getRealPreflight(): Observable<{ report: PreflightReport }> {
    return this.http.get<any>(
      `${this.apiBaseUrl}/diagnostico/spot-real-preflight`
    ).pipe(
      map(response => ({
        report: response.preflight // Extraer preflight como report
      })),
      catchError(this.handleError)
    );
  }

  /**
   * GET /api/diagnostico/spot-paper-execution
   * Obtiene estado de ejecución en papel
   */
  getPaperExecution(): Observable<{ report: PaperExecutionReport }> {
    return this.http.get<{ report: PaperExecutionReport }>(
      `${this.apiBaseUrl}/diagnostico/spot-paper-execution`
    ).pipe(
      catchError(this.handleError)
    );
  }

  /**
   * GET /api/diagnostico/spot-opportunities
   * Obtiene oportunidades spot actuales
   */
  getSpotOpportunities(): Observable<{ report: SpotOpportunitiesReport }> {
    return this.http.get<{ report: SpotOpportunitiesReport }>(
      `${this.apiBaseUrl}/diagnostico/spot-opportunities`
    ).pipe(
      catchError(this.handleError)
    );
  }

  /**
   * GET /api/diagnostico/hybrid-mode
   * Obtiene configuración y exposición del hybrid mode (70/30)
   */
  getHybridModeStatus(): Observable<any> {
    return this.http.get<any>(
      `${this.apiBaseUrl}/diagnostico/hybrid-mode`
    ).pipe(
      catchError(this.handleError)
    );
  }

  /**
   * Obtiene snapshot completo de todos los diagnósticos
   * Combina los 4 GET en paralelo
   */
  getFullMonitorSnapshot(): Observable<{
    real: { report: RealExecutionReport };
    preflight: { report: PreflightReport };
    paper: { report: PaperExecutionReport };
    opportunities: { report: SpotOpportunitiesReport };
    timestamp: Date;
  }> {
    return forkJoin({
      real: this.getRealExecution(),
      preflight: this.getRealPreflight(),
      paper: this.getPaperExecution(),
      opportunities: this.getSpotOpportunities()
    }).pipe(
      map(result => ({
        ...result,
        timestamp: new Date()
      })),
      catchError(error => {
        this.lastUpdate$.next(new Date());
        return throwError(() => error);
      })
    );
  }

  /**
   * Auto-refresh: obtiene snapshot cada intervalo especificado (ms)
   * Usa interval + switchMap para evitar acumulación
   */
  startAutoRefresh(intervalMs: number = 15000): Observable<any> {
    return interval(intervalMs).pipe(
      switchMap(() => this.getFullMonitorSnapshot()),
      catchError(error => {
        console.error('Auto-refresh error:', error);
        return of(null); // Continúa sin detener
      })
    );
  }

  /**
   * Obtiene la última hora de actualización
   */
  getLastUpdate(): Observable<Date> {
    return this.lastUpdate$.asObservable();
  }

  /**
   * Manejo centralizado de errores HTTP
   */
  private handleError(error: HttpErrorResponse) {
    let errorMessage = 'Error desconocido';
    
    if (error.error instanceof ErrorEvent) {
      // Error del lado del cliente
      errorMessage = `Error: ${error.error.message}`;
    } else {
      // Error del lado del servidor
      errorMessage = `Código ${error.status}: ${error.message}`;
    }
    
    console.error('HTTP Error:', errorMessage);
    return throwError(() => new Error(errorMessage));
  }
}
