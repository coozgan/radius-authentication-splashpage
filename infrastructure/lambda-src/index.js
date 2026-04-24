'use strict';

/**
 * RADIUS Client Tracker — Lambda Handler
 *
 * Triggered by SQS. For each auth event:
 *   - If the ClientID is new  → creates a new DynamoDB record
 *   - If the ClientID exists  → updates timestamps and increments ConnectionCount
 *
 * Records are NEVER deleted. ExpirationTimestamp is purely informational
 * and does NOT trigger DynamoDB TTL removal.
 *
 * DynamoDB record shape:
 *   ClientID            (S)  PK — MAC address
 *   ClientName          (S)  Authenticated username / email
 *   MacAddress          (S)  MAC address (redundant with PK for readability)
 *   ClientIP            (S)  IP at time of last auth
 *   SSID                (S)  WiFi SSID the client authenticated on (from NETWORK_SSID env var)
 *   ConnectionTimestamp (S)  Last successful auth — ISO 8601, SGT (+08:00)
 *   ExpirationTimestamp (S)  ConnectionTimestamp + 90 days — ISO 8601, SGT
 *   LastUpdated         (S)  UTC ISO 8601 of the DynamoDB write
 *   ConnectionCount     (N)  Lifetime total of successful authentications
 */

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, UpdateCommand } = require('@aws-sdk/lib-dynamodb');

const TABLE_NAME = process.env.DYNAMODB_TABLE_NAME;

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient, {
    marshallOptions: { removeUndefinedValues: true },
});

// ── Helpers ──────────────────────────────────────────────

/**
 * Formats a Date as ISO 8601 with Singapore Time offset (+08:00).
 * Works without any external timezone libraries.
 */
function toSGT(date) {
    const SGT_OFFSET_MS = 8 * 60 * 60 * 1000;
    const sgt = new Date(date.getTime() + SGT_OFFSET_MS);
    const pad = (n) => String(n).padStart(2, '0');
    return (
        `${sgt.getUTCFullYear()}-${pad(sgt.getUTCMonth() + 1)}-${pad(sgt.getUTCDate())}` +
        `T${pad(sgt.getUTCHours())}:${pad(sgt.getUTCMinutes())}:${pad(sgt.getUTCSeconds())}+08:00`
    );
}

/**
 * Returns ConnectionTimestamp (now in SGT) and ExpirationTimestamp (now + 90 days in SGT).
 */
function buildTimestamps() {
    const now = new Date();
    const expiry = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);
    return {
        connectionTimestamp: toSGT(now),
        expirationTimestamp: toSGT(expiry),
        lastUpdatedUtc: now.toISOString(),
    };
}

// ── Core DynamoDB logic ───────────────────────────────────

/**
 * Upserts a client record.
 * Uses UpdateItem so the operation is idempotent and safe for retries:
 *   - Creates the item when ClientID is new.
 *   - Updates all mutable fields and increments ConnectionCount when it exists.
 *
 * DeleteItem is never called — records accumulate indefinitely.
 */
async function upsertClient({ clientId, clientName, macAddress, clientIp, ssid }) {
    const { connectionTimestamp, expirationTimestamp, lastUpdatedUtc } = buildTimestamps();

    const command = new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { ClientID: clientId },
        // SET attributes are comma-separated within the SET block.
        // ADD is a separate DynamoDB clause — must be separated by a space, never a comma.
        UpdateExpression:
            'SET ClientName          = :clientName,' +
            '    MacAddress          = :macAddress,' +
            '    SSID                = :ssid,' +
            '    ConnectionTimestamp = :connectionTimestamp,' +
            '    ExpirationTimestamp = :expirationTimestamp,' +
            '    LastUpdated         = :lastUpdated,' +
            '    ClientIP            = :clientIp ' +
            'ADD ConnectionCount :one',
        ExpressionAttributeValues: {
            ':clientName':          clientName,
            ':macAddress':          macAddress,
            ':ssid':                ssid || '',
            ':connectionTimestamp': connectionTimestamp,
            ':expirationTimestamp': expirationTimestamp,
            ':lastUpdated':         lastUpdatedUtc,
            ':clientIp':            clientIp || '',
            ':one':                 1,
        },
        ReturnValues: 'UPDATED_NEW',
    });

    const result = await docClient.send(command);
    return result.Attributes;
}

// ── Lambda Handler ────────────────────────────────────────

/**
 * Processes a batch of SQS records.
 *
 * Returns batchItemFailures so SQS only retries the records that failed —
 * successfully processed records in the same batch are not re-delivered.
 */
exports.handler = async (event) => {
    if (!event.Records || !Array.isArray(event.Records)) {
        console.error('Invalid event: missing Records array. Event received:', JSON.stringify(event));
        return { batchItemFailures: [] };
    }

    console.log(`Received ${event.Records.length} record(s)`);

    const batchItemFailures = [];

    for (const record of event.Records) {
        const { messageId } = record;

        try {
            // SQS always delivers body as a string, but accept objects too for manual test invocations
            const body = typeof record.body === 'string' ? JSON.parse(record.body) : record.body;
            const { clientId, clientName, macAddress, clientIp, ssid } = body;

            if (!clientId || !clientName || !macAddress) {
                // Message is malformed — sending to DLQ is correct; do not retry endlessly
                console.error(`[${messageId}] Malformed message, routing to DLQ:`, JSON.stringify(body));
                batchItemFailures.push({ itemIdentifier: messageId });
                continue;
            }

            console.log(`[${messageId}] Upserting: clientId=${clientId} clientName=${clientName} ssid=${ssid || '(unset)'}`);
            const updated = await upsertClient({ clientId, clientName, macAddress, clientIp, ssid });
            console.log(`[${messageId}] OK — ConnectionCount=${updated?.ConnectionCount}, Expires=${updated?.ExpirationTimestamp}`);

        } catch (err) {
            // Transient errors (DynamoDB throttle, network) — SQS will retry up to maxReceiveCount
            console.error(`[${messageId}] Error:`, err.message);
            batchItemFailures.push({ itemIdentifier: messageId });
        }
    }

    if (batchItemFailures.length > 0) {
        console.warn(`${batchItemFailures.length}/${event.Records.length} record(s) failed`);
    }

    return { batchItemFailures };
};
