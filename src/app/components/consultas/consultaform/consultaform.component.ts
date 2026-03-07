import { Component, ChangeDetectorRef, inject, Injector, runInInjectionContext } from '@angular/core';
import { FormBuilder, Validators, FormGroup, ReactiveFormsModule } from '@angular/forms';
import { CommonModule } from '@angular/common';
import { HttpClientModule } from '@angular/common/http';
import { Firestore, collection, addDoc, serverTimestamp } from '@angular/fire/firestore';
import { ChartConfiguration, ChartOptions, ChartType } from 'chart.js';
import { NgChartsModule, NgChartsConfiguration } from 'ng2-charts';
import { ConsultaService } from '../../../servicios/consulta.service';

@Component({
  selector: 'app-consultaform',
  standalone: true,
  imports: [
    CommonModule,
    ReactiveFormsModule,
    HttpClientModule,
    NgChartsModule
  ],
  providers: [
    {
      provide: NgChartsConfiguration,
      useValue: {}
    }
  ],
  templateUrl: './consultaform.component.html',
  styleUrls: ['./consultaform.component.css']
})
export class ConsultaformComponent {
  form!: FormGroup;
  resultado = '';
  cargando = false;
  riesgo = '';
  probabilidadAlza = '';
  proyeccionMonteCarlo: any = null;
  variacionPorcentual = '';
  tendenciaVolumen = '';
  volatilidadDiaria = '';
  rsi = '';
  resultadoExtendido = '';
  sugerenciaCuantitativa = '';
  indiceConfianzaCuantico: number | null = null;
  mensajeConfianza = '';
  sentimiento = '';
  puntajeSentimiento: number | null = null;
  resumenNoticias = '';
  confianzaHistorica: number | null = null;
  alertaConfianza = '';
  horizonte = '';
  direccion = '';
  horizonteDias: number | null = null;
  horizonteLabel = '';

  noticias: any[] = [];
  resultadoCuantico: any = null;
  comparacionModelos: any = {};

  chartData: ChartConfiguration<'bar'>['data'] = {
    labels: [],
    datasets: [
      { label: 'Distribucion de precios simulados', data: [], backgroundColor: '#00aaff' }
    ]
  };

  chartOptions: ChartOptions<'bar'> = {
    responsive: true,
    plugins: {
      legend: { display: false },
      title: { display: true, text: 'Distribucion de Precios Simulados' }
    }
  };

  pesos: { [key: string]: number } = {};
  pesosAnalisis: { [clave: string]: number } = {};
  pieChartData: ChartConfiguration<'pie'>['data'] = {
    labels: [],
    datasets: [{ data: [], backgroundColor: ['#007bff', '#28a745', '#ffc107', '#dc3545', '#6610f2', '#17a2b8'] }]
  };
  pieChartType: ChartType = 'pie';

  private injector = inject(Injector);

  constructor(
    private fb: FormBuilder,
    private firestore: Firestore,
    private cd: ChangeDetectorRef,
    private consultaService: ConsultaService
  ) {
    this.form = this.fb.group({
      simbolo: ['', Validators.required],
      horizonte: ['largo', Validators.required],
      direccion: ['alza', Validators.required],
      horizonteDias: [30]
    });
  }

  async enviarConsulta() {
    if (this.form.invalid) return;

    const { simbolo, horizonte, direccion, horizonteDias } = this.form.value;
    const horizonteDiasFinal = horizonte === 'largo' ? Number(horizonteDias) : null;
    this.limpiarDatos();
    this.cargando = true;

    try {
      const respuesta = await this.consultaService
        .enviarConsulta(simbolo, horizonte, direccion, horizonteDiasFinal)
        .toPromise();

      this.resultado = this.limpiarTexto(respuesta.resultado);
      this.riesgo = this.limpiarTexto(respuesta.riesgo || '');
      this.probabilidadAlza = this.limpiarTexto(respuesta.probabilidadAlza || '');
      this.variacionPorcentual = this.limpiarTexto(respuesta.variacionPorcentual || '');
      this.tendenciaVolumen = this.limpiarTexto(respuesta.tendenciaVolumen || '');
      this.volatilidadDiaria = this.limpiarTexto(respuesta.volatilidadDiaria || '');
      this.rsi = this.limpiarTexto(respuesta.rsi || '');
      this.resultadoExtendido = this.limpiarTexto(respuesta.resultadoExtendido || '');
      const horizonteResp = respuesta.horizonte || horizonte;
      const direccionResp = respuesta.direccion || direccion;
      const horizonteDiasResp = respuesta.horizonteDias ?? horizonteDiasFinal;
      const horizonteLabelResp = respuesta.horizonteLabel || this.obtenerEtiquetaHorizonte(horizonteResp, horizonteDiasResp);
      this.horizonte = horizonteResp;
      this.direccion = direccionResp;
      this.horizonteDias = horizonteDiasResp;
      this.horizonteLabel = horizonteLabelResp;
      this.sugerenciaCuantitativa = this.generarSugerenciaV2(
        horizonteResp,
        direccionResp,
        this.resultado,
        this.riesgo,
        this.probabilidadAlza
      );
      this.indiceConfianzaCuantico = respuesta.indiceConfianzaCuantico ?? null;
      this.mensajeConfianza = this.limpiarTexto(respuesta.mensaje_confianza || '');
      this.sentimiento = this.limpiarTexto(respuesta.sentimiento || '');
      this.puntajeSentimiento = respuesta.puntajeSentimiento ?? null;
      this.noticias = respuesta.noticias || [];
      this.resumenNoticias = this.limpiarTexto(respuesta.resumenNoticias || '');
      this.pesos = respuesta.pesos || {};
      this.pieChartData.labels = Object.keys(this.pesos);
      this.pieChartData.datasets[0].data = Object.values(this.pesos);
      this.pesosAnalisis = respuesta.pesosAnalisis || {};
      this.confianzaHistorica = isNaN(parseFloat(respuesta.confianzaHistorica)) ? null : parseFloat(respuesta.confianzaHistorica);
      this.alertaConfianza = this.limpiarTexto(respuesta.alertaConfianza || '');

      await this.consultarComparador(simbolo);
      await this.consultarCuantico(simbolo);
      if (horizonteResp === 'largo') {
        await this.obtenerProyeccionMonteCarlo(simbolo);
      }

      await this.registrarEnFirestore(
        simbolo,
        horizonteResp,
        direccionResp,
        horizonteDiasResp,
        'completado',
        horizonteLabelResp
      );

    } catch (error) {
      this.resultado = 'Error al procesar la consulta.';
      this.riesgo = '';
      await this.registrarEnFirestore(
        simbolo,
        horizonte,
        direccion,
        horizonteDiasFinal,
        'fallido',
        this.obtenerEtiquetaHorizonte(horizonte, horizonteDiasFinal)
      );
    } finally {
      this.cargando = false;
    }
  }

  async obtenerProyeccionMonteCarlo(simbolo: string) {
    try {
      const respuesta = await this.consultaService.obtenerProyeccionMonteCarlo(simbolo).toPromise();
      this.proyeccionMonteCarlo = respuesta;
      this.actualizarGraficoMonteCarlo();
    } catch (error) {
      const mensaje = error instanceof Error ? error.message : String(error);
      console.error('Error en Monte Carlo:', mensaje);
      this.proyeccionMonteCarlo = this.generarFallbackProyeccionMonteCarlo(simbolo, mensaje);
      this.actualizarGraficoMonteCarlo();
    }
  }

  private actualizarGraficoMonteCarlo() {
    if (!this.proyeccionMonteCarlo) {
      this.chartData.labels = [];
      this.chartData.datasets[0].data = [];
      return;
    }

    const resultados = this.proyeccionMonteCarlo.simulaciones || [];
    if (resultados.length) {
      const bins: { [key: string]: number } = {};
      resultados.forEach((precio: number) => {
        const binKey = `$${Math.round(precio / 5) * 5}`;
        bins[binKey] = (bins[binKey] || 0) + 1;
      });

      const etiquetas = Object.keys(bins).sort((a, b) => Number(a.replace('$', '')) - Number(b.replace('$', '')));
      this.chartData.labels = etiquetas;
      this.chartData.datasets[0].data = etiquetas.map(label => bins[label]);
    } else if (this.proyeccionMonteCarlo.intervalo_confianza?.length === 2) {
      this.chartData.labels = ['Min', 'Estimado', 'Max'];
      this.chartData.datasets[0].data = [
        Number(this.proyeccionMonteCarlo.intervalo_confianza[0]),
        Number(this.proyeccionMonteCarlo.precio_estimado),
        Number(this.proyeccionMonteCarlo.intervalo_confianza[1])
      ];
    } else {
      this.chartData.labels = ['Estimado'];
      this.chartData.datasets[0].data = [Number(this.proyeccionMonteCarlo.precio_estimado) || 0];
    }
  }

  private generarFallbackProyeccionMonteCarlo(symbol: string, mensaje?: string) {
    const estimado = Number(this.comparacionModelos?.MonteCarlo?.precio_estimado) || 0;
    const base = estimado || 250;
    const intervalo = [this.round(base * 0.95), this.round(base * 1.05)];
    return {
      symbol,
      metodo: 'Monte Carlo fallback',
      precio_estimado: base,
      intervalo_confianza: intervalo,
      proyeccion: `No se pudieron obtener simulaciones (${mensaje || 'Error'}).`,
      warning: `Se usa proyección estática (${mensaje || 'sin detalles'}).`,
      simulaciones: [],
      precio_actual: base
    };
  }

  async consultarCuantico(simbolo: string) {
    try {
      this.resultadoCuantico = await this.consultaService.consultarCuantico(simbolo).toPromise();
      if (this.resultadoCuantico) {
        this.resultadoCuantico = {
          ...this.resultadoCuantico,
          metodo: this.limpiarTexto(this.resultadoCuantico.metodo || ''),
          tipo: this.limpiarTexto(this.resultadoCuantico.tipo || ''),
          warning: this.limpiarTexto(this.resultadoCuantico.warning || '')
        };
      }
      this.cd.detectChanges();
    } catch (error) {
      console.error('Error en simulacion cuantica:', error);
      this.resultadoCuantico = { symbol: simbolo, probabilidad_alza: 0, tipo: 'error', metodo: 'cuantico fallido' };
    }
  }

  async consultarComparador(simbolo: string) {
    try {
      const res = await this.consultaService.consultarComparador(simbolo).toPromise();
      this.comparacionModelos = res.comparacion || {};
      this.cd.detectChanges();
    } catch (error) {
      console.error('Error en comparacion modelos:', error);
      this.comparacionModelos = {};
    }
  }

  async registrarEnFirestore(
    simbolo: string,
    horizonte: string,
    direccion: string,
    horizonteDias: number | null,
    estado: string,
    horizonteLabel?: string
  ) {
    await runInInjectionContext(this.injector, async () => {
      const ref = collection(this.firestore, 'consultas');
      await addDoc(ref, {
        simbolo,
        tipo: horizonte,
        horizonte,
        direccion,
        horizonteDias: horizonteDias ?? null,
        horizonteLabel: horizonteLabel || this.obtenerEtiquetaHorizonte(horizonte, horizonteDias),
        fecha: serverTimestamp(),
        estado,
        resultado: this.resultado,
        riesgo: this.riesgo,
        probabilidadAlza: this.probabilidadAlza,
        proyeccionMonteCarlo: this.proyeccionMonteCarlo?.proyeccion || '',
        precioEstimado: this.proyeccionMonteCarlo?.precio_estimado || '',
        intervalo: this.proyeccionMonteCarlo?.intervalo_confianza?.join(' - ') || '',
        variacionPorcentual: this.variacionPorcentual,
        tendenciaVolumen: this.tendenciaVolumen,
        volatilidadDiaria: this.volatilidadDiaria,
        rsi: this.rsi,
        resultadoExtendido: this.resultadoExtendido,
        sugerenciaCuantitativa: this.sugerenciaCuantitativa,
        indiceConfianzaCuantico: this.indiceConfianzaCuantico,
        mensajeConfianza: this.mensajeConfianza,
        sentimiento: this.sentimiento,
        puntajeSentimiento: this.puntajeSentimiento,
        resultadoCuantico: this.resultadoCuantico,
        comparacionModelos: this.comparacionModelos,
        confianzaHistorica: this.confianzaHistorica,
        alertaConfianza: this.alertaConfianza
      });
    });
  }

  obtenerEtiquetaHorizonte(horizonte: string, horizonteDias: number | null): string {
    if (horizonte === 'intradia') {
      return 'Intradia (mismo dia)';
    }
    if (horizonte === 'corto') {
      return 'Corto plazo (1-3 dias)';
    }
    if (horizonte === 'largo') {
      const dias = horizonteDias ?? 30;
      return `Largo plazo (${dias} dias)`;
    }
    return horizonte;
  }

  generarSugerenciaV2(
    horizonte: string,
    direccion: string,
    resultado: string,
    riesgo: string,
    probabilidad: string
  ): string {
    if (this.confianzaHistorica !== null && this.confianzaHistorica < 0.4) {
      return 'Historial con baja efectividad. Mejor esperar confirmacion.';
    }

    const direccionTexto = direccion === 'baja' ? 'baja' : 'alza';

    if (horizonte === 'largo' && resultado.includes('alza')) {
      return `Escenario de ${direccionTexto} con horizonte largo. Evalua la tendencia y el riesgo.`;
    }

    if (horizonte === 'corto' && resultado.includes('negativo')) {
      return `Escenario de ${direccionTexto} en corto plazo. Gestiona el riesgo.`;
    }

    if (horizonte === 'intradia' && riesgo.includes('alta')) {
      return 'Riesgo alto en intradia. Espera confirmacion antes de entrar.';
    }

    return 'Mantener posicion o esperar senales mas claras.';
  }

  generarSugerencia(tipo: string, resultado: string, riesgo: string, probabilidad: string): string {
    if (this.confianzaHistorica !== null && this.confianzaHistorica < 0.4) {
      return 'Historial muestra baja efectividad para este simbolo.';
    }

    if (tipo === 'largo' && resultado.includes('alza')) {
      return 'Escenario favorable a largo plazo. Evalua riesgo y tendencia.';
    }

    if (tipo === 'corto' && resultado.includes('negativo')) {
      return 'Senales bajistas detectadas. Venta en corto posible con gestion de riesgo.';
    }

    if (tipo === 'intradia' && riesgo.includes('alta')) {
      return 'Riesgo alto para intradia. Se recomienda esperar confirmacion.';
    }

    return 'Mantener posicion o esperar senales mas claras.';
  }

  getClaves(obj: any): string[] {
    return obj ? Object.keys(obj) : [];
  }

  private limpiarTexto(valor: unknown): string {
    if (valor === null || valor === undefined) {
      return '';
    }
    const texto = String(valor);
    return texto.replace(/[^\x20-\x7E]/g, '').replace(/\s+/g, ' ').trim();
  }

  private round(value: number, decimals: number = 2): number {
    if (!Number.isFinite(value)) {
      return 0;
    }
    const factor = Math.pow(10, decimals);
    return Math.round(value * factor) / factor;
  }

  limpiarDatos() {
    this.resultado = '';
    this.riesgo = '';
    this.probabilidadAlza = '';
    this.proyeccionMonteCarlo = null;
    this.variacionPorcentual = '';
    this.tendenciaVolumen = '';
    this.volatilidadDiaria = '';
    this.rsi = '';
    this.resultadoExtendido = '';
    this.sugerenciaCuantitativa = '';
    this.indiceConfianzaCuantico = null;
    this.mensajeConfianza = '';
    this.sentimiento = '';
    this.puntajeSentimiento = null;
    this.noticias = [];
    this.resumenNoticias = '';
    this.pesos = {};
    this.pesosAnalisis = {};
    this.pieChartData.labels = [];
    this.pieChartData.datasets[0].data = [];
    this.resultadoCuantico = null;
    this.comparacionModelos = {};
    this.confianzaHistorica = null;
    this.alertaConfianza = '';
    this.horizonte = '';
    this.direccion = '';
    this.horizonteDias = null;
    this.horizonteLabel = '';
  }
}
