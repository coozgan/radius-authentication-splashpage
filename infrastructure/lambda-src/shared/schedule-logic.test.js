'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { advanceSchedule, dueFilter, newScheduleId } = require('./schedule-logic');

const NOW = '2026-09-05T04:00:00.000Z';
const ENDS_AT = '2027-06-30T16:00:00.000Z';

test('a successful once job disables itself', () => {
    const d = advanceSchedule(
        { Kind: 'once', Action: 'revoke', FailureCount: 0 },
        { ok: true }, NOW, 7
    );
    assert.strictEqual(d.disable, true);
    assert.strictEqual(d.nextRunAt, null);
    assert.strictEqual(d.spawnRevokeAt, null);
    assert.strictEqual(d.failureCount, 0);
});

test('a failed once job stays enabled and counts the failure', () => {
    const d = advanceSchedule(
        { Kind: 'once', Action: 'revoke', FailureCount: 2 },
        { ok: false }, NOW, 7
    );
    assert.strictEqual(d.disable, false);
    assert.strictEqual(d.failureCount, 3);
    assert.strictEqual(d.nextRunAt, null);
    assert.strictEqual(d.spawnRevokeAt, null);
});

test('a once job disables after 5 consecutive failures', () => {
    const d = advanceSchedule(
        { Kind: 'once', Action: 'revoke', FailureCount: 4 },
        { ok: false }, NOW, 7
    );
    assert.strictEqual(d.failureCount, 5);
    assert.strictEqual(d.disable, true);
    assert.strictEqual(d.nextRunAt, null);
    assert.strictEqual(d.spawnRevokeAt, null);
});

test('autorenew schedules the next run one lead time before the new expiry', () => {
    const d = advanceSchedule(
        { Kind: 'autorenew', Action: 'extend', EndsAt: ENDS_AT, FailureCount: 0 },
        { ok: true, newExpiration: '2026-12-04T04:49:29+08:00' }, NOW, 7
    );
    // 2026-12-04T04:49:29+08:00 is 2026-11-26T20:49:29Z minus 7 days
    assert.strictEqual(d.nextRunAt, '2026-11-26T20:49:29.000Z');
    assert.strictEqual(d.disable, false);
    assert.strictEqual(d.spawnRevokeAt, null);
    assert.strictEqual(d.failureCount, 0);
});

test('autorenew whose next run would pass EndsAt stops and spawns a revoke at EndsAt', () => {
    const d = advanceSchedule(
        { Kind: 'autorenew', Action: 'extend', EndsAt: ENDS_AT, FailureCount: 0 },
        { ok: true, newExpiration: '2027-08-10T04:00:00+08:00' }, NOW, 7
    );
    assert.strictEqual(d.disable, true);
    assert.strictEqual(d.spawnRevokeAt, ENDS_AT);
    assert.strictEqual(d.nextRunAt, null);
    assert.strictEqual(d.failureCount, 0);
});

test('autorenew whose next run lands exactly on EndsAt spawns a revoke rather than scheduling', () => {
    // newExpiration minus 7 days is EndsAt to the millisecond. Pins >= against >.
    const d = advanceSchedule(
        { Kind: 'autorenew', Action: 'extend', EndsAt: ENDS_AT, FailureCount: 0 },
        { ok: true, newExpiration: '2027-07-07T16:00:00.000Z' }, NOW, 7
    );
    assert.strictEqual(d.disable, true);
    assert.strictEqual(d.spawnRevokeAt, ENDS_AT);
    assert.strictEqual(d.nextRunAt, null);
});

test('autorenew whose next run lands one ms before EndsAt still schedules', () => {
    const d = advanceSchedule(
        { Kind: 'autorenew', Action: 'extend', EndsAt: ENDS_AT, FailureCount: 0 },
        { ok: true, newExpiration: '2027-07-07T15:59:59.999Z' }, NOW, 7
    );
    assert.strictEqual(d.disable, false);
    assert.strictEqual(d.nextRunAt, '2027-06-30T15:59:59.999Z');
    assert.strictEqual(d.spawnRevokeAt, null);
});

test('a failed autorenew retries without advancing NextRunAt', () => {
    const d = advanceSchedule(
        { Kind: 'autorenew', Action: 'extend', EndsAt: ENDS_AT, FailureCount: 0 },
        { ok: false }, NOW, 7
    );
    assert.strictEqual(d.nextRunAt, null);
    assert.strictEqual(d.disable, false);
    assert.strictEqual(d.failureCount, 1);
    assert.strictEqual(d.spawnRevokeAt, null);
});

test('autorenew acted on past its EndsAt disables and spawns a revoke to cut it off', () => {
    const d = advanceSchedule(
        { Kind: 'autorenew', Action: 'extend', EndsAt: '2026-01-01T00:00:00.000Z', FailureCount: 0 },
        { ok: true, newExpiration: '2026-12-04T04:49:29+08:00' }, NOW, 7
    );
    assert.strictEqual(d.disable, true);
    assert.strictEqual(d.spawnRevokeAt, '2026-01-01T00:00:00.000Z');
    assert.strictEqual(d.nextRunAt, null);
    assert.strictEqual(d.failureCount, 0);
});

test('autorenew with no EndsAt disables instead of renewing forever', () => {
    const d = advanceSchedule(
        { Kind: 'autorenew', Action: 'extend', FailureCount: 0 },
        { ok: true, newExpiration: '2026-12-04T04:49:29+08:00' }, NOW, 7
    );
    assert.strictEqual(d.disable, true);
    assert.strictEqual(d.nextRunAt, null);
    assert.strictEqual(d.spawnRevokeAt, null);
    assert.strictEqual(d.failureCount, 0);
});

test('autorenew with an unparseable EndsAt disables instead of renewing forever', () => {
    const d = advanceSchedule(
        { Kind: 'autorenew', Action: 'extend', EndsAt: '30/06/2027', FailureCount: 0 },
        { ok: true, newExpiration: '2026-12-04T04:49:29+08:00' }, NOW, 7
    );
    assert.strictEqual(d.disable, true);
    assert.strictEqual(d.nextRunAt, null);
});

test('a successful autorenew with no newExpiration takes the retry path instead of throwing', () => {
    const d = advanceSchedule(
        { Kind: 'autorenew', Action: 'extend', EndsAt: ENDS_AT, FailureCount: 0 },
        { ok: true }, NOW, 7
    );
    assert.strictEqual(d.disable, false);
    assert.strictEqual(d.failureCount, 1);
    assert.strictEqual(d.nextRunAt, null);
    assert.strictEqual(d.spawnRevokeAt, null);
});

test('a successful autorenew with an unparseable newExpiration takes the retry path', () => {
    const d = advanceSchedule(
        { Kind: 'autorenew', Action: 'extend', EndsAt: ENDS_AT, FailureCount: 4 },
        { ok: true, newExpiration: 'not a date' }, NOW, 7
    );
    assert.strictEqual(d.failureCount, 5);
    assert.strictEqual(d.disable, true);
    assert.strictEqual(d.nextRunAt, null);
});

test('a non-numeric FailureCount counts from zero rather than going NaN', () => {
    const d = advanceSchedule(
        { Kind: 'once', Action: 'revoke', FailureCount: 'corrupt' },
        { ok: false }, NOW, 7
    );
    assert.strictEqual(d.failureCount, 1);
    assert.strictEqual(d.disable, false);
});

test('an unknown Kind disables rather than falling through to autorenew', () => {
    const d = advanceSchedule(
        { Kind: 'autorenw', Action: 'extend', EndsAt: ENDS_AT, FailureCount: 0 },
        { ok: true, newExpiration: '2026-12-04T04:49:29+08:00' }, NOW, 7
    );
    assert.strictEqual(d.disable, true);
    assert.strictEqual(d.nextRunAt, null);
    assert.strictEqual(d.spawnRevokeAt, null);
});

test('dueFilter matches enabled rows whose NextRunAt has arrived', () => {
    assert.deepStrictEqual(dueFilter(NOW), {
        FilterExpression: '#enabled = :true AND #next <= :now',
        ExpressionAttributeNames: { '#enabled': 'Enabled', '#next': 'NextRunAt' },
        ExpressionAttributeValues: { ':true': true, ':now': NOW },
    });
});

test('newScheduleId returns distinct v4 UUIDs', () => {
    const id = newScheduleId();
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.notStrictEqual(id, newScheduleId());
});
