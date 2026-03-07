#!/usr/bin/env bash
set -euo pipefail

if ! command -v gcloud >/dev/null 2>&1; then
  echo "gcloud CLI not found. Install it first: https://cloud.google.com/sdk/docs/install"
  exit 1
fi

read -r -p "Cloud Run URL (e.g. https://service-xyz.a.run.app): " CLOUD_RUN_URL
CLOUD_RUN_URL="${CLOUD_RUN_URL%/}"
if [ -z "${CLOUD_RUN_URL}" ]; then
  echo "CLOUD_RUN_URL is required."
  exit 1
fi

read -r -p "CRON_SECRET: " CRON_SECRET
if [ -z "${CRON_SECRET}" ]; then
  echo "CRON_SECRET is required."
  exit 1
fi

read -r -p "Region [southamerica-west1]: " REGION
REGION="${REGION:-southamerica-west1}"

PROJECT="$(gcloud config get-value project 2>/dev/null | tr -d '\r')"
if [ -z "${PROJECT}" ] || [ "${PROJECT}" = "(unset)" ]; then
  read -r -p "GCP project id: " PROJECT
fi
if [ -z "${PROJECT}" ]; then
  echo "Project is required."
  exit 1
fi

CREATED_JOBS=()

ensure_job() {
  local name="$1"
  local schedule="$2"
  local path="$3"
  local uri="${CLOUD_RUN_URL}${path}"
  local action="created"

  if gcloud scheduler jobs describe "${name}" --location "${REGION}" --project "${PROJECT}" >/dev/null 2>&1; then
    gcloud scheduler jobs update http "${name}" \
      --location "${REGION}" \
      --project "${PROJECT}" \
      --schedule "${schedule}" \
      --uri "${uri}" \
      --http-method=POST \
      --headers=x-cron-secret=${CRON_SECRET}
    action="updated"
  else
    gcloud scheduler jobs create http "${name}" \
      --location "${REGION}" \
      --project "${PROJECT}" \
      --schedule "${schedule}" \
      --uri "${uri}" \
      --http-method=POST \
      --headers=x-cron-secret=${CRON_SECRET}
  fi

  CREATED_JOBS+=("${name} (${action})")
}

ensure_job "velas-full-cycle" "*/5 * * * *" "/internal/cron/velas/full-cycle"
ensure_job "velas-audit" "0 * * * *" "/internal/cron/velas/audit"
ensure_job "velas-prealerts" "*/2 * * * *" "/internal/cron/velas/prealerts"

read -r -p "Create separate predict/verification/learning jobs? [y/N]: " ADD_EXTRA
case "${ADD_EXTRA}" in
  y|Y|yes|YES)
    ensure_job "velas-predict" "*/2 * * * *" "/internal/cron/velas/predictions"
    ensure_job "velas-verifications" "1-59/2 * * * *" "/internal/cron/velas/verifications"
    ensure_job "velas-learning" "*/4 * * * *" "/internal/cron/velas/learning"
    ;;
esac

echo ""
echo "Jobs created/updated:"
for job in "${CREATED_JOBS[@]}"; do
  echo "  - ${job}"
done

echo ""
echo "Suggested commands:"
echo "  gcloud scheduler jobs list --location \"${REGION}\" --project \"${PROJECT}\""
echo "  gcloud scheduler jobs run velas-full-cycle --location \"${REGION}\" --project \"${PROJECT}\""
echo "  gcloud logging read \"resource.type=cloud_scheduler_job AND resource.labels.job_id=velas-full-cycle\" --limit 20 --project \"${PROJECT}\""
echo "  gcloud scheduler jobs pause velas-full-cycle --location \"${REGION}\" --project \"${PROJECT}\""
echo "  gcloud scheduler jobs delete velas-full-cycle --location \"${REGION}\" --project \"${PROJECT}\""
