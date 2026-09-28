'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, PATHS } = require('./helpers/editorHarness.js');

const days = [
    { date: '2026-09-01', span: 'жим лёжа 20', value: 20, group: 3 },
    { date: '2026-09-02', span: 'двадцать пять жим лёжа', value: 25, group: 2 },
    { date: '2026-09-03', span: 'жим лёжа: сорок', value: 40, group: 3 },
    { date: '2026-09-04', span: 'сделал 45 жимов лёжа', value: 45, group: 2 },
    { date: '2026-09-05', span: 'жим лёжа 50', value: 50, group: 1 },
].map((day) => ({ ...day, raw: `${day.date}: ${day.span}` }));

function mixedFetch() {
    let current;
    let routed = 0;
    return async (_url, options) => {
        const prompt = JSON.parse(options.body).messages[0].content;
        let payload;
        if (/нарезщик/i.test(prompt)) payload = { days: days.map((day) => ({ raw: day.raw, date: day.date.slice(5) })) };
        else if (/\brouter\b|роутер/i.test(prompt)) {
            current = days[routed++];
            payload = { groups: [{ chunk: current.raw, group: current.group, confidence: 0.99 }] };
        } else if (/Минорное дополнение правил/i.test(prompt)) {
            payload = { appends: [{ key: 'bench_units', chunk: current.span, exampleText: current.span }] };
        } else if (/RuleUpdate/i.test(prompt)) {
            const update = current === days[2];
            const target = prompt.match(/"id":\s*"((?:tmp_)?rule_001)"/)?.[1];
            if (update) assert.ok(target, 'the current proposal is visible to the next day');
            const values = { bench_units: current.value };
            const item = { key: 'bench_units', chunk: current.span, date: current.date, values };
            payload = {
                ...(update ? { updateRuleId: target } : {}),
                rule: { keys: [{ key: 'bench_units', meaning: 'жим лёжа, повторения' }],
                    mapping: { bench_units: 'жим лёжа, повторения' },
                    examples: [{ input: current.span, values }] },
                oldKeysEvents: update ? [item] : [], newKeys: update ? [] : [item], relations: [],
            };
        } else payload = [{ date: current.date, values: { bench_units: current.value } }];
        return { ok: true, status: 200, json: async () => ({ message: {
            content: JSON.stringify({ status: 'success', payload, confidence: 0.99 }),
        } }) };
    };
}

async function processed() {
    const harness = createHarness({ fetch: mixedFetch() });
    await harness.controller.render();
    const main = harness.mainBytes();
    harness.field(0).value = days.map((day) => day.raw).join('\n');
    await harness.click(harness.bundle.editor.UI_TEXT.runBtn);
    assert.deepEqual(harness.mainBytes(), main, 'processing changes temp only');
    assert.equal(harness.json(PATHS.dataTmp).events.length, days.length, harness.container.textContent);
    assert.equal(harness.json(PATHS.rulesTmp).newKeys.filter((item) => item.source === 'minorRuleUpdate').length, 2);
    return harness;
}

function assertSaved(harness) {
    const log = harness.json(PATHS.rules);
    assert.equal(log.version, 1, harness.container.textContent);
    const rules = log.entries.at(-1).rulesSnapshot.dynamic;
    assert.equal(rules.length, 1);
    assert.equal(rules[0].id, 'rule_001');
    for (const day of [days[1], days[3]]) assert.ok(rules[0].examples.some((example) =>
        example.input === day.span && example.values.bench_units === day.value), 'both minor appends survive Save');
    assert.equal(rules[0].completeSnapshot, undefined);
    assert.equal(rules[0].updateRuleId, undefined);
    assert.deepEqual(harness.json(PATHS.data).map(({ date, values }) => ({ date, values })),
        [...days].reverse().map((day) => ({ date: day.date, values: { bench_units: day.value } })));
    assert.deepEqual(harness.json(PATHS.rulesTmp), { rules: [], newKeys: [] });
    assert.deepEqual(harness.json(PATHS.dataTmp).events, []);
}

test('nodes 10/12: minor appends and a later update of a pending rule save as one stable rule', async () => {
    const harness = await processed();
    await harness.click(harness.bundle.editor.UI_TEXT.saveBtn);
    assertSaved(harness);
    const saved = harness.mainBytes();
    await harness.click(harness.bundle.editor.UI_TEXT.saveBtn);
    assert.deepEqual(harness.mainBytes(), saved, 'another Save adds no version');
    const reopened = createHarness({ initial: Object.fromEntries(harness.files) });
    await reopened.controller.render();
    assert.deepEqual(reopened.mainBytes(), saved);
    assert.equal(reopened.bundle.rulesLog.getLatestRules().dynamic.length, 1);
});

test('nodes 10/12: failed Save retains every minor append and retries without duplicate rules', async () => {
    const harness = await processed();
    const main = harness.mainBytes();
    const temp = [PATHS.rulesTmp, PATHS.graphTmp, PATHS.dataTmp].map((file) => harness.files.get(file));
    harness.failNext(PATHS.data);
    await harness.click(harness.bundle.editor.UI_TEXT.saveBtn);
    assert.deepEqual(harness.mainBytes(), main);
    assert.deepEqual([PATHS.rulesTmp, PATHS.graphTmp, PATHS.dataTmp].map((file) => harness.files.get(file)), temp);
    await harness.click(harness.bundle.editor.UI_TEXT.saveBtn);
    assertSaved(harness);
});

test('reload before Save retains full pending rules, updates and every minor example', async () => {
    const harness = await processed();
    const before = harness.mainBytes();
    const reopened = createHarness({ initial: Object.fromEntries(harness.files) });
    await reopened.controller.render();
    assert.deepEqual(reopened.mainBytes(), before, 'reload does not commit');
    await reopened.click(reopened.bundle.editor.UI_TEXT.saveBtn);
    assertSaved(reopened);
});

test('Save resolves legacy nested tmp aliases only against their pending rule and keeps other proposals separate', async () => {
    const harness = createHarness();
    const committedLog = harness.json(PATHS.rules);
    harness.bundle.rulesLog.setCachedLog(committedLog);
    const rule = { id: 'rule_001', raw: 'source', mapping: { bench_units: 'жим' },
        examples: [{ input: 'первый пример', values: { bench_units: 1 } }] };
    const result = await harness.bundle.pipeline.commitRules({ status: 'success', branch: 2, payload: {
        proposal: { updateRuleId: 'tmp_tmp_rule_001', rules: [rule,
            { ...rule, id: 'tmp_rule_001', completeSnapshot: true,
                examples: [{ input: 'новый пример', values: { bench_units: 2 } }] },
            { ...rule, id: 'tmp_tmp_rule_001', completeSnapshot: true,
                examples: [{ input: 'последний пример', values: { bench_units: 3 } }] },
            { id: 'rule_002', raw: 'other', mapping: { walk_units: 'ходьба' }, examples: [] }],
        }, events: [],
    } }, { committedLog, committedGraph: { relations: [] }, graphTmp: { relations: [] } });
    assert.equal(result.status, 'success', result.message);
    const rules = JSON.parse(JSON.stringify(result.payload.log.entries.at(-1).rulesSnapshot.dynamic));
    assert.deepEqual(rules.map((item) => item.id), ['rule_001', 'rule_002']);
    assert.deepEqual(rules[0].examples, [{ input: 'последний пример', values: { bench_units: 3 } }]);
    assert.deepEqual(rules[1].mapping, { walk_units: 'ходьба' });
});

test('Save refuses a missing update target before preparing unrelated rule entries', async () => {
    const harness = createHarness();
    const committedLog = harness.json(PATHS.rules);
    harness.bundle.rulesLog.setCachedLog(committedLog);
    const result = await harness.bundle.pipeline.commitRules({ status: 'success', branch: 2, payload: {
        proposal: { updateRuleId: 'tmp_rule_999', rules: [
            { id: 'rule_001', raw: 'source', mapping: { bench_units: 'жим' }, examples: [] },
            { id: 'tmp_rule_999', raw: 'missing', mapping: { walk_units: 'ходьба' }, examples: [] },
        ] },
    } }, { committedLog });
    assert.equal(result.status, 'error');
    assert.match(result.message, /tmp_rule_999/);
    assert.equal(harness.bundle.rulesLog.getVersion(), 0);
});

test('node 12: duplicate temp append merges values without mutating the prior snapshot', () => {
    const store = require('../adapters/tmpStore.js');
    const current = Object.freeze([Object.freeze({ key: 'bench_units', exampleText: 'жим',
        values: Object.freeze({ bench_units: 20 }) })]);
    const merged = store.mergeMinorAppends(current, [{ key: 'bench_units', exampleText: 'жим',
        values: { bench_peak: 5 } }]);
    assert.deepEqual(current[0].values, { bench_units: 20 });
    assert.deepEqual(merged[0].values, { bench_units: 20, bench_peak: 5 });
    assert.equal(merged.length, 1);
});

test('node 12: Save uses all verified temp appends even when the last result omits them', async () => {
    const harness = createHarness({ fetch: mixedFetch() });
    const next = harness.bundle.pipeline.next;
    harness.bundle.pipeline.next = async (...args) => {
        const result = await next(...args);
        delete result.payload.appends;
        return result;
    };
    await harness.controller.render();
    harness.field(0).value = days.map((day) => day.raw).join('\n');
    await harness.click(harness.bundle.editor.UI_TEXT.runBtn);
    assert.equal(harness.json(PATHS.rulesTmp).newKeys.filter((item) => item.source === 'minorRuleUpdate').length, 2);
    await harness.click(harness.bundle.editor.UI_TEXT.saveBtn);
    assertSaved(harness);
});

test('node 10: verified temp examples update an existing rule without requiring preview events', async () => {
    const harness = createHarness();
    const oldRule = { id: 'rule_001', raw: 'старый ввод', mapping: { bench_units: 'жим' },
        examples: [{ input: 'жим 10', values: { bench_units: 10 } }] };
    const committedLog = { version: 1, entries: [{ version: 1, changeType: 'add',
        rulesSnapshot: { version: 1, dynamic: [oldRule], global: [] } }] };
    harness.bundle.rulesLog.setCachedLog(committedLog);
    const result = await harness.bundle.pipeline.commitRules({ status: 'success', branch: 1, payload: {
        appends: [days[1], days[3]].map((day) => ({ key: 'bench_units', exampleText: day.span,
            date: day.date, values: { bench_units: day.value } })), events: [],
    } }, { committedLog, committedGraph: { relations: [] }, graphTmp: { relations: [] } });
    assert.equal(result.status, 'success', result.message);
    const log = JSON.parse(JSON.stringify(result.payload.log));
    assert.equal(log.version, 2);
    assert.deepEqual(log.entries[0], committedLog.entries[0]);
    assert.deepEqual(log.entries[1].rulesSnapshot.dynamic[0].examples,
        [...oldRule.examples, ...[days[1], days[3]].map((day) => ({ input: day.span, values: { bench_units: day.value } }))]);
});
