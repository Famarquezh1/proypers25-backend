// models/consulta.model.ts
export interface Consulta {
  id?: string;
  simbolo: string;               // Por ejemplo: AAPL
  tipo: 'corto' | 'largo' | 'intradia';
  fecha: number;                 // timestamp
  resultado?: string;            // "Comprar", "Vender", "Esperar"
  confianza?: number;            // 0-100%
  detalles?: string;             // Explicación
}

