'use strict';

// Read-only consistency check for the orchestrator handoff and acceptance plan.
// Run from any working directory: node tools/check_test_docs.js

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const DOCS = [
    'docs/ORCHESTRATOR_HANDOFF.md',
    'docs/testing/TESTING_PROTOCOL.md',
    'docs/testing/TEST_MATRIX.md',
    'docs/testing/OBSIDIAN_ACCEPTANCE_RUNBOOK.md',
    'docs/testing/EXECUTION_REPORT_TEMPLATE.md',
    'docs/testing/reports/2026-09-23-local-regression.md',
    'docs/testing/fixtures/TC-001-empty-state/README.md',
    'docs/testing/fixtures/TC-002-after-TC-001/README.md',
    'docs/testing/cases/TC-001-empty-rules-table/TC-001-report.md',
    'docs/testing/cases/TC-002-max-approaches/TC-002-run-report.md',
];
const PROJECT_SKILL = '.hermes/skills/training-orchestrator/SKILL.md';
const errors = [];
let linkCount = 0;
const testFiles = new Set();

function read(relativePath) {
    const absolute = path.join(ROOT, relativePath);
    if (!fs.existsSync(absolute)) {
        errors.push(`missing file: ${relativePath}`);
        return '';
    }
    return fs.readFileSync(absolute, 'utf8');
}

for (const doc of DOCS) {
    const contents = read(doc);
    const base = path.dirname(path.join(ROOT, doc));
    const links = contents.matchAll(/\[[^\]]+\]\(([^)#]+)(?:#[^)]+)?\)/g);
    for (const match of links) {
        const target = match[1].trim();
        if (/^(?:https?:|mailto:|#)/i.test(target)) continue;
        linkCount++;
        const decoded = decodeURIComponent(target);
        if (!fs.existsSync(path.resolve(base, decoded))) {
            errors.push(`broken link: ${doc} -> ${target}`);
        }
    }
}
read(PROJECT_SKILL);

const matrix = read('docs/testing/TEST_MATRIX.md');
const stepIds = [...matrix.matchAll(/^\|\s*(\d{2})\s*\|/gm)].map((m) => Number(m[1]));
if (stepIds.length !== 20 || stepIds.some((id, index) => id !== index + 1)) {
    errors.push(`matrix must contain steps 01..20 exactly once; found: ${stepIds.join(',')}`);
}
for (const match of matrix.matchAll(/`(tests\/[^`]+\.test\.js)`/g)) testFiles.add(match[1]);
for (const relativePath of testFiles) {
    if (!fs.existsSync(path.join(ROOT, relativePath))) errors.push(`matrix references missing test: ${relativePath}`);
}

const fixturesRoot = path.join(ROOT, 'docs/testing/fixtures');
let fixtureCount = 0;
const fixtureDirs = ['TC-001-empty-state', 'TC-002-after-TC-001'];
const fixtureNamesByDir = new Map();
for (const fixtureName of fixtureDirs) {
    const fixtureDir = path.join(fixturesRoot, fixtureName);
    const sumPath = path.join(fixtureDir, 'SHA256SUMS');
    const names = new Set();
    if (!fs.existsSync(sumPath)) {
        errors.push(`missing ${fixtureName} fixture SHA256SUMS`);
        fixtureNamesByDir.set(fixtureName, names);
        continue;
    }
    for (const line of fs.readFileSync(sumPath, 'utf8').split(/\r?\n/).filter(Boolean)) {
        const match = /^([a-f0-9]{64})\s+(.+)$/.exec(line);
        if (!match) {
            errors.push(`invalid SHA256SUMS line in ${fixtureName}: ${line}`);
            continue;
        }
        const [, expected, name] = match;
        names.add(name);
        fixtureCount++;
        const filePath = path.join(fixtureDir, name);
        if (!fs.existsSync(filePath)) {
            errors.push(`missing fixture file: ${fixtureName}/${name}`);
            continue;
        }
        const actual = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
        if (actual !== expected) errors.push(`fixture SHA-256 mismatch: ${fixtureName}/${name}`);
    }
    fixtureNamesByDir.set(fixtureName, names);
}
const expectedFixtureNames = ['data.json', 'graph.json', 'graph.tmp.json', 'rulesLog.json', 'rulesLog.tmp.json', 'data.tmp.json'];
for (const fixtureName of fixtureDirs) {
    const names = fixtureNamesByDir.get(fixtureName) || new Set();
    if (names.size !== expectedFixtureNames.length || expectedFixtureNames.some((name) => !names.has(name))) {
        errors.push(`${fixtureName} must manifest exactly six known JSON files; found: ${[...names].join(',')}`);
    }
}

// Verify the TC-002 baseline is an exact copy of the current TC-001 oracle.
try {
    const seedDir = path.join(fixturesRoot, 'TC-002-after-TC-001');
    const referenceDir = path.join(ROOT, 'docs/testing/reference-data/TC-001');
    for (const name of ['data.json', 'rulesLog.json', 'graph.json']) {
        if (!fs.readFileSync(path.join(seedDir, name)).equals(fs.readFileSync(path.join(referenceDir, name)))) {
            errors.push(`TC-002 seed ${name} must exactly match TC-001 reference data`);
        }
    }
} catch (error) { errors.push(`TC-002 seed state invalid (${error.message})`); }

const runbook = read('docs/testing/OBSIDIAN_ACCEPTANCE_RUNBOOK.md');
for (const oracleToken of ['затем каждый день по отдельности проходит Router', 'pull_rings_reps: 0', 'pull_reps: 50', '`overlay`', 'data/training/data.tmp.json', 'TC-002-after-TC-001']) {
    if (!runbook.includes(oracleToken)) errors.push(`runbook missing current user oracle/setup: ${oracleToken}`);
}
const seedGenerator = read('tools/prepare_tc002_seed.js');
if (!runbook.includes('штатную кнопку «Очистить память (полный сброс)»')
    || !runbook.includes('TC-002-after-TC-001')
    || !seedGenerator.includes('Refusing to overwrite existing fixture directory')) {
    errors.push('runbook must use current-Vault reset procedure and preserve the guarded TC-002 seed generator');
}
for (const required of ['каждая сущность должна отображаться один раз', 'каждый checkbox упражнения отдельно', 'повторные графические панели внутри виджета']) {
    if (!runbook.includes(required)) errors.push(`runbook missing chart UI acceptance check: ${required}`);
}

const canvasRefs = [
    {
        file: 'docs/testing/cases/TC-001-empty-rules-table/TC-001-spec.canvas',
        ids: ['input', 'router', 'cycle-1', 'cycle-2', 'cycle-3', 'staged', 'final-data', 'final-rules', 'final-graph'],
    },
    {
        file: 'docs/testing/cases/TC-002-max-approaches/TC-002-spec.canvas',
        ids: ['input', 'router', 'cycle-1', 'cycle-2', 'cycle-3', 'staged', 'final-data', 'final-rules', 'final-graph'],
    },
    {
        file: 'docs/user/artifacts/architecture.canvas',
        ids: ['876517b7408594de', 'staged', 'save'],
    },
];
let sourceNodeCount = 0;
const canvasData = new Map();
for (const ref of canvasRefs) {
    let nodes;
    try { nodes = JSON.parse(read(ref.file)).nodes || []; }
    catch (error) { errors.push(`invalid Canvas JSON: ${ref.file} (${error.message})`); continue; }
    canvasData.set(ref.file, nodes);
    const ids = new Set(nodes.map((node) => node.id));
    for (const id of ref.ids) {
        sourceNodeCount++;
        if (!ids.has(id)) errors.push(`missing cited source node: ${ref.file}#${id}`);
    }
}
for (const caseId of ['TC-001', 'TC-002']) {
    const canvasFile = caseId === 'TC-001'
        ? 'docs/testing/cases/TC-001-empty-rules-table/TC-001-spec.canvas'
        : 'docs/testing/cases/TC-002-max-approaches/TC-002-spec.canvas';
    const nodes = canvasData.get(canvasFile) || [];
    const router = nodes.find((node) => node.id === 'router')?.text || '';
    if (!router.includes('три вызова Router') || !router.includes('Cutter')) {
        errors.push(`${caseId} Canvas must show Cutter followed by three per-day Router calls`);
    }
    for (const [id, file] of [['final-data', 'data.json'], ['final-rules', 'rulesLog.json'], ['final-graph', 'graph.json']]) {
        const expected = read(`docs/testing/reference-data/${caseId}/${file}`).trimEnd();
        const node = nodes.find((item) => item.id === id);
        if (!node?.text?.includes('```json\n' + expected + '\n```')) {
            errors.push(`${caseId} Canvas ${id} must duplicate the full ${file} reference`);
        }
    }
    try {
        const referenceDir = path.join(ROOT, 'docs/testing/reference-data', caseId);
        const events = JSON.parse(fs.readFileSync(path.join(referenceDir, 'data.json'), 'utf8'));
        const log = JSON.parse(fs.readFileSync(path.join(referenceDir, 'rulesLog.json'), 'utf8'));
        const graph = JSON.parse(fs.readFileSync(path.join(referenceDir, 'graph.json'), 'utf8'));
        const expectedVersions = caseId === 'TC-001' ? [1, 2] : [1, 2, 3];
        const expectedRelationCount = caseId === 'TC-001' ? 2 : 4;
        if (JSON.stringify((log.rules || []).map((rule) => rule.version)) !== JSON.stringify(expectedVersions)
            || (log.rules || []).some((rule) => !Array.isArray(rule.examples) || rule.examples.length === 0)) {
            errors.push(`${caseId} reference rules must retain all nonempty versions and examples`);
        }
        if (!Array.isArray(graph.relations) || graph.relations.length !== expectedRelationCount
            || 'targets' in graph || 'trends' in graph) {
            errors.push(`${caseId} reference graph must retain all semantic relations without targets/trends`);
        }
        if (!Array.isArray(events) || events.some((event, index) =>
            Object.keys(event).join(',') !== 'date,values'
            || (index > 0 && events[index - 1].date < event.date))) {
            errors.push(`${caseId} reference events must contain date/values newest first`);
        }
        if (caseId === 'TC-002') {
            const previousDir = path.join(ROOT, 'docs/testing/reference-data/TC-001');
            const previousLog = JSON.parse(fs.readFileSync(path.join(previousDir, 'rulesLog.json'), 'utf8'));
            const previousGraph = JSON.parse(fs.readFileSync(path.join(previousDir, 'graph.json'), 'utf8'));
            if (JSON.stringify(log.rules.slice(0, 2)) !== JSON.stringify(previousLog.rules)
                || JSON.stringify(graph.relations.slice(0, 2)) !== JSON.stringify(previousGraph.relations)) {
                errors.push('TC-002 must preserve both prior rule versions and A+B relations from TC-001');
            }
            const prior = log.rules.at(-2)?.mapping || {};
            const current = log.rules.at(-1)?.mapping || {};
            for (const key of ['push_knees_reps', 'pull_rings_reps']) {
                if (!(key in prior) || key in current) {
                    errors.push(`TC-002 must retain ${key} in old rules but remove it from the current rule`);
                }
            }
        }
    } catch (error) { errors.push(`${caseId} reference data invalid (${error.message})`); }
}
let repairNodes;
try {
    repairNodes = (JSON.parse(read('docs/repair-map.canvas')).nodes || [])
        .map((node) => node.text || '')
        .map((nodeText) => /^##\s*(\d{2})\s*·/m.exec(nodeText))
        .filter(Boolean)
        .map((match) => Number(match[1]));
} catch (error) { errors.push(`invalid repair-map Canvas JSON (${error.message})`); }
const sortedRepairNodes = repairNodes ? [...repairNodes].sort((a, b) => a - b) : [];
if (!repairNodes || repairNodes.length !== 20 || sortedRepairNodes.some((id, index) => id !== index + 1)) {
    errors.push(`repair map must contain numbered stages 01..20 exactly once; found: ${repairNodes || []}`);
}

if (errors.length) {
    console.error(`FAIL: ${errors.length} testing-doc consistency issue(s)`);
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
} else {
    console.log(`PASS: ${DOCS.length} handoff docs, project skill present, ${linkCount} local links, 20 matrix steps, ${testFiles.size} test-file references, ${sourceNodeCount} cited source Canvas nodes, 20 repair-map stages, ${fixtureDirs.length} validated six-file fixtures (${fixtureCount} hashes), TC-002 seed oracle and runbook oracle.`);
}
