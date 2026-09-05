'use strict';

/**
 * Pure scheduling decisions — no AWS calls, no clock reads. Everything the
 * sweeper needs to know about "what happens to this row after it fires".
 *
 * All timestamps in and out are UTC ISO 8601 (Z). NextRunAt is compared as a
 * string in DynamoDB, so a mixed-offset value would sort wrongly and fire at
 * the wrong time.
 */

const { randomUUID } = require('node:crypto');

const MAX_CONSECUTIVE_FAILURES = 5;
const DAY_MS = 86_400_000;

function newScheduleId() {
    return randomUUID();
}

/** Epoch ms for an ISO string, or null if absent/unparseable. */
function parseMs(iso) {
    const ms = new Date(iso ?? '').getTime();
    return Number.isFinite(ms) ? ms : null;
}

/**
 * DynamoDB Scan filter for rows that are enabled and due.
 *
 * `:true` is a native JS boolean, so this is built for the DocumentClient. A
 * caller on the low-level client must marshall it ({BOOL: true} / {S: nowIso}).
 */
function dueFilter(nowIso) {
    return {
        FilterExpression: '#enabled = :true AND #next <= :now',
        ExpressionAttributeNames: { '#enabled': 'Enabled', '#next': 'NextRunAt' },
        ExpressionAttributeValues: { ':true': true, ':now': nowIso },
    };
}

/**
 * @param schedule  the DynamoDB row that just fired
 * @param outcome   {ok: boolean, newExpiration?: string}
 * @param nowIso    UTC ISO 8601
 * @param leadDays  how far before expiry autorenew acts
 * @returns {{disable: boolean, nextRunAt: string|null, spawnRevokeAt: string|null, failureCount: number}}
 */
function advanceSchedule(schedule, outcome, nowIso, leadDays) {
    const raw = Number(schedule.FailureCount ?? 0);
    // Junk in FailureCount would otherwise write NaN back and jam the cap.
    const prior = Number.isFinite(raw) ? raw : 0;

    // Leave NextRunAt in the past so the next tick retries, until the cap.
    const retry = () => {
        const failureCount = prior + 1;
        return {
            disable: failureCount >= MAX_CONSECUTIVE_FAILURES,
            nextRunAt: null,
            spawnRevokeAt: null,
            failureCount,
        };
    };
    const stop = (spawnRevokeAt = null) =>
        ({ disable: true, nextRunAt: null, spawnRevokeAt, failureCount: 0 });

    if (!outcome.ok) return retry();

    if (schedule.Kind === 'once') return stop();

    // Anything but a known kind fails closed rather than renewing on forever.
    if (schedule.Kind !== 'autorenew') return stop();

    // EndsAt is mandatory for autorenew: it is the only bound on renewal. A
    // missing or malformed one must stop the row, never renew unbounded.
    const endsAt = parseMs(schedule.EndsAt);
    if (endsAt === null) return stop();

    if (new Date(nowIso).getTime() >= endsAt) {
        // We just extended a device whose window is already over (retries ran
        // long, or EndsAt was shortened). Cut it off instead of leaving it
        // authorized with nothing scheduled to revoke it. EndsAt is in the past
        // here, so the sweeper picks the spawned row up on its next pass.
        return stop(new Date(endsAt).toISOString());
    }

    // A successful extend with no usable expiry cannot be turned into a next
    // run. Retrying self-limits at the cap; throwing here would lose the
    // decision after Meraki already acted and re-extend every sweep.
    const newExpirationMs = parseMs(outcome.newExpiration);
    if (newExpirationMs === null) return retry();

    const nextRunMs = newExpirationMs - leadDays * DAY_MS;

    if (nextRunMs >= endsAt) {
        // This renewal overshoots the end date. Let it stand so the device keeps
        // working, and hand EndsAt to a one-off revoke so it goes off on time.
        return stop(new Date(endsAt).toISOString());
    }

    return {
        disable: false,
        nextRunAt: new Date(nextRunMs).toISOString(),
        spawnRevokeAt: null,
        failureCount: 0,
    };
}

module.exports = { newScheduleId, dueFilter, advanceSchedule, MAX_CONSECUTIVE_FAILURES };
