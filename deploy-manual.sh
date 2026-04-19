#!/bin/bash
# MANUAL DEPLOYMENT SCRIPT
# Run this when Cloud Build is stuck or unreachable
# Usage: bash deploy-manual.sh

set -e

PROJECT="proypers2025"
SERVICE="proypers25-backend"
REGION="southamerica-west1"
REGISTRY="southamerica-west1-docker.pkg.dev"
REPO="backend-repo"
IMAGE_NAME="backend-image"

echo "════════════════════════════════════════════════════════════"
echo "MANUAL DEPLOYMENT - 7 Extra Phases Production Deploy"
echo "════════════════════════════════════════════════════════════"
echo ""
echo "Project: $PROJECT"
echo "Service: $SERVICE"
echo "Region: $REGION"
echo "Registry: $REGISTRY"
echo ""

# Step 1: Verify we're logged in
echo "Step 1: Verifying GCP authentication..."
if ! gcloud auth list --filter=status:ACTIVE --format="value(account)" | grep -q .; then
    echo "ERROR: Not authenticated to GCP"
    echo "Run: gcloud auth login"
    exit 1
fi
echo "✓ Authenticated"
echo ""

# Step 2: Set project
echo "Step 2: Setting GCP project..."
gcloud config set project $PROJECT
echo "✓ Project set to $PROJECT"
echo ""

# Step 3: Check current service status
echo "Step 3: Checking current Cloud Run service..."
gcloud run services describe $SERVICE \
    --region $REGION \
    --format="table(status.conditions[0].message, status.url)" \
    2>/dev/null || {
    echo "✗ Service not found. Make sure service exists."
    exit 1
}
echo "✓ Service found"
echo ""

# Step 4: Check if image exists
echo "Step 4: Checking for built Docker images..."
IMAGE_EXISTS=$(gcloud artifacts docker images list $REGISTRY/$PROJECT/$REPO \
    --format='value(image)' \
    --limit=1 | grep -c . || true)

if [ $IMAGE_EXISTS -eq 0 ]; then
    echo "✗ No Docker images found in registry"
    echo "Need to build image first:"
    echo "  cd backend && docker build -t backend:latest ."
    echo "  docker tag backend:latest $REGISTRY/$PROJECT/$REPO/$IMAGE_NAME:latest"
    echo "  docker push $REGISTRY/$PROJECT/$REPO/$IMAGE_NAME:latest"
    exit 1
fi
echo "✓ Docker images found in registry"
echo ""

# Step 5: Deploy
echo "Step 5: Deploying to Cloud Run..."
echo "Command: gcloud run deploy $SERVICE --image $REGISTRY/$PROJECT/$REPO/$IMAGE_NAME:latest --region $REGION --allow-unauthenticated"
echo ""

gcloud run deploy $SERVICE \
    --image "$REGISTRY/$PROJECT/$REPO/$IMAGE_NAME:latest" \
    --region $REGION \
    --allow-unauthenticated \
    --memory 2Gi \
    --cpu 2 \
    --timeout 3600 \
    --max-instances 100 \
    --min-instances 1 \
    --platform managed \
    --quiet

echo ""
echo "════════════════════════════════════════════════════════════"
echo "✓ DEPLOYMENT COMPLETE"
echo "════════════════════════════════════════════════════════════"
echo ""
echo "Service deployed. Testing endpoints..."
echo ""

# Step 6: Test endpoints
SERVICE_URL=$(gcloud run services describe $SERVICE --region $REGION --format='value(status.url)')
echo "Service URL: $SERVICE_URL"
echo ""

echo "Testing new endpoints (should return 200 OK):"
echo ""

echo "1. Testing /api/system/critical-alerts"
curl -s -w "Status: %{http_code}\n" "$SERVICE_URL/api/system/critical-alerts" | head -3
echo ""

echo "2. Testing /api/system/heartbeats"
curl -s -w "Status: %{http_code}\n" "$SERVICE_URL/api/system/heartbeats" | head -3
echo ""

echo "3. Testing /api/system/safety-status"
curl -s -w "Status: %{http_code}\n" "$SERVICE_URL/api/system/safety-status" | head -3
echo ""

echo "════════════════════════════════════════════════════════════"
echo "If endpoints return status 200, deployment was successful!"
echo "════════════════════════════════════════════════════════════"
