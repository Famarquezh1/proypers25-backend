import { Component } from '@angular/core';
import { FormBuilder, Validators, FormGroup, ReactiveFormsModule } from '@angular/forms';
import { CommonModule } from '@angular/common';
import { HttpClient, HttpClientModule } from '@angular/common/http';
import { Firestore, collection, addDoc, serverTimestamp } from '@angular/fire/firestore';
import { ChartConfiguration, ChartOptions, ChartType } from 'chart.js';
import { NgChartsModule } from 'ng2-charts';
import { ChangeDetectorRef } from '@angular/core';


@Component({
  selector: 'app-consultaform',
  standalone: true,
  imports: [
    CommonModule,
    ReactiveFormsModule,
    HttpClientModule,
    NgChartsModule
  ],
  templateUrl: './consultaform.component.html',
  styleUrls: ['./consultaform.component.css']
})
export class ConsultaformComponent {
  form!: FormGroup;
  resultado: string = '';
  cargando: boolean = false;
  riesgo: string = '';
  probabilidadAlza: string = '';
  proyeccionMonteCarlo: any = null;
  variacionPorcentual: string = '';
  tendenciaVolumen: string = '';
  volatilidadDiaria: string = '';
  rsi: string = '';
  resultadoExtendido: string = '';
  sugerenciaCuantitativa: string = '';
  indiceConfianzaCuantico: number | null = null;
  mensajeConfianza: string = '';
  sentimiento: string = '';
  puntajeSentimiento: number | null = null;
  resumenNoticias: string = '';
  confianzaHistorica: number | null = null;
  alertaConfianza: string = '';


  noticias: {
    resumen: string;
    titulo: string;
    fuente: string;
    url: string;
    fecha: string;
    sentimiento: number;
  }[] = [];

  resultadoCuantico: {
    symbol: string;
    probabilidad_alza: number;
    tipo: string;
    metodo: string;
  } | null = null;

  comparacionModelos: {
    LSTM?: any;
    MonteCarlo?: any;
    Qiskit?: any;
  } = {};


  chartData: ChartConfiguration<'bar'>['data'] = {
    labels: [],
    datasets: [
      {
        label: 'Distribución de precios simulados',
        data: [],
        backgroundColor: '#00aaff'
      }
    ]
  };

  chartOptions: ChartOptions<'bar'> = {
    responsive: true,
    plugins: {
      legend: { display: false },
      title: {
        display: true,
        text: 'Distribución de Precios Simulados'
      }
    }
  };

  pesos: { [key: string]: number } = {};
  pesosAnalisis: { [clave: string]: number } = {};

  pieChartData: ChartConfiguration<'pie'>['data'] = {
    labels: [],
    datasets: [
      {
        data: [],
        backgroundColor: ['#007bff', '#28a745', '#ffc107', '#dc3545', '#6610f2', '#17a2b8']
      }
    ]
  };

  pieChartType: ChartType = 'pie';

  constructor(
    private fb: FormBuilder,
    private http: HttpClient,
    private firestore: Firestore,
    private cd: ChangeDetectorRef
  ) {
    this.form = this.fb.group({
      simbolo: ['', Validators.required],
      tipo: ['largo', Validators.required]
    });
  }

  async enviarConsulta() {
    if (this.form.invalid) return;

    this.resultado = '';
    this.riesgo = '';
    this.probabilidadAlza = '';
    this.proyeccionMonteCarlo = null;
    this.chartData.labels = [];
    this.chartData.datasets[0].data = [];
    this.cargando = true;

    const { simbolo, tipo } = this.form.value;
    let respuesta: any;

    try {
      respuesta = await this.http.post('http://localhost:3000/api/consultar', { simbolo, tipo }).toPromise();

      this.resultado = respuesta.resultado;
      this.riesgo = respuesta.riesgo || '';
      this.probabilidadAlza = respuesta.probabilidadAlza || '';
      this.variacionPorcentual = respuesta.variacionPorcentual || '';
      this.tendenciaVolumen = respuesta.tendenciaVolumen || '';
      this.volatilidadDiaria = respuesta.volatilidadDiaria || '';
      this.rsi = respuesta.rsi || '';
      this.resultadoExtendido = respuesta.resultadoExtendido || '';
      this.sugerenciaCuantitativa = this.generarSugerencia(tipo, this.resultado, this.riesgo, this.probabilidadAlza);
      this.indiceConfianzaCuantico = respuesta.indiceConfianzaCuantico || null;
      this.mensajeConfianza = respuesta.mensaje_confianza || '';
      this.sentimiento = respuesta.sentimiento || '';
      this.puntajeSentimiento = respuesta.puntajeSentimiento ?? null;
      this.noticias = respuesta.noticias || [];
      this.resumenNoticias = respuesta.resumenNoticias || '';
      this.pesos = respuesta.pesos || {};
      this.pieChartData.labels = Object.keys(this.pesos);
      this.pieChartData.datasets[0].data = Object.values(this.pesos);
      this.pesosAnalisis = respuesta.pesosAnalisis || {};
      this.confianzaHistorica = isNaN(parseFloat(respuesta.confianzaHistorica)) ? null : parseFloat(respuesta.confianzaHistorica);
      this.alertaConfianza = respuesta.alertaConfianza || '';

      await this.consultarComparador(simbolo);


      if (tipo === 'largo') {
        await this.obtenerProyeccionMonteCarlo(simbolo);
      }

      await this.consultarCuantico(); // ✅ Llamada a simulación cuántica

      const ref = collection(this.firestore, 'consultas');
      await addDoc(ref, {
  simbolo,
  tipo,
  fecha: serverTimestamp(),
  estado: 'completado',
  resultado: this.resultado,
  riesgo: this.riesgo,
  probabilidadAlza: this.probabilidadAlza,
  proyeccionMonteCarlo: this.proyeccionMonteCarlo?.proyeccion || '',
  precioEstimado: this.proyeccionMonteCarlo?.precio_estimado || '',
  intervalo: this.proyeccionMonteCarlo?.intervalo_confianza?.join(' – ') || '',
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
  resultadoCuantico: this.resultadoCuantico ? {
    symbol: this.resultadoCuantico.symbol,
    probabilidad_alza: this.resultadoCuantico.probabilidad_alza,
    tipo: this.resultadoCuantico.tipo,
    metodo: this.resultadoCuantico.metodo
  } : null,
  comparacionModelos: {
    LSTM: this.comparacionModelos?.LSTM || null,
    MonteCarlo: this.comparacionModelos?.MonteCarlo || null,
    Qiskit: this.comparacionModelos?.Qiskit || null
  },
  confiancaHistorica: this.confianzaHistorica || null,
  alertaConfianza: this.alertaConfianza || '',
});


    } catch (error) {
      this.resultado = 'Error al procesar la consulta.';
      this.riesgo = '';

      const ref = collection(this.firestore, 'consultas');
      await addDoc(ref, {
        simbolo,
        tipo,
        fecha: serverTimestamp(),
        estado: 'fallido',
        resultado: this.resultado,
        riesgo: this.riesgo,
        sugerenciaCuantitativa: this.sugerenciaCuantitativa
      });

    } finally {
      this.cargando = false;
    }
  }

  async obtenerProyeccionMonteCarlo(simbolo: string) {
    try {
      const respuesta: any = await this.http.get(`http://localhost:3000/api/stock/proyeccion/${simbolo}`).toPromise();
      this.proyeccionMonteCarlo = respuesta;
      this.cd.detectChanges();
      const resultados = respuesta.simulaciones || [];

      if (resultados.length) {
        const bins: { [key: string]: number } = {};
        resultados.forEach((precio: number) => {
          const binKey = `$${Math.round(precio / 5) * 5}`;
          bins[binKey] = (bins[binKey] || 0) + 1;
        });

        const etiquetas = Object.keys(bins).sort((a, b) => Number(a.replace('$', '')) - Number(b.replace('$', '')));
        const valores = etiquetas.map(label => bins[label]);

        this.chartData.labels = etiquetas;
        this.chartData.datasets[0].data = valores;
      } else {
        this.chartData.labels = ['Min', 'Estimado', 'Max'];
        this.chartData.datasets[0].data = [
          Number(respuesta.intervalo_confianza[0]),
          Number(respuesta.precio_estimado),
          Number(respuesta.intervalo_confianza[1])
        ];
      }



    } catch (error) {
      console.error('❌ Error al obtener proyección Monte Carlo:', error);
      this.proyeccionMonteCarlo = null;
    }
  }



  getClaves(obj: any): string[] {
    return Object.keys(obj);
  }

  generarSugerencia(tipo: string, resultado: string, riesgo: string, probabilidad: string): string {
    if (this.confianzaHistorica !== null && this.confianzaHistorica < 0.4) {
      return '⚠️ Historial muestra baja efectividad para este símbolo. Se recomienda extrema cautela.';
    }

    if (tipo === 'largo' && resultado.includes('alza')) {
      return '✅ Podría ser un buen momento para considerar inversión a largo plazo. Supervisar confirmaciones.';
    }
    if (tipo === 'corto' && resultado.includes('negativo')) {
      return '⚠️ Señales bajistas detectadas. Venta en corto posible con gestión de riesgo.';
    }
    if (tipo === 'intradia' && riesgo.includes('alta')) {
      return '⛔ Riesgo alto para intradía. Se recomienda esperar confirmación o evitar operar.';
    }

    return '🔍 Sugerencia: Mantener posición o esperar señales más claras antes de actuar.';
  }


  async consultarCuantico() {
    const simbolo = this.form.get('simbolo')?.value;
    if (!simbolo) return;

    this.resultadoCuantico = null;

    try {
      const respuesta: any = await this.http.get(`http://localhost:3000/api/cuantic/${simbolo}`).toPromise();
      this.resultadoCuantico = respuesta;
      console.log('🔮 Resultado cuántico:', this.resultadoCuantico); // ✅ DEBUG
    } catch (error) {
      console.error('❌ Error al obtener simulación cuántica:', error);
      this.resultadoCuantico = {
        symbol: simbolo,
        probabilidad_alza: 0,
        tipo: 'error',
        metodo: 'cuántico fallido'
      };
    }
  }

  async consultarComparador(simbolo: string) {
    try {
      const res: any = await this.http.get(`http://localhost:3000/api/comparar/${simbolo}`).toPromise();
      this.comparacionModelos = res.comparacion || {};
      this.cd.detectChanges();
      console.log('📊 Comparación de modelos:', this.comparacionModelos);
    } catch (error) {
      console.error('❌ Error al consultar comparación de modelos:', error);
      this.comparacionModelos = {};
    }
  }

}
