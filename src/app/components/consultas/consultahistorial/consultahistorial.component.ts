import { Component, OnInit } from '@angular/core';
import { Firestore, collectionData, collection, query, orderBy } from '@angular/fire/firestore';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient, HttpClientModule } from '@angular/common/http';
import { ConsultaService } from '../../../servicios/consulta.service';
import { environment } from '../../../../environments/environment';

@Component({
  selector: 'app-consultahistorial',
  standalone: true,
  imports: [CommonModule, FormsModule, HttpClientModule],
  templateUrl: './consultahistorial.component.html',
  styleUrls: ['./consultahistorial.component.css']
})
export class ConsultahistorialComponent implements OnInit {
  consultas: any[] = [];
  consultasFiltradas: any[] = [];
  filtroTexto = '';
  cargando = true;
  seleccionadas = new Set<string>();
  seleccionarTodas = false;
  precisionStats: any = null;
  metricSummary: any = null;
  backtestData: any = null;
  modelosEntrenados: string[] = [];

  constructor(
    private firestore: Firestore,
    private http: HttpClient,
    private consultaService: ConsultaService
  ) {}

  ngOnInit(): void {
    this.cargarConsultas();
    this.obtenerStats();
  }

  private coerceNumber(value: unknown): number | null {
    if (typeof value === 'number' && isFinite(value)) return value;
    if (typeof value === 'string') {
      const cleaned = value.replace(/[^0-9.-]/g, '');
      if (!cleaned) return null;
      const parsed = Number(cleaned);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  }

  private normalizarFecha(value: any): Date | null {
    if (!value) return null;
    if (value instanceof Date) return value;
    if (value.toDate) return value.toDate();
    const parsed = new Date(value);
    return isNaN(parsed.getTime()) ? null : parsed;
  }

  private normalizarValidacionInfo(validacion: any, resultado: any): any | null {
    if (!validacion) return null;
    const acierto = validacion.acierto ?? validacion.success ?? validacion.direction_match ?? null;
    const precioReal = this.coerceNumber(
      validacion.precio_real ?? validacion.precio_final ?? validacion.final_price ?? validacion.finalPrice
    );
    const precioEstimado = this.coerceNumber(resultado?.precio_estimado ?? resultado?.precioEstimado);
    let diferencia = this.coerceNumber(
      validacion.diferencia ?? validacion.margen_error ?? validacion.error_calculado
    );
    if (diferencia === null && precioReal !== null && precioEstimado !== null) {
      diferencia = precioReal - precioEstimado;
    }
    const estadoLabel = acierto === true ? 'Validado' : acierto === false ? 'Fallido' : 'Pendiente';
    return {
      acierto,
      estadoLabel,
      precioReal,
      diferencia
    };
  }

  formatPercent(value: any): string {
    const numero = this.coerceNumber(value);
    if (numero === null) return '0%';
    const normalizado = numero <= 1 ? numero * 100 : numero;
    return `${normalizado.toFixed(2)}%`;
  }

  private cargarConsultas(): void {
    const ref = collection(this.firestore, 'consultas');
    const q = query(ref, orderBy('fecha', 'desc'));

    collectionData(q, { idField: 'id' }).subscribe({
      next: data => {
        this.consultas = (data as any[]).map(c => {
          const resultadoBase = c.resultado || {};
          const resultadoTexto =
            typeof resultadoBase === 'string'
              ? resultadoBase
              : resultadoBase?.resultado ?? resultadoBase?.texto ?? '';
          const validacionRaw =
            c.validacion ||
            resultadoBase.validacion ||
            resultadoBase.verification ||
            c.resultado?.validacion ||
            c.resultado?.verification;
          const simbolo = resultadoBase.simbolo || c.simbolo || validacionRaw?.simbolo || c.symbol;
          const tipo = resultadoBase.tipo || resultadoBase.metodo || c.tipo;
          const comparacionLstm = c.comparacionModelos?.LSTM || c.comparacionModelos?.lstm || {};
          const comparacionMonteCarlo =
            c.comparacionModelos?.MonteCarlo || c.comparacionModelos?.monteCarlo || {};

          const precioActualRaw =
            resultadoBase.precio_actual ??
            resultadoBase.precioActual ??
            c.precio_actual ??
            c.precioActual ??
            comparacionLstm.precio_actual ??
            comparacionMonteCarlo.precio_actual ??
            c.resultadoCuantico?.precio_actual;
          const precioEstimadoRaw =
            resultadoBase.precio_estimado ??
            resultadoBase.precioEstimado ??
            c.precio_estimado ??
            c.precioEstimado ??
            c.proyeccionMonteCarlo?.precio_estimado ??
            comparacionLstm.precio_estimado ??
            comparacionMonteCarlo.precio_estimado ??
            c.resultadoCuantico?.precio_estimado;
          const porcentajeRaw = resultadoBase.porcentaje ?? c.porcentaje ?? c.variacionPorcentual;
          const gananciaEstimRaw =
            resultadoBase.ganancia_estim ??
            resultadoBase.ganancia_estimada ??
            c.ganancia_estim ??
            c.ganancia_estimada;
          const motivoRaw = resultadoBase.motivo ?? c.motivo ?? c.resultadoExtendido ?? c.sugerenciaCuantitativa;
          const quantumModelRaw =
            resultadoBase.quantum_model ??
            c.resultadoCuantico?.metodo ??
            c.resultadoCuantico?.model ??
            c.resultadoCuantico?.tipo;
          const quantumScoreRaw =
            resultadoBase.quantum_score ??
            c.resultadoCuantico?.probabilidad_alza ??
            c.indiceConfianzaCuantico;

          const resultado = {
            ...(typeof resultadoBase === 'object' ? resultadoBase : {}),
            texto: resultadoTexto,
            simbolo,
            tipo,
            precio_actual: this.coerceNumber(precioActualRaw) ?? precioActualRaw,
            precio_estimado: this.coerceNumber(precioEstimadoRaw) ?? precioEstimadoRaw,
            porcentaje: this.coerceNumber(porcentajeRaw) ?? porcentajeRaw,
            ganancia_estim: this.coerceNumber(gananciaEstimRaw) ?? gananciaEstimRaw,
            motivo: motivoRaw,
            quantum_model: quantumModelRaw,
            quantum_score: this.coerceNumber(quantumScoreRaw) ?? quantumScoreRaw
          };
          const validacionInfo = this.normalizarValidacionInfo(validacionRaw, resultado);
          return {
            ...c,
            resultado,
            simbolo,
            tipo,
            fecha: this.normalizarFecha(c.fecha ?? c.timestamp ?? c.created_at),
            expandido: false,
            validacionInfo,
            estado: this.normalizarEstado(c.estado, validacionInfo)
          };
        });
        this.consultasFiltradas = [...this.consultas];
        this.cargando = false;
      },
      error: err => {
        console.error('Error cargando consultas:', err);
        this.cargando = false;
      }
    });
  }

  private normalizarEstado(estado?: string, validacionInfo?: any): string {
    if (validacionInfo) {
      if (validacionInfo.acierto === true) return 'completado';
      if (validacionInfo.acierto === false) return 'fallido';
    }
    if (!estado) return 'pendiente';
    const limpio = estado.toLowerCase();
    if (limpio.includes('complet')) return 'completado';
    if (limpio.includes('fall')) return 'fallido';
    return limpio;
  }

  private obtenerStats(): void {
    this.http.get<string[]>(`${environment.apiUrl}/api/modelos/modelos-entrenados`).subscribe({
      next: modelos => (this.modelosEntrenados = modelos || []),
      error: err => console.error('Error modelos entrenados:', err)
    });

    this.refrescarPrecision();
    this.refrescarMetricsCompradas();
    this.refrescarBacktest();
  }

  refrescarPrecision(): void {
    this.consultaService.obtenerPrecision().subscribe({
      next: datos => {
        this.precisionStats = {
          precisionGlobal: this.formatPercent(datos?.accuracy),
          errorPromedio: this.formatPercent(datos?.avgError),
          total: datos?.total ?? 0,
          methods: datos?.methods ?? []
        };
      },
      error: err => console.error('Error actualizando precision:', err)
    });
  }

  refrescarMetricsCompradas(): void {
    const aplicarMetrics = (metrics: any) => {
      this.metricSummary = {
        totalEvaluations: metrics?.totalCount ?? 0,
        accuracy: this.formatPercent(metrics?.totalAccuracy),
        symbolMetrics: metrics?.symbolMetrics ?? []
      };
    };

    this.consultaService.recalcularMetrics().subscribe({
      next: resp => {
        const summary = resp?.summary ?? resp;
        if (summary) {
          aplicarMetrics(summary);
        }
        this.consultaService.obtenerMetrics().subscribe({
          next: metrics => aplicarMetrics(metrics),
          error: err => console.error('Error cargando metricas:', err)
        });
      },
      error: err => console.error('Error recalculando metricas:', err)
    });
  }

  refrescarBacktest(): void {
    this.consultaService.obtenerBacktest().subscribe({
      next: backtest => {
        const perDay = (backtest?.perDay ?? []).map((item: any) => ({
          ...item,
          accuracyLabel: this.formatPercent(item?.accuracy)
        }));
        this.backtestData = {
          count: backtest?.total ?? 0,
          precision: this.formatPercent(backtest?.accuracy),
          perDay
        };
      },
      error: err => console.error('Error cargando backtest:', err)
    });
  }

  filtrarConsultas(): void {
    const texto = this.filtroTexto.toLowerCase();
    this.consultasFiltradas = this.consultas.filter(consulta =>
      [consulta.simbolo, consulta.tipo, consulta.estado, consulta.resultado?.simbolo, consulta.resultado?.metodo]
        .filter(Boolean)
        .some(valor => valor.toLowerCase().includes(texto))
    );
  }

  toggleDetalle(consulta: any): void {
    consulta.expandido = !consulta.expandido;
  }

  toggleSeleccionGlobal(event: Event): void {
    const el = event.target as HTMLInputElement;
    this.seleccionadas.clear();
    this.seleccionarTodas = el.checked;
    if (el.checked) {
      this.consultasFiltradas.forEach(c => this.seleccionadas.add(c.id));
    }
  }

  toggleSeleccion(consultaId: string, event: Event): void {
    const el = event.target as HTMLInputElement;
    if (el.checked) {
      this.seleccionadas.add(consultaId);
    } else {
      this.seleccionadas.delete(consultaId);
      this.seleccionarTodas = false;
    }
  }

  eliminarSeleccionadas(): void {
    this.consultasFiltradas = this.consultasFiltradas.filter(c => !this.seleccionadas.has(c.id));
    this.seleccionadas.clear();
    this.seleccionarTodas = false;
  }

  refrescarMetrics(): void {
    this.refrescarMetricsCompradas();
  }
}
