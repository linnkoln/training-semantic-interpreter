'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const editor = require('../ui/editor.js');
const storage = require('../adapters/storage.js');
const vaultWriter = require('../adapters/vaultWriter.js');
const staging = require('../adapters/staging.js');
const tmpStore = require('../adapters/tmpStore.js');
const GRAPH_TMP_PATH = 'scripts/training/data/graph.tmp.json';

class MockElement {
    constructor(tag) {
        this.tagName = tag;
        this.children = [];
        this.listeners = new Map();
        this.style = {};
        this.value = '';
        this._text = '';
        this._html = '';
    }
    appendChild(child) { this.children.push(child); child.parent = this; return child; }
    setAttribute() {}
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

test('Save merges Vault graph.tmp into graph.json and retains temp on transaction rollback', async (t) => {
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
    const oldRelation = { type: 'overlay', base: 'pull_reps', sub: 'pull_rings_reps' };
    const stagedRelation = { type: 'overlay', base: 'push_reps', sub: 'push_max_set' };
    const mainGraph = { relations: [oldRelation], targets: [], trends: [] };
    const originalData = [{ date: '2026-09-01', values: { press_reps: 20 }, interpretation_version: 1 }];
    const dataPath = storage.DATA_PATH;
    const files = new Map([
        [vaultWriter.FILES.rulesLog, JSON.stringify(mainRules)],
        [vaultWriter.FILES.graph, JSON.stringify(mainGraph)],
        [dataPath, JSON.stringify(originalData)],
        [GRAPH_TMP_PATH, JSON.stringify({ relations: [] })],
    ]);
    let failGraphWrite = false;
    let failGraphRead = false;
    const app = { vault: {
        getAbstractFileByPath: (path) => files.has(path) ? { path } : null,
        read: async (file) => {
            if (failGraphRead && file.path === vaultWriter.FILES.graph) {
                failGraphRead = false;
                throw new Error('injected graph read failure');
            }
            return files.get(file.path);
        },
        create: async (path, contents) => { files.set(path, contents); },
        createFolder: async () => {},
        modify: async (file, contents) => {
            if (failGraphWrite && file.path === vaultWriter.FILES.graph) {
                failGraphWrite = false;
                throw new Error('injected graph write failure');
            }
            files.set(file.path, contents);
        },
        delete: async (file) => { files.delete(file.path); },
    } };
    const appStorage = storage.makeStorage(app);
    const event = { date: '2026-09-02', values: { push_reps: 40 }, interpretation_version: 1 };
    const bundle = {
        storage: { makeStorage: () => appStorage },
        vaultWriter,
        staging,
        tmpStore,
        pipeline: {
            next: async () => ({
                status: 'success', branch: 3, confidence: 0.99,
                payload: {
                    raw: '50 отжимания максимум за подход: 12',
                    events: [event],
                    relations: [{ type: 'subset', old: 'push_reps', new: 'push_max_set' }],
                },
            }),
            // Reproduce a successful analysis where no new rule is committed.
            commitRules: async () => ({
                status: 'noop', branch: 3, added: 0, version: 0,
                payload: { graph: { relations: [oldRelation, stagedRelation], targets: ['derived'], trends: [] } },
            }),
        },
        renderRules: {
            mergeGraph: (graph) => graph,
            relationsFromLLM: (relations) => relations.map((item) => ({
                type: 'overlay', base: item.old, sub: item.new,
            })),
        },
        loadGraph: () => mainGraph,
        chartModel: { toChartConfigs: () => [] },
        chartview: { renderChartGrouped: () => [] },
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
    textareas[0].value = '50 отжимания максимум за подход: 12';
    const runButton = findElement(container, (node) => node.tagName === 'button' && node.textContent === editor.UI_TEXT.runBtn);
    await runButton.listeners.get('click')();
    assert.deepEqual(JSON.parse(files.get(GRAPH_TMP_PATH)).relations, [stagedRelation]);

    const saveButton = findElement(container, (node) => node.tagName === 'button' && node.textContent === editor.UI_TEXT.saveBtn);
    failGraphRead = true;
    await saveButton.listeners.get('click')();
    assert.deepEqual(JSON.parse(files.get(vaultWriter.FILES.graph)), mainGraph,
        'unreadable main graph is not treated as an empty graph');
    assert.deepEqual(JSON.parse(files.get(GRAPH_TMP_PATH)).relations, [stagedRelation],
        'temp relation remains after strict main graph read failure');

    failGraphWrite = true;
    await saveButton.listeners.get('click')();
    assert.deepEqual(JSON.parse(files.get(vaultWriter.FILES.graph)), mainGraph,
        'transaction rollback restores graph.json after a Vault write failure');
    assert.deepEqual(JSON.parse(files.get(GRAPH_TMP_PATH)).relations, [stagedRelation],
        'temp relation remains available for retry');

    await saveButton.listeners.get('click')();
    const savedGraph = JSON.parse(files.get(vaultWriter.FILES.graph));
    assert.deepEqual(savedGraph, { relations: [oldRelation, stagedRelation] },
        'retry persists old and staged relations to the live Vault graph in canonical shape');
    assert.deepEqual(Object.keys(savedGraph), ['relations'], 'main graph JSON omits derived targets/trends');
    assert.deepEqual(JSON.parse(files.get(GRAPH_TMP_PATH)).relations, [],
        'temp graph clears only after the main-file transaction succeeds');
    assert.deepEqual(JSON.parse(files.get(dataPath)), [event, originalData[0]]);
});
