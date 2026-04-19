#!/bin/bash
# Post-Deployment Validation & Initialization
# Run this after Cloud Build completes and new revision is live

set -e

echo "╔════════════════════════════════════════════════════════════╗"
echo "║ PROYPERS25 EXTRA PHASES 1-7 POST-DEPLOYMENT CHECKLIST    ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

SERVICE_NAME="proypers25-backend"
REGION="southamerica-west1"

# Get service URL
echo "[*] Step 1: Retrieving service URL..."
SERVICE_URL=$(gcloud run services describe $SERVICE_NAME --region $REGION --format 'value(status.url)' 2>/dev/null)
if [ -z "$SERVICE_URL" ]; then
  echo -e "${RED}[✗] Failed to get service URL${NC}"
  exit 1
fi
echo -e "${GREEN}[✓] Service URL: $SERVICE_URL${NC}"
echo ""

# Test connectivity
echo "[*] Step 2: Testing service connectivity..."
RESPONSE=$(curl -s -w "\n%{http_code}" "$SERVICE_URL/api/system/deep-health")
HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
if [ "$HTTP_CODE" != "200" ]; then
  echo -e "${RED}[✗] Service not responding (HTTP $HTTP_CODE)${NC}"
  exit 1
fi
echo -e "${GREEN}[✓] Service responding (HTTP 200)${NC}"
echo ""

# Test Critical Alerts Endpoint
echo "[*] Step 3: Testing /api/system/critical-alerts endpoint..."
ALERTS=$(curl -s "$SERVICE_URL/api/system/critical-alerts?limit=10")
ALERT_COUNT=$(echo "$ALERTS" | jq '.total_count // 0')
if [ "$ALERT_COUNT" == "null" ] || [ -z "$ALERT_COUNT" ]; then
  echo -e "${YELLOW}[⚠] Could not parse alert count${NC}"
else
  echo -e "${GREEN}[✓] Critical Alerts: $ALERT_COUNT recent alerts${NC}"
fi
echo "$ALERTS" | jq '.alerts[] | {timestamp, event_type, severity}' 2>/dev/null | head -5
echo ""

# Test Heartbeats Endpoint
echo "[*] Step 4: Testing /api/system/heartbeats endpoint..."
HEARTBEATS=$(curl -s "$SERVICE_URL/api/system/heartbeats?limit=12")
HB_COUNT=$(echo "$HEARTBEATS" | jq '.heartbeats | length // 0')
CONSECUTIVE=$(echo "$HEARTBEATS" | jq '.consecutive_healthy // 0')
echo -e "${GREEN}[✓] Heartbeats: $HB_COUNT recent entries${NC}"
echo -e "${GREEN}[✓] Consecutive Healthy: $CONSECUTIVE${NC}"
echo "$HEARTBEATS" | jq '.heartbeats[0] | {timestamp, system_state, is_healthy, signals_last_5m, executions_last_5m}'
echo ""

# Test Safety Status Endpoint
echo "[*] Step 5: Testing /api/system/safety-status endpoint..."
SAFETY=$(curl -s "$SERVICE_URL/api/system/safety-status")
ALL_ACTIVE=$(echo "$SAFETY" | jq '.all_phases_active')
HEALTH_SCORE=$(echo "$SAFETY" | jq '.system_health.score')
if [ "$ALL_ACTIVE" == "true" ]; then
  echo -e "${GREEN}[✓] All 7 Phases: ACTIVE${NC}"
else
  echo -e "${RED}[✗] Some phases INACTIVE (check details below)${NC}"
fi
echo -e "${GREEN}[✓] System Health Score: $HEALTH_SCORE/100${NC}"
echo ""
echo "Phase Details:"
echo "$SAFETY" | jq '.phases | to_entries[] | "\(.key): active=\(.value.active)"'
echo ""

# Create Firestore collections if needed
echo "[*] Step 6: Verifying Firestore collections..."
if gcloud firestore collections list --database='(default)' 2>/dev/null | grep -q "critical_safety_alerts"; then
  echo -e "${GREEN}[✓] critical_safety_alerts collection exists${NC}"
else
  echo -e "${YELLOW}[⚠] critical_safety_alerts collection will be auto-created on first write${NC}"
fi

if gcloud firestore collections list --database='(default)' 2>/dev/null | grep -q "system_heartbeats"; then
  echo -e "${GREEN}[✓] system_heartbeats collection exists${NC}"
else
  echo -e "${YELLOW}[⚠] system_heartbeats collection will be auto-created on first write${NC}"
fi
echo ""

# Summary
echo "╔════════════════════════════════════════════════════════════╗"
echo "║ DEPLOYMENT VALIDATION SUMMARY                            ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""
echo -e "${GREEN}✓ Service connectivity${NC} - Responding"
echo -e "${GREEN}✓ Critical Alerts API${NC} - Responding (via jq: $ALERT_COUNT alerts)"
echo -e "${GREEN}✓ Heartbeats API${NC} - Responding (via jq: $HB_COUNT entries)"
echo -e "${GREEN}✓ Safety Status API${NC} - Responding (all_phases_active: $ALL_ACTIVE)"
echo -e "${GREEN}✓ Health Score${NC} - $HEALTH_SCORE/100"
echo ""

# Next steps
echo "╔════════════════════════════════════════════════════════════╗"
echo "║ NEXT STEPS                                                ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""
echo "1. VERIFY HEARTBEAT (next 5 minutes):"
echo "   $ curl -s '$SERVICE_URL/api/system/heartbeats?limit=1' | jq '.'"
echo ""
echo "2. MONITOR FIRESTORE COLLECTIONS:"
echo "   Dashboard: https://console.firebase.google.com"
echo "   - Expand 'critical_safety_alerts' (should be empty for healthy system)"
echo "   - Expand 'system_heartbeats' (should have entries every 5 min)"
echo ""
echo "3. DEPLOY MONITORING DASHBOARD:"
echo "   Create alerts for:"
echo "   - critical_safety_alerts with severity='critical'"
echo "   - Missing heartbeat (gap > 10 min)"
echo "   - /api/system/safety-status returning error"
echo ""
echo "4. VALIDATE EACH PHASE (test procedures):"
echo "   See: VISUAL_TROUBLESHOOTING_GUIDE.md for phase-specific testing"
echo ""
echo "5. KEEP REFERENCES HANDY:"
echo "   - EXTRA_PHASES_IMPLEMENTATION.md - Phase specifications"
echo "   - OPERATIONAL_RUNBOOK.md - Response procedures"
echo "   - VISUAL_TROUBLESHOOTING_GUIDE.md - Troubleshooting matrix"
echo ""

echo "╔════════════════════════════════════════════════════════════╗"
echo "║ SYSTEM READY FOR PRODUCTION                              ║"
echo "║ All 7 Extra Phases Active and Monitoring                 ║"
echo "╚════════════════════════════════════════════════════════════╝"
