'use strict';

/**
 * Cleanup script — deletes DynamoDB records that were incorrectly inserted
 * with MAC address as the ClientID (primary key).
 *
 * Run this ONCE to remove the bad records, then re-run import-clients.js
 * to insert them correctly with client_id as the PK.
 *
 * Usage:
 *   node scripts/cleanup-wrong-imports.js <path-to-csv>
 *
 * Example:
 *   node scripts/cleanup-wrong-imports.js "/Users/joshua/Downloads/ICS Clients - Sheet1.csv"
 */

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, DeleteCommand } = require('@aws-sdk/lib-dynamodb');
const fs = require('fs');

const TABLE_NAME  = process.env.DYNAMODB_TABLE_NAME || 'radius-auth-clients';
const REGION      = process.env.AWS_REGION          || 'ap-southeast-1';
const CONCURRENCY = 5;
const CSV_PATH    = process.argv[2];

if (!CSV_PATH) {
    console.error('Usage: node scripts/cleanup-wrong-imports.js "<path-to-csv>"');
    process.exit(1);
}

const dynamoClient = new DynamoDBClient({ region: REGION });
const docClient    = DynamoDBDocumentClient.from(dynamoClient);

function parseCSV(filePath) {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines   = content.trim().split('\n');
    const headers = lines[0].split(',').map(h => h.trim());
    return lines.slice(1).map(line => {
        const values = line.split(',').map(v => v.trim().replace(/^"|"$/g, ''));
        const row = {};
        headers.forEach((h, idx) => { row[h] = values[idx] || ''; });
        return row;
    });
}

async function deleteItem(clientId) {
    await docClient.send(new DeleteCommand({
        TableName: TABLE_NAME,
        Key: { ClientID: clientId },
    }));
}

async function runWithConcurrency(tasks, concurrency) {
    let index  = 0;
    let done   = 0;
    let errors = 0;
    const total = tasks.length;

    async function worker() {
        while (index < total) {
            const current = index++;
            try {
                await tasks[current]();
                done++;
                process.stdout.write(`\r  Progress: ${done + errors}/${total}  ✓ ${done}  ✗ ${errors}`);
            } catch (err) {
                errors++;
                console.error(`\n  Error on row ${current + 1}: ${err.message}`);
            }
        }
    }

    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    console.log('');
    return { done, errors };
}

async function main() {
    console.log(`Table  : ${TABLE_NAME}`);
    console.log(`Region : ${REGION}`);
    console.log('');

    const rows = parseCSV(CSV_PATH);
    console.log(`Found ${rows.length} client_id-keyed records to delete\n`);

    // Delete records that were wrongly inserted using client_id as the PK
    const tasks = rows.map(row => () => deleteItem(row.client_id));
    const { done, errors } = await runWithConcurrency(tasks, CONCURRENCY);

    console.log('');
    console.log('─────────────────────────────────');
    console.log(`Deleted : ${done}`);
    console.log(`Errors  : ${errors}`);
    console.log('─────────────────────────────────');

    if (errors === 0) {
        console.log('\nCleanup complete. Now run:');
        console.log(`  node scripts/import-clients.js "${CSV_PATH}"`);
    }
}

main().catch(err => {
    console.error('Fatal:', err.message);
    process.exit(1);
});
