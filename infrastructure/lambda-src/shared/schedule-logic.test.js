'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { advanceSchedule } = require('./schedule-logic');

const NOW = '2026-09-05T04:00:00.000Z';

test('a successful once job disables itself', () => {
    const d = advanceSchedule(
        { Kind: 'once', Action: 'revoke', FailureCount: 0 },
        { ok: true }, NOW, 7
    );
    assert.strictEqual(d.disable, true);
    assert.strictEqual(d.nextRunAt, null);
    assert.strictEqual(d.spawnRevokeAt, null);
});

test('a failed once job stays enabled and counts the failure', () => {
    const d = advanceSchedule(
        { Kind: 'once', Action: 'revoke', FailureCount: 2 },
        { ok: false }, NOW, 7
    );
    assert.strictEqual(d.disable, false);
    assert.strictEqual(d.failureCount, 3);
});

test('a once job disables after 5 consecutive failures', () => {
    const d = advanceSchedule(
        { Kind: 'once', Action: 'revoke', FailureCount: 4 },
        { ok: false }, NOW, 7
    );
    assert.strictEqual(d.failureCount, 5);
    assert.strictEqual(d.disable, true);
});

test('autorenew schedules the next run one lead time before the new expiry', () => {
    const d = advanceSchedule(
        { Kind: 'autorenew', Action: 'extend', EndsAt: '2027-06-30T16:00:00.000Z', FailureCount: 0 },
        { ok: true, newExpiration: '2026-12-04T04:49:29+08:00' }, NOW, 7
    );
    // 2026-12-04T04:49:29+08:00 is 2026-11-26T20:49:29Z minus 7 days
    assert.strictEqual(d.nextRunAt, '2026-11-26T20:49:29.000Z');
    assert.strictEqual(d.disable, false);
    assert.strictEqual(d.spawnRevokeAt, null);
});

test('autorenew whose next run would pass EndsAt stops and spawns a revoke at EndsAt', () => {
    const d = advanceSchedule(
        { Kind: 'autorenew', Action: 'extend', EndsAt: '2027-06-30T16:00:00.000Z', FailureCount: 0 },
        { ok: true, newExpiration: '2027-08-10T04:00:00+08:00' }, NOW, 7
    );
    assert.strictEqual(d.disable, true);
    assert.strictEqual(d.spawnRevokeAt, '2027-06-30T16:00:00.000Z');
});

test('a failed autorenew retries without advancing NextRunAt', () => {
    const d = advanceSchedule(
        { Kind: 'autorenew', Action: 'extend', EndsAt: '2027-06-30T16:00:00.000Z', FailureCount: 0 },
        { ok: false }, NOW, 7
    );
    assert.strictEqual(d.nextRunAt, null);
    assert.strictEqual(d.disable, false);
    assert.strictEqual(d.failureCount, 1);
});

test('autorenew past its EndsAt disables without acting again', () => {
    const d = advanceSchedule(
        { Kind: 'autorenew', Action: 'extend', EndsAt: '2026-01-01T00:00:00.000Z', FailureCount: 0 },
        { ok: true, newExpiration: '2026-12-04T04:49:29+08:00' }, NOW, 7
    );
    assert.strictEqual(d.disable, true);
});
