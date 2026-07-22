# Portal Unificado Proypers25

## Rutas

- `GET /dashboard`: launcher principal.
- `GET /dashboard/comparison`: comparación CORE vs GEM Hunter.
- `GET /dashboard/production-gate`: checklist automático de preparación.
- `GET /dashboard/settings`: estado de configuración de solo lectura.
- `GET /internal/dashboard/control-center`: fuente privada de datos del portal.

## Garantías de esta fase

- Las rutas históricas permanecen activas.
- El portal consume Firestore y reutiliza las colecciones existentes de CORE, GEM Hunter, Discovery y evidencia Spot.
- Las estrategias comparadas permanecen en modo Shadow.
- El Production Gate es informativo y no habilita trading real.
- No se modifican scheduler, capital, límites, compras, ventas ni ejecución Spot real.
- Las fuentes sin datos se presentan con estado vacío, sin fallar la interfaz.
