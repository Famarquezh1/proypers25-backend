:: despliega-ligero.bat
@echo off
set PROJECT=proypers2025
set REGION=southamerica-west1
set IMAGE=southamerica-west1-docker.pkg.dev/%PROJECT%/backend-repo/backend-image:latest

echo Desplegando la última imagen ya existente...
gcloud run deploy proypers25-backend ^
  --project=%PROJECT% ^
  --image %IMAGE% ^
  --platform managed ^
  --region %REGION% ^
  --allow-unauthenticated || (
    echo ERROR: El deploy falló
    exit /b 1
  )

echo Verificando /api/velas/disponibles...
for /f "delims=" %%A in ('curl -s -o nul -w "%%{http_code}" https://proypers25-backend-518292923158.southamerica-west1.run.app/api/velas/disponibles') do set STATUS=%%A
if "%STATUS%" == "200" (
  echo OK: /api/velas/disponibles responde
) else (
  echo ERROR: /api/velas/disponibles respondió %STATUS%
  exit /b 1
)
