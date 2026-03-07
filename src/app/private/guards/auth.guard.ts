// src/app/private/guards/auth.guard.ts
import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from '../../servicios/auth.service';

export const AuthGuard: CanActivateFn = async () => {
  const authService = inject(AuthService);
  const router = inject(Router);

  const isLogged = await authService.isLoggedIn();
  if (!isLogged) {
    router.navigate(['/login']);
    return false;
  }

  return true;
};









