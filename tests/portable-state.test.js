'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const rulesLog = require('../core/rulesLog.js');
const { createHarness, PATHS } = require('./helpers/editorHarness.js');

test('new installation: missing personal journal is empty and appears only on explicit append', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'training-new-user-'));
    const target = path.join(directory, 'rulesLog.json');
    const original = rulesLog._getLogPath();
    try {
        rulesLog._setLogPath(target);
        rulesLog._resetCache();
        assert.deepEqual(rulesLog.getRulesLog(), { version: 0, updatedAt: null, entries: [] });
        assert.equal(rulesLog.getVersion(), 0);
        assert.deepEqual(rulesLog.getLatestRules().dynamic, []);
        assert.equal(fs.existsSync(target), false, 'reading the initial state does not persist');
        rulesLog.appendRule({ id: 'rule_001', raw: 'my own source', mapping: { climb_reps: 'climbing' }, examples: [] }, 'add');
        assert.equal(JSON.parse(fs.readFileSync(target)).version, 1);
        fs.writeFileSync(target, '{broken');
        rulesLog._resetCache();
        assert.throws(() => rulesLog.getRulesLog(), SyntaxError, 'corrupt state is not treated as a fresh installation');
    } finally {
        rulesLog._setLogPath(original);
        rulesLog._resetCache();
        if (fs.existsSync(target)) fs.unlinkSync(target);
        fs.rmdirSync(directory);
    }
});

test('portable bundle: built-in rules and graph are empty templates', () => {
    const harness = createHarness();
    assert.deepEqual(JSON.parse(JSON.stringify(harness.bundle.rulesLog.getRulesLog())),
        JSON.parse(fs.readFileSync(path.resolve(__dirname, '../data/defaults/rulesLog.json'))));
    assert.deepEqual(JSON.parse(JSON.stringify(harness.bundle.loadGraph())),
        JSON.parse(fs.readFileSync(path.resolve(__dirname, '../data/defaults/graph.json'))));
});

test('new Vault: first user-specific rule, events and graph are created by the common Save', async () => {
    const harness = createHarness();
    for (const file of [PATHS.data, PATHS.rules, PATHS.graph]) harness.files.delete(file);
    await harness.controller.render();
    assert.equal(harness.files.has(PATHS.rules), false, 'startup does not create a personal journal');
    const rule = { id: 'rule_001', raw: 'climbing 12', mapping: { climb_reps: 'climbing repetitions' },
        examples: [{ input: 'climbing 12', values: { climb_reps: 12 } }] };
    harness.bundle.pipeline.next = async () => ({ status: 'success', branch: 2, payload: {
        events: [{ date: '2026-09-26', values: { climb_reps: 12 }, interpretation_version: 0 }],
        proposal: { rule, rules: [rule], newKeys: [] },
        relations: [{ type: 'overlay', base: 'climb_reps', sub: 'climb_peak' }],
    } });
    harness.field(0).value = '2026-09-26: climbing 12';
    await harness.click(harness.bundle.editor.UI_TEXT.runBtn);
    assert.equal(harness.files.has(PATHS.rules), false, 'preview writes temp only');
    assert.equal(harness.files.has(PATHS.data), false);
    await harness.click(harness.bundle.editor.UI_TEXT.saveBtn);
    assert.equal(harness.json(PATHS.rules).version, 1, harness.container.textContent);
    assert.deepEqual(harness.json(PATHS.rules).entries[0].rulesSnapshot.dynamic[0].mapping, rule.mapping);
    assert.equal(harness.json(PATHS.data)[0].values.climb_reps, 12);
    assert.equal(harness.json(PATHS.graph).relations.length, 1);
    assert.deepEqual(harness.json(PATHS.rulesTmp), { rules: [], newKeys: [] });
});
