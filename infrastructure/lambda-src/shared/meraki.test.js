'use strict';
const test = require('node:test');
const assert = require('node:assert');

// The @aws-sdk/* packages are provided by the nodejs18.x Lambda runtime, not by
// package.json, so stub them out to load the module under test locally.
// ponytail: crude Module._load patch; swap for node:test module mocking when it
// leaves experimental.
const Module = require('node:module');

// One distinct class per command name so assertions can read WHICH command was
// sent, not just that something was. Same shape as sweeper/index.test.js.
// `from()` is DynamoDBDocumentClient.from(); the plain object it returns is the
// module's `dynamo`, so its send() is attached after load.
const commandClasses = new Map();
const stubExports = new Proxy({}, {
    get: (_t, name) => {
        if (!commandClasses.has(name)) {
            const cls = class {
                constructor(input) { this.input = input; }
                static from() { return {}; }
                // Secrets Manager client: sm.send(new GetSecretValueCommand(..)).
                async send() { return { SecretString: JSON.stringify({ api_key: 'test-key' }) }; }
            };
            Object.defineProperty(cls, 'name', { value: String(name) });
            commandClasses.set(name, cls);
        }
        return commandClasses.get(name);
    },
});

// setAuthorization reads all four at module load, so they must be set first.
process.env.DYNAMODB_TABLE_NAME = 'test-clients';
process.env.MERAKI_SECRET_ARN = 'arn:aws:secretsmanager:test';
process.env.MERAKI_NETWORK_ID = 'N_123';
process.env.SSID_MAP = '{"ICS-Staff":"1","ICS-HS":"7"}';

const load = Module._load;
Module._load = (request, ...rest) =>
    request.startsWith('@aws-sdk/') ? stubExports : load(request, ...rest);

let merakiUtcToSGT, setAuthorization, dynamo;
try {
    ({ merakiUtcToSGT, setAuthorization, dynamo } = require('./meraki'));
} finally {
    Module._load = load; // process-global patch; never leave it installed
}

// ── Harness ───────────────────────────────────────────────────────────────────

const sends = [];         // every dynamo.send, in call order
const fetches = [];       // every Meraki request, as [url, options]
let clientRecord = { ClientID: 'aa:bb:cc', SSID: 'ICS-Staff' };
let merakiResponse = { ok: true, status: 200, body: {} };

dynamo.send = async cmd => {
    sends.push(cmd);
    return cmd.constructor.name === 'GetCommand' ? { Item: clientRecord } : {};
};

globalThis.fetch = async (url, options) => {
    fetches.push([url, options]);
    return {
        ok: merakiResponse.ok,
        status: merakiResponse.status,
        json: async () => merakiResponse.body,
        text: async () => JSON.stringify(merakiResponse.body),
    };
};

/** The UpdateCommand the call under test issued, or undefined. */
const updateSent = () => sends.find(s => s.constructor.name === 'UpdateCommand');
/** The parsed body of the Meraki PUT. */
const putBody = () => JSON.parse(fetches[0][1].body);

test.beforeEach(() => {
    sends.length = 0;
    fetches.length = 0;
    clientRecord = { ClientID: 'aa:bb:cc', SSID: 'ICS-Staff' };
    merakiResponse = { ok: true, status: 200, body: {} };
});

// ── merakiUtcToSGT ────────────────────────────────────────────────────────────

test('merakiUtcToSGT converts Meraki UTC format to SGT ISO 8601', () => {
    assert.strictEqual(
        merakiUtcToSGT('2026-04-24 04:49:29 UTC'),
        '2026-04-24T12:49:29+08:00'
    );
});

test('merakiUtcToSGT rolls the date forward across midnight', () => {
    assert.strictEqual(
        merakiUtcToSGT('2026-04-24 20:30:00 UTC'),
        '2026-04-25T04:30:00+08:00'
    );
});

// ── setAuthorization: revoke ──────────────────────────────────────────────────

test('revoke PUTs isAuthorized false and records the revoke', async () => {
    merakiResponse.body = { ssids: { 1: { isAuthorized: false } } };

    const result = await setAuthorization('aa:bb:cc', false);

    assert.deepStrictEqual(putBody(), { ssids: { 1: { isAuthorized: false } } });
    assert.strictEqual(fetches[0][1].method, 'PUT');
    assert.match(fetches[0][0], /networks\/N_123\/clients\/aa:bb:cc\/splashAuthorizationStatus$/);

    const expr = updateSent().input.UpdateExpression;
    for (const attr of ['ExpirationTimestamp', 'RevokedAt', 'LastUpdated']) {
        assert.match(expr, new RegExp(`\\b${attr} = :`), `revoke must SET ${attr}`);
    }
    assert.match(expr, /\bADD RevokeCount :one\b/);
    // I2: SET and ADD are space-separated in DynamoDB. A comma here is a
    // runtime-only ValidationException — every revoke fails in production.
    assert.doesNotMatch(expr, /,\s*ADD\b/, `no comma before ADD: ${expr}`);

    assert.deepStrictEqual(Object.keys(result).sort(), ['clientId', 'revokedAt']);
    assert.strictEqual(result.clientId, 'aa:bb:cc');
    assert.ok(result.revokedAt.endsWith('Z'), `revokedAt must be UTC ISO 8601: ${result.revokedAt}`);
});

test('revoke throws and writes nothing if Meraki still reports authorized', async () => {
    // The only guard preventing a "revoked" row being written for a device that
    // Meraki did not actually deauthorize.
    merakiResponse.body = { ssids: { 1: { isAuthorized: true } } };

    await assert.rejects(() => setAuthorization('aa:bb:cc', false),
        /still reports the client as authorized/);
    assert.strictEqual(updateSent(), undefined, 'must not record a revoke that did not happen');
});

test('revoke does not require expiresAt — Meraki returns none when deauthorizing', async () => {
    // Deliberate asymmetry with the extend path; asserting it so a "consistency"
    // refactor that adds the validation fails here instead of in production.
    merakiResponse.body = { ssids: { 1: { isAuthorized: false } } };
    await setAuthorization('aa:bb:cc', false);
    assert.ok(updateSent(), 'a revoke with no expiresAt must still be recorded');
});

// ── setAuthorization: extend ──────────────────────────────────────────────────

test('extend PUTs isAuthorized true and records SGT timestamps', async () => {
    merakiResponse.body = {
        ssids: {
            1: {
                isAuthorized: true,
                expiresAt: '2026-04-24 04:49:29 UTC',
                authorizedAt: '2026-01-24 04:49:29 UTC',
            },
        },
    };

    const result = await setAuthorization('aa:bb:cc', true);

    assert.deepStrictEqual(putBody(), { ssids: { 1: { isAuthorized: true } } });

    const expr = updateSent().input.UpdateExpression;
    assert.match(expr, /\bADD RenewalCount :one\b/);
    // I2: same space-separation constraint on the extend branch.
    assert.doesNotMatch(expr, /,\s*ADD\b/, `no comma before ADD: ${expr}`);

    assert.deepStrictEqual(Object.keys(result).sort(),
        ['clientId', 'lastRenewed', 'newExpiration']);
    assert.strictEqual(result.newExpiration, '2026-04-24T12:49:29+08:00');
    assert.strictEqual(result.lastRenewed, '2026-01-24T12:49:29+08:00');
});

test('extend throws if Meraki omits expiresAt', async () => {
    merakiResponse.body = { ssids: { 1: { isAuthorized: true, authorizedAt: '2026-01-24 04:49:29 UTC' } } };
    await assert.rejects(() => setAuthorization('aa:bb:cc', true), /missing expiresAt/);
    assert.strictEqual(updateSent(), undefined);
});

test('extend throws if Meraki does not confirm authorization', async () => {
    merakiResponse.body = { ssids: { 1: { isAuthorized: false } } };
    await assert.rejects(() => setAuthorization('aa:bb:cc', true), /did not confirm authorization/);
    assert.strictEqual(updateSent(), undefined);
});

// ── setAuthorization: failure paths ───────────────────────────────────────────

test('a non-ok Meraki response throws with the status and writes nothing', async () => {
    merakiResponse = { ok: false, status: 429, body: { errors: ['rate limit'] } };

    await assert.rejects(() => setAuthorization('aa:bb:cc', true), /429/);
    assert.strictEqual(updateSent(), undefined, 'a failed Meraki call must not be recorded');
});

test('an unmapped SSID throws before any Meraki call', async () => {
    clientRecord = { ClientID: 'aa:bb:cc', SSID: 'ICS-Guest' };
    await assert.rejects(() => setAuthorization('aa:bb:cc', true), /No SSID number mapping/);
    assert.strictEqual(fetches.length, 0);
});

test('an unknown client throws before any Meraki call', async () => {
    clientRecord = undefined;
    await assert.rejects(() => setAuthorization('nope', true), /Client not found/);
    assert.strictEqual(fetches.length, 0);
});
