'use strict';
const test = require('node:test');
const assert = require('node:assert');

// Stub @aws-sdk/* (Lambda-runtime provided) and ../shared/meraki so the handler
// can be driven without AWS. Same Module._load trick as shared/meraki.test.js.
// ponytail: crude Module._load patch; swap for node:test module mocking when it
// leaves experimental.
const Module = require('node:module');

// One distinct class per command name, so tests can assert WHICH command was
// sent (and in what order) rather than trusting a boolean.
const commandClasses = new Map();
const sdkExports = new Proxy({}, {
    get: (_t, name) => {
        if (!commandClasses.has(name)) {
            commandClasses.set(name, class { constructor(input) { this.input = input; } });
            Object.defineProperty(commandClasses.get(name), 'name', { value: String(name) });
        }
        return commandClasses.get(name);
    },
});

// Recorded dynamo traffic: one entry per send, in call order.
const sends = [];
let sendImpl = async () => ({});
let setAuthorizationImpl = async () => ({ newExpiration: '2027-01-01T00:00:00.000Z' });

const merakiStub = {
    setAuthorization: (...args) => setAuthorizationImpl(...args),
    dynamo: {
        send: async cmd => {
            sends.push(cmd);
            return sendImpl(cmd);
        },
    },
};

const load = Module._load;
Module._load = (request, ...rest) => {
    if (request.startsWith('@aws-sdk/')) return sdkExports;
    if (request.endsWith('shared/meraki')) return merakiStub;
    return load(request, ...rest);
};

let sweeper;
try {
    sweeper = require('./index');
} finally {
    Module._load = load; // process-global patch; never leave it installed
}

const {
    revokeScheduleId, isUnexpectedStop, buildScheduleUpdate,
    applyDecision, runOne, pooled, STOPPED_TOKEN, CAP_TOKEN,
} = sweeper;

const NOW = '2026-09-05T00:00:00.000Z';
const okOutcome = { ok: true };

/** Captures console.<level> for the duration of `fn`; returns the lines. */
async function captureConsole(level, fn) {
    const lines = [];
    const original = console[level];
    console[level] = (...args) => lines.push(args.join(' '));
    try {
        await fn();
    } finally {
        console[level] = original;
    }
    return lines;
}

test.beforeEach(() => {
    sends.length = 0;
    sendImpl = async () => ({});
    setAuthorizationImpl = async () => ({ newExpiration: '2027-01-01T00:00:00.000Z' });
});

// ── Ruling 2: write order ─────────────────────────────────────────────────────

test('ruling 2: the spawned revoke is Put BEFORE the parent is disabled', async () => {
    await applyDecision(
        { ScheduleID: 'parent-1', ClientID: 'aa:bb:cc' },
        { disable: true, nextRunAt: null, spawnRevokeAt: '2026-12-01T00:00:00.000Z', failureCount: 0 },
        okOutcome,
        NOW
    );

    assert.strictEqual(sends.length, 2, 'expected exactly a Put then an Update');
    assert.strictEqual(sends[0].constructor.name, 'PutCommand',
        'the revoke row must be written first — disabling the parent first and then ' +
        'crashing leaves the device authorized with nothing scheduled to revoke it');
    assert.strictEqual(sends[1].constructor.name, 'UpdateCommand');

    // And the Put is the revoke, not something else.
    assert.strictEqual(sends[0].input.Item.Action, 'revoke');
    assert.strictEqual(sends[0].input.Item.ScheduleID,
        revokeScheduleId('parent-1', '2026-12-01T00:00:00.000Z'));
    assert.strictEqual(sends[1].input.Key.ScheduleID, 'parent-1');
});

test('ruling 2: a crash while disabling still leaves the revoke row written', async () => {
    // The ordering only matters because the second write can fail. Prove the
    // first one has already landed when it does.
    sendImpl = async cmd => {
        if (cmd.constructor.name === 'UpdateCommand') throw new Error('DynamoDB unavailable');
        return {};
    };

    await assert.rejects(() => applyDecision(
        { ScheduleID: 'parent-1', ClientID: 'aa:bb:cc' },
        { disable: true, nextRunAt: null, spawnRevokeAt: '2026-12-01T00:00:00.000Z', failureCount: 0 },
        okOutcome,
        NOW
    ));

    assert.strictEqual(sends[0].constructor.name, 'PutCommand');
    assert.strictEqual(sends[0].input.Item.Action, 'revoke');
});

test('no spawnRevokeAt means a single Update and no Put', async () => {
    await applyDecision(
        { ScheduleID: 'parent-1', ClientID: 'aa:bb:cc' },
        { disable: false, nextRunAt: '2026-10-01T00:00:00.000Z', spawnRevokeAt: null, failureCount: 0 },
        okOutcome,
        NOW
    );
    assert.deepStrictEqual(sends.map(s => s.constructor.name), ['UpdateCommand']);
});

// ── Ruling 7: every retry is logged ───────────────────────────────────────────

test('ruling 7: a failed run logs the schedule id and the failure count', async () => {
    setAuthorizationImpl = async () => { throw new Error('Meraki API 500'); };

    const warnings = await captureConsole('warn', () => runOne(
        { ScheduleID: 'sched-7', ClientID: 'aa:bb:cc', Kind: 'autorenew', Action: 'extend', FailureCount: 1 },
        NOW
    ));

    const line = warnings.find(l => l.includes('sched-7'));
    assert.ok(line, `expected a warn naming the schedule; got ${JSON.stringify(warnings)}`);
    assert.match(line, /2\/5/, 'must state which attempt this is out of the cap');
    assert.match(line, /retry next sweep/);
});

test('ruling 7: a successful run logs no retry warning', async () => {
    const warnings = await captureConsole('warn', () => runOne(
        { ScheduleID: 'sched-ok', ClientID: 'aa:bb:cc', Kind: 'once', Action: 'extend' },
        NOW
    ));
    assert.deepStrictEqual(warnings, []);
});

// ── Alarm tokens — these strings are the Terraform metric-filter contract ─────

test('the unexpected-stop path emits SCHEDULE_STOPPED_UNEXPECTED', async () => {
    // A corrupt Kind: advanceSchedule stops it clean, with no revoke spawned.
    const errors = await captureConsole('error', () => runOne(
        { ScheduleID: 'sched-corrupt', ClientID: 'aa:bb:cc', Kind: 'autorenwe', Action: 'extend' },
        NOW
    ));

    const line = errors.find(l => l.includes(STOPPED_TOKEN));
    assert.ok(line, `expected ${STOPPED_TOKEN}; got ${JSON.stringify(errors)}`);
    assert.ok(line.includes('sched-corrupt'));
    assert.strictEqual(STOPPED_TOKEN, 'SCHEDULE_STOPPED_UNEXPECTED',
        'token is grepped by aws_cloudwatch_log_metric_filter.sweeper_unexpected_stop');
});

test('a successful once job emits no stop token — it is the normal terminal path', async () => {
    const errors = await captureConsole('error', () => runOne(
        { ScheduleID: 'sched-once', ClientID: 'aa:bb:cc', Kind: 'once', Action: 'revoke' },
        NOW
    ));
    assert.deepStrictEqual(errors.filter(l => l.includes(STOPPED_TOKEN)), []);
});

test('hitting the failure cap emits SCHEDULE_FAILURE_CAP_REACHED', async () => {
    setAuthorizationImpl = async () => { throw new Error('Meraki API 401'); };

    // FailureCount 4 + this failure = 5 = MAX_CONSECUTIVE_FAILURES.
    const errors = await captureConsole('error', () => runOne(
        { ScheduleID: 'sched-cap', ClientID: 'aa:bb:cc', Kind: 'autorenew', Action: 'extend', FailureCount: 4 },
        NOW
    ));

    const line = errors.find(l => l.includes(CAP_TOKEN));
    assert.ok(line, `expected ${CAP_TOKEN}; got ${JSON.stringify(errors)}`);
    assert.ok(line.includes('sched-cap'));
    assert.match(line, /Meraki API 401/, 'the last error is what makes it diagnosable');
    assert.strictEqual(CAP_TOKEN, 'SCHEDULE_FAILURE_CAP_REACHED',
        'token is grepped by aws_cloudwatch_log_metric_filter.sweeper_failure_cap');
});

test('a failure below the cap does not emit the cap token', async () => {
    setAuthorizationImpl = async () => { throw new Error('Meraki API 500'); };

    const errors = await captureConsole('error', () => runOne(
        { ScheduleID: 'sched-3', ClientID: 'aa:bb:cc', Kind: 'autorenew', Action: 'extend', FailureCount: 2 },
        NOW
    ));
    assert.deepStrictEqual(errors.filter(l => l.includes(CAP_TOKEN)), []);
});

test('a failed persist is logged with the schedule id before it rethrows', async () => {
    sendImpl = async () => { throw new Error('AccessDeniedException'); };

    const errors = await captureConsole('error', async () => {
        await assert.rejects(() => runOne(
            { ScheduleID: 'sched-persist', ClientID: 'aa:bb:cc', Kind: 'once', Action: 'revoke' },
            NOW
        ));
    });

    const line = errors.find(l => l.includes('not persisted'));
    assert.ok(line, `expected a persist-failure error; got ${JSON.stringify(errors)}`);
    assert.ok(line.includes('sched-persist'));
});

// ── Concurrency bound ─────────────────────────────────────────────────────────

test('pooled never exceeds its concurrency limit and preserves order', async () => {
    let inFlight = 0;
    let peak = 0;
    const items = Array.from({ length: 20 }, (_, i) => i);

    const results = await pooled(items, 4, async i => {
        peak = Math.max(peak, ++inFlight);
        await new Promise(r => setTimeout(r, 1));
        inFlight--;
        return i * 2;
    });

    assert.ok(peak <= 4, `peak concurrency ${peak} exceeded the limit of 4`);
    assert.strictEqual(peak, 4, 'the pool should actually saturate');
    assert.deepStrictEqual(results.map(r => r.value), items.map(i => i * 2));
});

test('pooled isolates failures the way allSettled did', async () => {
    const results = await pooled([1, 2, 3], 2, async i => {
        if (i === 2) throw new Error('boom');
        return i;
    });

    assert.deepStrictEqual(results.map(r => r.status), ['fulfilled', 'rejected', 'fulfilled']);
    assert.strictEqual(results[1].reason.message, 'boom');
});

// ── Pure helpers ──────────────────────────────────────────────────────────────

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
        NOW
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
        NOW
    );
    assert.ok(upd.UpdateExpression.includes('#next = :next'));
    assert.strictEqual(upd.ExpressionAttributeNames['#next'], 'NextRunAt');
    assert.strictEqual(upd.ExpressionAttributeValues[':next'], '2026-10-01T00:00:00.000Z');
});

test('disable writes Enabled = false', () => {
    const upd = buildScheduleUpdate(
        { disable: true, nextRunAt: null, spawnRevokeAt: null, failureCount: 0 },
        okOutcome,
        NOW
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
