// src/app/services/consulta.service.ts
import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { environment } from '../../environments/environment';
import { Observable } from 'rxjs';

@Injectable({
  providedIn: 'root'
})
export class ConsultaService {
  constructor(private http: HttpClient) {}

  enviarConsulta(
    simbolo: string,
    horizonte: string,
    direccion: string,
    horizonteDias?: number | null
  ): Observable<any> {
    const payload: Record<string, any> = {
      simbolo,
      horizonte,
      direccion,
      tipo: horizonte
    };

    if (horizonte === 'largo') {
      payload['horizonteDias'] = horizonteDias ?? null;
    }

    return this.http.post(`${environment.apiUrl}/api/consultar`, payload);
  }

  obtenerProyeccionMonteCarlo(simbolo: string): Observable<any> {
    return this.http.get(`${environment.apiUrl}/api/stock/proyeccion/${simbolo}`);
  }

  consultarCuantico(simbolo: string): Observable<any> {
    return this.http.get(`${environment.apiUrl}/api/cuantic/${simbolo}`);
  }

  consultarComparador(simbolo: string): Observable<any> {
    return this.http.get(`${environment.apiUrl}/api/comparar/${simbolo}`);
  }

  obtenerPrecision(): Observable<any> {
    return this.http.get(`${environment.apiUrl}/api/validacion/accuracy`);
  }

  obtenerMetrics(): Observable<any> {
    return this.http.get(`${environment.apiUrl}/api/validacion/metrics`);
  }

  recalcularMetrics(): Observable<any> {
    return this.http.post(`${environment.apiUrl}/api/validacion/metrics/recompute`, {});
  }

  obtenerBacktest(limit: number = 100): Observable<any> {
    return this.http.get(`${environment.apiUrl}/api/validacion/backtest?limit=${limit}`);
  }
}
