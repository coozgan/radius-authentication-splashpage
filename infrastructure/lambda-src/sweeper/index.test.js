'use strict';
const test = require('node:test');
const assert = require('node:assert');

// Stub @aws-sdk/* (Lambda-runtime provided) and ../shared/meraki so the pure
// helpers can be loaded without AWS. Same Module._load trick as
// shared/meraki.test.js.
// ponytail: crude Module._load patch; swap for node:test module mocking when it
// leaves experimental.
const Module = require('node:module');
const Stub = class { static from() { return {}; } };
const sdkExports = new Proxy({}, { get: () => Stub });
const merakiStub = { setAuthorization: async () => ({}), dynamo: { send: async () => ({}) } };

const load = Module._load;
Module._load = (request, ...rest) => {
    if (request.startsWith('@aws-sdk/')) return sdkExports;
    if (request.endsWith('shared/meraki')) return merakiStub;
    return load(request, ...rest);
};

let revokeScheduleId, isUnexpectedStop, buildScheduleUpdate;
try {
    ({ revokeScheduleId, isUnexpectedStop, buildScheduleUpdate } = require('./index'));
} finally {
    Module._load = load; // process-global patch; never leave it installed
}

const okOutcome = { ok: true };

test('revokeScheduleId is deterministic so a retried sweep overwrites, not duplicates', () => {
    const a = revokeScheduleId('parent-1', '2026-12-01T00:00:00.000Z');
    const b = revokeScheduleId('parent-1', '2026-12-01T00:00:00.000Z');
    assert.strictEqual(a, b);
    assert.notStrictEqual(a, revokeScheduleId('parent-2', '2026-12-01T00:00:00.000Z'));
});

test('a null nextRunAt omits NextRunAt entirely — never writes a DynamoDB NULL', () => {
    const upd = buildScheduleUpdate(
        { disable: false, nextRunAt: null, spawnRevokeAt: null, failureCount: 1 },
        { ok: false, error: 'boom' },
        '2026-09-05T00:00:00.000Z'
    );
    assert.ok(!upd.UpdateExpression.includes('NextRunAt'));
    assert.ok(!upd.UpdateExpression.includes('#next'));
    assert.strictEqual(upd.ExpressionAttributeValues[':next'], undefined);
    assert.strictEqual(upd.ExpressionAttributeValues[':fc'], 1);
});

test('a real nextRunAt is written via a name placeholder (NextRunAt is reserved-ish)', () => {
    const upd = buildScheduleUpdate(
        { disable: false, nextRunAt: '2026-10-01T00:00:00.000Z', spawnRevokeAt: null, failureCount: 0 },
        okOutcome,
        '2026-09-05T00:00:00.000Z'
    );
    assert.ok(upd.UpdateExpression.includes('#next = :next'));
    assert.strictEqual(upd.ExpressionAttributeNames['#next'], 'NextRunAt');
    assert.strictEqual(upd.ExpressionAttributeValues[':next'], '2026-10-01T00:00:00.000Z');
});

test('disable writes Enabled = false', () => {
    const upd = buildScheduleUpdate(
        { disable: true, nextRunAt: null, spawnRevokeAt: null, failureCount: 0 },
        okOutcome,
        '2026-09-05T00:00:00.000Z'
    );
    assert.strictEqual(upd.ExpressionAttributeNames['#enabled'], 'Enabled');
    assert.strictEqual(upd.ExpressionAttributeValues[':false'], false);
});

test('a successful once job is the normal terminal path and must not alarm', () => {
    assert.strictEqual(
        isUnexpectedStop(
            { Kind: 'once' },
            { disable: true, nextRunAt: null, spawnRevokeAt: null, failureCount: 0 }
        ),
        false
    );
});

test('an autorenew stopping with no failures and no revoke alarms', () => {
    assert.strictEqual(
        isUnexpectedStop(
            { Kind: 'autorenew' },
            { disable: true, nextRunAt: null, spawnRevokeAt: null, failureCount: 0 }
        ),
        true
    );
});

test('a corrupt Kind hitting the same signature alarms too', () => {
    for (const Kind of ['autorenwe', undefined, '', 'ONCE']) {
        assert.strictEqual(
            isUnexpectedStop(
                { Kind },
                { disable: true, nextRunAt: null, spawnRevokeAt: null, failureCount: 0 }
            ),
            true,
            `Kind ${JSON.stringify(Kind)} should alarm`
        );
    }
});

test('a stop that spawned a revoke is a clean end-of-window, not an alarm', () => {
    assert.strictEqual(
        isUnexpectedStop(
            { Kind: 'autorenew' },
            { disable: true, nextRunAt: null, spawnRevokeAt: '2026-12-01T00:00:00.000Z', failureCount: 0 }
        ),
        false
    );
});

test('hitting the failure cap is a failure, not the corrupt-data signature', () => {
    assert.strictEqual(
        isUnexpectedStop(
            { Kind: 'autorenew' },
            { disable: true, nextRunAt: null, spawnRevokeAt: null, failureCount: 5 }
        ),
        false
    );
});
