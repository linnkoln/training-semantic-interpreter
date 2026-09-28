'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, findAll, PATHS } = require('./helpers/editorHarness.js');

const savedEvent = { date: '2026-09-02', values: { push_reps: 10 }, interpretation_version: 1 };
const tempEvent = { date: '2026-09-03', values: { push_reps: 20, push_knees_reps: 30 }, interpretation_version: 1 };
const rule = { id: 'rule_001', raw: '50 отжимания (20+30)',
    mapping: { push_reps: 'обычные отжимания', push_knees_reps: 'отжимания с колен' },
    examples: [{ input: '50 отжимания (20+30)', values: tempEvent.values }] };
const relation = { type: 'A+B', base: 'push_reps', parts: ['push_knees_reps'], stackOrder: ['push_reps', 'push_knees_reps'] };

function initialTemp() {
    return {
        [PATHS.data]: JSON.stringify([savedEvent]),
        [PATHS.dataTmp]: JSON.stringify({ events: [tempEvent, { ...savedEvent, values: { push_reps: 999 } }], state: { hiddenGroups: ['pull'] } }),
        [PATHS.rulesTmp]: JSON.stringify({ rules: [rule], newKeys: [] }),
        [PATHS.graphTmp]: JSON.stringify({ relations: [relation] }),
    };
}

const notice = (view) => findAll(view.container, (node) => node.className === 'training-temp-notice')[0];
const clearButton = (view) => findAll(view.container, (node) => node.tagName === 'button'
    && node.textContent === view.bundle.editor.UI_TEXT.clearTmpBtn)[0];

test('reload recovers main + three temp files without writes, uses saved dates and restores chart relations', async () => {
    const ui = createHarness({ initial: initialTemp() });
    const bytes = Object.fromEntries(ui.files);
    let chart;
    ui.bundle.chartview.renderChartGrouped = (_element, groups) => { chart = groups; return []; };
    await ui.controller.render();
    assert.deepEqual(Object.fromEntries(ui.files), bytes, 'startup is read only');
    assert.deepEqual(ui.writes, []);
    assert.deepEqual(JSON.parse(ui.field(1).value), [tempEvent, savedEvent], 'committed wins duplicate dates; newest date is first');
    assert.equal(chart.length, 1, 'the temporary A+B relation groups the two metrics');
    assert.deepEqual([...new Set(Array.from(chart[0].config.datasets, (dataset) => dataset.label))].sort(), ['push_knees_reps', 'push_reps']);
    assert.match(notice(ui).textContent, /График отрисован с временными файлами/);
    assert.equal(clearButton(ui).hidden, false);
    await ui.click(ui.bundle.editor.UI_TEXT.saveBtn);
    assert.deepEqual(ui.json(PATHS.data), [tempEvent, savedEvent]);
    assert.deepEqual(ui.json(PATHS.rules).entries.at(-1).rulesSnapshot.dynamic[0].mapping, rule.mapping);
    assert.deepEqual(ui.json(PATHS.graph).relations, [relation]);
    assert.deepEqual(ui.json(PATHS.dataTmp).events, []);
    assert.deepEqual(ui.json(PATHS.rulesTmp), { rules: [], newKeys: [] });
    assert.deepEqual(ui.json(PATHS.graphTmp), { relations: [] });
    assert.equal(notice(ui).textContent, '');
    assert.equal(clearButton(ui).hidden, true);
});

test('notice detects each temporary layer independently; missing, empty and UI-only files stay quiet', async () => {
    for (const initial of [
        {},
        { [PATHS.dataTmp]: '{"events":[],"state":{"hiddenGroups":["push"]}}',
            [PATHS.rulesTmp]: '{"rules":[],"newKeys":[]}', [PATHS.graphTmp]: '{"relations":[]}' },
        { [PATHS.dataTmp]: ' ', [PATHS.rulesTmp]: '', [PATHS.graphTmp]: '\n' },
    ]) {
        const ui = createHarness({ initial });
        await ui.controller.render();
        assert.equal(notice(ui).textContent, '');
        assert.equal(clearButton(ui).hidden, true);
        assert.deepEqual(ui.writes, []);
    }
    for (const [file, data] of [
        [PATHS.dataTmp, [tempEvent]],
        [PATHS.rulesTmp, { rules: [rule] }],
        [PATHS.rulesTmp, { newKeys: [{ key: 'push_reps', exampleText: 'отжимания 20' }] }],
        [PATHS.graphTmp, { relations: [relation] }],
    ]) {
        const ui = createHarness({ initial: { [file]: JSON.stringify(data) } });
        await ui.controller.render();
        assert.equal(notice(ui).textContent, ui.bundle.editor.UI_TEXT.tempNotice, file);
        assert.equal(clearButton(ui).hidden, false, file);
    }
});

test('clear temp removes events, graph and rules, preserves main and UI settings, and Save cannot revive proposals', async () => {
    const ui = createHarness({ initial: initialTemp() });
    const main = ui.mainBytes();
    await ui.controller.render();
    await ui.click(ui.bundle.editor.UI_TEXT.clearTmpBtn);
    assert.deepEqual(ui.mainBytes(), main);
    assert.deepEqual(ui.json(PATHS.dataTmp), { events: [], state: { hiddenGroups: ['pull'] } });
    assert.deepEqual(ui.json(PATHS.rulesTmp), { rules: [], newKeys: [] });
    assert.deepEqual(ui.json(PATHS.graphTmp), { relations: [] });
    assert.deepEqual(JSON.parse(ui.field(1).value), [savedEvent]);
    assert.equal(notice(ui).textContent, '');
    assert.equal(clearButton(ui).hidden, true);
    await ui.click(ui.bundle.editor.UI_TEXT.saveBtn);
    assert.deepEqual(ui.mainBytes().slice(1), main.slice(1), 'cleared rules cannot be committed from memory');
    assert.deepEqual(ui.json(PATHS.data), [savedEvent]);
});

test('rerender during LLM keeps a single operation and displays its finished temp in the new bundle', async () => {
    const ui = createHarness({ initial: { [PATHS.data]: JSON.stringify([savedEvent]) } });
    await ui.controller.render();
    let resolveResult;
    let started;
    const startedPromise = new Promise((resolve) => { started = resolve; });
    ui.bundle.pipeline.next = async (_raw, options) => {
        options.onStage('structured');
        started();
        return new Promise((resolve) => { resolveResult = resolve; });
    };
    ui.field(0).value = '2026-09-03: 50 отжимания (20+30)';
    const processing = ui.click(ui.bundle.editor.UI_TEXT.runBtn);
    await startedPromise;
    ui.controller.destroy();
    const refreshed = ui.remount();
    let newCalls = 0;
    refreshed.bundle.pipeline.next = async () => { newCalls++; return { status: 'error' }; };
    const state = await refreshed.controller.render();
    assert.equal(state.busy, true, 'the new view knows the old operation is active');
    assert.match(refreshed.container.textContent, /⏳/);
    const main = ui.mainBytes();
    await refreshed.click(refreshed.bundle.editor.UI_TEXT.clearTmpBtn);
    await refreshed.click(refreshed.bundle.editor.UI_TEXT.saveBtn);
    await refreshed.click(refreshed.bundle.editor.UI_TEXT.runBtn);
    assert.equal(newCalls, 0, 'rerender cannot start a second cycle over the active temp');
    assert.deepEqual(ui.mainBytes(), main);
    resolveResult({ status: 'success', branch: 1, payload: {
        events: [tempEvent], proposal: { rule, rules: [rule] }, relations: [relation],
    } });
    await processing;
    assert.equal(state.busy, false);
    assert.deepEqual(JSON.parse(refreshed.field(1).value), [tempEvent, savedEvent]);
    assert.equal(notice(refreshed).textContent, refreshed.bundle.editor.UI_TEXT.tempNotice);
    assert.doesNotMatch(refreshed.container.textContent, /⏳/);
    await refreshed.click(refreshed.bundle.editor.UI_TEXT.saveBtn);
    assert.deepEqual(ui.json(PATHS.data), [tempEvent, savedEvent]);
    assert.deepEqual(ui.json(PATHS.graph).relations, [relation]);
    assert.equal(ui.json(PATHS.rules).version, 1);
});

test('unreadable temp blocks Save without changing files and can be explicitly cleared', async () => {
    for (const file of [PATHS.dataTmp, PATHS.rulesTmp, PATHS.graphTmp]) {
        const ui = createHarness({ initial: { ...initialTemp(), [file]: '{broken' } });
        const before = Object.fromEntries(ui.files);
        const state = await ui.controller.render();
        assert.equal(state.tmpCleanupReady, false);
        assert.match(ui.container.textContent, /Не удалось восстановить временные файлы/);
        await ui.click(ui.bundle.editor.UI_TEXT.saveBtn);
        assert.deepEqual(Object.fromEntries(ui.files), before);
        await ui.click(ui.bundle.editor.UI_TEXT.clearTmpBtn);
        assert.equal(state.tmpCleanupReady, true);
        assert.deepEqual(ui.json(PATHS.dataTmp).events, []);
        assert.deepEqual(ui.json(PATHS.rulesTmp), { rules: [], newKeys: [] });
        assert.deepEqual(ui.json(PATHS.graphTmp), { relations: [] });
    }
});

test('recovered update targets the committed rule and keeps its earlier version', async () => {
    const oldRule = { ...rule, mapping: { push_reps: 'обычные отжимания' },
        examples: [{ input: '10 отжимания', values: savedEvent.values }] };
    const oldEntry = { version: 1, changeType: 'add', rulesSnapshot: { version: 1, dynamic: [oldRule], global: [] } };
    const ui = createHarness({ initial: {
        ...initialTemp(),
        [PATHS.rules]: JSON.stringify({ version: 1, entries: [oldEntry] }),
        [PATHS.rulesTmp]: JSON.stringify({ rules: [{ ...rule, id: 'tmp_rule_001', updateRuleId: 'rule_001', completeSnapshot: true }], newKeys: [] }),
    } });
    await ui.controller.render();
    await ui.click(ui.bundle.editor.UI_TEXT.saveBtn);
    const log = ui.json(PATHS.rules);
    assert.equal(log.version, 2, ui.container.textContent);
    assert.deepEqual(log.entries[0], oldEntry);
    assert.equal(log.entries[1].changeType, 'update');
    assert.equal(log.entries[1].rulesSnapshot.dynamic.length, 1);
    assert.equal(log.entries[1].rulesSnapshot.dynamic[0].id, 'rule_001');
    assert.deepEqual(log.entries[1].rulesSnapshot.dynamic[0].mapping, rule.mapping);
});

test('failed explicit temp cleanup leaves main intact and can be retried', async () => {
    const ui = createHarness({ initial: initialTemp() });
    const main = ui.mainBytes();
    await ui.controller.render();
    ui.failNext(PATHS.dataTmp);
    await ui.click(ui.bundle.editor.UI_TEXT.clearTmpBtn);
    assert.deepEqual(ui.mainBytes(), main);
    assert.equal(clearButton(ui).hidden, false, 'the remaining rule/graph temp can still be cleared');
    assert.match(ui.container.textContent, /Ошибка очистки временных файлов/);
    await ui.click(ui.bundle.editor.UI_TEXT.clearTmpBtn);
    assert.deepEqual(ui.mainBytes(), main);
    assert.equal(clearButton(ui).hidden, true);
    assert.equal(notice(ui).textContent, '');
});
