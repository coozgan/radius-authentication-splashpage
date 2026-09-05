'use strict';
const test = require('node:test');
const assert = require('node:assert');

// The @aws-sdk/* packages are provided by the nodejs18.x Lambda runtime, not by
// package.json, so stub them out to load the module under test locally.
// ponytail: crude Module._load patch; swap for node:test module mocking when it
// leaves experimental.
const Module = require('node:module');
const Stub = class { static from() { return {}; } };
const stubExports = new Proxy({}, { get: () => Stub });
const load = Module._load;
Module._load = (request, ...rest) =>
    request.startsWith('@aws-sdk/') ? stubExports : load(request, ...rest);

const { merakiUtcToSGT } = require('./meraki');

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
