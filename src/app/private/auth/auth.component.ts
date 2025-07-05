import { Component } from '@angular/core';
import { Router } from '@angular/router';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Auth, GoogleAuthProvider, signInWithPopup } from '@angular/fire/auth';
import { RouterModule } from '@angular/router';
import { browserLocalPersistence, setPersistence } from 'firebase/auth';

@Component({
  selector: 'app-auth',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterModule],
  templateUrl: './auth.component.html',
  styleUrls: ['./auth.component.css']
})
export class AuthComponent {
  error = '';

  constructor(private auth: Auth, private router: Router) {}

  async loginWithGoogle() {
  try {
    await setPersistence(this.auth, browserLocalPersistence); // ✅ establece persistencia

    const provider = new GoogleAuthProvider();
    const result = await signInWithPopup(this.auth, provider);
    const user = result.user;

    const token = await user.getIdToken();
    localStorage.setItem('token', token);

    this.router.navigate(['/dashboard']);
  } catch (err: any) {
    this.error = err.message || 'Error al iniciar sesión con Google';
  }
}


}

