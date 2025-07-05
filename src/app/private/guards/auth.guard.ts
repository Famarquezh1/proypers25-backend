// auth.guard.ts
import { CanActivateFn } from '@angular/router';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { getAuth } from 'firebase/auth';

export const AuthGuard: CanActivateFn = () => {
  const router = inject(Router);
  const auth = getAuth();
  const user = auth.currentUser;

  if (user) {
    return true;
  } else {
    router.navigate(['/login']);
    return false;
  }
};



