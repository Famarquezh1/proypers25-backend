# Cron de velas (Cloud Scheduler)

## Endpoints

- `POST /internal/cron/velas/predictions`
- `POST /internal/cron/velas/verifications`
- `POST /internal/cron/velas/learning`
- `POST /internal/cron/velas/audit`
- `POST /internal/cron/velas/full-cycle`

## Autenticación

Usa el header `x-cron-secret` con el valor de `CRON_SECRET`.

Ejemplo local:

```bash
curl -X POST https://<CLOUD_RUN_URL>/internal/cron/velas/predictions \
  -H "x-cron-secret: <CRON_SECRET>"
```

## Ejemplos de Cloud Scheduler (placeholders)

```bash
gcloud scheduler jobs create http velas-predictions \
  --schedule="* * * * *" \
  --uri="https://<CLOUD_RUN_URL>/internal/cron/velas/predictions" \
  --http-method=POST \
  --headers="x-cron-secret:<CRON_SECRET>"
```

```bash
gcloud scheduler jobs create http velas-verifications \
  --schedule="*/5 * * * *" \
  --uri="https://<CLOUD_RUN_URL>/internal/cron/velas/verifications" \
  --http-method=POST \
  --headers="x-cron-secret:<CRON_SECRET>"
```

```bash
gcloud scheduler jobs create http velas-learning \
  --schedule="0 * * * *" \
  --uri="https://<CLOUD_RUN_URL>/internal/cron/velas/learning" \
  --http-method=POST \
  --headers="x-cron-secret:<CRON_SECRET>"
```

```bash
gcloud scheduler jobs create http velas-audit \
  --schedule="0 2 * * *" \
  --uri="https://<CLOUD_RUN_URL>/internal/cron/velas/audit" \
  --http-method=POST \
  --headers="x-cron-secret:<CRON_SECRET>"
```

```bash
gcloud scheduler jobs create http velas-full-cycle \
  --schedule="*/10 * * * *" \
  --uri="https://<CLOUD_RUN_URL>/internal/cron/velas/full-cycle" \
  --http-method=POST \
  --headers="x-cron-secret:<CRON_SECRET>"
```
