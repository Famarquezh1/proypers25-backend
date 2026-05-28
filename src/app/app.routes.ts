import { Routes } from '@angular/router';

// Componentes standalone públicos
import { AuthComponent } from './private/auth/auth.component';

// Guards
import { AuthGuard } from './private/guards/auth.guard';

// Layout privado (dashboard principal)
import { DashboardComponent } from './components/dashboard/dashboard.component';

export const routes: Routes = [
  // 🔓 Zona pública
  {
    path: 'login',
    component: AuthComponent
  },

  // 🔐 Zona protegida con rutas hijas (protegidas con AuthGuard)
  {
    path: 'dashboard',
    component: DashboardComponent,
    canActivate: [AuthGuard],
    children: [
      { path: '', redirectTo: 'form', pathMatch: 'full' },
      {
        path: 'form',
        loadComponent: () => import('./components/consultas/consultaform/consultaform.component')
          .then(m => m.ConsultaformComponent)
      },
      {
        path: 'historial',
        loadComponent: () => import('./components/consultas/consultahistorial/consultahistorial.component')
          .then(m => m.ConsultahistorialComponent)
      },
      {
        path: 'autonoma',
        loadComponent: () => import('./components/consultas/consulta-autonoma/consulta-autonoma.component')
          .then(m => m.ConsultaAutonomaComponent)
      },
      {
        path: 'entrenamientos',
        loadComponent: () => import('./components/consultas/entrenamientos/entrenamientos.component')
          .then(m => m.EntrenamientosComponent)
      },
      {
        path: 'predicciones-velas',
        loadComponent: () => import('./components/consultas/predicciones-velas/predicciones-velas.component')
          .then(m => m.PrediccionesVelasComponent)
      },
      {
        path: 'historial-velas',
        loadComponent: () => import('./components/consultas/historial-velas/historial-velas.component')
          .then(m => m.HistorialVelasComponent)
      }
    ]
  },

  // 🔍 Monitor de Trading (solo lectura, sin autenticación)
  {
    path: 'trading-monitor',
    loadComponent: () => import('./components/trading-monitor/trading-monitor.component')
      .then(m => m.TradingMonitorComponent)
  },

  // 🌐 Ruta raíz redirige a login
  { path: '', redirectTo: 'login', pathMatch: 'full' },

  // Ruta comodín
  { path: '**', redirectTo: 'login' }
];



