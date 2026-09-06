'use strict';

/**
 * Shared-secret gate for the dashboard API.
 *
 * API Gateway has no authorizer and a `$default` catch-all route, so without
 * this check every route is reachable by anyone who learns the URL. Cloudflare
 * Access protects the dashboard *page*; it cannot protect this API, because
 * requests here go straight to AWS and never traverse Cloudflare.
 *
 * The Worker sends the secret as `X-Dashboard-Key`. We compare in constant time
 * and fail closed: a missing secret in the environment rejects everything rather
 * than silently allowing it.
 */

const { createHash, timingSafeEqual } = require('node:crypto');
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');

const sm = new SecretsManagerClient({});

const HEADER = 'x-dashboard-key';
const SECRET_ARN = process.env.DASHBOARD_KEY_SECRET_ARN;

// Module-level cache, same pattern as the Meraki key — survives warm invocations.
let _cachedKey = null;

async function getApiKey() {
    if (_cachedKey) return _cachedKey;
    if (!SECRET_ARN) return null;
    try {
        const resp = await sm.send(new GetSecretValueCommand({ SecretId: SECRET_ARN }));
        const parsed = JSON.parse(resp.SecretString);
        // An empty or absent value must not become a valid credential.
        _cachedKey = parsed.api_key || null;
        return _cachedKey;
    } catch (e) {
        // Between `terraform apply` and `put-secret-value` the secret exists
        // with no value, and Secrets Manager throws ResourceNotFoundException.
        // This throw would escape the handler's try block (the gate runs before
        // it), so API Gateway would answer 502 with the raw AWS message rather
        // than a clean 403. Unparseable JSON and throttling land here too.
        //
        // Returning null routes every one of these into the same fail-closed
        // path as an unset ARN: refuse, and say so in the log. Nothing is
        // cached, so the next invocation retries.
        console.error(`API_KEY_UNREADABLE ${e.name}: ${e.message}`);
        return null;
    }
}

/**
 * Constant-time string comparison.
 *
 * timingSafeEqual throws on length mismatch, and that throw would itself leak
 * length. Hashing both sides to a fixed 32 bytes removes the length channel and
 * lets one code path handle every input.
 */
function safeEqual(a, b) {
    const ha = createHash('sha256').update(String(a)).digest();
    const hb = createHash('sha256').update(String(b)).digest();
    return timingSafeEqual(ha, hb);
}

/** Header lookup that tolerates any casing — HTTP header names are case-insensitive. */
function readHeader(headers) {
    if (!headers) return null;
    for (const [name, value] of Object.entries(headers)) {
        if (name.toLowerCase() === HEADER) return value;
    }
    return null;
}

/**
 * Returns null when the request is authorized, or an API Gateway 403 response
 * when it is not. Callers must return that response without doing any work.
 */
async function checkApiKey(event) {
    const expected = await getApiKey();

    // Fail closed. A misconfigured secret must never mean "allow everyone".
    if (!expected) {
        console.error('API_KEY_NOT_CONFIGURED dashboard key secret missing or empty; rejecting');
        return forbidden();
    }

    const presented = readHeader(event?.headers);
    if (!presented || !safeEqual(presented, expected)) {
        console.warn(`AUTH_REJECTED ${event?.requestContext?.http?.method || '?'} ${event?.rawPath || '?'}`);
        return forbidden();
    }

    return null;
}

function forbidden() {
    return {
        statusCode: 403,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Forbidden' }),
    };
}

module.exports = { checkApiKey, HEADER, _resetCacheForTests: () => { _cachedKey = null; } };
