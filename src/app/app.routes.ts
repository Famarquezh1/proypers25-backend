// app.routes.ts
import { Routes } from '@angular/router';
import { AuthComponent } from './private/auth/auth.component';
import { AuthGuard } from './private/guards/auth.guard';


export const routes: Routes = [
  { path: '', redirectTo: 'login', pathMatch: 'full' },
  { path: 'login', component: AuthComponent },
  {
    path: 'dashboard',
    canActivate: [AuthGuard],
    loadChildren: () => import('./components/features/dashboard.routes')
      .then(m => m.dashboardRoutes)
  },
  { path: '**', redirectTo: 'login' }
];

