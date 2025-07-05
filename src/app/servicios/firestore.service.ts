// src/app/servicios/firestore.service.ts
import { Injectable } from '@angular/core';
import {
  Firestore,
  collection,
  collectionData,
  doc,
  getDoc,
  addDoc,
  updateDoc,
  deleteDoc
} from '@angular/fire/firestore';
import { Observable } from 'rxjs';
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

