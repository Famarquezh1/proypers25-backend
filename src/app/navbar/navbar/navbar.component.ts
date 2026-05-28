// src/app/components/navbar/navbar.component.ts
import { Component, OnInit } from '@angular/core';
import { AuthService } from '../../servicios/auth.service';
import { CommonModule } from '@angular/common';
import { RouterLink, RouterModule } from '@angular/router';
import { ThemeService } from '../../servicios/theme.service';

@Component({
  selector: 'app-navbar',
  standalone: true,
  imports: [CommonModule, RouterModule, RouterLink],
  templateUrl: './navbar.component.html',
  styleUrls: ['./navbar.component.css']
})
export class NavbarComponent implements OnInit {
  logueado = false;
  themeMode: 'light' | 'dark' = 'light';

  items = [
    { nombre: 'Formulario', ruta: 'form' },
    { nombre: 'Historial', ruta: 'historial' },
    { nombre: 'Autónoma', ruta: 'autonoma' },
    { nombre: 'Entrenamientos', ruta: 'entrenamientos' },
    { nombre: 'Predicciones Velas', ruta: 'predicciones-velas' },
    { nombre: 'Historial Velas', ruta: 'historial-velas' },
    { nombre: 'Monitor Spot', ruta: '/trading-monitor' },
  ];

  constructor(
    public authService: AuthService,
    private themeService: ThemeService
  ) {}

  ngOnInit(): void {
    this.authService.isLoggedIn().then((estado) => {
      this.logueado = estado;
    });
    this.themeMode = this.themeService.currentMode;
    this.themeService.mode$.subscribe((mode) => {
      this.themeMode = mode;
    });
  }

  cerrarSesion() {
    this.authService.logout();
  }

  toggleTheme(): void {
    this.themeService.toggleMode();
  }
}



