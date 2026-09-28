'use strict';

// Build the TC-002 starting fixture from the TC-001 reference files.
// The existing fixture is never overwritten.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'docs/testing/fixtures/TC-002-after-TC-001');
const referenceDir = path.join(root, 'docs/testing/reference-data/TC-001');
const names = ['data.json', 'data.tmp.json', 'rulesLog.json', 'rulesLog.tmp.json', 'graph.json', 'graph.tmp.json'];

function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function writeJson(file, value) { fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8'); }
function sha256(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }

if (fs.existsSync(outDir)) throw new Error(`Refusing to overwrite existing fixture directory: ${outDir}`);
const data = readJson(path.join(referenceDir, 'data.json'));
const log = readJson(path.join(referenceDir, 'rulesLog.json'));
const graph = readJson(path.join(referenceDir, 'graph.json'));
const expectedDates = ['2026-06-02', '2026-05-31', '2026-05-29'];
if (!Array.isArray(data) || data.length !== 3 || data.some((event, i) => event.date !== expectedDates[i]
    || Object.keys(event).join(',') !== 'date,values')) {
    throw new Error('TC-001 reference events must contain date/values in newest-first order');
}
if (!Array.isArray(log.rules) || log.rules.length !== 2
    || log.rules.some((rule, i) => rule.version !== i + 1 || !Array.isArray(rule.examples) || !rule.examples.length)) {
    throw new Error('TC-001 reference log must contain two nonempty rule versions with examples');
}
if (!Array.isArray(graph.relations) || graph.relations.length !== 2
    || graph.relations.some((relation) => relation.type !== 'A+B')
    || 'targets' in graph || 'trends' in graph) {
    throw new Error('TC-001 reference graph must contain the two A+B relations only');
}

fs.mkdirSync(outDir, { recursive: false });
for (const name of ['data.json', 'rulesLog.json', 'graph.json']) {
    fs.copyFileSync(path.join(referenceDir, name), path.join(outDir, name));
}
writeJson(path.join(outDir, 'data.tmp.json'), []);
writeJson(path.join(outDir, 'rulesLog.tmp.json'), { rules: [] });
writeJson(path.join(outDir, 'graph.tmp.json'), { relations: [] });
fs.writeFileSync(path.join(outDir, 'SHA256SUMS'),
    names.map((name) => `${sha256(path.join(outDir, name))}  ${name}`).join('\n') + '\n', 'utf8');
console.log(JSON.stringify({ fixture: outDir, dates: data.map((event) => event.date),
    versions: log.rules.map((rule) => rule.version), graphRelations: graph.relations.length,
    hashes: Object.fromEntries(names.map((name) => [name, sha256(path.join(outDir, name))])) }, null, 2));
