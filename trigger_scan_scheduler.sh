#!/bin/bash
# Cloud Scheduler automated scan generation trigger
# Called every 45 minutes by Cloud Scheduler

set -e

PROJECT_ID="proypers2025"
BACKEND_URL="https://proypers25-backend-518292923158.southamerica-west1.run.app"
CRON_SECRET="proypers25-cron-secret"

echo "[$(date +'%Y-%m-%d %H:%M:%S')] Starting automated scan generation..."

# Get current scan age
SCAN_STATUS=$(curl -s -H "x-cron-secret: ${CRON_SECRET}" "${BACKEND_URL}/api/diagnostico/spot-real-execution" | jq -r '.report.entry_diagnostic.latest_scan_age_minutes // "UNKNOWN"')

echo "Latest scan age: ${SCAN_STATUS} minutes"

# Generate fresh scan
cd /workspace/backend

echo "Generating fresh scan..."
node generate_scan.js

echo "[$(date +'%Y-%m-%d %H:%M:%S')] Scan generation completed successfully"
