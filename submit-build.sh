#!/bin/bash
cd /c/Desarrollo/proypers25
echo "Submitting Build 5 manually..."
gcloud builds submit --async --config=cloudbuild.yaml 2>&1 | head -20
