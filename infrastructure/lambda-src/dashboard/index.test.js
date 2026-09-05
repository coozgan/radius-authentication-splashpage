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

const stub = {
    setAuthorization: async (clientId, authorized) => {
        calls.push({ clientId, authorized });
        return setAuthorizationImpl(clientId, authorized);
    },
    getAllClients: async () => [],
    deleteOne:     async () => {},
};

const load = Module._load;
Module._load = (request, ...rest) =>
    request.endsWith('shared/meraki') ? stub : load(request, ...rest);

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
    setAuthorizationImpl = async clientId => ({ clientId, revokedAt: '2026-09-05T10:00:00.000Z' });
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
