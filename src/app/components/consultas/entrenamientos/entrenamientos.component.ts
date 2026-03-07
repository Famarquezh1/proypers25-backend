import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
  Firestore,
  collection,
  collectionData,
  limit,
  orderBy,
  query,
} from '@angular/fire/firestore';

@Component({
  selector: 'app-entrenamientos',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './entrenamientos.component.html',
  styleUrls: ['./entrenamientos.component.css']
})
export class EntrenamientosComponent implements OnInit {
  entrenamientos: any[] = [];
  entrenamientosFiltrados: any[] = [];
  filtroTexto: string = '';
  error: string = '';
  pendingJobs: PendingJob[] = [];

  constructor(private firestore: Firestore) {}

  ngOnInit(): void {
    this.loadEntrenamientos();
    this.loadPendingJobs();
  }

  private loadEntrenamientos(): void {
    const ref = collection(this.firestore, 'entrenamientos');

    collectionData(ref, { idField: 'id' }).subscribe({
      next: data => {
        this.entrenamientos = this.normalizeEntrenamientos(data as any[]);
        this.entrenamientosFiltrados = [...this.entrenamientos];
      },
      error: err => {
        console.error('🔥 Error Firestore:', err);
        this.error = 'No se pudo cargar la información de Firestore.';
      }
    });
  }

  private normalizeEntrenamientos(data: any[]): any[] {
    const entrenamientos = data
      .map(item => ({
        ...item,
        timestamp: item.timestamp?.toDate?.() || item.timestamp,
      }))
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    const agrupados = new Map<string, any[]>();

    for (const item of entrenamientos) {
      const clave = `${item.simbolo}-${item.metodo}`;
      if (!agrupados.has(clave)) {
        agrupados.set(clave, []);
      }
      agrupados.get(clave)!.push(item);
    }

    agrupados.forEach(lista => {
      for (let i = 0; i < lista.length - 1; i++) {
        const actual = lista[i];
        const anterior = lista[i + 1];

        if (
          actual?.error_entrenamiento != null &&
          anterior?.error_entrenamiento != null
        ) {
          const mejora = ((anterior.error_entrenamiento - actual.error_entrenamiento) / anterior.error_entrenamiento) * 100;
          actual.mejora = Math.max(mejora, 0);
        } else {
          actual.mejora = null;
        }
      }

      const ultimo = lista[lista.length - 1];
      if (ultimo) ultimo.mejora = null;
    });

    return entrenamientos;
  }

  private loadPendingJobs(): void {
    const ref = collection(this.firestore, 'entrenamientos_pendientes');
    const q = query(ref, orderBy('createdAt', 'desc'), limit(5));

    collectionData(q, { idField: 'id' }).subscribe({
      next: data => {
        this.pendingJobs = (data as any[]).map(job => ({
          ...job,
          createdAt: job.createdAt?.toDate?.() || job.createdAt,
          logsRecord: job.logs ?? {},
        }));
      },
      error: err => {
        console.error('🔁 Error leyendo la cola de entrenamientos:', err);
      }
    });
  }

  filtrar(): void {
    const texto = this.filtroTexto.toLowerCase();
    this.entrenamientosFiltrados = this.entrenamientos.filter(e =>
      e.simbolo?.toLowerCase().includes(texto)
    );
  }

  getJobProgress(job: PendingJob): number {
    const logs = job.logsRecord ?? {};
    const total = Object.keys(logs).length;
    if (!total) {
      return job.status === 'done' ? 100 : 0;
    }
    const completed = Object.values(logs).filter(
      entry => entry?.status && entry.status !== 'running'
    ).length;
    return Math.round((completed / total) * 100);
  }

  statusClass(status?: string): string {
    if (!status) return 'status-default';
    if (status.includes('complete') || status === 'done') return 'status-done';
    if (status === 'running') return 'status-running';
    if (status === 'skipped') return 'status-skipped';
    return 'status-default';
  }

  getSymbolKeys(job: PendingJob): string[] {
    return Object.keys(job.logsRecord ?? {});
  }
}

interface PendingJob {
  id: string;
  status?: string;
  createdAt?: Date | string;
  metadata?: any;
  logsRecord?: Record<string, LogEntry>;
}

interface LogEntry {
  status?: string;
  reason?: string;
}
