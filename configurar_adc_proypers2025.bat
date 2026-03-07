@echo off
echo === REVOCANDO CREDENCIALES ANTIGUAS (ADC) ===
gcloud auth application-default revoke --quiet

echo.
echo === INICIANDO AUTENTICACIÓN CON TU CUENTA ===
gcloud auth application-default login

echo.
echo === CONFIGURANDO PROYECTO DE CUOTA ===
gcloud auth application-default set-quota-project proypers2025-465001

echo.
echo ✅ Configuración completada. Ya puedes usar Google APIs con tu proyecto "proypers2025-465001".
pause
