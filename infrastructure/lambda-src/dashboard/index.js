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
 */

const {
    setAuthorization, getAllClients, deleteOne,
} = require('../shared/meraki');

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

        return notFound();

    } catch (e) {
        console.error('Unhandled error:', e.message, e.stack);
        return serverError(e.message ?? 'Internal server error');
    }
};
