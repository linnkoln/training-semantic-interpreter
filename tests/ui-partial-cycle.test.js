'use strict';
// Focused UI test (work/cycle-loss-2026-09-26): partial-cycle diagnostics in ui/editor.js.
// TC001 shape: 3 days, day 1 RuleUpdate fails, days 2/3 succeed. Core returns
// success + payload.events for days 2/3 + payload.warnings + payload.failedDays.
// Total failure → top-level response.failedDays. Fake DOM + fake Vault only.

const test = require('node:test');
const assert = require('node:assert/strict');
const editor = require('../ui/editor.js');
const storage = require('../adapters/storage.js');
const vaultWriter = require('../adapters/vaultWriter.js');
const staging = require('../adapters/staging.js');
const tmpStore = require('../adapters/tmpStore.js');
const loadGraph = require('../core/loadGraph.js');
const chartModel = require('../core/chartModel.js');

class MockElement {
    constructor(tag) {
        this.tagName = tag;
        this.children = [];
        this.listeners = new Map();
        this.attributes = {};
        this.style = {};
        this.value = '';
        this._text = '';
        this._html = '';
        this.parent = null;
    }
    appendChild(child) { this.children.push(child); child.parent = this; return child; }
    setAttribute(name, value) { this.attributes[name] = value; }
    addEventListener(name, callback) { this.listeners.set(name, callback); }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this); }
    set textContent(value) { this._text = String(value); }
    get textContent() { return this._text + this.children.map((child) => child.textContent).join(''); }
    set innerHTML(value) { this._html = String(value); this.children = []; }
    get innerHTML() { return this._html; }
}

function findElement(node, predicate) {
    if (predicate(node)) return node;
    for (const child of node.children) {
        const found = findElement(child, predicate);
        if (found) return found;
    }
    return null;
}

const DAY2 = { date: '2026-05-30', values: { press_reps: 50 }, interpretation_version: 1 };
const DAY3 = { date: '2026-05-31', values: { press_reps: 55 }, interpretation_version: 1 };
const ALL3 = [
    { date: '2026-05-29', values: { press_reps: 45 }, interpretation_version: 1 },
    DAY2, DAY3,
];
const FAILED_DAYS = [{ dayIndex: 1, date: '2026-05-29', reason: 'Не удалось построить правило из ответа LLM' }];

test('UI shows partial-cycle diagnostics (failedDays + warnings) and keeps surviving events', async (t) => {
    const oldDocument = global.document;
    global.document = {
        createElement: (tag) => new MockElement(tag),
        createTextNode: (text) => {
            const node = new MockElement('#text');
            node.textContent = text;
            return node;
        },
    };
    t.after(() => { global.document = oldDocument; });

    const mainRules = { version: 0, updatedAt: null, entries: [] };
    const mainGraph = { relations: [], targets: [], trends: [] };
    const dataPath = storage.makeStorage({ vault: {} }).DATA_PATH;

    // TC001 partial: 3 days, day 1 fails, days 2/3 succeed.
    const scenarios = [
        {
            name: 'partial',
            result: {
                status: 'success', branch: 1, confidence: 0.9,
                payload: {
                    events: [DAY2, DAY3],
                    warnings: ['День 1: перевод по правилам не удался'],
                    failedDays: FAILED_DAYS,
                },
            },
            expectStaged: 2,
            expectPartialMsg: true,
        },
        {
            name: 'total-failure',
            result: {
                status: 'error', branch: 1, confidence: 0.9,
                message: 'ни один день не вернул результат',
                failedDays: FAILED_DAYS,
            },
            expectStaged: 0,
            expectFailedInCard: true,
        },
        {
            name: 'complete',
            result: {
                status: 'success', branch: 1, confidence: 0.99,
                payload: { events: ALL3 },
            },
            expectStaged: 3,
            expectAll3: true,
        },
    ];

    loadGraph.clearLatestGraph();
    for (const scenario of scenarios) {
        const files = new Map([
            [vaultWriter.FILES.rulesLog, JSON.stringify(mainRules)],
            [vaultWriter.FILES.graph, JSON.stringify(mainGraph)],
            [dataPath, '[]'],
        ]);
        const app = { vault: {
            getAbstractFileByPath: (path) => files.has(path) ? { path } : null,
            read: async (file) => files.get(file.path),
            create: async (path, contents) => { files.set(path, contents); },
            modify: async (file, contents) => { files.set(file.path, contents); },
        } };
        const readOnlyStorage = storage.makeStorage(app);
        const bundle = {
            storage: {
                makeStorage: () => ({
                    loadData: () => readOnlyStorage.loadData(),
                    saveData: async () => { throw new Error('save must not run in this test'); },
                }),
            },
            vaultWriter,
            staging,
            tmpStore,
            pipeline: {
                next: async () => JSON.parse(JSON.stringify(scenario.result)),
            },
            loadGraph,
            chartModel: { toChartConfigs: (events, graph) => chartModel.toChartConfigs(events, graph) },
            chartview: { renderChartGrouped: () => [] },
        };

        const container = new MockElement('container');
        const controller = editor.mountEditor({ container, app, bundle });
        await controller.render();
        const textareas = [];
        const collect = (node) => {
            if (node.tagName === 'textarea') textareas.push(node);
            node.children.forEach(collect);
        };
        collect(container);
        assert.equal(textareas.length, 2);
        textareas[0].value = 'week table';
        const runButton = findElement(container,
            (node) => node.tagName === 'button' && node.textContent === editor.UI_TEXT.runBtn);
        assert.ok(runButton, scenario.name + ': run button exists');
        await runButton.listeners.get('click')();

        // status messages of the run (runMsg + card lines)
        const statusNodes = [];
        const walk = (node) => {
            const txt = node._text || '';
            if (txt.includes('превью') || txt.includes('Ошибка') || txt.includes('Частичный')) statusNodes.push(node);
            node.children.forEach(walk);
        };
        walk(container);

        // staged events survive the run (nothing saved to data.json without Save)
        const staged = JSON.parse(files.get(staging.STAGE_PATH));
        assert.deepEqual(staged.events, scenario.result.status === 'error'
            ? []
            : (scenario.expectAll3 ? [...ALL3].reverse() : [DAY3, DAY2]),
            scenario.name + ': staged events');
        assert.equal(files.get(dataPath), '[]', scenario.name + ': data.json untouched before Save');

        if (scenario.expectPartialMsg) {
            const partial = statusNodes.map((n) => n._text || '').find((txt) => txt.includes('Частичный результат'));
            assert.ok(partial, scenario.name + ': run status explicitly says partial result');
            assert.ok(partial.includes('2026-05-29'), scenario.name + ': status names failed date');
            const allText = [];
            const walkText = (node) => { allText.push(node._text || ''); node.children.forEach(walkText); };
            walkText(container);
            const joined = allText.join('\n');
            assert.ok(joined.includes('2026-05-29'), scenario.name + ': failed date visible in card');
            assert.ok(joined.includes('Не удалось построить правило из ответа LLM'),
                scenario.name + ': failure reason visible');
            assert.ok(joined.includes('День 1: перевод по правилам не удался'),
                scenario.name + ': payload.warnings message shown');
            assert.ok(textareas[1].value.includes('2026-05-30') && textareas[1].value.includes('2026-05-31'),
                scenario.name + ': surviving events shown in field 2');
        }
        if (scenario.expectFailedInCard) {
            const allText = [];
            const walkText = (node) => { allText.push(node._text || ''); node.children.forEach(walkText); };
            walkText(container);
            const joined = allText.join('\n');
            assert.ok(joined.includes('2026-05-29'), scenario.name + ': failed date shown on total error');
            assert.ok(joined.includes('Не удалось построить правило из ответа LLM'),
                scenario.name + ': reason shown on total error');
        }
        if (scenario.expectAll3) {
            const partialMsg = statusNodes.map((n) => n._text || '').find((txt) => txt.includes('Частичный'));
            assert.ok(!partialMsg, scenario.name + ': complete run has no partial-result status');
            const allText = [];
            const walkText = (node) => { allText.push(node._text || ''); node.children.forEach(walkText); };
            walkText(container);
            const joined = allText.join('\n');
            assert.ok(!joined.includes('Не удалось обработать'), scenario.name + ': no failed-day warning');
            assert.ok(joined.includes('3 событий добавлено в превью'), scenario.name + ': green status for 3 events');
            const field2 = findElement(container, (node) => node.tagName === 'textarea'
                && (node.value || '').includes('2026-05-29'));
            assert.ok(field2, scenario.name + ': all 3 events staged into field 2');
        }
        controller.destroy();
    }
    loadGraph.clearLatestGraph();
});
