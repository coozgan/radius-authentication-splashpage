'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { validateScheduleInput } = require('./validate-schedule');

const NOW = '2026-09-05T04:00:00.000Z';
const OK = { kind: 'once', action: 'revoke', clientId: 'aa:bb:cc', runAt: '2026-09-06T04:00:00.000Z' };

test('accepts a valid once job and normalises timestamps to UTC', () => {
    const r = validateScheduleInput({ ...OK, runAt: '2026-09-06T12:00:00+08:00' }, NOW);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.item.NextRunAt, '2026-09-06T04:00:00.000Z');
    assert.strictEqual(r.item.Enabled, true);
    assert.strictEqual(r.item.FailureCount, 0);
});

test('rejects an unknown kind', () => {
    const r = validateScheduleInput({ ...OK, kind: 'policy' }, NOW);
    assert.strictEqual(r.ok, false);
});

test('rejects an unknown kind on its own merits, not by a later check', () => {
    // Deleting the kind guard alone must break something. Without this, an
    // unknown kind only fails because it falls through to the autorenew branch
    // and trips the endsAt check — so the same body *with* a valid endsAt would
    // be stored with Kind 'policy', which the sweeper treats as corrupt.
    for (const kind of ['policy', 'ONCE', 'recurring', '', 'once ', undefined, null, 1, {}]) {
        const r = validateScheduleInput(
            { ...OK, kind, endsAt: '2027-06-30T16:00:00.000Z' },
            NOW
        );
        assert.strictEqual(r.ok, false, `kind ${JSON.stringify(kind)} should be rejected`);
        assert.match(r.error, /kind/i, `kind ${JSON.stringify(kind)} should fail on the kind check`);
    }
});

test('rejects a missing clientId', () => {
    const r = validateScheduleInput({ ...OK, clientId: '' }, NOW);
    assert.strictEqual(r.ok, false);
});

test('rejects a once job scheduled in the past', () => {
    const r = validateScheduleInput({ ...OK, runAt: '2026-09-04T04:00:00.000Z' }, NOW);
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /past/i);
});

test('rejects an unparseable timestamp', () => {
    const r = validateScheduleInput({ ...OK, runAt: 'next tuesday' }, NOW);
    assert.strictEqual(r.ok, false);
});

test('requires endsAt on autorenew', () => {
    const r = validateScheduleInput({ kind: 'autorenew', action: 'extend', clientId: 'aa:bb:cc' }, NOW);
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /endsAt/i);
});

test('accepts autorenew and sets its first run to now', () => {
    const r = validateScheduleInput(
        { kind: 'autorenew', action: 'extend', clientId: 'aa:bb:cc', endsAt: '2027-06-30T16:00:00.000Z' },
        NOW
    );
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.item.NextRunAt, NOW);
    assert.strictEqual(r.item.Action, 'extend');
});

test('forces autorenew action to extend even if the caller says revoke', () => {
    const r = validateScheduleInput(
        { kind: 'autorenew', action: 'revoke', clientId: 'aa:bb:cc', endsAt: '2027-06-30T16:00:00.000Z' },
        NOW
    );
    assert.strictEqual(r.item.Action, 'extend');
});

test('rejects autorenew whose endsAt has already passed', () => {
    const r = validateScheduleInput(
        { kind: 'autorenew', action: 'extend', clientId: 'aa:bb:cc', endsAt: '2020-01-01T00:00:00.000Z' },
        NOW
    );
    assert.strictEqual(r.ok, false);
});

// ── Fail-closed cases ─────────────────────────────────────────────────────────
// Task 7 shipped a defect where new Date(undefined).getTime() gave NaN and every
// comparison silently returned false — a fail-open. These pin the opposite.

test('rejects a runAt exactly equal to now', () => {
    // Pins <= rather than <. A row written with NextRunAt === now is already due
    // on the sweep that is running right now, so "scheduled" means "immediate".
    const r = validateScheduleInput({ ...OK, runAt: NOW }, NOW);
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /past/i);
});

test('rejects an endsAt exactly equal to now', () => {
    const r = validateScheduleInput(
        { kind: 'autorenew', action: 'extend', clientId: 'aa:bb:cc', endsAt: NOW },
        NOW
    );
    assert.strictEqual(r.ok, false);
});

test('rejects non-string timestamps rather than coercing them', () => {
    // new Date(null) is epoch 0 and new Date(0) is a valid date: both would slip
    // past a bare Number.isNaN check.
    for (const runAt of [null, 0, 1788000000000, true, {}, [], ['2027-01-01T00:00:00Z']]) {
        const r = validateScheduleInput({ ...OK, runAt }, NOW);
        assert.strictEqual(r.ok, false, `runAt ${JSON.stringify(runAt)} should be rejected`);
    }
});

test('fails closed on a missing or unparseable body', () => {
    for (const body of [undefined, null, {}, 'nonsense', 42]) {
        assert.strictEqual(validateScheduleInput(body, NOW).ok, false);
    }
});

test('fails closed when nowIso itself is unusable', () => {
    // A NaN clock must not make every "is it in the past" comparison false.
    for (const now of [undefined, null, 'not a date', '']) {
        const r = validateScheduleInput(OK, now);
        assert.strictEqual(r.ok, false, `now ${JSON.stringify(now)} should be rejected`);
    }
});

test('rejects an unknown action on a once job', () => {
    const r = validateScheduleInput({ ...OK, action: 'reboot' }, NOW);
    assert.strictEqual(r.ok, false);
});

test('normalises CreatedAt and EndsAt to UTC too', () => {
    const r = validateScheduleInput(
        { kind: 'autorenew', action: 'extend', clientId: 'aa:bb:cc', endsAt: '2027-07-01T00:00:00+08:00' },
        '2026-09-05T12:00:00+08:00'
    );
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.item.EndsAt, '2027-06-30T16:00:00.000Z');
    assert.strictEqual(r.item.CreatedAt, NOW);
    assert.strictEqual(r.item.NextRunAt, NOW);
});

test('trims clientId and bounds an oversized one', () => {
    const r = validateScheduleInput({ ...OK, clientId: '  aa:bb:cc  ' }, NOW);
    assert.strictEqual(r.item.ClientID, 'aa:bb:cc');

    const tooLong = validateScheduleInput({ ...OK, clientId: 'x'.repeat(300) }, NOW);
    assert.strictEqual(tooLong.ok, false);
});

test('truncates an overlong note instead of storing it whole', () => {
    const r = validateScheduleInput({ ...OK, note: 'n'.repeat(900) }, NOW);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.item.Note.length, 500);
});

test('gives every schedule its own id', () => {
    const a = validateScheduleInput(OK, NOW);
    const b = validateScheduleInput(OK, NOW);
    assert.notStrictEqual(a.item.ScheduleID, b.item.ScheduleID);
    assert.match(a.item.ScheduleID, /^[0-9a-f-]{36}$/);
});

test('never emits a row the sweeper would treat as a different kind', () => {
    // The sweeper switches on Kind and Action verbatim; anything it does not
    // recognise stops the row. Whatever we store must be one of its known values.
    for (const kind of ['once', 'autorenew']) {
        const body = kind === 'once'
            ? OK
            : { kind, action: 'extend', clientId: 'aa:bb:cc', endsAt: '2027-06-30T16:00:00.000Z' };
        const r = validateScheduleInput({ ...body, kind }, NOW);
        assert.strictEqual(r.ok, true);
        assert.ok(['once', 'autorenew'].includes(r.item.Kind));
        assert.ok(['extend', 'revoke'].includes(r.item.Action));
        assert.strictEqual(typeof r.item.NextRunAt, 'string');
        assert.ok(r.item.NextRunAt.endsWith('Z'));
    }
});
