// src/app/components/navbar/navbar.component.ts
import { Component, OnInit } from '@angular/core';
import { AuthService } from '../../servicios/auth.service';
import { CommonModule } from '@angular/common';
import { RouterLink, RouterModule } from '@angular/router';

@Component({
  selector: 'app-navbar',
  standalone: true,
  imports: [CommonModule, RouterModule, RouterLink],
  templateUrl: './navbar.component.html',
  styleUrls: ['./navbar.component.css']
})
export class NavbarComponent implements OnInit {
  logueado = false;

  items = [
    { nombre: 'Formulario', ruta: 'form' },
    { nombre: 'Historial', ruta: 'historial' },
    { nombre: 'Autónoma', ruta: 'autonoma' },
    { nombre: 'Entrenamientos', ruta: 'entrenamientos' },
    { nombre: 'Predicciones Velas', ruta: 'predicciones-velas' },
    { nombre: 'Historial Velas', ruta: 'historial-velas' },
  ];

  constructor(public authService: AuthService) {}

  ngOnInit(): void {
    this.authService.isLoggedIn().then((estado) => {
      this.logueado = estado;
    });
  }

  cerrarSesion() {
    this.authService.logout();
  }
}



