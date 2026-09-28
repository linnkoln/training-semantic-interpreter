'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const editor = require('../ui/editor.js');
const storage = require('../adapters/storage.js');
const vaultWriter = require('../adapters/vaultWriter.js');
const staging = require('../adapters/staging.js');
const tmpStore = require('../adapters/tmpStore.js');
const loadGraph = require('../core/loadGraph.js');
const chartModel = require('../core/chartModel.js');
const renderRules = require('../core/renderRules.js');

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

test('Branch 3 proposal stages through Vault for standalone and mixed Branch 1 results', async (t) => {
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
    const mainGraph = {
        relations: [{ type: 'part_of', parent: 'press_total', child: 'press_reps' }],
        targets: [], trends: [],
    };
    const originalData = [{ date: '2026-05-28', values: { press_reps: 40 }, interpretation_version: 0 }];
    const dataPath = storage.makeStorage({ vault: {} }).DATA_PATH;
    const event = { date: '2026-05-29', values: { press_reps: 50, press_max_set: 20 }, interpretation_version: 0 };
    const rule = {
        id: 'rule_001', raw: '50 пресс',
        mapping: { press_reps: 'пресс, повторения' },
        examples: [{ input: '50 пресс', values: { press_reps: 50 } }],
    };
    const relation = { type: 'overlay', base: 'press_reps', sub: 'press_max_set' };
    const chartGraphs = [];
    const chartCalls = [];
    for (const scenario of [
        { branch: 2, withProposal: true },
        { branch: 1, withProposal: true }, // TC-001 mixed [3,2,1] dominant branch.
        { branch: 1, withProposal: false }, // Ordinary Branch 1 must not invent a proposal.
    ]) {
        const { branch, withProposal } = scenario;
        loadGraph.clearLatestGraph();
        const files = new Map([
            [vaultWriter.FILES.rulesLog, JSON.stringify(mainRules)],
            [vaultWriter.FILES.graph, JSON.stringify(mainGraph)],
            [dataPath, JSON.stringify(originalData)],
        ]);
        const app = { vault: {
            getAbstractFileByPath: (path) => files.has(path) ? { path } : null,
            read: async (file) => files.get(file.path),
            create: async (path, contents) => { files.set(path, contents); },
            modify: async (file, contents) => { files.set(file.path, contents); },
        } };
        const readOnlyMainStorage = storage.makeStorage(app);
        const saveCalls = [];
        const commitInputs = [];
        const bundle = {
            storage: {
                makeStorage: () => ({
                    loadData: () => readOnlyMainStorage.loadData(),
                    saveData: async (events, options) => {
                        saveCalls.push({ events, options });
                        return { saved: true, path: dataPath, backup: false };
                    },
                }),
            },
            vaultWriter,
            staging,
            tmpStore,
            pipeline: {
                next: async () => ({
                    status: 'success', branch, confidence: 0.99,
                    payload: {
                        raw: '50 пресс', events: [event],
                        ...(withProposal ? {
                            rules: [rule], rule,
                            newKeys: [{ key: 'press_max_set', meaning: 'максимальный подход' }],
                            relations: [{ type: 'subset', old: 'press_reps', new: 'press_max_set' }],
                            proposal: { rule, rules: [rule] },
                        } : {}),
                    },
                }),
                commitRules: async (result) => {
                    commitInputs.push(result);
                    return { status: 'noop', branch, added: 0, version: 0 };
                },
            },
            renderRules: {
                ...renderRules,
                relationsFromLLM: (relations) => relations.map((item) => ({
                    type: 'overlay', base: item.old, sub: item.new,
                })),
            },
            loadGraph,
            chartModel: {
                toChartConfigs: (events, graph) => {
                    chartGraphs.push(JSON.parse(JSON.stringify(graph)));
                    return chartModel.toChartConfigs(events, graph);
                },
            },
            chartview: { renderChartGrouped: (_el, groups) => { chartCalls.push(groups); return []; } },
        };

        const container = new MockElement('container');
        const controller = editor.mountEditor({ container, app, bundle });
        await controller.render();
        const textareas = [];
        const collectTextareas = (node) => {
            if (node.tagName === 'textarea') textareas.push(node);
            node.children.forEach(collectTextareas);
        };
        collectTextareas(container);
        assert.equal(textareas.length, 2);
        textareas[0].value = '50 пресс';
        const runButton = findElement(container, (node) => node.tagName === 'button' && node.textContent === editor.UI_TEXT.runBtn);
        assert.ok(runButton);
        await runButton.listeners.get('click')();

        const rulesTmp = JSON.parse(files.get(tmpStore.RULESLOG_TMP_PATH));
        const graphTmp = JSON.parse(files.get(tmpStore.GRAPH_TMP_PATH));
        const staged = JSON.parse(files.get(staging.STAGE_PATH));
        assert.deepEqual(rulesTmp.rules, withProposal ? [rule] : [], `branch=${branch}: proposal staging`);
        assert.deepEqual(rulesTmp.newKeys, withProposal ? [{ key: 'press_max_set', meaning: 'максимальный подход' }] : []);
        assert.deepEqual(staged.events, [event], `branch=${branch}: event staged`);
        assert.deepEqual(graphTmp.relations, withProposal ? [relation] : [], `branch=${branch}: graph relation staging`);
        assert.deepEqual(loadGraph(), mainGraph, 'startup graph source is the graph.json value read from Vault');
        const renderedGraph = chartGraphs[chartGraphs.length - 1];
        assert.deepEqual(renderedGraph.relations, withProposal ? [...mainGraph.relations, relation] : mainGraph.relations,
            'chart preview combines Vault main graph and staged graph.tmp relations');
        if (withProposal) {
            const groups = chartCalls[chartCalls.length - 1];
            assert.equal(groups.length, 1, 'main part_of and staged overlay place both metrics in one chart group');
            assert.deepEqual(groups[0].config.datasets.map((dataset) => dataset.label).sort(),
                ['press_max_set', 'press_reps'], 'preview chart renders both base and overlay datasets');
        }
        assert.equal(files.get(vaultWriter.FILES.rulesLog), JSON.stringify(mainRules));
        assert.equal(files.get(vaultWriter.FILES.graph), JSON.stringify(mainGraph));
        assert.equal(files.get(dataPath), JSON.stringify(originalData));
        assert.ok(files.has(tmpStore.RULESLOG_TMP_PATH));
        assert.ok(files.has(tmpStore.GRAPH_TMP_PATH));
        assert.ok(files.has(staging.STAGE_PATH));
        if (branch === 1 && withProposal) {
            assert.equal(commitInputs.length, 0, 'proposal is not committed before explicit Save');
            const acceptButton = findElement(container, (node) => node.tagName === 'button' && /Принять правило/.test(node.textContent));
            assert.equal(acceptButton, null, 'no separate rule approval pane');
            const saveButton = findElement(container, (node) => node.tagName === 'button' && node.textContent === editor.UI_TEXT.saveBtn);
            await saveButton.listeners.get('click')();
            assert.equal(commitInputs.length, 1, 'Save reaches commit gate');
            assert.equal(Object.hasOwn(commitInputs[0].payload, 'proposal'), true,
                'Save confirms the mixed proposal with the events');
            assert.equal(saveCalls.length, 1);
        }
        assert.equal(files.get(vaultWriter.FILES.rulesLog), JSON.stringify(mainRules));
        assert.equal(files.get(vaultWriter.FILES.graph), JSON.stringify(mainGraph));
        assert.equal(files.get(dataPath), JSON.stringify(originalData));

        // Reopen restores any unsaved relations alongside the Vault main graph.
        loadGraph.clearLatestGraph();
        await controller.render();
        assert.deepEqual(loadGraph(), mainGraph, 'reopen uses Vault graph.json, not the embedded empty graph snapshot');
        const remainingTemp = JSON.parse(files.get(tmpStore.GRAPH_TMP_PATH)).relations;
        assert.deepEqual(chartGraphs[chartGraphs.length - 1].relations, [...mainGraph.relations, ...remainingTemp],
            'reopened chart renders main plus any unsaved temp');
    }
    loadGraph.clearLatestGraph();
});
