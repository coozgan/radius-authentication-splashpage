'use strict';
const test   = require('node:test');
const assert = require('node:assert');

// Stub ../shared/meraki so the handler's routing can be tested without AWS or
// Meraki. Same Module._load trick as shared/meraki.test.js.
// ponytail: crude Module._load patch; swap for node:test module mocking when it
// leaves experimental.
const Module = require('node:module');

const calls = [];
let setAuthorizationImpl = async clientId => ({ clientId, revokedAt: '2026-09-05T10:00:00.000Z' });

// Every dynamo.send() the handler makes, as {type, input} — the schedule routes
// are pure DynamoDB, so this is the only way to see what they would write.
const dynamoCalls = [];
let dynamoImpl = async () => ({});

const stub = {
    setAuthorization: async (clientId, authorized) => {
        calls.push({ clientId, authorized });
        return setAuthorizationImpl(clientId, authorized);
    },
    getAllClients: async () => [],
    deleteOne:     async () => {},
    dynamo: {
        send: async (cmd) => {
            dynamoCalls.push({ type: cmd.constructor.name, input: cmd.input });
            return dynamoImpl(cmd);
        },
    },
};

// @aws-sdk/* is provided by the Lambda runtime, not package.json. Each command
// keeps its input and its class name so assertions can read both.
const command = name => ({ [name]: class { constructor(input) { this.input = input; } } })[name];
const sdkStub = { ScanCommand: command('ScanCommand'), PutCommand: command('PutCommand'), UpdateCommand: command('UpdateCommand') };

const load = Module._load;
Module._load = (request, ...rest) => {
    if (request.endsWith('shared/meraki')) return stub;
    if (request.startsWith('@aws-sdk/')) return sdkStub;
    return load(request, ...rest);
};

let handler;
try {
    ({ handler } = require('./index'));
} finally {
    Module._load = load; // process-global patch; never leave it installed
}

const evt = (method, rawPath, body) => ({
    requestContext: { http: { method } },
    rawPath,
    body: body === undefined ? undefined : JSON.stringify(body),
});

test.beforeEach(() => {
    calls.length = 0;
    dynamoCalls.length = 0;
    setAuthorizationImpl = async clientId => ({ clientId, revokedAt: '2026-09-05T10:00:00.000Z' });
    dynamoImpl = async () => ({});
});

test('POST /clients/{id}/revoke deauthorizes and returns the success envelope', async () => {
    const res = await handler(evt('POST', '/clients/abc123/revoke'));

    assert.deepStrictEqual(calls, [{ clientId: 'abc123', authorized: false }]);
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(JSON.parse(res.body), {
        success:   true,
        clientId:  'abc123',
        revokedAt: '2026-09-05T10:00:00.000Z',
    });
});

test('POST /clients/{id}/revoke URL-decodes the client id', async () => {
    await handler(evt('POST', '/clients/aa%3Abb%3Acc/revoke'));
    assert.strictEqual(calls[0].clientId, 'aa:bb:cc');
});

test('POST /clients/bulk-revoke is not swallowed by the single-revoke matcher', async () => {
    const res = await handler(evt('POST', '/clients/bulk-revoke', { clientIds: ['a', 'b'] }));

    assert.deepStrictEqual(calls, [
        { clientId: 'a', authorized: false },
        { clientId: 'b', authorized: false },
    ]);
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(JSON.parse(res.body), {
        succeeded: [
            { clientId: 'a', revokedAt: '2026-09-05T10:00:00.000Z' },
            { clientId: 'b', revokedAt: '2026-09-05T10:00:00.000Z' },
        ],
        failed: [],
    });
});

test('POST /clients/bulk-revoke reports per-client failures without failing the batch', async () => {
    setAuthorizationImpl = async (clientId) => {
        if (clientId === 'bad') throw new Error('Client not found: bad');
        return { clientId, revokedAt: '2026-09-05T10:00:00.000Z' };
    };

    const res = await handler(evt('POST', '/clients/bulk-revoke', { clientIds: ['good', 'bad'] }));

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(JSON.parse(res.body), {
        succeeded: [{ clientId: 'good', revokedAt: '2026-09-05T10:00:00.000Z' }],
        failed:    [{ clientId: 'bad', error: 'Client not found: bad' }],
    });
});

test('POST /clients/bulk-revoke rejects a missing or empty clientIds array', async () => {
    for (const body of [{}, { clientIds: [] }, { clientIds: 'a' }]) {
        const res = await handler(evt('POST', '/clients/bulk-revoke', body));
        assert.strictEqual(res.statusCode, 400);
        assert.deepStrictEqual(JSON.parse(res.body), { error: 'clientIds must be a non-empty array' });
    }
    assert.deepStrictEqual(calls, []);
});

test('a failing single revoke surfaces as a 500', async () => {
    setAuthorizationImpl = async () => { throw new Error('Meraki API 404: not found'); };

    const res = await handler(evt('POST', '/clients/abc123/revoke'));
    assert.strictEqual(res.statusCode, 500);
    assert.deepStrictEqual(JSON.parse(res.body), { error: 'Meraki API 404: not found' });
});

test('the extend routes still work alongside revoke', async () => {
    setAuthorizationImpl = async clientId => ({ clientId, newExpiration: 'x', lastRenewed: 'y' });

    const res = await handler(evt('POST', '/clients/abc123/extend'));
    assert.deepStrictEqual(calls, [{ clientId: 'abc123', authorized: true }]);
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(JSON.parse(res.body), {
        success: true, clientId: 'abc123', newExpiration: 'x', lastRenewed: 'y',
    });
});

// ── Schedule routes ───────────────────────────────────────────────────────────

const FUTURE = '2099-01-01T00:00:00.000Z';
const validPost = over => ({
    kind: 'once', action: 'revoke', clientId: 'aa:bb:cc', runAt: FUTURE, ...over,
});

test('POST /schedules stores the validated row and echoes it back', async () => {
    const res = await handler(evt('POST', '/schedules', validPost()));

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(dynamoCalls.length, 1);
    assert.strictEqual(dynamoCalls[0].type, 'PutCommand');

    const item = dynamoCalls[0].input.Item;
    assert.strictEqual(item.Kind, 'once');
    assert.strictEqual(item.Action, 'revoke');
    assert.strictEqual(item.ClientID, 'aa:bb:cc');
    assert.strictEqual(item.Enabled, true);
    assert.strictEqual(item.NextRunAt, FUTURE);
    assert.deepStrictEqual(JSON.parse(res.body), item);
});

test('POST /schedules rejects invalid input with a 400 and writes nothing', async () => {
    const bad = [
        validPost({ kind: 'policy' }),
        validPost({ clientId: '' }),
        validPost({ runAt: '2020-01-01T00:00:00.000Z' }),
        validPost({ runAt: 'next tuesday' }),
        { kind: 'autorenew', action: 'extend', clientId: 'aa:bb:cc' }, // no endsAt
    ];
    for (const body of bad) {
        const res = await handler(evt('POST', '/schedules', body));
        assert.strictEqual(res.statusCode, 400, `should reject ${JSON.stringify(body)}`);
        assert.ok(JSON.parse(res.body).error);
    }
    assert.deepStrictEqual(dynamoCalls, [], 'no rejected body may reach DynamoDB');
});

test('POST /schedules answers malformed JSON with a 400, not a 500', async () => {
    const res = await handler({
        requestContext: { http: { method: 'POST' } }, rawPath: '/schedules', body: '{not json',
    });
    assert.strictEqual(res.statusCode, 400);
    assert.deepStrictEqual(dynamoCalls, []);
});

test('a stored row satisfies the sweeper own due filter', async () => {
    // Imported, not re-typed: this fails if the write and the filter ever drift.
    const { dueFilter } = require('../shared/schedule-logic');

    await handler(evt('POST', '/schedules', validPost()));
    const item = dynamoCalls[0].input.Item;

    const { ExpressionAttributeNames: names, ExpressionAttributeValues: vals } = dueFilter(FUTURE);
    // FilterExpression is "#enabled = :true AND #next <= :now" — evaluate it
    // against the row the way DynamoDB would.
    assert.strictEqual(item[names['#enabled']], vals[':true'], 'Enabled must be a native boolean');
    assert.ok(item[names['#next']] <= vals[':now'], 'NextRunAt must compare as a string');
    assert.ok(item.NextRunAt.endsWith('Z'), 'a non-Z offset sorts wrongly against the filter');
});

test('GET /schedules pages the scan and returns newest first', async () => {
    const rows = [
        { ScheduleID: 'old', CreatedAt: '2026-01-01T00:00:00.000Z' },
        { ScheduleID: 'new', CreatedAt: '2026-09-01T00:00:00.000Z' },
    ];
    let page = 0;
    dynamoImpl = async () => (page++ === 0
        ? { Items: [rows[0]], LastEvaluatedKey: { ScheduleID: 'old' } }
        : { Items: [rows[1]] });

    const res = await handler(evt('GET', '/schedules'));

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(dynamoCalls.length, 2, 'must follow LastEvaluatedKey');
    assert.deepStrictEqual(dynamoCalls[1].input.ExclusiveStartKey, { ScheduleID: 'old' });
    assert.deepStrictEqual(JSON.parse(res.body).map(r => r.ScheduleID), ['new', 'old']);
});

test('DELETE /schedules/{id} disables the row rather than deleting it', async () => {
    const res = await handler(evt('DELETE', '/schedules/sched-1'));

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(dynamoCalls[0].type, 'UpdateCommand', 'cancel must not be a DeleteCommand');

    const { input } = dynamoCalls[0];
    assert.deepStrictEqual(input.Key, { ScheduleID: 'sched-1' });

    // The clause must actually be IN the expression, not merely described by
    // the names/values maps. Without this, dropping "#enabled = :false" from
    // the string leaves both maps populated and every other assertion here
    // still true: cancel returns 200, the row keeps Enabled=true, and the
    // sweeper fires the "cancelled" revoke at a live client on its next tick.
    assert.match(input.UpdateExpression, /#enabled\s*=\s*:false/);
    assert.strictEqual(input.ExpressionAttributeNames['#enabled'], 'Enabled');
    assert.strictEqual(input.ExpressionAttributeValues[':false'], false);
    // Aliased for consistency with the sweeper (ENABLED is not itself reserved).
    assert.ok(!/\bSET Enabled\b/.test(input.UpdateExpression), 'Enabled must be aliased');
    // UpdateItem upserts: without this, cancelling an unknown id creates a row
    // with no Kind — the corrupt shape the sweeper alarms on.
    assert.match(input.ConditionExpression, /attribute_exists/);
});

test('DELETE /schedules/{id} URL-decodes the id and 404s an unknown one', async () => {
    dynamoImpl = async () => {
        const e = new Error('The conditional request failed');
        e.name = 'ConditionalCheckFailedException';
        throw e;
    };

    const res = await handler(evt('DELETE', '/schedules/a%2Fb'));
    assert.strictEqual(dynamoCalls[0].input.Key.ScheduleID, 'a/b');
    assert.strictEqual(res.statusCode, 404);
});
