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
}
