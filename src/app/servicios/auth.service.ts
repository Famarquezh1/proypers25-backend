// src/app/servicios/auth.service.ts
import { Injectable, inject, Injector, runInInjectionContext } from '@angular/core';
import {
  Auth,
  GoogleAuthProvider,
  signInWithRedirect,
  signInWithPopup,
  getRedirectResult,
  signInWithEmailAndPassword,
  signOut
} from '@angular/fire/auth';

@Injectable({ providedIn: 'root' })
export class AuthService {
  private auth = inject(Auth);
  private injector = inject(Injector);

  async loginWithGoogle(): Promise<void> {
    const provider = new GoogleAuthProvider();
    console.log('[AuthService] iniciando login con Google');
    await signInWithPopup(this.auth, provider);
  }

  async loginWithEmail(email: string, password: string): Promise<void> {
    try {
      await signInWithEmailAndPassword(this.auth, email, password);
    } catch (error) {
      console.error('[AuthService] login email error', error);
      throw error;
    }
  }

  async handleRedirect(): Promise<boolean> {
    console.log('[AuthService] handleRedirect invocado');
    try {
      const result = await runInInjectionContext(this.injector, () => getRedirectResult(this.auth));
      console.log('[AuthService] resultado de redirect:', result?.user);
      return !!result?.user;
    } catch (error) {
      console.error('Error en el redirect:', error);
      return false;
    }
  }

  async isLoggedIn(): Promise<boolean> {
    console.log('[AuthService] isLoggedIn: currentUser ->', this.auth.currentUser);
    if (this.auth.currentUser) {
      return true;
    }

    return new Promise<boolean>(resolve => {
      let settled = false;
      const unsub = this.auth.onAuthStateChanged(user => {
        if (user) {
          settled = true;
          unsub();
          resolve(true);
        }
      });

      setTimeout(() => {
        if (!settled) {
          unsub();
          resolve(false);
        }
      }, 4000);
    });
  }

  logout(): void {
    signOut(this.auth);
    window.location.href = '/login';
  }
}



