// src/app/components/features/dashboard/dashboard.routes.ts
import { Routes } from '@angular/router';



export const dashboardRoutes: Routes = [
  {
    path: '',
    loadComponent: () => import('./dashboard/dashboard.component').then(m => m.DashboardComponent),
    children: [
      {
        path: '',
        redirectTo: 'consulta',
        pathMatch: 'full'
      },
      {
        path: 'formulario',
        loadComponent: () => import('../consultas/consultaform/consultaform.component')
          .then(m => m.ConsultaformComponent)
      },
      {
        path: 'historial',
        loadComponent: () => import('../consultas/consultahistorial/consultahistorial.component')
          .then(m => m.ConsultahistorialComponent)
      },
      {
        path: 'autonoma',
        loadComponent: () => import('../consultas/consulta-autonoma/consulta-autonoma.component')
          .then(m => m.ConsultaAutonomaComponent)
      },
    ]
  }
];

