import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Firestore, collection, collectionData, deleteDoc, doc, writeBatch } from '@angular/fire/firestore';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { FormsModule } from '@angular/forms';
import { Consulta } from '../../../models/consulta.model';

@Component({
  selector: 'app-consultahistorial',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './consultahistorial.component.html',
  styleUrls: ['./consultahistorial.component.css']
})
export class ConsultahistorialComponent implements OnInit {
  consultas$: Observable<any[]> = new Observable();
  consultasFiltradas: any[] = [];
  filtroTexto: string = '';
  seleccionadas: Set<string> = new Set();
  seleccionarTodas: boolean = false;
  cargando: boolean = true;

  constructor(private firestore: Firestore) {}

  ngOnInit() {
    const ref = collection(this.firestore, 'consultas');
    this.consultas$ = collectionData(ref, { idField: 'id' }).pipe(
      map((consultas: any[]) =>
        consultas
          .map(consulta => ({
            ...consulta,
            fecha: consulta.fecha?.toDate ? consulta.fecha.toDate() : null,
            mensajeConfianza: consulta.mensaje_confianza || '',
            indiceConfianzaCuantico: consulta.indiceConfianzaCuantico || null,
            sentimiento: consulta.sentimiento || '',
            puntajeSentimiento: consulta.puntajeSentimiento ?? null,
            resultadoCuantico: consulta.resultadoCuantico ?? null,
            comparacionModelos: consulta.comparacionModelos ?? null,
            recomendacion: consulta.recomendacion ?? null,
            resultado: consulta.resultado ?? null,
            confianzaHistorica: consulta.confianzaHistorica ?? null,
            alertaConfianza: consulta.alertaConfianza || '',
            expandido: false
          }))
          .sort((a, b) => (b.fecha?.getTime?.() || 0) - (a.fecha?.getTime?.() || 0))
      )
    );

    this.consultas$.subscribe(data => {
      this.consultasFiltradas = data;
      this.cargando = false;
    });
  }

  filtrarConsultas() {
    const texto = this.filtroTexto.toLowerCase();
    this.consultas$.subscribe(data => {
      this.consultasFiltradas = data.filter(consulta =>
        consulta.simbolo?.toLowerCase().includes(texto) ||
        consulta.tipo?.toLowerCase().includes(texto) ||
        consulta.estado?.toLowerCase().includes(texto)
      );
    });
  }

  toggleDetalle(consulta: any) {
    consulta.expandido = !consulta.expandido;
  }

  toggleSeleccion(consultaId: string, event: any) {
    if (event.target.checked) {
      this.seleccionadas.add(consultaId);
    } else {
      this.seleccionadas.delete(consultaId);
    }
  }

  toggleSeleccionGlobal(event: any, consultas: any[]) {
    this.seleccionadas.clear();
    this.seleccionarTodas = event.target.checked;
    if (this.seleccionarTodas) {
      consultas.forEach(c => this.seleccionadas.add(c.id));
    }
  }

  async eliminarSeleccionadas() {
    const batch = writeBatch(this.firestore);
    this.seleccionadas.forEach(id => {
      const ref = doc(this.firestore, 'consultas', id);
      batch.delete(ref);
    });
    await batch.commit();
    this.seleccionadas.clear();
  }

  eliminarConsulta(id: string) {
    const ref = doc(this.firestore, 'consultas', id);
    deleteDoc(ref).then(() => {
      this.consultas$.subscribe(data => {
        this.consultasFiltradas = data;
      });
    });
  }
}

