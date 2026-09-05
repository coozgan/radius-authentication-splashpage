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

/** DynamoDB Scan filter for rows that are enabled and due. */
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
    const prior = Number(schedule.FailureCount ?? 0);

    if (!outcome.ok) {
        const failureCount = prior + 1;
        // Leave NextRunAt in the past so the next tick retries, until the cap.
        return {
            disable: failureCount >= MAX_CONSECUTIVE_FAILURES,
            nextRunAt: null,
            spawnRevokeAt: null,
            failureCount,
        };
    }

    if (schedule.Kind === 'once') {
        return { disable: true, nextRunAt: null, spawnRevokeAt: null, failureCount: 0 };
    }

    // autorenew
    const endsAt = new Date(schedule.EndsAt).getTime();

    if (new Date(nowIso).getTime() >= endsAt) {
        return { disable: true, nextRunAt: null, spawnRevokeAt: null, failureCount: 0 };
    }

    const nextRunMs = new Date(outcome.newExpiration).getTime() - leadDays * DAY_MS;

    if (nextRunMs >= endsAt) {
        // This renewal overshoots the end date. Let it stand so the device keeps
        // working, and hand EndsAt to a one-off revoke so it goes off on time.
        return {
            disable: true,
            nextRunAt: null,
            spawnRevokeAt: new Date(endsAt).toISOString(),
            failureCount: 0,
        };
    }

    return {
        disable: false,
        nextRunAt: new Date(nextRunMs).toISOString(),
        spawnRevokeAt: null,
        failureCount: 0,
    };
}

module.exports = { newScheduleId, dueFilter, advanceSchedule, MAX_CONSECUTIVE_FAILURES };
