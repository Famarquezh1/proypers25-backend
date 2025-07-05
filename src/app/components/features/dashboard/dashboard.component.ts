// dashboard.component.ts
import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule, Router } from '@angular/router';
import { Auth, signOut } from '@angular/fire/auth';

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [CommonModule, RouterModule],
  templateUrl: './dashboard.component.html',
  styleUrls: ['./dashboard.component.css']
})
export class DashboardComponent {
  constructor(private auth: Auth, private router: Router) {}

  cerrarSesion() {
    signOut(this.auth).then(() => {
      localStorage.removeItem('token'); // opcional, si lo usas para validación
      this.router.navigate(['/login']); // ajusta si tu ruta de login es distinta
    });
  }
}

