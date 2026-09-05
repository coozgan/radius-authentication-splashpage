'use strict';

/**
 * Shared Meraki + DynamoDB helpers.
 *
 * The Meraki API key is fetched from AWS Secrets Manager and cached in module
 * scope so warm Lambda invocations skip the Secrets Manager call entirely.
 *
 * All DynamoDB updates use ADD for counters (never resets to 0) and SET for
 * timestamps. Records are never deleted by the scheduled paths.
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

async function deleteOne(clientId) {
    await dynamo.send(new DeleteCommand({
        TableName: TABLE_NAME,
        Key: { ClientID: clientId },
    }));
}

// ── Core business logic ───────────────────────────────────────────────────────

/**
 * Sets a client's Meraki splash authorization on or off, then records the
 * result in DynamoDB. Throws on any failure so callers decide how to handle it.
 *
 * authorized=true  → Meraki returns expiresAt/authorizedAt; we store them.
 * authorized=false → Meraki returns no expiry; we set expiry to now and stamp
 *                    RevokedAt, so the row reads as expired everywhere.
 */
async function setAuthorization(clientId, authorized) {
    const client = await getClient(clientId);
    if (!client) throw new Error(`Client not found: ${clientId}`);

    const merakiId = client.MerakiClientID || client.ClientID;
    const ssid     = client.SSID || 'ICS-Staff';
    const ssidNum  = getSsidNumber(ssid);

    if (!ssidNum) {
        throw new Error(`No SSID number mapping for "${ssid}". Update the SSID_MAP variable.`);
    }

    const apiKey = await getMerakiApiKey();
    const url    = `${MERAKI_BASE}/networks/${MERAKI_NETWORK_ID}/clients/${merakiId}/splashAuthorizationStatus`;

    console.log(`${authorized ? 'Extending' : 'Revoking'} ${clientId} on SSID "${ssid}" (number ${ssidNum})`);

    const res = await fetch(url, {
        method:  'PUT',
        headers: {
            Authorization:  `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            Accept:         'application/json',
        },
        body: JSON.stringify({ ssids: { [ssidNum]: { isAuthorized: authorized } } }),
    });

    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Meraki API ${res.status}: ${text}`);
    }

    const data     = await res.json();
    const ssidData = data.ssids?.[ssidNum];

    if (!authorized) {
        // Meraki returns no expiresAt when deauthorizing — do not validate it.
        if (ssidData?.isAuthorized) throw new Error('Meraki still reports the client as authorized');
        const now = new Date().toISOString();
        await dynamo.send(new UpdateCommand({
            TableName: TABLE_NAME,
            Key: { ClientID: clientId },
            UpdateExpression:
                'SET ExpirationTimestamp = :now, RevokedAt = :now, LastUpdated = :now ' +
                'ADD RevokeCount :one',
            ExpressionAttributeValues: { ':now': now, ':one': 1 },
        }));
        console.log(`Revoked ${clientId}`);
        return { clientId, revokedAt: now };
    }

    if (!ssidData?.isAuthorized) throw new Error('Meraki did not confirm authorization in response');
    if (!ssidData.expiresAt)     throw new Error('Meraki response missing expiresAt');
    if (!ssidData.authorizedAt)  throw new Error('Meraki response missing authorizedAt');

    const newExpiration = merakiUtcToSGT(ssidData.expiresAt);
    const lastRenewed   = merakiUtcToSGT(ssidData.authorizedAt);

    await dynamo.send(new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { ClientID: clientId },
        UpdateExpression:
            'SET ExpirationTimestamp = :exp, LastUpdated = :lu, LastRenewed = :lr ' +
            'ADD RenewalCount :one',
        ExpressionAttributeValues: {
            ':exp': newExpiration,
            ':lu':  new Date().toISOString(),
            ':lr':  lastRenewed,
            ':one': 1,
        },
    }));

    console.log(`Extended ${clientId}: expires ${newExpiration}`);
    return { clientId, newExpiration, lastRenewed };
}

module.exports = {
    setAuthorization, merakiUtcToSGT, getAllClients, getClient, deleteOne,
    dynamo, TABLE_NAME,
};
