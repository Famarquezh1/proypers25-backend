/**
 * Secret Manager Integration for Binance Spot Real Execution
 *
 * Secure credential management using Google Secret Manager.
 * - No hardcoded secrets
 * - No secret values logged
 * - No secret values in error messages
 * - Memory caching per process
 * - Clear error messages without exposing values
 */

const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');

const PROJECT_ID = process.env.GCP_PROJECT || 'proypers2025';
const SECRET_CACHE = {};
const CACHE_TTL_MS = 3600000; // 1 hour

/**
 * Get secret value from Google Secret Manager
 * @param {string} secretName - Secret name (e.g., 'binance-spot-api-key')
 * @returns {Promise<string>} Secret value
 */
async function getSecretValue(secretName) {
    // Check cache first
    if (SECRET_CACHE[secretName]) {
        const { value, expiresAt } = SECRET_CACHE[secretName];
        if (Date.now() < expiresAt) {
            return value;
        }
        delete SECRET_CACHE[secretName];
    }

    try {
        const client = new SecretManagerServiceClient();
        const resourceName = client.secretVersionPath(PROJECT_ID, secretName, 'latest');

        const [version] = await client.accessSecretVersion({ name: resourceName });

        // Extract secret value - try multiple paths
        let secretValue = null;

        // Try standard path: version.payload.data (Buffer or string)
        if (version.payload && version.payload.data) {
            secretValue = typeof version.payload.data === 'string' ?
                version.payload.data :
                version.payload.data.toString('utf8');
        }
        // Try alternate path: version.payload as Buffer/string
        else if (version.payload) {
            if (typeof version.payload === 'string') {
                secretValue = version.payload;
            } else if (Buffer.isBuffer(version.payload)) {
                secretValue = version.payload.toString('utf8');
            } else if (version.payload.toString) {
                secretValue = version.payload.toString('utf8');
            }
        }

        if (!secretValue) {
            throw new Error('BINANCE_SPOT_SECRET_MISSING');
        }

        // AGGRESSIVE CLEANING: Remove ALL non-printable characters and whitespace
        // This handles null bytes, BOM markers, control chars, etc.
        secretValue = secretValue
            // Remove BOM markers
            .replace(/^\uFEFF/, '')
            // Remove all control characters and non-ASCII
            .replace(/[\x00-\x1F\x7F-\x9F]/g, '')
            // Remove all whitespace
            .trim();

        if (!secretValue || secretValue === '') {
            throw new Error('BINANCE_SPOT_SECRET_MISSING');
        }

        // Validate format for API credentials
        if (secretName.includes('api-key') || secretName.includes('api-secret')) {
            // After cleaning, should ONLY have alphanumeric, dash, underscore
            if (!/^[a-zA-Z0-9_-]+$/.test(secretValue)) {
                console.error(`[SECRET_MANAGER] Secret ${secretName} contains invalid format for Binance API credentials`);
                throw new Error('BINANCE_SPOT_SECRET_FORMAT_INVALID');
            }

            // Minimum length check for Binance keys
            if (secretValue.length < 20) {
                console.error(`[SECRET_MANAGER] Secret ${secretName} is too short (${secretValue.length} chars)`);
                throw new Error('BINANCE_SPOT_SECRET_FORMAT_INVALID');
            }
        }

        // Cache the secret
        SECRET_CACHE[secretName] = {
            value: secretValue,
            expiresAt: Date.now() + CACHE_TTL_MS
        };

        return secretValue;
    } catch (error) {
        // Parse error for specific handling
        if (error.message.includes('BINANCE_SPOT_SECRET_FORMAT_INVALID')) {
            throw error;
        }
        if (error.code === 3 || error.message.includes('NOT_FOUND')) {
            throw new Error('BINANCE_SPOT_SECRET_MISSING');
        }
        if (error.code === 7 || error.message.includes('PERMISSION_DENIED')) {
            throw new Error('BINANCE_SPOT_SECRET_ACCESS_DENIED');
        }
        throw new Error(`BINANCE_SPOT_SECRET_ERROR: ${error.code || 'unknown'}`);
    }
}

/**
 * Get Binance Spot API credentials
 * @returns {Promise<{apiKey: string, apiSecret: string}>} API credentials
 */
async function getBinanceSpotCredentials() {
    try {
        const [apiKey, apiSecret] = await Promise.all([
            getSecretValue('binance-spot-api-key'),
            getSecretValue('binance-spot-api-secret')
        ]);

        if (!apiKey || !apiSecret) {
            throw new Error('BINANCE_SPOT_SECRET_MISSING');
        }

        return { apiKey, apiSecret };
    } catch (error) {
        // Re-throw without exposing secret values
        if (error.message.includes('BINANCE_SPOT_SECRET')) {
            throw error;
        }
        throw new Error(`BINANCE_SPOT_CREDENTIALS_FAILED: ${error.message}`);
    }
}

/**
 * Check if credentials are available (without returning them)
 * @returns {Promise<{present: boolean, accessible: boolean, error: string|null}>}
 */
async function checkBinanceSpotCredentials() {
    try {
        const client = new SecretManagerServiceClient();

        // Check API key secret
        let apiKeyPresent = false;
        let apiKeyAccessible = false;
        let apiKeyError = null;

        try {
            const apiKeyResource = client.secretVersionPath(PROJECT_ID, 'binance-spot-api-key', 'latest');
            const [apiKeyVersion] = await client.accessSecretVersion({ name: apiKeyResource });
            if (apiKeyVersion && apiKeyVersion.payload) {
                apiKeyPresent = true;
                apiKeyAccessible = true;
            }
        } catch (error) {
            if (error.code === 3 || error.message.includes('NOT_FOUND')) {
                apiKeyError = 'NOT_FOUND';
            } else if (error.code === 7 || error.message.includes('PERMISSION_DENIED')) {
                apiKeyError = 'PERMISSION_DENIED';
            } else {
                apiKeyError = 'UNKNOWN_ERROR';
            }
            apiKeyPresent = error.code !== 3;
            apiKeyAccessible = error.code !== 7;
        }

        // Check API secret
        let apiSecretPresent = false;
        let apiSecretAccessible = false;
        let apiSecretError = null;

        try {
            const apiSecretResource = client.secretVersionPath(PROJECT_ID, 'binance-spot-api-secret', 'latest');
            const [apiSecretVersion] = await client.accessSecretVersion({ name: apiSecretResource });
            if (apiSecretVersion && apiSecretVersion.payload) {
                apiSecretPresent = true;
                apiSecretAccessible = true;
            }
        } catch (error) {
            if (error.code === 3 || error.message.includes('NOT_FOUND')) {
                apiSecretError = 'NOT_FOUND';
            } else if (error.code === 7 || error.message.includes('PERMISSION_DENIED')) {
                apiSecretError = 'PERMISSION_DENIED';
            } else {
                apiSecretError = 'UNKNOWN_ERROR';
            }
            apiSecretPresent = error.code !== 3;
            apiSecretAccessible = error.code !== 7;
        }

        return {
            api_key_present: apiKeyPresent,
            api_key_accessible: apiKeyAccessible,
            api_key_error: apiKeyError,
            api_secret_present: apiSecretPresent,
            api_secret_accessible: apiSecretAccessible,
            api_secret_error: apiSecretError,
            both_present: apiKeyPresent && apiSecretPresent,
            both_accessible: apiKeyAccessible && apiSecretAccessible
        };
    } catch (error) {
        console.error('[SECRET_MANAGER] Failed to check credentials:', error.code || error.message);
        return {
            api_key_present: false,
            api_key_accessible: false,
            api_key_error: 'CHECK_FAILED',
            api_secret_present: false,
            api_secret_accessible: false,
            api_secret_error: 'CHECK_FAILED',
            both_present: false,
            both_accessible: false
        };
    }
}

/**
 * Clear secret cache (for testing or credential rotation)
 */
function clearSecretCache() {
    Object.keys(SECRET_CACHE).forEach(key => {
        delete SECRET_CACHE[key];
    });
}

module.exports = {
    getSecretValue,
    getBinanceSpotCredentials,
    checkBinanceSpotCredentials,
    clearSecretCache
};