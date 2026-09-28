'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, findAll, PATHS } = require('./helpers/editorHarness.js');

const days = [
    { date: '2026-09-01', raw: '2026-09-01: 50 отжимания (20+30)', span: '50 отжимания (20+30)', values: { push_reps: 20, push_knees_reps: 30 } },
    { date: '2026-09-02', raw: '2026-09-02: 50 отжимания (25+25)', span: '50 отжимания (25+25)', values: { push_reps: 25, push_knees_reps: 25 } },
    { date: '2026-09-03', raw: '2026-09-03: 50 отжимания (30+20)', span: '50 отжимания (30+20)', values: { push_reps: 30, push_knees_reps: 20 } },
];
const relation = { type: 'A+B', base: 'push_reps', parts: ['push_knees_reps'], stackOrder: ['push_reps', 'push_knees_reps'] };

function pseudoFetch({ minorOnly = false } = {}) {
    let routerCalls = 0;
    let parseCalls = 0;
    const minorDay = { date: '2026-09-04', raw: '2026-09-04: 50 отжимания — 35 обычных и 15 с колен',
        span: '50 отжимания — 35 обычных и 15 с колен', values: { push_reps: 35, push_knees_reps: 15 } };
    return async (_url, options) => {
        const prompt = JSON.parse(options.body).messages[0].content;
        let result;
        if (/нарезщик/i.test(prompt)) result = { days: (minorOnly ? [minorDay] : days)
            .map(({ date, raw }) => ({ date: date.slice(5), raw })) };
        else if (/\brouter\b|роутер/i.test(prompt)) {
            const index = routerCalls++;
            result = { groups: [{ chunk: minorOnly ? minorDay.raw : days[index].raw,
                group: minorOnly ? 2 : [3, 2, 1][index], confidence: 0.99 }] };
        } else if (/Минорное дополнение правил/i.test(prompt)) {
            const day = minorOnly ? minorDay : days[1];
            result = { appends: [{ key: 'push_reps', chunk: day.span, exampleText: day.span,
                date: day.date, values: day.values }] };
        } else if (/RuleUpdate/i.test(prompt)) {
            result = {
                rule: {
                    semantics: 'обычные отжимания и отжимания с колен',
                    keys: [{ key: 'push_reps', meaning: 'обычные отжимания' }, { key: 'push_knees_reps', meaning: 'отжимания с колен' }],
                    mapping: { push_reps: 'обычные отжимания', push_knees_reps: 'отжимания с колен' },
                    examples: [{ input: days[0].span, values: days[0].values }], composition: 'A+B',
                },
                oldKeysEvents: [],
                newKeys: Object.keys(days[0].values).map((key) => ({ key, meaning: key, chunk: days[0].span,
                    date: days[0].date, values: days[0].values })),
                relations: [relation], confidence: 0.99,
            };
        } else if (/Structured|JSON для графика|Режим ПЕРЕВОДА В JSON|режим разбора/i.test(prompt)) {
            const day = minorOnly ? minorDay : days[++parseCalls];
            result = [{ date: day.date, values: day.values }];
        } else throw new Error('Unexpected prompt: ' + prompt.slice(0, 100));
        return { ok: true, status: 200, json: async () => ({ message: {
            content: JSON.stringify({ status: 'success', payload: result, confidence: 0.99 }),
        } }) };
    };
}

async function processedHarness() {
    const harness = createHarness({ fetch: pseudoFetch() });
    await harness.controller.render();
    harness.field(0).value = days.map((day) => day.raw).join('\n');
    await harness.click(harness.bundle.editor.UI_TEXT.runBtn);
    assert.equal(harness.json(PATHS.dataTmp).events.length, 3, harness.container.textContent);
    assert.ok(harness.json(PATHS.rulesTmp).rules.length > 0);
    assert.ok(harness.json(PATHS.rulesTmp).newKeys.some((item) => item.source === 'minorRuleUpdate'),
        'Branch 2 appends use the Vault temp adapter');
    assert.ok(harness.json(PATHS.graphTmp).relations.length > 0);
    assert.doesNotMatch(harness.container.textContent, /dirname is not a function|не записан[ы]? в tmp|не записаны в temp/);
    return harness;
}

test('browser bundle: one Save persists the mixed rule, examples, events and graph; reload uses main', async () => {
    const harness = await processedHarness();
    assert.equal(harness.json(PATHS.rules).entries.length, 0, 'processing does not save main rules');
    assert.deepEqual(harness.json(PATHS.data), []);
    assert.deepEqual(harness.json(PATHS.graph), { relations: [] });
    assert.ok(!findAll(harness.container, (node) => /Принять правило|^📝 2026/.test(node._text)).length,
        'no separate result pane or approval button');
    await harness.click(harness.bundle.editor.UI_TEXT.saveBtn);
    const log = harness.json(PATHS.rules);
    assert.ok(log.entries.length > 0, harness.container.textContent);
    const rule = log.entries.at(-1).rulesSnapshot.dynamic[0];
    assert.equal(rule.mapping.push_reps, 'обычные отжимания', 'full proposal meaning is retained');
    assert.ok(rule.examples.some((example) => example.input === days[0].span));
    assert.ok(rule.examples.some((example) => example.input === days[1].span), 'minor examples survive Save');
    assert.deepEqual(harness.json(PATHS.data).map(({ date, values }) => ({ date, values })),
        [...days].reverse().map(({ date, values }) => ({ date, values })));
    assert.equal(harness.json(PATHS.graph).relations.length, 1);
    assert.deepEqual(harness.json(PATHS.rulesTmp), { rules: [], newKeys: [] });
    assert.deepEqual(harness.json(PATHS.graphTmp), { relations: [] });
    assert.deepEqual(harness.json(PATHS.dataTmp).events, []);
    assert.ok(harness.container.textContent.includes(PATHS.rules), 'Save shows where rules were persisted');
    const bytes = harness.mainBytes();
    const reopened = createHarness({ initial: Object.fromEntries(harness.files) });
    await reopened.controller.render();
    assert.deepEqual(reopened.mainBytes(), bytes, 'reload preserves saved files');
    assert.equal(reopened.bundle.rulesLog.getVersion(), log.version, 'reload reads Vault rules, not bundled seed');
    assert.equal(JSON.parse(reopened.field(1).value).length, 3);
});

test('browser bundle: each failed main write rolls back all files, retains temp and retries once', async () => {
    for (const failedFile of [PATHS.rules, PATHS.graph, PATHS.data]) {
        const harness = await processedHarness();
        const before = harness.mainBytes();
        const tempBefore = [PATHS.rulesTmp, PATHS.graphTmp, PATHS.dataTmp].map((file) => harness.files.get(file));
        harness.failNext(failedFile);
        await harness.click(harness.bundle.editor.UI_TEXT.saveBtn);
        assert.deepEqual(harness.mainBytes(), before, failedFile);
        assert.deepEqual([PATHS.rulesTmp, PATHS.graphTmp, PATHS.dataTmp].map((file) => harness.files.get(file)), tempBefore);
        assert.match(harness.container.textContent, /Сохранение отменено/);
        await harness.click(harness.bundle.editor.UI_TEXT.saveBtn);
        assert.equal(harness.json(PATHS.data).length, 3);
        assert.equal(harness.json(PATHS.graph).relations.length, 1);
        const log = harness.json(PATHS.rules);
        assert.ok(log.version > 0);
        assert.equal(log.entries.at(-1).rulesSnapshot.dynamic.length, 1, 'retry creates no duplicate rule');
        const saved = harness.mainBytes();
        await harness.click(harness.bundle.editor.UI_TEXT.saveBtn);
        assert.deepEqual(harness.mainBytes(), saved, 'second Save adds no rule/event version');
    }
});

test('Save stops before writing main or clearing temp when rules tmp is unreadable', async () => {
    const harness = await processedHarness();
    const bytes = harness.mainBytes();
    harness.files.set(PATHS.rulesTmp, '{invalid');
    await harness.click(harness.bundle.editor.UI_TEXT.saveBtn);
    assert.deepEqual(harness.mainBytes(), bytes);
    assert.equal(harness.files.get(PATHS.rulesTmp), '{invalid');
    assert.equal(harness.json(PATHS.dataTmp).events.length, 3);
});

test('browser bundle: Branch 2-only Save appends a new example to the existing versioned rule', async () => {
    const seed = await processedHarness();
    await seed.click(seed.bundle.editor.UI_TEXT.saveBtn);
    const harness = createHarness({ initial: Object.fromEntries(seed.files), fetch: pseudoFetch({ minorOnly: true }) });
    await harness.controller.render();
    const before = harness.json(PATHS.rules);
    const bytes = harness.mainBytes();
    harness.field(0).value = '2026-09-04: 50 отжимания — 35 обычных и 15 с колен';
    await harness.click(harness.bundle.editor.UI_TEXT.runBtn);
    assert.deepEqual(harness.mainBytes(), bytes);
    await harness.click(harness.bundle.editor.UI_TEXT.saveBtn);
    const saved = harness.json(PATHS.rules);
    assert.equal(saved.version, before.version + 1, harness.container.textContent);
    assert.deepEqual(saved.entries.slice(0, -1), before.entries, 'previous snapshots stay intact');
    const rules = saved.entries.at(-1).rulesSnapshot.dynamic;
    assert.equal(rules.length, 1, 'minor append does not invent another rule');
    assert.ok(rules[0].examples.some((example) => example.input === '50 отжимания — 35 обычных и 15 с колен'
        && example.values.push_reps === 35 && example.values.push_knees_reps === 15));
    assert.equal(harness.json(PATHS.data).length, 4);
    assert.deepEqual(harness.json(PATHS.rulesTmp), { rules: [], newKeys: [] });
});
