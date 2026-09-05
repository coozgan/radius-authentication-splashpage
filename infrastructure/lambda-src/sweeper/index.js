'use strict';

/**
 * Schedule Sweeper — runs every 5 minutes on EventBridge.
 *
 * Scans radius-auth-schedules for enabled rows whose NextRunAt has passed,
 * performs each row's action through the same setAuthorization() the dashboard
 * uses, then advances or disables the row.
 *
 * Missed ticks self-heal: the filter is `NextRunAt <= now`, so an outage means
 * late execution, never a skipped one.
 */

const { UpdateCommand, ScanCommand, PutCommand } = require('@aws-sdk/lib-dynamodb');
const { setAuthorization, dynamo } = require('../shared/meraki');
const { advanceSchedule, dueFilter, MAX_CONSECUTIVE_FAILURES } = require('../shared/schedule-logic');

const SCHEDULES_TABLE = process.env.SCHEDULES_TABLE_NAME;
const LEAD_DAYS = Number(process.env.AUTORENEW_LEAD_DAYS || 7);

/** Logged verbatim; a CloudWatch metric filter alarms on this token. */
const STOPPED_TOKEN = 'SCHEDULE_STOPPED_UNEXPECTED';

/**
 * Deterministic id for the revoke a schedule spawns, so a retried sweep
 * overwrites the same row instead of creating a second revoke.
 */
function revokeScheduleId(parentId, revokeAt) {
    return `${parentId}-revoke-${revokeAt}`;
}

/**
 * A row that stopped with no failures and no revoke to enforce its end date.
 * That is the normal terminal state of a `once` job, and a red flag on anything
 * else — including a corrupt Kind, which is exactly what this must catch.
 */
function isUnexpectedStop(schedule, decision) {
    return decision.disable && decision.failureCount === 0
        && !decision.spawnRevokeAt && schedule.Kind !== 'once';
}

/**
 * Builds the parent row's update. `nextRunAt: null` means "leave NextRunAt
 * alone" — writing a NULL would sort before every real timestamp and make the
 * row match the due filter on every sweep forever.
 */
function buildScheduleUpdate(decision, outcome, nowIso) {
    const sets = ['LastRunAt = :now', 'LastResult = :res', 'FailureCount = :fc'];
    const names = {};
    const values = {
        ':now': nowIso,
        ':res': outcome.ok ? 'ok' : String(outcome.error ?? 'failed').slice(0, 500),
        ':fc': decision.failureCount,
        ':one': 1,
    };

    if (decision.disable) {
        sets.push('#enabled = :false');
        names['#enabled'] = 'Enabled';
        values[':false'] = false;
    }
    if (decision.nextRunAt) {
        sets.push('#next = :next');
        names['#next'] = 'NextRunAt';
        values[':next'] = decision.nextRunAt;
    }

    return {
        UpdateExpression: `SET ${sets.join(', ')} ADD RunCount :one`,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
    };
}

async function findDue(nowIso) {
    const items = [];
    let lastKey;
    do {
        const resp = await dynamo.send(new ScanCommand({
            TableName: SCHEDULES_TABLE,
            ExclusiveStartKey: lastKey,
            ...dueFilter(nowIso),
        }));
        if (resp.Items) items.push(...resp.Items);
        lastKey = resp.LastEvaluatedKey;
    } while (lastKey);
    return items;
}

/** Applies a decision from advanceSchedule to the row, plus any spawned revoke. */
async function applyDecision(schedule, decision, outcome, nowIso) {
    // Spawn first, disable second. spawnRevokeAt is only a decision; if we
    // disabled the parent and then crashed, the auto-renew would be dead with
    // nothing left to revoke the device. A duplicate revoke is harmless, a
    // missing one leaves a device authorized forever.
    if (decision.spawnRevokeAt) {
        await dynamo.send(new PutCommand({
            TableName: SCHEDULES_TABLE,
            Item: {
                ScheduleID: revokeScheduleId(schedule.ScheduleID, decision.spawnRevokeAt),
                Kind: 'once',
                Action: 'revoke',
                ClientID: schedule.ClientID,
                NextRunAt: decision.spawnRevokeAt,
                Enabled: true,
                RunCount: 0,
                FailureCount: 0,
                CreatedAt: nowIso,
                Note: `Auto-created: enforces EndsAt of schedule ${schedule.ScheduleID}`,
            },
        }));
        console.log(`Spawned EndsAt revoke for ${schedule.ClientID} at ${decision.spawnRevokeAt}`);
    }

    const { ExpressionAttributeNames, ...rest } = buildScheduleUpdate(decision, outcome, nowIso);

    await dynamo.send(new UpdateCommand({
        TableName: SCHEDULES_TABLE,
        Key: { ScheduleID: schedule.ScheduleID },
        ...rest,
        ...(Object.keys(ExpressionAttributeNames).length ? { ExpressionAttributeNames } : {}),
    }));
}

async function runOne(schedule, nowIso) {
    let outcome;
    try {
        const result = await setAuthorization(schedule.ClientID, schedule.Action === 'extend');
        outcome = { ok: true, newExpiration: result.newExpiration };
    } catch (e) {
        console.error(`Schedule ${schedule.ScheduleID} failed: ${e.message}`);
        outcome = { ok: false, error: e.message };
    }

    const decision = advanceSchedule(schedule, outcome, nowIso, LEAD_DAYS);

    // A failing row does not advance NextRunAt, so it re-fires every sweep until
    // the cap. Bounded by design, but each attempt must be traceable.
    if (decision.failureCount > 0) {
        console.warn(
            `Schedule ${schedule.ScheduleID} (client ${schedule.ClientID}) failure ` +
            `${decision.failureCount}/${MAX_CONSECUTIVE_FAILURES}` +
            `${decision.disable ? ' — cap reached, disabling' : ' — will retry next sweep'}`
        );
    }
    if (isUnexpectedStop(schedule, decision)) {
        console.error(
            `${STOPPED_TOKEN} schedule ${schedule.ScheduleID} (client ${schedule.ClientID}, ` +
            `Kind ${JSON.stringify(schedule.Kind)}, EndsAt ${JSON.stringify(schedule.EndsAt)}) ` +
            'stopped with no failures and no revoke scheduled'
        );
    }

    await applyDecision(schedule, decision, outcome, nowIso);
    return outcome.ok;
}

exports.handler = async () => {
    const nowIso = new Date().toISOString();
    const due = await findDue(nowIso);

    if (due.length === 0) {
        console.log('No schedules due');
        return { processed: 0 };
    }

    console.log(`Processing ${due.length} due schedule(s)`);
    // ponytail: unbounded fan-out — fine at hundreds of rows within the 300s
    // timeout; add a concurrency limit if a sweep ever nears it.
    const results = await Promise.allSettled(due.map(s => runOne(s, nowIso)));

    const ok = results.filter(r => r.status === 'fulfilled' && r.value).length;
    const failed = due.length - ok;

    console.log(`Sweep complete: ${ok} OK, ${failed} failed`);
    return { processed: due.length, ok, failed };
};

module.exports.revokeScheduleId = revokeScheduleId;
module.exports.isUnexpectedStop = isUnexpectedStop;
module.exports.buildScheduleUpdate = buildScheduleUpdate;
