# Cloud Run + Scheduler (Pipeline de velas)

Este documento explica como activar el pipeline de velas en produccion con Cloud Scheduler.

## 1) Obtener el CLOUD_RUN_URL

Opciones:
- Consola de Cloud Run -> Servicio `proypers25-backend` -> copiar el `Service URL`.
- CLI:
  - `gcloud run services describe proypers25-backend --region southamerica-west1 --format="value(status.url)"`

## 2) Configurar CRON_SECRET en Cloud Run

1. En Cloud Run -> Servicio `proypers25-backend` -> "Editar y desplegar".
2. En Variables de entorno agrega:
   - `CRON_SECRET` = un string aleatorio (copialo porque el scheduler debe usar el mismo).
   - `LEARNING_MODE` = `observe`
   - `LEARNING_LOG` = `false`
   - `PREDICTION_CONFIG` = ver `backend/.env.example` si quieres customizarlo.
3. Despliega la revision.

## 3) Ejecutar el script de creacion de jobs

Desde la raiz del repo:

```bash
bash backend/scripts/setupScheduler.sh
```

El script pedira:
- `CLOUD_RUN_URL`
- `CRON_SECRET`
- Region (default: `southamerica-west1`)

Creara:
- `velas-full-cycle` cada 5 minutos
- `velas-audit` cada hora
- `velas-prealerts` cada 2 minutos (alertas tempranas para Telegram)

Si respondes "yes", tambien crea:
- `velas-predict` cada 2 minutos
- `velas-verifications` cada 2 minutos (offset a minutos impares)
- `velas-learning` cada 4 minutos

## 4) Ver logs de Cloud Scheduler

```bash
gcloud logging read "resource.type=cloud_scheduler_job AND resource.labels.job_id=velas-full-cycle" --limit 50 --project <PROJECT_ID>
```

Tambien puedes ver los logs del servicio Cloud Run:

```bash
gcloud run services logs read proypers25-backend --region southamerica-west1 --project <PROJECT_ID> --limit 50
```

## 5) Verificar que Firestore recibe datos

En Firestore, revisa:
- `velas_predicciones` (nuevos documentos)
- `validaciones` (documento `summary` con `updatedAt` reciente)
- `velas_training_stats` y `entrenamientos`

## 6) Pausar o borrar jobs

```bash
gcloud scheduler jobs pause velas-full-cycle --location southamerica-west1 --project <PROJECT_ID>
gcloud scheduler jobs delete velas-full-cycle --location southamerica-west1 --project <PROJECT_ID>
```

## 7) Ejecucion inmediata (manual)

```bash
gcloud scheduler jobs run velas-full-cycle --location southamerica-west1 --project <PROJECT_ID>
```

## Advertencia

No actives `LEARNING_MODE=active` hasta que el win_rate lo justifique en `validaciones/summary`.
