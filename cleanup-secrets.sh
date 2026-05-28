#!/usr/bin/env bash
# Clean and reload secrets without exposing values
# Only shows status, NOT actual secret content

PROJECT_ID="proypers2025"

echo "[$(date)] Starting secret cleanup..."

# Function to safely reload a secret
reload_secret() {
    local SECRET_NAME=$1
    echo ""
    echo "Processing: $SECRET_NAME"

    # Get secret value (piped, not printed)
    gcloud secrets versions access latest --secret="$SECRET_NAME" --project "$PROJECT_ID" 2>/dev/null | \
    # Remove leading/trailing whitespace and add new version
    sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | \
    # Only create new version if different from previous
    {
        read cleaned_value
        if [ -n "$cleaned_value" ]; then
            echo -n "$cleaned_value" | gcloud secrets versions add "$SECRET_NAME" --project "$PROJECT_ID" --data-file=- > /dev/null 2>&1
            if [ $? -eq 0 ]; then
                echo "  ✓ Cleaned and reloaded (newline/spaces removed)"
            else
                echo "  ✗ Failed to reload"
            fi
        else
            echo "  ✗ Secret is empty"
        fi
    }
}

# Reload both secrets
reload_secret "binance-spot-api-key"
reload_secret "binance-spot-api-secret"

echo ""
echo "[$(date)] Secret cleanup complete"
echo "Test endpoint: curl https://proypers25-backend-h4put26qmq-tl.a.run.app/api/diagnostico/spot-real-preflight"
