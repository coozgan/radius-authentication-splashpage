'use strict';

/**
 * One-time historical import script.
 *
 * Reads the CSV and upserts each row into DynamoDB using if_not_exists()
 * on every field — so existing live records are NEVER overwritten.
 *
 * Usage:
 *   node scripts/import-clients.js <path-to-csv>
 *
 * Example:
 *   node scripts/import-clients.js "/Users/joshua/Downloads/ICS Clients - Sheet1.csv"
 *
 * AWS credentials must be set in the environment before running:
 *   export AWS_ACCESS_KEY_ID=...
 *   export AWS_SECRET_ACCESS_KEY=...
 *   export AWS_SESSION_TOKEN=...  (if using temporary credentials)
 */

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, UpdateCommand } = require('@aws-sdk/lib-dynamodb');
const fs   = require('fs');
const path = require('path');

// ── Config ────────────────────────────────────────────────
const TABLE_NAME  = process.env.DYNAMODB_TABLE_NAME || 'radius-auth-clients';
const REGION      = process.env.AWS_REGION          || 'ap-southeast-1';
const CONCURRENCY = 5;   // parallel writes at a time
const CSV_PATH    = process.argv[2];

if (!CSV_PATH) {
    console.error('Usage: node scripts/import-clients.js "<path-to-csv>"');
    process.exit(1);
}

// ── AWS clients ───────────────────────────────────────────
const dynamoClient = new DynamoDBClient({ region: REGION });
const docClient    = DynamoDBDocumentClient.from(dynamoClient, {
    marshallOptions: { removeUndefinedValues: true },
});

// ── Helpers ───────────────────────────────────────────────

/**
 * Parses the CSV file into an array of objects.
 * Handles quoted fields and trims whitespace.
 */
function parseCSV(filePath) {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines   = content.trim().split('\n');
    const headers = lines[0].split(',').map(h => h.trim());

    return lines.slice(1).map((line, i) => {
        const values = line.split(',').map(v => v.trim().replace(/^"|"$/g, ''));
        const row = {};
        headers.forEach((h, idx) => { row[h] = values[idx] || ''; });
        return row;
    });
}

/**
 * Converts "2026-01-13 01:48:25 UTC" to ISO 8601 SGT string "2026-01-13T09:48:25+08:00"
 */
function utcStringToSGT(utcStr) {
    // Replace space with T and strip trailing " UTC" so Date can parse it
    const normalized = utcStr.replace(' UTC', '').replace(' ', 'T') + 'Z';
    const date       = new Date(normalized);
    if (isNaN(date.getTime())) {
        throw new Error(`Invalid date: ${utcStr}`);
    }

    const SGT_OFFSET_MS = 8 * 60 * 60 * 1000;
    const sgt           = new Date(date.getTime() + SGT_OFFSET_MS);
    const pad           = n => String(n).padStart(2, '0');

    return (
        `${sgt.getUTCFullYear()}-${pad(sgt.getUTCMonth() + 1)}-${pad(sgt.getUTCDate())}` +
        `T${pad(sgt.getUTCHours())}:${pad(sgt.getUTCMinutes())}:${pad(sgt.getUTCSeconds())}+08:00`
    );
}

/**
 * Returns the SGT timestamp + 90 days (expiration).
 */
function addNinetyDays(utcStr) {
    const normalized    = utcStr.replace(' UTC', '').replace(' ', 'T') + 'Z';
    const date          = new Date(normalized);
    const SGT_OFFSET_MS = 8 * 60 * 60 * 1000;
    const expiry        = new Date(date.getTime() + SGT_OFFSET_MS + 90 * 24 * 60 * 60 * 1000);
    const pad           = n => String(n).padStart(2, '0');

    return (
        `${expiry.getUTCFullYear()}-${pad(expiry.getUTCMonth() + 1)}-${pad(expiry.getUTCDate())}` +
        `T${pad(expiry.getUTCHours())}:${pad(expiry.getUTCMinutes())}:${pad(expiry.getUTCSeconds())}+08:00`
    );
}

/**
 * Upserts one CSV row into DynamoDB.
 *
 * Uses if_not_exists() on every attribute so that any record already written
 * by a live authentication is NEVER overwritten by the historical import.
 */
async function upsertRow(row) {
    const clientId            = row.mac;   // MAC address — the only identifier available at auth time
    const connectionTimestamp = utcStringToSGT(row.date);
    const expirationTimestamp = addNinetyDays(row.date);
    const lastUpdated         = new Date().toISOString();

    const command = new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { ClientID: clientId },
        // if_not_exists() means: only set this field if the item is brand-new
        // or this particular attribute has never been written before.
        // Existing live records keep all their current values untouched.
        UpdateExpression: [
            'SET MacAddress          = if_not_exists(MacAddress,          :macAddress)',
            '    ClientName          = if_not_exists(ClientName,          :clientName)',
            '    SSID                = if_not_exists(SSID,                :ssid)',
            '    ConnectionTimestamp = if_not_exists(ConnectionTimestamp, :connectionTimestamp)',
            '    ExpirationTimestamp = if_not_exists(ExpirationTimestamp, :expirationTimestamp)',
            '    LastUpdated         = if_not_exists(LastUpdated,         :lastUpdated)',
            '    ClientIP            = if_not_exists(ClientIP,            :clientIp)',
            '    MerakiClientID      = if_not_exists(MerakiClientID,      :merakiClientId)',
            '    ConnectionCount     = if_not_exists(ConnectionCount,     :one)',
        ].join(', '),
        ExpressionAttributeValues: {
            ':macAddress':          row.mac,
            ':clientName':          row.client_name,
            ':ssid':                row.SSID,
            ':connectionTimestamp': connectionTimestamp,
            ':expirationTimestamp': expirationTimestamp,
            ':lastUpdated':         lastUpdated,
            ':clientIp':            '',
            ':merakiClientId':      row.client_id,
            ':one':                 1,
        },
    });

    await docClient.send(command);
}

/**
 * Runs an array of async tasks with limited concurrency.
 */
async function runWithConcurrency(tasks, concurrency) {
    let index   = 0;
    let done    = 0;
    let errors  = 0;
    const total = tasks.length;

    async function worker() {
        while (index < total) {
            const current = index++;
            const task    = tasks[current];
            try {
                await task();
                done++;
                process.stdout.write(`\r  Progress: ${done + errors}/${total}  ✓ ${done}  ✗ ${errors}`);
            } catch (err) {
                errors++;
                console.error(`\n  Error on row ${current + 1}: ${err.message}`);
            }
        }
    }

    const workers = Array.from({ length: concurrency }, () => worker());
    await Promise.all(workers);
    console.log(''); // newline after progress line
    return { done, errors };
}

// ── Main ──────────────────────────────────────────────────
async function main() {
    console.log(`Table  : ${TABLE_NAME}`);
    console.log(`Region : ${REGION}`);
    console.log(`CSV    : ${path.resolve(CSV_PATH)}`);
    console.log('');

    const rows = parseCSV(CSV_PATH);
    console.log(`Parsed ${rows.length} rows from CSV`);
    console.log('Starting import (existing live records will not be overwritten)...\n');

    const tasks = rows.map(row => () => upsertRow(row));
    const { done, errors } = await runWithConcurrency(tasks, CONCURRENCY);

    console.log('');
    console.log('─────────────────────────────────');
    console.log(`Total rows  : ${rows.length}`);
    console.log(`Inserted    : ${done}`);
    console.log(`Errors      : ${errors}`);
    console.log('─────────────────────────────────');

    if (errors > 0) {
        console.log('\nSome rows failed. Check errors above and re-run — the script is safe to re-run.');
        process.exit(1);
    } else {
        console.log('\nImport complete.');
    }
}

main().catch(err => {
    console.error('Fatal error:', err.message);
    process.exit(1);
});
