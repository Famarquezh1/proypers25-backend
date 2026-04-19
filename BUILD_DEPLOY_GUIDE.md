# 📋 Guía de Build & Deploy - Backend Proypers25

## 🎯 Resumen Ejecutivo

**Flujo correcto:**
1. Git commit & push a `proypers25` (monorepo)
2. Cloud Build compila Docker → Artifact Registry
3. gcloud run deploy → Cloud Run
4. Validar endpoints en producción

---

## 📁 Estructura de Repositorios (DEFINITIVO)

### ✅ MANTENER:
- **`proypers25`** (monorepo en GitHub)
  - Frontend: `src/`, `angular.json`
  - Backend: `backend/` ← AQUÍ está tu código

### ❌ ELIMINAR (si existen):
- `proypers25-backend` - Redundante y causa sincronización manual

---

## 🔧 PASO 1: Preparar Cambios Locales

### Ubicación correcta:
```bash
cd c:\Desarrollo\proypers25\backend
```

### Hacer cambios en archivos:
```
backend/
├── server.js           ← Cambios de rutas
├── routes/
│   └── deep_health_router.js  ← Nuevos endpoints
├── controllers/
├── lib/
└── Dockerfile          ← Si necesitas cambios
```

### Validar sintaxis (ANTES de commit):
```bash
node -c backend/server.js
```

### Commit & Push:
```bash
cd c:\Desarrollo\proypers25
git add backend/
git commit -m "Descripción clara del cambio"
git push origin main
```

**IMPORTANTE:** El código DEBE estar en GitHub antes de hacer build.

---

## 🏗️ PASO 2: Cloud Build (Compilar Docker)

### Ubicación:
```bash
cd c:\Desarrollo\proypers25\backend
```

### Iniciar build:
```bash
gcloud builds submit --config cloudbuild.yaml --project proypers2025
```

### Qué hace:
1. Copia código de GitHub a Cloud Build
2. Ejecuta `docker build` con Dockerfile
3. Pushea imagen a Artifact Registry: `southamerica-west1-docker.pkg.dev/proypers2025/backend-repo/backend-image`
4. Tags: `latest`, `fixed-endpoints`, `<SHA>`

### Monitorear:
```bash
# Ver builds recientes
gcloud builds list --project proypers2025 --limit 3

# Ver status de un build específico
gcloud builds log BUILD_ID --project proypers2025
```

### Tiempo esperado:
- **Primera vez:** ~5 minutos (construye capas Docker)
- **Cambios menores:** ~2-3 minutos (reutiliza capas)

### Éxito = `STATUS: SUCCESS`

---

## 🚀 PASO 3: Deploy a Cloud Run

### Opción A: Deploy automático (RECOMENDADO)
```bash
gcloud run deploy proypers25-backend \
  --image southamerica-west1-docker.pkg.dev/proypers2025/backend-repo/backend-image:latest \
  --region southamerica-west1 \
  --project proypers2025 \
  --allow-unauthenticated
```

### Opción B: Si no se actualiza inmediatamente
Cloud Run a veces retiene la revisión anterior. Fuerza tráfico a la nueva:
```bash
gcloud run services update-traffic proypers25-backend \
  --to-revisions LATEST=100 \
  --region southamerica-west1 \
  --project proypers2025
```

### Verificar deployment:
```bash
# Ver revisión activa
gcloud run services describe proypers25-backend \
  --region southamerica-west1 \
  --project proypers2025 \
  --format="value(status.latestReadyRevisionName)"

# Ver tráfico
gcloud run services describe proypers25-backend \
  --region southamerica-west1 \
  --project proypers2025 \
  --format="value(status.traffic)"
```

### Tiempo esperado:
- Deploy: ~1-2 minutos
- Cloud Run pulls imagen y startup: ~30-60 segundos

### Éxito = revisión activa muestra tu imagen

---

## ✅ PASO 4: Validar Endpoints en Producción

### URL base:
```
https://proypers25-backend-518292923158.southamerica-west1.run.app
```

### Endpoints para validar:
```bash
# 1. Critical Alerts
curl "https://proypers25-backend-518292923158.southamerica-west1.run.app/api/system/critical-alerts"

# 2. Heartbeats
curl "https://proypers25-backend-518292923158.southamerica-west1.run.app/api/system/heartbeats"

# 3. Safety Status
curl "https://proypers25-backend-518292923158.southamerica-west1.run.app/api/system/safety-status"
```

### Esperado:
- Status: **200 OK**
- Response: JSON válido con `timestamp`, `status`, datos relevantes

### Troubleshooting:

#### ❌ 404 - Endpoint no encontrado
- La revisión anterior aún está activa
- Solución: Ejecutar `gcloud run services update-traffic` (Paso 3B)
- Esperar 30 segundos y reintentar

#### ❌ 500 - Error del servidor
- Ver logs: `gcloud run revisions logs REVISION_NAME --project proypers2025`
- Posible causa: Firestore no accesible, variables env faltando

#### ❌ Connection refused
- Cloud Run aún está iniciando
- Esperar 1 minuto y reintentar

---

## 📊 Workflow Completo (De Inicio a Fin)

```bash
# 1. Cambios locales
cd c:\Desarrollo\proypers25
git add backend/
git commit -m "Fix: register deep health router"
git push origin main

# 2. Esperar ~10 segundos para que GitHub registre push

# 3. Build
cd c:\Desarrollo\proypers25\backend
gcloud builds submit --config cloudbuild.yaml --project proypers2025
# Esperar 2-5 minutos, confirmar STATUS: SUCCESS

# 4. Deploy
gcloud run deploy proypers25-backend \
  --image southamerica-west1-docker.pkg.dev/proypers2025/backend-repo/backend-image:latest \
  --region southamerica-west1 \
  --project proypers2025 \
  --allow-unauthenticated
# Esperar 1-2 minutos

# 5. Rotar tráfico a nueva revisión
gcloud run services update-traffic proypers25-backend \
  --to-revisions LATEST=100 \
  --region southamerica-west1 \
  --project proypers2025
# Esperar 30 segundos

# 6. Validar
curl "https://proypers25-backend-518292923158.southamerica-west1.run.app/api/system/critical-alerts"
# Debe ser 200 OK
```

**Tiempo total: ~10-15 minutos**

---

## 🔐 Autenticación GCP

### Usuario actual:
```
f.marquez.hernandez@gmail.com
```

### Verificar:
```bash
gcloud auth list
```

### Si necesita cambiar:
```bash
gcloud auth login
```

---

## 📦 Dockerfile - Notas Importantes

**Ubicación:** `backend/Dockerfile`

**Optimizaciones aplicadas:**
- Base: `node:20-slim` (ligero, eficiente)
- Python: Sistema packages (`apt-get`), no compilado
- Tiempo de build: ~2-5 minutos (vs ~30 min original)

**NO modificar sin testear localmente:**
```bash
docker build -t test-backend:local .
docker run -p 8080:8080 test-backend:local
```

---

## 🗂️ Artifact Registry - Limpieza

### Ver imágenes:
```bash
gcloud artifacts docker images list \
  southamerica-west1-docker.pkg.dev/proypers2025/backend-repo/backend-image \
  --project proypers2025
```

### Eliminar imagen vieja:
```bash
gcloud artifacts docker images delete \
  southamerica-west1-docker.pkg.dev/proypers2025/backend-repo/backend-image@sha256:DIGEST \
  --project proypers2025 --quiet
```

**Regla:** Mantener solo `latest` y las últimas 2 builds anteriores.

---

## 🚨 Problemas Comunes & Soluciones

| Problema | Causa | Solución |
|----------|-------|----------|
| `fatal: Not a git repository` | Estás fuera de `proypers25` | `cd c:\Desarrollo\proypers25` |
| Build timeout | Docker compila Python desde source | Ya está optimizado en `Dockerfile` |
| 404 después de deploy | Tráfico no migrado a nueva revisión | Ejecutar `gcloud run services update-traffic` |
| Cambios no reflejados | Código no pusheado a GitHub | Hacer `git push origin main` primero |
| Permiso denegado en Cloud Build | Usuario sin permisos | Usar `f.marquez.hernandez@gmail.com` |
| Endpoint retorna 500 | Firestore desconectada o key faltando | Verificar serviceAccountKey.json en backend/ |

---

## 📝 Checklist Para Futuros Deploys

- [ ] Cambios hechos en `backend/` (no en raíz)
- [ ] `node -c server.js` sin errores
- [ ] `git push origin main` ejecutado
- [ ] Esperar ~10s para GitHub
- [ ] `gcloud builds submit` - esperar SUCCESS
- [ ] `gcloud run deploy` ejecutado
- [ ] `gcloud run services update-traffic` LATEST=100
- [ ] Endpoints retornan 200 OK
- [ ] ✅ Deployment exitoso

---

## 📞 Referencia Rápida

```bash
# Build
gcloud builds submit --config cloudbuild.yaml --project proypers2025

# Deploy
gcloud run deploy proypers25-backend --image southamerica-west1-docker.pkg.dev/proypers2025/backend-repo/backend-image:latest --region southamerica-west1 --project proypers2025 --allow-unauthenticated

# Actualizar tráfico
gcloud run services update-traffic proypers25-backend --to-revisions LATEST=100 --region southamerica-west1 --project proypers2025

# Validar
curl https://proypers25-backend-518292923158.southamerica-west1.run.app/api/system/critical-alerts
```

---

**Última actualización:** 2026-04-19
**Versión estable:** Commit ef6ce38 (deep health router registered)
