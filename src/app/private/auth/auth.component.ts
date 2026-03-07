// src/app/private/auth/auth.component.ts
import { Component, inject, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { AuthService } from '../../servicios/auth.service';
import { CommonModule } from '@angular/common';
import { FormBuilder, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';

@Component({
  selector: 'app-auth',
  standalone: true,
  imports: [CommonModule, ReactiveFormsModule],
  templateUrl: './auth.component.html',
  styleUrls: ['./auth.component.css']
})
export class AuthComponent implements OnInit {
  private router = inject(Router);
  private authService = inject(AuthService);
  private fb = inject(FormBuilder);
  form: FormGroup = this.fb.group({
    email: ['', [Validators.required, Validators.email]],
    password: ['', Validators.required]
  });
  error: string | null = null;

  async ngOnInit(): Promise<void> {
    console.log('[AuthComponent] ngOnInit');
    const handledRedirect = await this.authService.handleRedirect();
    console.log('[AuthComponent] handleRedirect resultado', handledRedirect);
    if (handledRedirect) {
      this.router.navigate(['/dashboard']);
      return;
    }

    const loggedIn = await this.authService.isLoggedIn();
    console.log('[AuthComponent] isLoggedIn resultado', loggedIn);
    if (loggedIn) {
      this.router.navigate(['/dashboard']);
    }
  }

  async login(): Promise<void> {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }

    const { email, password } = this.form.value;
    try {
      await this.authService.loginWithEmail(email, password);
      this.router.navigate(['/dashboard']);
    } catch (err: any) {
      console.error('Login email error:', err);
      this.error = err.message || 'Error de inicio de sesión';
    }
  }

  async loginWithGoogle(): Promise<void> {
    try {
      await this.authService.loginWithGoogle();
      this.router.navigate(['/dashboard']);
    } catch (err: any) {
      console.error('Login Google error:', err);
      this.error = err.message || 'Error de inicio con Google';
    }
  }
}







