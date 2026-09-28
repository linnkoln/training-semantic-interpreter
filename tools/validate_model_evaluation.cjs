'use strict';

// Read-only preflight for the model evaluation protocol. No LLM or storage calls.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const manifestPath = path.join(root, 'docs/testing/model-evaluation/CASE_MANIFEST.json');
const errors = [];
let hashesChecked = 0;
function sha(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function resolveSource(relative) {
    const absolute = path.resolve(root, relative);
    if (!absolute.startsWith(root + path.sep)) throw new Error(`Source outside repository: ${relative}`);
    return absolute;
}
function read(relative) { return fs.readFileSync(resolveSource(relative)); }
function checkFile(record) {
    try {
        const bytes = read(record.path);
        if (sha(bytes) !== record.sha256) errors.push(`Snapshot changed: ${record.path}`);
        hashesChecked++;
    } catch (error) { errors.push(`${record.path}: ${error.message}`); }
}
try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (manifest.schemaVersion !== 1) errors.push('Unsupported manifest schema');
    if (manifest.independentQualificationRepeats !== 3) errors.push('Qualification requires three independent repeats');
    const ids = manifest.cases.map(item => item.caseId);
    if (JSON.stringify(ids) !== JSON.stringify(['TC-001', 'TC-002'])) errors.push('Expected TC-001 and TC-002 once each');
    for (const record of [...manifest.authoritySources, ...manifest.baselinePrompts]) checkFile(record);
    for (const item of manifest.cases) {
        for (const record of [item.input.source, item.spec, ...item.initialState.files, ...item.oracle.files]) checkFile(record);
        const inputSource = JSON.parse(read(item.input.source.path));
        if (typeof inputSource.input !== 'string' || sha(inputSource.input) !== item.input.textSha256) {
            errors.push(`Input mismatch: ${item.caseId}`);
        }
        const expectedGroups = item.caseId === 'TC-001' ? [3, 2, 1] : [1, 1, 3];
        if (JSON.stringify(item.expectedRouterGroups) !== JSON.stringify(expectedGroups)) errors.push(`Group mismatch: ${item.caseId}`);
        const expectedDates = item.caseId === 'TC-001' ? ['2026-05-29', '2026-05-31', '2026-06-02'] : ['2026-07-17', '2026-07-19', '2026-07-21'];
        if (JSON.stringify(item.processingDates) !== JSON.stringify(expectedDates)) errors.push(`Date mismatch: ${item.caseId}`);
        const events = JSON.parse(read(item.oracle.files.find(file => file.path.endsWith('/data.json')).path));
        if (!Array.isArray(events) || events.length !== (item.caseId === 'TC-001' ? 3 : 6)) errors.push(`Oracle event count: ${item.caseId}`);
        for (const event of events) {
            if (Object.keys(event).sort().join(',') !== 'date,values') errors.push(`Unexpected event fields: ${item.caseId} ${event.date}`);
        }
        if (JSON.stringify(events.slice(0, 3).map(event => event.date)) !== JSON.stringify([...expectedDates].reverse())) errors.push(`Oracle event ordering: ${item.caseId}`);
        const sums = read(item.initialState.checksumsPath).toString('utf8').trim().split(/\r?\n/);
        for (const line of sums) {
            const match = /^([a-f0-9]{64})\s+(.+)$/.exec(line);
            if (!match || sha(read(`${item.initialState.directory}/${match[2]}`)) !== match[1]) errors.push(`Fixture checksum: ${item.caseId} ${line}`);
        }
    }
    const profile = JSON.parse(read('docs/testing/model-evaluation/MODEL_PROFILE.example.json'));
    if (profile.scope !== 'router-stage-only' || profile.latencyTargetMs !== null) errors.push('Example profile exceeds its measured scope');
} catch (error) { errors.push(error.stack || String(error)); }
if (errors.length) {
    console.error(JSON.stringify({ status: 'FAIL', scope: 'registry-preflight-only', errors }, null, 2));
    process.exitCode = 1;
} else {
    console.log(JSON.stringify({ status: 'PASS', scope: 'registry-preflight-only', hashesChecked, modelCalls: 0,
        note: 'Source snapshot is consistent; no model quality or live acceptance result was produced.' }, null, 2));
}
