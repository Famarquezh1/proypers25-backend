#!/usr/bin/env bash

# Production Hardening v3 - Monitoring & Verification Guide

echo "==================================="
echo "PRODUCTION HARDENING v3"
echo "Monitoring & Verification Guide"
echo "==================================="
echo ""

# Get service info
SERVICE_URL=$(gcloud run services list \
  --filter="name=proypers25-backend" \
  --format='value(URL)' \
  --region=southamerica-west1)

echo "Service URL: $SERVICE_URL"
echo ""

# SECTION 1: System State
echo "SECTION 1: Current System State"
echo "================================"
echo ""
echo "Getting deep-health status..."

HEALTH=$(curl -s "$SERVICE_URL/api/system/deep-health")
echo "$HEALTH" | jq '.' || echo "Could not retrieve health status"
echo ""

# SECTION 2: Firestore Collections
echo ""
echo "SECTION 2: Firestore Collections Status"
echo "========================================"
echo ""

echo "Checking system_diagnostics collection..."
gcloud firestore documents list --collection-id=system_diagnostics --limit=5

echo ""
echo "Checking anti_stall_events collection..."
gcloud firestore documents list --collection-id=anti_stall_events --limit=5

echo ""
echo "Checking autocalibration_logs collection (last 3)..."
gcloud firestore documents list --collection-id=autocalibration_logs --limit=3

echo ""

# SECTION 3: Cloud Logs
echo "SECTION 3: Recent Cloud Logs"
echo "=============================="
echo ""
echo "Fetching last 20 log entries..."

gcloud logging read \
  'resource.type="cloud_run_revision" AND resource.labels.service_name="proypers25-backend"' \
  --limit=20 \
  --format='json' | jq '.[] | {timestamp: .timestamp, severity: .severity, message: .textPayload}' || echo "No logs available"

echo ""

# SECTION 4: API Endpoints
echo "SECTION 4: Testing API Endpoints"
echo "=================================="
echo ""

echo "1. Testing /api/system/deep-health..."
curl -s "$SERVICE_URL/api/system/deep-health" | jq '.system_state, .health_score, .data_status' || echo "FAILED"

echo ""
echo "2. Testing /api/system/deep-health/detailed..."
curl -s "$SERVICE_URL/api/system/deep-health/detailed" | jq '.system_state, .recent_diagnostics | length, .recent_anti_stall_events | length' || echo "FAILED"

echo ""
echo "3. Testing /api/system/deep-health/timeline..."
curl -s "$SERVICE_URL/api/system/deep-health/timeline" | jq '.total_events, .timeline | length' || echo "FAILED"

echo ""
echo "4. Testing /api/system/runtime-calibration-health..."
curl -s "$SERVICE_URL/api/system/runtime-calibration-health" | jq '.system_state, .enabled, .last_cycle' || echo "FAILED"

echo ""

# SECTION 5: Health Checks
echo "SECTION 5: Health Checks"
echo "========================"
echo ""

echo "Checking if system_state is one of: healthy, degraded, stalled, paused"
STATE=$(curl -s "$SERVICE_URL/api/system/deep-health" | jq -r '.system_state // "unknown"')
echo "Current state: $STATE"

SCORE=$(curl -s "$SERVICE_URL/api/system/deep-health" | jq '.health_score // 0')
echo "Health score: $SCORE/100"

if [[ "$STATE" == "healthy" ]]; then
  echo "Status: OK - System is operating normally"
elif [[ "$STATE" == "degraded" ]]; then
  echo "Status: WARNING - System is degraded, check diagnostics"
elif [[ "$STATE" == "stalled" ]]; then
  echo "Status: CRITICAL - System is stalled, immediate action needed"
elif [[ "$STATE" == "paused" ]]; then
  echo "Status: INFO - System is intentionally paused"
else
  echo "Status: UNKNOWN - Could not determine state"
fi

echo ""
echo "==================================="
echo "Monitoring Complete"
echo "==================================="
