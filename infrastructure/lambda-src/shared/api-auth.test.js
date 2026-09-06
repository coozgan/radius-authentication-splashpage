'use strict';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');

// ── Stub @aws-sdk/client-secrets-manager before requiring the module ──────────

let secretValue = JSON.stringify({ api_key: 'correct-horse' });
let sendCalls = 0;
let sendThrows = null;   // set to an Error to make Secrets Manager fail

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === '@aws-sdk/client-secrets-manager') {
        return {
            SecretsManagerClient: class {
                async send() {
                    sendCalls += 1;
                    if (sendThrows) throw sendThrows;
                    return { SecretString: secretValue };
                }
            },
            GetSecretValueCommand: class { constructor(i) { this.input = i; } },
        };
    }
    return origLoad.apply(this, arguments);
};

process.env.DASHBOARD_KEY_SECRET_ARN = 'arn:aws:secretsmanager:ap-southeast-1:1:secret:test';

let checkApiKey, _resetCacheForTests, CACHE_TTL_MS;
({ checkApiKey, _resetCacheForTests, CACHE_TTL_MS } = require('./api-auth'));

Module._load = origLoad;   // restore immediately; the module is now loaded

const evt = (headers) => ({
    headers,
    rawPath: '/clients',
    requestContext: { http: { method: 'GET' } },
});

test.beforeEach(() => {
    _resetCacheForTests();
    secretValue = JSON.stringify({ api_key: 'correct-horse' });
    sendThrows = null;
    sendCalls = 0;
});

test('authorized request returns null so routing proceeds', async () => {
    assert.strictEqual(await checkApiKey(evt({ 'X-Dashboard-Key': 'correct-horse' })), null);
});

test('header match is case-insensitive on the header NAME', async () => {
    // HTTP header names are case-insensitive; API Gateway v2 lowercases them,
    // but a direct invoke or a future gateway change may not.
    assert.strictEqual(await checkApiKey(evt({ 'x-dashboard-key': 'correct-horse' })), null);
    assert.strictEqual(await checkApiKey(evt({ 'X-DASHBOARD-KEY': 'correct-horse' })), null);
});

test('wrong key is rejected with 403', async () => {
    const res = await checkApiKey(evt({ 'x-dashboard-key': 'wrong' }));
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(JSON.parse(res.body).error, 'Forbidden');
});

test('missing header is rejected with 403', async () => {
    assert.strictEqual((await checkApiKey(evt({}))).statusCode, 403);
    assert.strictEqual((await checkApiKey(evt(undefined))).statusCode, 403);
});

test('key VALUE comparison is case-sensitive', async () => {
    // Guards against a lowercasing "normalisation" being applied to the value.
    assert.strictEqual((await checkApiKey(evt({ 'x-dashboard-key': 'CORRECT-HORSE' }))).statusCode, 403);
});

test('a prefix of the real key is rejected', async () => {
    // Pins that comparison is full-value, not startsWith/includes.
    assert.strictEqual((await checkApiKey(evt({ 'x-dashboard-key': 'correct' }))).statusCode, 403);
});

test('fails CLOSED when the secret is empty', async () => {
    secretValue = JSON.stringify({ api_key: '' });
    // An empty expected key must not authorize an empty presented key.
    assert.strictEqual((await checkApiKey(evt({ 'x-dashboard-key': '' }))).statusCode, 403);
    assert.strictEqual((await checkApiKey(evt({ 'x-dashboard-key': 'anything' }))).statusCode, 403);
});

test('fails CLOSED when the secret has no api_key field', async () => {
    secretValue = JSON.stringify({ wrong_field: 'x' });
    assert.strictEqual((await checkApiKey(evt({ 'x-dashboard-key': 'correct-horse' }))).statusCode, 403);
});

test('a Secrets Manager failure is a 403, not a crash', async () => {
    // The window between `terraform apply` and `put-secret-value`: the secret
    // exists with no value. The gate runs BEFORE the handler's try block, so an
    // escaping throw is a 502 with the raw AWS message, not a 403.
    const e = new Error('Secrets Manager cannot find the specified secret value');
    e.name = 'ResourceNotFoundException';
    sendThrows = e;

    const res = await checkApiKey(evt({ 'x-dashboard-key': 'correct-horse' }));
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(JSON.parse(res.body).error, 'Forbidden');
});

test('unparseable secret JSON is a 403, not a crash', async () => {
    secretValue = 'not json at all';
    assert.strictEqual((await checkApiKey(evt({ 'x-dashboard-key': 'correct-horse' }))).statusCode, 403);
});

test('a read failure is not cached, so recovery needs no redeploy', async () => {
    // Caching the failure would keep the API down after the secret is set.
    const e = new Error('Rate exceeded');
    e.name = 'ThrottlingException';
    sendThrows = e;
    assert.strictEqual((await checkApiKey(evt({ 'x-dashboard-key': 'correct-horse' }))).statusCode, 403);

    sendThrows = null;   // the secret becomes readable
    assert.strictEqual(await checkApiKey(evt({ 'x-dashboard-key': 'correct-horse' })), null);
});

test('the secret is cached across calls', async () => {
    await checkApiKey(evt({ 'x-dashboard-key': 'correct-horse' }));
    await checkApiKey(evt({ 'x-dashboard-key': 'correct-horse' }));
    assert.strictEqual(sendCalls, 1, 'Secrets Manager must be read once per warm container');
});

test('a rotated key is picked up once the cache TTL elapses', async () => {
    // The bug this pins was seen in production: a warm container held the
    // pre-rotation key and rejected the NEW, correct key — the same key
    // alternating 200 and 403 depending on which container answered. Without a
    // TTL that container never recovers, so rotation takes the API down for the
    // container's whole lifetime.
    const realNow = Date.now;
    try {
        let clock = realNow();
        Date.now = () => clock;

        assert.strictEqual(await checkApiKey(evt({ 'x-dashboard-key': 'correct-horse' })), null);

        // Operator rotates the secret.
        secretValue = JSON.stringify({ api_key: 'new-key' });

        // Still inside the TTL: the container legitimately holds the old key.
        assert.strictEqual(await checkApiKey(evt({ 'x-dashboard-key': 'new-key' })).then(r => r?.statusCode), 403);
        assert.strictEqual(sendCalls, 1, 'must not re-read Secrets Manager on every request');

        clock += CACHE_TTL_MS + 1;

        // Past the TTL the new key must work and the old one must not.
        assert.strictEqual(await checkApiKey(evt({ 'x-dashboard-key': 'new-key' })), null);
        assert.strictEqual((await checkApiKey(evt({ 'x-dashboard-key': 'correct-horse' }))).statusCode, 403);
    } finally {
        Date.now = realNow;
    }
});
