import { Injectable } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';

export interface VelasDisponibles {
  symbols: string[];
  timeframes: string[];
}

@Injectable({
  providedIn: 'root'
})
export class VelasService {
  private apiUrl = environment.apiUrl;

  constructor(private http: HttpClient) {}

  entrenarVelas(simbolo: string): Observable<any> {
    return this.http.post(`${this.apiUrl}/api/velas/entrenar/${simbolo}`, {});
  }

  entrenarVelasMultiple(): Observable<any> {
    return this.http.post(`${this.apiUrl}/api/velas/entrenar-multiple`, {});
  }

  obtenerPrediccionesVelas(symbol?: string): Observable<any[]> {
    const endpoint = symbol
      ? `${this.apiUrl}/api/velas/predicciones?symbol=${symbol}`
      : `${this.apiUrl}/api/velas/predicciones`;
    return this.http.get<any[]>(endpoint);
  }

  obtenerHistorialVelas(params?: {
    limit?: number;
    symbol?: string;
    status?: string;
    from?: string;
    to?: string;
    startAfter?: string;
  }): Observable<any[]> {
    let httpParams = new HttpParams();
    if (params?.limit) httpParams = httpParams.set('limit', params.limit.toString());
    if (params?.symbol) httpParams = httpParams.set('symbol', params.symbol);
    if (params?.status) httpParams = httpParams.set('status', params.status);
    if (params?.from) httpParams = httpParams.set('from', params.from);
    if (params?.to) httpParams = httpParams.set('to', params.to);
    if (params?.startAfter) httpParams = httpParams.set('startAfter', params.startAfter);
    return this.http.get<any[]>(`${this.apiUrl}/api/velas/historial`, { params: httpParams });
  }

  obtenerEntrenamientos(): Observable<any[]> {
    return this.http.get<any[]>(`${this.apiUrl}/api/velas/historial/entrenamientos`);
  }

  generarPrediccion(simbolo: string, timeframe: string, monto: number, executionMode: string = 'timeframe'): Observable<any> {
    return this.http.post(`${this.apiUrl}/api/velas/prediccion`, {
      symbol: simbolo,
      timeframe,
      monto,
      execution_mode: executionMode
    });
  }

  verificarPrediccion(id: string): Observable<any> {
    return this.http.post(`${this.apiUrl}/api/velas/verificar/${id}`, {});
  }

  obtenerEntrenamientoPendiente(): Observable<any | null> {
    return this.http.get<any>(`${this.apiUrl}/api/velas/entrenamientos/pendientes`);
  }

  getDisponibles(): Observable<VelasDisponibles> {
    return this.http.get<VelasDisponibles>(`${this.apiUrl}/api/velas/disponibles`);
  }

  obtenerSignalIntelligenceAudit(params?: { refresh?: boolean; days?: number; maxDocs?: number }): Observable<any> {
    let httpParams = new HttpParams();
    if (params?.refresh) httpParams = httpParams.set('refresh', 'true');
    if (params?.days) httpParams = httpParams.set('days', String(params.days));
    if (params?.maxDocs) httpParams = httpParams.set('maxDocs', String(params.maxDocs));
    return this.http.get<any>(`${this.apiUrl}/api/velas/audit-signal-intelligence`, { params: httpParams });
  }

  obtenerSignalIntelligenceDashboard(params?: {
    refresh?: boolean;
    days?: number;
    maxDocs?: number;
    suppressedMaxDocs?: number;
    executionMaxDocs?: number;
    concurrency?: number;
    matchWindowMinutes?: number;
  }): Observable<any> {
    let httpParams = new HttpParams();
    if (params?.refresh) httpParams = httpParams.set('refresh', 'true');
    if (params?.days) httpParams = httpParams.set('days', String(params.days));
    if (params?.maxDocs) httpParams = httpParams.set('maxDocs', String(params.maxDocs));
    if (params?.suppressedMaxDocs) {
      httpParams = httpParams.set('suppressedMaxDocs', String(params.suppressedMaxDocs));
    }
    if (params?.executionMaxDocs) {
      httpParams = httpParams.set('executionMaxDocs', String(params.executionMaxDocs));
    }
    if (params?.concurrency) httpParams = httpParams.set('concurrency', String(params.concurrency));
    if (params?.matchWindowMinutes) {
      httpParams = httpParams.set('matchWindowMinutes', String(params.matchWindowMinutes));
    }
    return this.http.get<any>(`${this.apiUrl}/api/velas/signal-intelligence-dashboard`, { params: httpParams });
  }

  obtenerSuppressedValidationAudit(params?: {
    refresh?: boolean;
    days?: number;
    maxDocs?: number;
    concurrency?: number;
  }): Observable<any> {
    let httpParams = new HttpParams();
    if (params?.refresh) httpParams = httpParams.set('refresh', 'true');
    if (params?.days) httpParams = httpParams.set('days', String(params.days));
    if (params?.maxDocs) httpParams = httpParams.set('maxDocs', String(params.maxDocs));
    if (params?.concurrency) httpParams = httpParams.set('concurrency', String(params.concurrency));
    return this.http.get<any>(`${this.apiUrl}/api/velas/audit-suppressed-validation`, { params: httpParams });
  }

  obtenerExecutionVsModelAudit(params?: {
    refresh?: boolean;
    days?: number;
    maxDocs?: number;
    concurrency?: number;
    matchWindowMinutes?: number;
  }): Observable<any> {
    let httpParams = new HttpParams();
    if (params?.refresh) httpParams = httpParams.set('refresh', 'true');
    if (params?.days) httpParams = httpParams.set('days', String(params.days));
    if (params?.maxDocs) httpParams = httpParams.set('maxDocs', String(params.maxDocs));
    if (params?.concurrency) httpParams = httpParams.set('concurrency', String(params.concurrency));
    if (params?.matchWindowMinutes) {
      httpParams = httpParams.set('matchWindowMinutes', String(params.matchWindowMinutes));
    }
    return this.http.get<any>(`${this.apiUrl}/api/velas/audit-execution-vs-model`, { params: httpParams });
  }

  obtenerRankingSummary(params?: { limit?: number }): Observable<any> {
    let httpParams = new HttpParams();
    if (params?.limit) httpParams = httpParams.set('limit', String(params.limit));
    return this.http.get<any>(`${this.apiUrl}/api/velas/ranking-summary`, { params: httpParams });
  }

  obtenerAdaptiveProfiles(params?: { days?: number; maxDocs?: number }): Observable<any> {
    let httpParams = new HttpParams();
    if (params?.days) httpParams = httpParams.set('days', String(params.days));
    if (params?.maxDocs) httpParams = httpParams.set('maxDocs', String(params.maxDocs));
    return this.http.get<any>(`${this.apiUrl}/api/velas/adaptive-profiles`, { params: httpParams });
  }

  obtenerContextIntelligenceSummary(params?: { days?: number; maxDocs?: number }): Observable<any> {
    let httpParams = new HttpParams();
    if (params?.days) httpParams = httpParams.set('days', String(params.days));
    if (params?.maxDocs) httpParams = httpParams.set('maxDocs', String(params.maxDocs));
    return this.http.get<any>(`${this.apiUrl}/api/velas/context-intelligence-summary`, { params: httpParams });
  }

  obtenerCounterfactualLearning(params?: { refresh?: boolean; days?: number; maxDocs?: number }): Observable<any> {
    let httpParams = new HttpParams();
    if (params?.refresh) httpParams = httpParams.set('refresh', 'true');
    if (params?.days) httpParams = httpParams.set('days', String(params.days));
    if (params?.maxDocs) httpParams = httpParams.set('maxDocs', String(params.maxDocs));
    return this.http.get<any>(`${this.apiUrl}/api/velas/counterfactual-learning`, { params: httpParams });
  }

  obtenerExpectancyStability(params?: { refresh?: boolean; days?: number; maxDocs?: number }): Observable<any> {
    let httpParams = new HttpParams();
    if (params?.refresh) httpParams = httpParams.set('refresh', 'true');
    if (params?.days) httpParams = httpParams.set('days', String(params.days));
    if (params?.maxDocs) httpParams = httpParams.set('maxDocs', String(params.maxDocs));
    return this.http.get<any>(`${this.apiUrl}/api/velas/expectancy-stability`, { params: httpParams });
  }

  obtenerRegimeLearning(params?: { refresh?: boolean; days?: number; maxDocs?: number }): Observable<any> {
    let httpParams = new HttpParams();
    if (params?.refresh) httpParams = httpParams.set('refresh', 'true');
    if (params?.days) httpParams = httpParams.set('days', String(params.days));
    if (params?.maxDocs) httpParams = httpParams.set('maxDocs', String(params.maxDocs));
    return this.http.get<any>(`${this.apiUrl}/api/velas/regime-learning`, { params: httpParams });
  }

  obtenerAlphaDecay(params?: { refresh?: boolean; days?: number; maxDocs?: number }): Observable<any> {
    let httpParams = new HttpParams();
    if (params?.refresh) httpParams = httpParams.set('refresh', 'true');
    if (params?.days) httpParams = httpParams.set('days', String(params.days));
    if (params?.maxDocs) httpParams = httpParams.set('maxDocs', String(params.maxDocs));
    return this.http.get<any>(`${this.apiUrl}/api/velas/alpha-decay`, { params: httpParams });
  }

  obtenerExploitationSummary(params?: { limit?: number; riskLimit?: number }): Observable<any> {
    let httpParams = new HttpParams();
    if (params?.limit) httpParams = httpParams.set('limit', String(params.limit));
    if (params?.riskLimit) httpParams = httpParams.set('riskLimit', String(params.riskLimit));
    return this.http.get<any>(`${this.apiUrl}/api/velas/exploitation-summary`, { params: httpParams });
  }

  obtenerConfidenceCalibration(params?: { refresh?: boolean; days?: number; maxDocs?: number }): Observable<any> {
    let httpParams = new HttpParams();
    if (params?.refresh) httpParams = httpParams.set('refresh', 'true');
    if (params?.days) httpParams = httpParams.set('days', String(params.days));
    if (params?.maxDocs) httpParams = httpParams.set('maxDocs', String(params.maxDocs));
    return this.http.get<any>(`${this.apiUrl}/api/velas/confidence-calibration`, { params: httpParams });
  }

  obtenerExecutionDisciplineSummary(): Observable<any> {
    return this.http.get<any>(`${this.apiUrl}/api/velas/execution-discipline-summary`);
  }

  obtenerEquityCurve(params?: {
    refresh?: boolean;
    maxTrades?: number;
    initialCapital?: number;
  }): Observable<any> {
    let httpParams = new HttpParams();
    if (params?.refresh) httpParams = httpParams.set('refresh', 'true');
    if (params?.maxTrades) httpParams = httpParams.set('maxTrades', String(params.maxTrades));
    if (params?.initialCapital) httpParams = httpParams.set('initialCapital', String(params.initialCapital));
    return this.http.get<any>(`${this.apiUrl}/api/velas/equity-curve`, { params: httpParams });
  }
}
