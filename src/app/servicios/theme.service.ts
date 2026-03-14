import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';

type ThemeMode = 'light' | 'dark';

@Injectable({
  providedIn: 'root'
})
export class ThemeService {
  private readonly storageKey = 'proypers_theme_mode';
  private readonly modeSubject = new BehaviorSubject<ThemeMode>('light');
  readonly mode$ = this.modeSubject.asObservable();

  init(): void {
    const stored = (localStorage.getItem(this.storageKey) || '').toLowerCase();
    const mode: ThemeMode = stored === 'dark' ? 'dark' : 'light';
    this.apply(mode);
  }

  get currentMode(): ThemeMode {
    return this.modeSubject.value;
  }

  setMode(mode: ThemeMode): void {
    this.apply(mode);
    localStorage.setItem(this.storageKey, mode);
  }

  toggleMode(): void {
    this.setMode(this.currentMode === 'dark' ? 'light' : 'dark');
  }

  private apply(mode: ThemeMode): void {
    const body = document.body;
    body.classList.remove('theme-light', 'theme-dark');
    body.classList.add(mode === 'dark' ? 'theme-dark' : 'theme-light');
    this.modeSubject.next(mode);
  }
}
