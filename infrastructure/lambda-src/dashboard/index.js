'use strict';

/**
 * Dashboard API — Lambda Handler
 *
 * Routes:
 *   GET  /clients                   — Full DynamoDB Scan, sorted by ExpirationTimestamp asc
 *   POST /clients/{clientId}/extend — Extend one client via Meraki + update DynamoDB
 *   POST /clients/bulk-extend       — Extend many clients in parallel
 *
 * The Meraki API key is fetched from AWS Secrets Manager and cached in module
 * scope so warm Lambda invocations skip the Secrets Manager call entirely.
 *
 * All DynamoDB updates use ADD for RenewalCount (never resets to 0) and SET
 * for timestamps. Records are never deleted.
 */

const { DynamoDBClient }                                     = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, ScanCommand, GetCommand,
        UpdateCommand, DeleteCommand }                       = require('@aws-sdk/lib-dynamodb');
const { SecretsManagerClient, GetSecretValueCommand }        = require('@aws-sdk/client-secrets-manager');

// ── AWS clients ───────────────────────────────────────────────────────────────

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
});
const sm = new SecretsManagerClient({});

// ── Config ────────────────────────────────────────────────────────────────────

const TABLE_NAME        = process.env.DYNAMODB_TABLE_NAME;
const SECRET_ARN        = process.env.MERAKI_SECRET_ARN;
const MERAKI_NETWORK_ID = process.env.MERAKI_NETWORK_ID;
const MERAKI_BASE       = 'https://api.meraki.com/api/v1';

// ── Module-level secret cache (survives warm Lambda invocations) ──────────────

let _cachedApiKey = null;

async function getMerakiApiKey() {
    if (_cachedApiKey) return _cachedApiKey;
    const resp = await sm.send(new GetSecretValueCommand({ SecretId: SECRET_ARN }));
    _cachedApiKey = JSON.parse(resp.SecretString).api_key;
    return _cachedApiKey;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getSsidNumber(ssidName) {
    const map = JSON.parse(process.env.SSID_MAP || '{"ICS-Staff":"1","ICS-HS":"7"}');
    return map[ssidName] ?? null;
}

/**
 * Converts a Meraki UTC timestamp ("2026-04-24 04:49:29 UTC") to SGT ISO 8601.
 * No external libraries — pure UTC offset arithmetic.
 */
function merakiUtcToSGT(utcStr) {
    const normalized = utcStr.replace(' UTC', '').replace(' ', 'T') + 'Z';
    const date       = new Date(normalized);
    const sgt        = new Date(date.getTime() + 8 * 60 * 60 * 1000);
    const pad        = n => String(n).padStart(2, '0');
    return (
        `${sgt.getUTCFullYear()}-${pad(sgt.getUTCMonth() + 1)}-${pad(sgt.getUTCDate())}` +
        `T${pad(sgt.getUTCHours())}:${pad(sgt.getUTCMinutes())}:${pad(sgt.getUTCSeconds())}+08:00`
    );
}

// ── DynamoDB operations ───────────────────────────────────────────────────────

async function getAllClients() {
    const items = [];
    let lastKey;

    do {
        const resp = await dynamo.send(new ScanCommand({
            TableName: TABLE_NAME,
            ExclusiveStartKey: lastKey,
        }));
        if (resp.Items) items.push(...resp.Items);
        lastKey = resp.LastEvaluatedKey;
    } while (lastKey);

    // Sort soonest-to-expire first so the dashboard shows urgent items at the top
    items.sort((a, b) => {
        const ta = a.ExpirationTimestamp ? new Date(a.ExpirationTimestamp).getTime() : 0;
        const tb = b.ExpirationTimestamp ? new Date(b.ExpirationTimestamp).getTime() : 0;
        return ta - tb;
    });

    return items;
}

async function getClient(clientId) {
    const resp = await dynamo.send(new GetCommand({
        TableName: TABLE_NAME,
        Key: { ClientID: clientId },
    }));
    return resp.Item ?? null;
}

/**
 * Updates the expiration fields after a successful Meraki renewal.
 * Uses ADD for RenewalCount so it increments atomically from any starting value.
 * SET and ADD are space-separated — a comma between them is a DynamoDB syntax error.
 */
async function updateExpiration(clientId, newExpiration, lastRenewed) {
    await dynamo.send(new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { ClientID: clientId },
        UpdateExpression:
            'SET ExpirationTimestamp = :exp, LastUpdated = :lu, LastRenewed = :lr ' +
            'ADD RenewalCount :one',
        ExpressionAttributeValues: {
            ':exp':  newExpiration,
            ':lu':   new Date().toISOString(),
            ':lr':   lastRenewed,
            ':one':  1,
        },
    }));
}

async function deleteOne(clientId) {
    await dynamo.send(new DeleteCommand({
        TableName: TABLE_NAME,
        Key: { ClientID: clientId },
    }));
}

// ── Core business logic ───────────────────────────────────────────────────────

/**
 * Extends one client's Meraki splash authorization and updates DynamoDB.
 * Throws on any failure so the caller can decide how to handle it.
 */
async function extendOne(clientId) {
    const client = await getClient(clientId);
    if (!client) throw new Error(`Client not found: ${clientId}`);

    // Meraki accepts both its internal ID and MAC address as the client identifier
    const merakiId = client.MerakiClientID || client.ClientID;
    const ssid     = client.SSID || 'ICS-Staff';
    const ssidNum  = getSsidNumber(ssid);

    if (!ssidNum) {
        throw new Error(`No SSID number mapping for "${ssid}". Update the SSID_MAP variable.`);
    }

    const apiKey = await getMerakiApiKey();
    const url    = `${MERAKI_BASE}/networks/${MERAKI_NETWORK_ID}/clients/${merakiId}/splashAuthorizationStatus`;

    console.log(`Extending ${clientId} on SSID "${ssid}" (number ${ssidNum})`);

    const res = await fetch(url, {
        method:  'PUT',
        headers: {
            Authorization:  `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            Accept:         'application/json',
        },
        body: JSON.stringify({ ssids: { [ssidNum]: { isAuthorized: true } } }),
    });

    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Meraki API ${res.status}: ${text}`);
    }

    const data     = await res.json();
    const ssidData = data.ssids?.[ssidNum];

    if (!ssidData?.isAuthorized)  throw new Error('Meraki did not confirm authorization in response');
    if (!ssidData.expiresAt)      throw new Error('Meraki response missing expiresAt');
    if (!ssidData.authorizedAt)   throw new Error('Meraki response missing authorizedAt');

    const newExpiration = merakiUtcToSGT(ssidData.expiresAt);
    const lastRenewed   = merakiUtcToSGT(ssidData.authorizedAt);

    await updateExpiration(clientId, newExpiration, lastRenewed);

    console.log(`Extended ${clientId}: expires ${newExpiration}`);
    return { clientId, newExpiration, lastRenewed };
}

// ── HTTP response helpers ─────────────────────────────────────────────────────

const jsonHeaders = { 'Content-Type': 'application/json' };

function ok(body) {
    return { statusCode: 200, headers: jsonHeaders, body: JSON.stringify(body) };
}

function clientError(message) {
    return { statusCode: 400, headers: jsonHeaders, body: JSON.stringify({ error: message }) };
}

function notFound() {
    return { statusCode: 404, headers: jsonHeaders, body: JSON.stringify({ error: 'Not found' }) };
}

function serverError(message) {
    return { statusCode: 500, headers: jsonHeaders, body: JSON.stringify({ error: message }) };
}

// ── Lambda handler ────────────────────────────────────────────────────────────

exports.handler = async (event) => {
    const method  = event.requestContext?.http?.method || 'UNKNOWN';
    const rawPath = event.rawPath || '/';

    console.log(`${method} ${rawPath}`);

    try {
        // ── GET /clients ──────────────────────────────────────────────────────
        if (method === 'GET' && rawPath === '/clients') {
            const clients = await getAllClients();
            return ok(clients);
        }

        // ── POST /clients/{clientId}/extend ───────────────────────────────────
        const extendMatch = rawPath.match(/^\/clients\/(.+)\/extend$/);
        if (method === 'POST' && extendMatch) {
            const clientId = decodeURIComponent(extendMatch[1]);
            const result   = await extendOne(clientId);
            return ok({ success: true, ...result });
        }

        // ── POST /clients/bulk-extend ─────────────────────────────────────────
        if (method === 'POST' && rawPath === '/clients/bulk-extend') {
            const body = typeof event.body === 'string'
                ? JSON.parse(event.body)
                : (event.body ?? {});

            const { clientIds } = body;
            if (!Array.isArray(clientIds) || clientIds.length === 0) {
                return clientError('clientIds must be a non-empty array');
            }

            console.log(`Bulk extending ${clientIds.length} client(s)`);

            const results   = await Promise.allSettled(clientIds.map(id => extendOne(id)));
            const succeeded = [];
            const failed    = [];

            results.forEach((r, i) => {
                if (r.status === 'fulfilled') {
                    succeeded.push(r.value);
                } else {
                    console.error(`Failed to extend ${clientIds[i]}: ${r.reason?.message}`);
                    failed.push({ clientId: clientIds[i], error: r.reason?.message ?? 'Unknown error' });
                }
            });

            console.log(`Bulk extend complete: ${succeeded.length} OK, ${failed.length} failed`);
            return ok({ succeeded, failed });
        }

        // ── DELETE /clients/{clientId} ────────────────────────────────────────
        const deleteMatch = rawPath.match(/^\/clients\/([^/]+)$/);
        if (method === 'DELETE' && deleteMatch) {
            const clientId = decodeURIComponent(deleteMatch[1]);
            await deleteOne(clientId);
            console.log(`Deleted client: ${clientId}`);
            return ok({ success: true, clientId });
        }

        // ── POST /clients/bulk-delete ─────────────────────────────────────────
        if (method === 'POST' && rawPath === '/clients/bulk-delete') {
            const body = typeof event.body === 'string'
                ? JSON.parse(event.body)
                : (event.body ?? {});

            const { clientIds } = body;
            if (!Array.isArray(clientIds) || clientIds.length === 0) {
                return clientError('clientIds must be a non-empty array');
            }

            console.log(`Bulk deleting ${clientIds.length} client(s)`);

            const results   = await Promise.allSettled(clientIds.map(id => deleteOne(id)));
            const succeeded = [];
            const failed    = [];

            results.forEach((r, i) => {
                if (r.status === 'fulfilled') {
                    succeeded.push(clientIds[i]);
                } else {
                    console.error(`Failed to delete ${clientIds[i]}: ${r.reason?.message}`);
                    failed.push({ clientId: clientIds[i], error: r.reason?.message ?? 'Unknown error' });
                }
            });

            console.log(`Bulk delete complete: ${succeeded.length} deleted, ${failed.length} failed`);
            return ok({ succeeded, failed });
        }

        return notFound();

    } catch (e) {
        console.error('Unhandled error:', e.message, e.stack);
        return serverError(e.message ?? 'Internal server error');
    }
};
