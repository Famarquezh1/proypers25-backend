import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Observable } from 'rxjs';
import { finalize } from 'rxjs/operators';
import { VelasService } from '../../../servicios/velas.service';
import { FormsModule } from '@angular/forms';

@Component({
  selector: 'app-historial-velas',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './historial-velas.component.html',
  styleUrls: ['./historial-velas.component.css']
})
export class HistorialVelasComponent implements OnInit {
  historial: any[] = [];
  entrenamientos$: Observable<any[]> | undefined;
  mensaje = '';
  verificandoId: string | null = null;
  cargandoHistorial = false;
  hasMore = true;
  pageSize = 100;
  lastTimestamp: string | null = null;
  filtroSymbol = '';
  filtroStatus = '';
  filtroDesde = '';
  filtroHasta = '';

  constructor(private velasService: VelasService) {}

  ngOnInit(): void {
    this.cargarHistorial();
    this.cargarEntrenamientos();
  }

  cargarHistorial(reset = true): void {
    if (this.cargandoHistorial) return;
    if (reset) {
      this.historial = [];
      this.lastTimestamp = null;
      this.hasMore = true;
    }
    if (!this.hasMore) return;
    this.cargandoHistorial = true;

    this.velasService.obtenerHistorialVelas({
      limit: this.pageSize,
      symbol: this.filtroSymbol?.trim() || undefined,
      status: this.filtroStatus || undefined,
      from: this.filtroDesde || undefined,
      to: this.filtroHasta || undefined,
      startAfter: this.lastTimestamp || undefined
    }).pipe(finalize(() => (this.cargandoHistorial = false)))
      .subscribe({
        next: (items) => {
          const nextItems = Array.isArray(items) ? items : [];
          this.historial = reset ? nextItems : [...this.historial, ...nextItems];
          if (nextItems.length < this.pageSize) {
            this.hasMore = false;
          }
          const last = nextItems[nextItems.length - 1];
          const ts = last?.timestamp || last?.created_at;
          if (ts) {
            this.lastTimestamp = ts;
          }
        },
        error: () => {
          this.mensaje = 'No se pudo cargar el historial.';
        }
      });
  }

  cargarEntrenamientos(): void {
    this.entrenamientos$ = this.velasService.obtenerEntrenamientos();
  }

  computeProgress(entrenamiento: any): number {
    const total = entrenamiento.total_symbols || entrenamiento.symbols?.length || 0;
    const completed = entrenamiento.completed_count || 0;
    if (!total) {
      return 0;
    }
    const percent = Math.round((completed / total) * 100);
    return percent > 100 ? 100 : percent;
  }

  verificar(item: any): void {
    if (!item?.id || item.status !== 'pendiente') {
      return;
    }
    this.verificandoId = item.id;
    this.velasService.verificarPrediccion(item.id).pipe(
      finalize(() => (this.verificandoId = null))
    ).subscribe({
      next: (resultado) => {
        this.mensaje = `Predicción ${item.simbolo} ${resultado.status}`;
        this.cargarHistorial(true);
      },
      error: () => {
        this.mensaje = 'No se pudo verificar el historial.';
      }
    });
  }

  statusClass(status: string): string {
    switch (status) {
      case 'pendiente':
        return 'badge bg-warning';
      case 'validado':
        return 'badge bg-success';
      case 'fallido':
        return 'badge bg-danger';
      default:
        return 'badge bg-secondary';
    }
  }

  aplicarFiltros(): void {
    this.cargarHistorial(true);
  }

  limpiarFiltros(): void {
    this.filtroSymbol = '';
    this.filtroStatus = '';
    this.filtroDesde = '';
    this.filtroHasta = '';
    this.cargarHistorial(true);
  }

  cargarMas(): void {
    this.cargarHistorial(false);
  }
}
