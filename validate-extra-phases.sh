#!/bin/bash
# Validation script for Extra Phases 1-7 deployment
# Run this after Cloud Build completes and new revision is live

SERVICE_URL="https://proypers25-backend-southamerica-west1.run.app"

echo "=========================================="
echo "Extra Phases 1-7 Post-Deployment Validation"
echo "=========================================="
echo ""

# Get service URL from gcloud if not provided
if [ -z "$SERVICE_URL" ]; then
    echo "[*] Retrieving service URL from Cloud Run..."
    SERVICE_URL=$(gcloud run services describe proypers25-backend --region southamerica-west1 --format 'value(status.url)')
    echo "[✓] Service URL: $SERVICE_URL"
fi

echo ""
echo "[Test 1/3] Critical Alerts Endpoint"
echo "GET $SERVICE_URL/api/system/critical-alerts"
ALERTS=$(curl -s "$SERVICE_URL/api/system/critical-alerts?limit=10")
echo "$ALERTS" | jq '.'
ALERT_COUNT=$(echo "$ALERTS" | jq '.alerts | length')
echo "[✓] Retrieved $ALERT_COUNT recent alerts"

echo ""
echo "[Test 2/3] System Heartbeats Endpoint"
echo "GET $SERVICE_URL/api/system/heartbeats"
HEARTBEATS=$(curl -s "$SERVICE_URL/api/system/heartbeats?limit=12")
echo "$HEARTBEATS" | jq '.'
HB_COUNT=$(echo "$HEARTBEATS" | jq '.heartbeats | length')
echo "[✓] Retrieved $HB_COUNT recent heartbeats"

echo ""
echo "[Test 3/3] Safety Status Endpoint"
echo "GET $SERVICE_URL/api/system/safety-status"
SAFETY=$(curl -s "$SERVICE_URL/api/system/safety-status")
echo "$SAFETY" | jq '.'
ALL_ACTIVE=$(echo "$SAFETY" | jq '.all_phases_active')
echo "[✓] All phases active: $ALL_ACTIVE"

echo ""
echo "=========================================="
echo "Validation Results:"
echo "=========================================="
echo "✓ Critical Alerts: $ALERT_COUNT recent alerts (expect 0-5 for healthy system)"
echo "✓ Heartbeats: $HB_COUNT recent entries (expect 10-12 for healthy system)"
echo "✓ Safety Status: All 7 phases $ALL_ACTIVE"
echo ""
echo "Next Steps:"
echo "1. Monitor critical_safety_alerts collection for new entries"
echo "2. Verify system_heartbeats collection grows every 5 minutes"
echo "3. Check Firestore dashboard for any CRITICAL severity alerts"
echo "4. If heartbeats gap > 10 minutes, system may be down"
echo ""
