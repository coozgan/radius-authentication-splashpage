'use strict';

/**
 * Validates and normalises schedule-creation input. This is the trust
 * boundary: the sweeper acts unattended on whatever gets stored, so nothing
 * beyond this point re-checks the shape.
 *
 * All timestamps are normalised to UTC ISO 8601 — NextRunAt and EndsAt are
 * compared as strings in DynamoDB, so a "+08:00" offset would sort before a
 * "Z" value of the same instant and fire at the wrong time.
 *
 * Invalid input is rejected, never coerced: no clamping a past time to now, no
 * defaulting a missing endsAt, no guessing a kind. A coerced row is an
 * unattended wrong action against a real network later.
 */

const { newScheduleId } = require('./schedule-logic');

const KINDS = new Set(['once', 'autorenew']);
const ACTIONS = new Set(['extend', 'revoke']);
const MAX_NOTE = 500;
const MAX_CLIENT_ID = 256;

/**
 * Epoch ms for an ISO-8601 *string*, or null if absent, non-string or
 * unparseable.
 *
 * The string check is load-bearing, not defensive noise. `new Date(null)` and
 * `new Date(0)` are epoch, `new Date(true)` is 1ms after it, and a raw epoch
 * number parses to a perfectly valid date — all of them slip past a bare
 * Number.isNaN test and would be stored as a timestamp nobody typed.
 */
function parseMs(value) {
    if (typeof value !== 'string' || value.trim() === '') return null;
    const ms = new Date(value).getTime();
    return Number.isFinite(ms) ? ms : null;
}

/** UTC ISO 8601 for a timestamp string, or null if it is not one. */
function toUtcIso(value) {
    const ms = parseMs(value);
    return ms === null ? null : new Date(ms).toISOString();
}

/**
 * @param body   the parsed request body
 * @param nowIso UTC ISO 8601 — the caller's clock
 * @returns {{ok: true, item: object} | {ok: false, error: string}}
 */
function validateScheduleInput(body, nowIso) {
    // A NaN clock would make every "is this in the past" comparison false and
    // wave the whole set through — the Task 7 fail-open defect. Check it first.
    const nowMs = parseMs(nowIso);
    if (nowMs === null) return { ok: false, error: 'nowIso must be a valid timestamp' };
    const createdAt = new Date(nowMs).toISOString();

    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        return { ok: false, error: 'body must be a JSON object' };
    }

    const { kind, action, clientId, runAt, endsAt, note } = body;

    if (!KINDS.has(kind)) return { ok: false, error: `kind must be one of: ${[...KINDS].join(', ')}` };
    if (!ACTIONS.has(action)) return { ok: false, error: `action must be one of: ${[...ACTIONS].join(', ')}` };
    if (typeof clientId !== 'string' || !clientId.trim()) return { ok: false, error: 'clientId is required' };
    if (clientId.trim().length > MAX_CLIENT_ID) return { ok: false, error: `clientId must be at most ${MAX_CLIENT_ID} characters` };
    if (note !== undefined && typeof note !== 'string') return { ok: false, error: 'note must be a string' };

    const item = {
        ScheduleID: newScheduleId(),
        Kind: kind,
        ClientID: clientId.trim(),
        Enabled: true,
        RunCount: 0,
        FailureCount: 0,
        CreatedAt: createdAt,
    };
    if (note) item.Note = note.slice(0, MAX_NOTE);

    if (kind === 'once') {
        const at = parseMs(runAt);
        if (at === null) return { ok: false, error: 'runAt must be a valid timestamp' };
        // <= not <: a row whose NextRunAt equals now is already due on the sweep
        // running right now, which is an immediate action, not a scheduled one.
        if (at <= nowMs) return { ok: false, error: 'runAt is in the past' };
        item.Action = action;
        item.NextRunAt = new Date(at).toISOString();
        return { ok: true, item };
    }

    // autorenew: always an extend, always bounded, first check immediately.
    // EndsAt is the only bound on renewal, so a missing one is invalid input —
    // not a licence to renew forever.
    const ends = parseMs(endsAt);
    if (ends === null) return { ok: false, error: 'endsAt is required for autorenew and must be a valid timestamp' };
    if (ends <= nowMs) return { ok: false, error: 'endsAt is in the past' };
    item.Action = 'extend';
    item.EndsAt = new Date(ends).toISOString();
    item.NextRunAt = createdAt;
    return { ok: true, item };
}

module.exports = { validateScheduleInput, toUtcIso };
