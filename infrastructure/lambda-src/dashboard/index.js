'use strict';

/**
 * Dashboard API — Lambda Handler (routing only).
 * Business logic lives in ../shared/meraki.js, shared with the sweeper so
 * scheduled and manual actions cannot drift apart.
 *
 *   GET    /clients                      — list all clients (DynamoDB Scan)
 *   POST   /clients/{clientId}/extend    — extend one client (Meraki + DynamoDB)
 *   POST   /clients/bulk-extend          — extend many clients in parallel
 *   POST   /clients/{clientId}/revoke    — revoke one client's authorization
 *   POST   /clients/bulk-revoke          — revoke many clients in parallel
 *   DELETE /clients/{clientId}           — delete one client record
 *   POST   /clients/bulk-delete          — delete many client records
 *   GET    /schedules                    — list all schedules (DynamoDB Scan)
 *   POST   /schedules                    — create a validated schedule
 *   DELETE /schedules/{scheduleId}       — cancel a schedule (disable, never delete)
 */

const { ScanCommand, UpdateCommand, PutCommand } = require('@aws-sdk/lib-dynamodb');
const {
    setAuthorization, getAllClients, deleteOne, dynamo,
} = require('../shared/meraki');
const { validateScheduleInput } = require('../shared/validate-schedule');
const { checkApiKey } = require('../shared/api-auth');

const SCHEDULES_TABLE = process.env.SCHEDULES_TABLE_NAME;

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

    // Authorize before any routing, so no handler runs for an unauthenticated
    // caller. API Gateway has no authorizer; this is the only gate on the API.
    const denied = await checkApiKey(event);
    if (denied) return denied;

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
            const result   = await setAuthorization(clientId, true);
            return ok({ success: true, ...result });
        }

        // ── POST /clients/{clientId}/revoke ───────────────────────────────────
        const revokeMatch = rawPath.match(/^\/clients\/(.+)\/revoke$/);
        if (method === 'POST' && revokeMatch) {
            const clientId = decodeURIComponent(revokeMatch[1]);
            const result   = await setAuthorization(clientId, false);
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

            const results   = await Promise.allSettled(clientIds.map(id => setAuthorization(id, true)));
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

        // ── POST /clients/bulk-revoke ─────────────────────────────────────────
        if (method === 'POST' && rawPath === '/clients/bulk-revoke') {
            const body = typeof event.body === 'string'
                ? JSON.parse(event.body)
                : (event.body ?? {});

            const { clientIds } = body;
            if (!Array.isArray(clientIds) || clientIds.length === 0) {
                return clientError('clientIds must be a non-empty array');
            }

            console.log(`Bulk revoking ${clientIds.length} client(s)`);

            const results   = await Promise.allSettled(clientIds.map(id => setAuthorization(id, false)));
            const succeeded = [];
            const failed    = [];

            results.forEach((r, i) => {
                if (r.status === 'fulfilled') {
                    succeeded.push(r.value);
                } else {
                    console.error(`Failed to revoke ${clientIds[i]}: ${r.reason?.message}`);
                    failed.push({ clientId: clientIds[i], error: r.reason?.message ?? 'Unknown error' });
                }
            });

            console.log(`Bulk revoke complete: ${succeeded.length} OK, ${failed.length} failed`);
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

        // ── GET /schedules ────────────────────────────────────────────────────
        if (method === 'GET' && rawPath === '/schedules') {
            const items = [];
            let lastKey;
            do {
                const resp = await dynamo.send(new ScanCommand({
                    TableName: SCHEDULES_TABLE,
                    ExclusiveStartKey: lastKey,
                }));
                if (resp.Items) items.push(...resp.Items);
                lastKey = resp.LastEvaluatedKey;
            } while (lastKey);

            // Newest first — the list is a log of what someone set up.
            items.sort((a, b) => String(b.CreatedAt ?? '').localeCompare(String(a.CreatedAt ?? '')));
            return ok(items);
        }

        // ── POST /schedules ───────────────────────────────────────────────────
        if (method === 'POST' && rawPath === '/schedules') {
            let body;
            try {
                body = typeof event.body === 'string' ? JSON.parse(event.body) : (event.body ?? {});
            } catch {
                // Malformed JSON is a caller error, not a 500.
                return clientError('body must be valid JSON');
            }

            // The trust boundary: nothing past this point re-checks the shape.
            const result = validateScheduleInput(body, new Date().toISOString());
            if (!result.ok) return clientError(result.error);

            await dynamo.send(new PutCommand({
                TableName: SCHEDULES_TABLE,
                Item: result.item,
            }));

            console.log(`Created ${result.item.Kind} schedule ${result.item.ScheduleID} for ${result.item.ClientID}`);
            return ok(result.item);
        }

        // ── DELETE /schedules/{scheduleId} ────────────────────────────────────
        const scheduleMatch = rawPath.match(/^\/schedules\/([^/]+)$/);
        if (method === 'DELETE' && scheduleMatch) {
            const scheduleId = decodeURIComponent(scheduleMatch[1]);
            // Cancel means disable — rows are never deleted, so the history of
            // what was scheduled survives. Enabled=false takes the row out of
            // the sweeper's due filter permanently; NextRunAt is left alone
            // because nothing reads it once Enabled is false.
            //
            // The condition is what stops a cancel from *creating* a row:
            // UpdateItem upserts, so cancelling an unknown id would otherwise
            // write {ScheduleID, Enabled: false} — a row with no Kind, which is
            // exactly the corrupt shape the sweeper alarms on.
            try {
                await dynamo.send(new UpdateCommand({
                    TableName: SCHEDULES_TABLE,
                    Key: { ScheduleID: scheduleId },
                    UpdateExpression: 'SET #enabled = :false, LastResult = :res',
                    ConditionExpression: 'attribute_exists(ScheduleID)',
                    // Aliased for consistency with the sweeper, which aliases
                    // Enabled everywhere it touches it. ENABLED is not itself a
                    // DynamoDB reserved word (ENABLE is), so this is defensive
                    // rather than required — it costs nothing and keeps the
                    // attribute safe if it is ever renamed to one that is.
                    ExpressionAttributeNames: { '#enabled': 'Enabled' },
                    ExpressionAttributeValues: { ':false': false, ':res': 'cancelled' },
                }));
            } catch (e) {
                if (e.name === 'ConditionalCheckFailedException') return notFound();
                throw e;
            }
            console.log(`Cancelled schedule: ${scheduleId}`);
            return ok({ success: true, scheduleId });
        }

        return notFound();

    } catch (e) {
        console.error('Unhandled error:', e.message, e.stack);
        return serverError(e.message ?? 'Internal server error');
    }
};
