import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { HttpClient, HttpClientModule } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { RouterModule } from '@angular/router';
import { Firestore, collection, addDoc, serverTimestamp } from '@angular/fire/firestore';

@Component({
  selector: 'app-consulta-autonoma',
  standalone: true,
  imports: [CommonModule, HttpClientModule, FormsModule, RouterModule],
  templateUrl: './consulta-autonoma.component.html',
  styleUrls: ['./consulta-autonoma.component.css']
})
export class ConsultaAutonomaComponent {
  monto: number = 1000;
  cargando: boolean = false;
  error: string = '';
  recomendacion: any = null;
  confianzaHistorica: number | null = null;
  alertaConfianza: string = '';

  constructor(private http: HttpClient, private firestore: Firestore) {}

  async obtenerRecomendacion() {
    this.cargando = true;
    this.error = '';
    this.recomendacion = null;
    this.confianzaHistorica = null;
    this.alertaConfianza = '';

    try {
      const respuesta = await this.http.get<any>('http://localhost:3000/api/inversion/recomendacion').toPromise();

      const porcentaje = parseFloat(respuesta.porcentaje || '0');
      const ganancia_estim = ((this.monto * porcentaje) / 100).toFixed(2);

      const recomendacionFinal = {
        ...respuesta,
        invertir: this.monto,
        ganancia_estim,
        hora_consulta: new Date().toISOString(),
        validacion: {
          precio_real: null,
          diferencia: null,
          acierto: null
        }
      };

      this.recomendacion = recomendacionFinal;

      // 🔁 Aprendizaje histórico
      this.confianzaHistorica = isNaN(parseFloat(respuesta.confianzaHistorica))
        ? null
        : parseFloat(respuesta.confianzaHistorica);
      this.alertaConfianza = respuesta.alertaConfianza || '';

      const ref = collection(this.firestore, 'consultas');
      await addDoc(ref, {
        simbolo: respuesta.simbolo,
        tipo: 'autonoma',
        monto: this.monto,
        fecha: serverTimestamp(),
        estado: 'completado',
        resultado: recomendacionFinal
      });

    } catch (err) {
      console.error('Error en recomendación autónoma:', err);
      this.error = 'Ocurrió un error al obtener la recomendación.';
    }

    this.cargando = false;
  }
}








