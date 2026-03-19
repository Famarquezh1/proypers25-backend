// src/app/servicios/firestore.service.ts
import { Injectable } from '@angular/core';
import {
  Firestore,
  collection,
  collectionData,
  query,
  orderBy,
  limit,
  where,
  documentId,
  doc,
  docData,
  getDoc,
  addDoc,
  setDoc,
  updateDoc,
  deleteDoc
} from '@angular/fire/firestore';
import { Observable, combineLatest, of } from 'rxjs';
import { map } from 'rxjs/operators';
import { DocumentData, WithFieldValue } from 'firebase/firestore';

@Injectable({
  providedIn: 'root'
})
export class FirestoreService {
  constructor(private firestore: Firestore) {}

  getCollection<T extends DocumentData>(path: string): Observable<T[]> {
    const ref = collection(this.firestore, path);
    return collectionData(ref, { idField: 'id' }) as Observable<T[]>;
  }

  getHighConvictionSignals<T extends DocumentData>(max = 5): Observable<T[]> {
    const ref = collection(this.firestore, 'high_conviction_signals');
    const q = query(ref, orderBy('created_at', 'desc'), limit(max));
    return collectionData(q, { idField: 'id' }) as Observable<T[]>;
  }

  getBinanceExecutionIntents<T extends DocumentData>(max = 20): Observable<T[]> {
    const ref = collection(this.firestore, 'binance_execution_intents');
    const q = query(ref, orderBy('created_at', 'desc'), limit(max));
    return collectionData(q, { idField: 'id' }) as Observable<T[]>;
  }

  getTelegramNotifications<T extends DocumentData>(max = 10): Observable<T[]> {
    const ref = collection(this.firestore, 'telegram_notifications');
    const q = query(ref, orderBy('created_at', 'desc'), limit(max));
    return collectionData(q, { idField: 'id' }) as Observable<T[]>;
  }

  getMonitoringSnapshots<T extends DocumentData>(max = 20): Observable<T[]> {
    const ref = collection(this.firestore, 'velas_monitoring_snapshots');
    const q = query(ref, orderBy('created_at', 'desc'), limit(max));
    return collectionData(q, { idField: 'id' }) as Observable<T[]>;
  }

  getHighConvictionSignalsByDateRange<T extends DocumentData>(
    options: { days?: number; from?: Date; to?: Date; max?: number } = {}
  ): Observable<T[]> {
    const ref = collection(this.firestore, 'high_conviction_signals');
    const max = options.max ?? 50;
    const constraints: any[] = [];

    if (typeof options.days === 'number' && options.days > 0) {
      const from = new Date();
      from.setDate(from.getDate() - options.days);
      constraints.push(where('created_at', '>=', from));
    } else {
      if (options.from) {
        constraints.push(where('created_at', '>=', options.from));
      }
      if (options.to) {
        constraints.push(where('created_at', '<=', options.to));
      }
    }

    const q = query(ref, ...constraints, orderBy('created_at', 'desc'), limit(max));
    return collectionData(q, { idField: 'id' }) as Observable<T[]>;
  }

  getBinanceBotConfig<T extends DocumentData>(): Observable<T | null> {
    const ref = doc(this.firestore, 'binance_bot_config', 'global');
    return docData(ref, { idField: 'id' }).pipe(
      map((value) => (value ? (value as T) : null))
    );
  }

  saveBinanceBotConfig(data: any): Promise<void> {
    const ref = doc(this.firestore, 'binance_bot_config', 'global');
    return setDoc(ref, data, { merge: true });
  }

  getCollectionByIds<T extends DocumentData>(path: string, ids: string[]): Observable<T[]> {
    const cleanIds = Array.from(new Set((ids || []).filter(Boolean)));
    if (!cleanIds.length) {
      return of([] as T[]);
    }

    const ref = collection(this.firestore, path);
    const chunkSize = 10;
    const chunks: string[][] = [];
    for (let i = 0; i < cleanIds.length; i += chunkSize) {
      chunks.push(cleanIds.slice(i, i + chunkSize));
    }

    const streams = chunks.map((chunk) => {
      const q = query(ref, where(documentId(), 'in', chunk));
      return collectionData(q, { idField: 'id' }) as Observable<T[]>;
    });

    return combineLatest(streams).pipe(map((results) => results.flat()));
  }

  getCollectionByFieldIn<T extends DocumentData>(path: string, field: string, values: string[]): Observable<T[]> {
    const cleanValues = Array.from(new Set((values || []).filter(Boolean)));
    if (!cleanValues.length) {
      return of([] as T[]);
    }

    const ref = collection(this.firestore, path);
    const chunkSize = 10;
    const chunks: string[][] = [];
    for (let i = 0; i < cleanValues.length; i += chunkSize) {
      chunks.push(cleanValues.slice(i, i + chunkSize));
    }

    const streams = chunks.map((chunk) => {
      const q = query(ref, where(field as any, 'in', chunk));
      return collectionData(q, { idField: 'id' }) as Observable<T[]>;
    });

    return combineLatest(streams).pipe(map((results) => results.flat()));
  }

  getDocument<T>(path: string, id: string): Promise<T | undefined> {
    const ref = doc(this.firestore, path, id) as import('firebase/firestore').DocumentReference<T>;
    return getDoc(ref).then(docSnap =>
      docSnap.exists() ? (docSnap.data() as T) : undefined
    );
  }

  addDocument<T extends DocumentData>(path: string, data: WithFieldValue<T>): Promise<any> {
    const ref = collection(this.firestore, path);
    return addDoc(ref, data);
  }

  updateDocument<T>(path: string, id: string, data: Partial<T>): Promise<void> {
  const ref = doc(this.firestore, path, id);
  return updateDoc(ref as any, data as any);

}



  deleteDocument(path: string, id: string): Promise<void> {
    const ref = doc(this.firestore, path, id);
    return deleteDoc(ref);
  }
}

