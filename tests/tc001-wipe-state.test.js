'use strict';
// Тесты расхождения №6: handleWipe должен сбрасывать state.hiddenGroups в staged.tmp
// (staging.clear() сохраняет state → после wipe оставались «зомби-тоглы» скрытых групп).
// Запуск: node --test tests/tc001-wipe-state.test.js

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const stagingMod = require('../adapters/staging.js');
const editorMod = require('../ui/editor.js');
const UI_TEXT = editorMod.UI_TEXT;

// ---- минимальный DOM-шим (editor.js не требует jsdom) -----------------------
function makeNode(tag) {
    const node = {
        tag, children: [], style: {}, listeners: {}, parentNode: null,
        className: '', value: '', checked: false, disabled: false,
        setAttribute(n, v) { this['attr_' + n] = v; },
        appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
        remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((c) => c !== this); },
        addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); },
    };
    let _tc = '';
    Object.defineProperty(node, 'textContent', { get: () => _tc, set: (v) => { _tc = String(v); } });
    let _ih = '';
    Object.defineProperty(node, 'innerHTML', {
        get: () => _ih,
        set: (v) => { _ih = String(v); if (v === '') node.children = []; },
    });
    return node;
}

function makeDocument() {
    return {
        createElement: (tag) => makeNode(tag),
        createTextNode: (text) => ({ tag: '#text', text: String(text) }),
    };
}

function findButton(root, label) {
    if (root.textContent === label) return root;
    for (const c of root.children || []) {
        const hit = findButton(c, label);
        if (hit) return hit;
    }
    return null;
}

// ---- мок app.vault: файлы в памяти ------------------------------------------
function makeVault(initial) {
    const files = new Map();
    for (const [p, content] of Object.entries(initial || {})) files.set(p, { path: p, content });
    return {
        _files: files,
        getAbstractFileByPath(p) { return files.get(p) || null; },
        async read(f) { return f.content; },
        async create(p, content) { const f = { path: p, content }; files.set(p, f); },
        async modify(f, content) { f.content = content; },
    };
}

function makeBundle(stagingAdapter) {
    return {
        staging: { makeStaging: () => stagingAdapter },
        tmpStore: {
            makeTmpStore: () => ({
                clearRulesTmp: async () => {},
                clearGraphTmp: async () => {},
                readGraphTmp: async () => ({ relations: [], targets: [], trends: [] }),
                mergeGraphs: (a) => a,
            }),
        },
        storage: { makeStorage: () => ({ loadData: async () => [], saveData: async () => {} }) },
        chartModel: { toChartConfigs: () => [] },
        chartview: { renderChartGrouped: () => [] },
        loadGraph: () => ({ relations: [], targets: [], trends: [] }),
        rulesLog: {},
        renderRules: {},
    };
}

async function mount(vault, stagingAdapter) {
    const document = makeDocument();
    const savedDoc = global.document;
    const savedWin = global.window;
    global.document = document;
    global.window = { confirm: () => true };
    const container = makeNode('div');
    const ctrl = editorMod.mountEditor({ container, app: { vault }, bundle: makeBundle(stagingAdapter) });
    await ctrl.render();
    return {
        ctrl,
        container,
        wipe: async () => {
            const btn = findButton(container, UI_TEXT.wipeBtn);
            assert.ok(btn, 'wipe-кнопка не найдена в DOM');
            await btn.listeners.click[0]();
        },
        cleanup() { global.document = savedDoc; global.window = savedWin; try { ctrl.destroy(); } catch (_) {} },
    };
}

const STATE_PATH = stagingMod.STAGE_PATH;
const seededFile = JSON.stringify({
    events: [{ date: '2026-09-01', values: { push_1: 10 } }],
    state: { hiddenGroups: ['push', 'squat'] },
}, null, 2);

test('TC-001/расх.6: wipe сбрасывает state.hiddenGroups в staged.tmp', async () => {
    const vault = makeVault({ [STATE_PATH]: seededFile });
    const staging = stagingMod.makeStaging({ vault });
    const ui = await mount(vault, staging);
    try {
        // Санити: до wipe скрытые группы восстановлены в staging-файле.
        const before = await staging.readState();
        assert.deepStrictEqual(before.hiddenGroups, ['push', 'squat']);
        await ui.wipe();
        const file = JSON.parse(vault._files.get(STATE_PATH).content);
        assert.deepStrictEqual(file.state.hiddenGroups, [], 'после wipe hiddenGroups должно быть пусто');
        assert.deepStrictEqual(file.events, [], 'события после wipe стёрты');
        // И через адаптер:
        const after = await staging.readState();
        assert.deepStrictEqual(after.hiddenGroups, []);
    } finally { ui.cleanup(); }
});

test('TC-001/расх.6: wipe работает и когда staging-файла ещё нет (создаёт с пустым state)', async () => {
    const vault = makeVault({});
    const staging = stagingMod.makeStaging({ vault });
    const ui = await mount(vault, staging);
    try {
        await ui.wipe();
        assert.ok(!vault._files.get(STATE_PATH) || JSON.parse(vault._files.get(STATE_PATH).content).state.hiddenGroups.length === 0);
    } finally { ui.cleanup(); }
});

test('TC-001/расх.6: staging.clear() по-прежнему сохраняет state (Save-путь не изменён)', async () => {
    const vault = makeVault({ [STATE_PATH]: seededFile });
    const staging = stagingMod.makeStaging({ vault });
    await staging.clear();
    const st = await staging.readState();
    assert.deepStrictEqual(st.hiddenGroups, ['push', 'squat'], 'clear() не должен трогать state');
});

test('TC-001/расх.6: staging.writeState мержит патч поверх сохранённого state', async () => {
    const vault = makeVault({ [STATE_PATH]: seededFile });
    const staging = stagingMod.makeStaging({ vault });
    await staging.writeState({ hiddenGroups: [] });
    const st = await staging.readState();
    assert.deepStrictEqual(st.hiddenGroups, []);
});
