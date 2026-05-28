/**
 * Diagnose secret format without exposing values
 * Safe validation script - NO secrets printed
 */

const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');

async function diagnoseSecrets() {
    const PROJECT_ID = 'proypers2025';
    const client = new SecretManagerServiceClient();

    const secrets = ['binance-spot-api-key', 'binance-spot-api-secret'];

    for (const secretName of secrets) {
        try {
            const resourceName = client.secretVersionPath(PROJECT_ID, secretName, 'latest');
            const [version] = await client.accessSecretVersion({ name: resourceName });

            let value = null;
            if (version.payload && version.payload.data) {
                value = typeof version.payload.data === 'string' ?
                    version.payload.data :
                    version.payload.data.toString('utf8');
            } else if (version.payload) {
                value = version.payload.toString('utf8');
            }

            if (!value) {
                console.log(`[${secretName}] ❌ EMPTY`);
                continue;
            }

            // Safely analyze format without printing value
            const original_length = value.length;
            const trimmed = value.trim();
            const trimmed_length = trimmed.length;
            const has_newlines = /[\n\r]/.test(value);
            const has_spaces = /[ \t]/.test(value);
            const has_quotes = /["'`]/.test(value);
            const has_other_special = /[^a-zA-Z0-9_-]/.test(trimmed);
            const starts_with_space = /^\s/.test(value);
            const ends_with_space = /\s$/.test(value);

            console.log(`\n[${secretName}]`);
            console.log(`  Original length: ${original_length}`);
            console.log(`  Trimmed length: ${trimmed_length}`);
            console.log(`  Whitespace removed: ${original_length - trimmed_length} chars`);
            console.log(`  Has newlines (\\n\\r): ${has_newlines ? '❌ YES' : '✓ NO'}`);
            console.log(`  Has spaces/tabs: ${has_spaces ? '❌ YES' : '✓ NO'}`);
            console.log(`  Has quotes: ${has_quotes ? '❌ YES' : '✓ NO'}`);
            console.log(`  Starts with space: ${starts_with_space ? '❌ YES' : '✓ NO'}`);
            console.log(`  Ends with space: ${ends_with_space ? '❌ YES' : '✓ NO'}`);
            console.log(`  Has special chars (not alphanumeric, _, -): ${has_other_special ? '❌ YES' : '✓ NO'}`);
            console.log(`  Status: ${trimmed && !has_newlines && !has_spaces && !has_quotes && !has_other_special ? '✅ VALID FORMAT' : '⚠️ NEEDS RELOAD'}`);

        } catch (error) {
            console.log(`[${secretName}] ❌ ERROR: ${error.message}`);
        }
    }
}

diagnoseSecrets().catch(console.error);