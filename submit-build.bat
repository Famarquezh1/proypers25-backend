@echo off
cd c:\Desarrollo\proypers25
echo Submitting Build 5...
call gcloud builds submit --async --config=cloudbuild.yaml
pause
