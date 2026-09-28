'use strict';
// tests/tmpStore.test.js — пункт 5 (сверка STAGED-превью и Save с канвой):
//   • отрисовка main ∪ tmp: mergeGraphs / mergeRuleSnapshots (чистые слияния);
//   • Save-транзакция: аппенд в tmp-файлы и их очистка (clearRulesTmp/clearGraphTmp,
//     clearGraphTmpRelationsFs) — «tmp дописывается в main, tmp очищается»;
//   • очистка tmp при повторной «Обработке» (тот же clear-контракт, канал узла
//     «Очистка .tmp» канвы).

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const tmpStore = require('../adapters/tmpStore.js');

function tmpPath(name) {
    return path.resolve(__dirname, `../data/tmpStore.${name}.${crypto.randomBytes(6).toString('hex')}.tmp.json`);
}

// ---------------------------------------------------------------------
// Чистые слияния (отрисовка main ∪ tmp на лету)
// ---------------------------------------------------------------------

test('mergeGraphs: main ∪ tmp — связи/targets/trends сливаются, дубли убираются, вход не мутируется', () => {
    const main = {
        relations: [{ type: 'part_of', parent: 'push_total', child: 'push_reps' }],
        targets: ['push_max'],
        trends: ['push_reps'],
    };
    const tmp = {
        relations: [
            { type: 'part_of', parent: 'push_total', child: 'push_reps' }, // дубль main
            { type: 'part_of', parent: 'pull_total', child: 'pull_rings' }, // новый (Branch 3)
        ],
        targets: ['pull_max'],
        trends: ['pull_rings'],
    };
    const merged = tmpStore.mergeGraphs(main, tmp);
    assert.ok(merged.relations.some((r) => r.parent === 'push_total' && r.child === 'push_reps'));
    assert.ok(merged.relations.some((r) => r.parent === 'pull_total' && r.child === 'pull_rings'));
    assert.equal(merged.relations.filter((r) => r.child === 'push_reps').length, 1, 'дубликат main не задвоен');
    assert.deepEqual(merged.targets.sort(), ['pull_max', 'push_max']);
    assert.deepEqual(merged.trends.sort(), ['pull_rings', 'push_reps']);
    // INV-4: входы не мутированы
    assert.equal(main.relations.length, 1);
    assert.equal(tmp.relations.length, 2);
});

test('mergeGraphs: пустые/битые входы не бросают', () => {
    assert.deepEqual(tmpStore.mergeGraphs(null, null).relations, []);
    assert.deepEqual(tmpStore.mergeGraphs({ relations: [] }, undefined).targets, []);
});

test('mergeRuleSnapshots: minor-пример добавляется к существующему ключу, новые ключи — во временное правило', () => {
    const mainSnapshot = {
        version: 3,
        updatedAt: '2026-09-02T00:00:00.000Z',
        dynamic: [{ id: 'rule_001', semantics: 'отжимания', mapping: { push_reps: 'отжимания' }, roles: { push_reps: 'stack' }, cues: [], examples: [] }],
        global: [],
    };
    const tmpKeys = [
        { key: 'push_knees', role: 'stack', exampleText: 'отжимания с колен' },
        { key: 'push_reps', role: 'stack', exampleText: 'новая формулировка', source: 'minorRuleUpdate' },
    ];
    const merged = tmpStore.mergeRuleSnapshots(mainSnapshot, tmpKeys);
    const tmpRule = merged.dynamic.find((r) => r.id === 'tmp_session_keys');
    assert.ok(tmpRule, 'tmp-правило добавлено к main');
    assert.equal(tmpRule.mapping.push_knees, 'отжимания с колен');
    assert.ok(!('push_reps' in tmpRule.mapping), 'ключ main не дублируется в tmp-правиле');
    assert.equal(merged.dynamic[0].id, 'rule_001', 'main-правила сохранены');
    assert.deepEqual(merged.dynamic[0].examples, [{ input: 'новая формулировка', values: {} }]);
    const withValues = tmpStore.mergeRuleSnapshots(mainSnapshot, [
        { key: 'push_reps', role: 'stack', exampleText: 'явный ноль (50+0)', values: { push_reps: 50, push_knees_reps: 0 }, source: 'minorRuleUpdate' },
    ]);
    assert.deepEqual(withValues.dynamic[0].examples[0].values, {
        push_reps: 50, push_knees_reps: 0,
    }, 'пример сохраняет явный ноль как числовое значение');
    assert.ok(tmpRule.__tmp, 'пометка tmp для дедупа на Save');
});

// ---------------------------------------------------------------------
// fs-функции (node-контекст): аппенд в tmp и очистка (Save / повторная обработка)
// ---------------------------------------------------------------------

test('appendMinorMappingFs + readRulesTmpFs: аппенд «ключ → пример» в rulesLog.tmp.json с дедупом', () => {
    const p = tmpPath('rules');
    try {
        tmpStore._setRulesTmpPath(p);
        const r1 = tmpStore.appendMinorMappingFs([{ key: 'pull_bands', chunk: 'тяга резинкой 12', role: 'stack' }]);
        assert.equal(r1.newKeys.length, 1);
        // дедуп по key+exampleText
        const r2 = tmpStore.appendMinorMappingFs([{ key: 'pull_bands', chunk: 'тяга резинкой 12' }]);
        assert.equal(r2.newKeys.length, 1);
        assert.equal(tmpStore.readRulesTmpFs(p).newKeys.length, 1);
    } finally {
        tmpStore._setRulesTmpPath(path.resolve(__dirname, '..', 'data', 'rulesLog.tmp.json'));
        try { fs.unlinkSync(p); } catch (_) {}
    }
});

test('appendProposedRulesFs: Branch 3 rules сохраняются вместе с newKeys, legacy temp поддерживается', () => {
    const p = tmpPath('branch3-rules');
    try {
        tmpStore._setRulesTmpPath(p);
        fs.writeFileSync(p, JSON.stringify({ newKeys: [{ key: 'minor_key', source: 'minorRuleUpdate' }] }));
        const rule = {
            id: 'rule_001', raw: 'недетерминированный ввод',
            mapping: { press_reps: 'пресс' },
            examples: [{ input: '50 пресс', values: { press_reps: 50 } }],
        };
        tmpStore.appendProposedRulesFs([rule]);
        tmpStore.appendProposedRulesFs([rule]);
        const staged = tmpStore.readRulesTmpFs(p);
        assert.deepEqual(staged.rules, [rule], 'повторный append не дублирует предложение');
        assert.deepEqual(staged.newKeys, [{ key: 'minor_key', source: 'minorRuleUpdate' }], 'minor keys сохраняются');
    } finally {
        tmpStore._setRulesTmpPath(path.resolve(__dirname, '..', 'data', 'rulesLog.tmp.json'));
        try { fs.unlinkSync(p); } catch (_) {}
    }
});

test('appendProposedRulesFs: completeSnapshot replaces retired mapping/examples; unmarked updates stay incremental', () => {
    const p = tmpPath('branch3-snapshot');
    try {
        tmpStore._setRulesTmpPath(p);
        tmpStore.appendProposedRulesFs([{
            id: 'rule_007', raw: 'old source', mapping: { press_reps: 'press', press_knees: 'knees' },
            examples: [
                { input: 'old press', values: { press_reps: 20 } },
                { input: 'old knees', values: { press_knees: 10 } },
            ],
        }]);
        tmpStore.appendProposedRulesFs([{
            id: 'rule_007', raw: 'incremental source', mapping: { pull_reps: 'pull' },
            examples: [{ input: 'pull 5', values: { pull_reps: 5 } }],
        }]);
        tmpStore.appendProposedRulesFs([{
            id: 'rule_007', raw: 'complete source', completeSnapshot: true,
            mapping: { press_reps: 'press revised' },
            examples: [{ input: 'current press', values: { press_reps: 30 } }],
        }]);
        const staged = tmpStore.readRulesTmpFs(p);
        assert.deepEqual(staged.rules, [{
            id: 'rule_007', raw: 'complete source', completeSnapshot: true,
            mapping: { press_reps: 'press revised' },
            examples: [{ input: 'current press', values: { press_reps: 30 } }],
        }]);
    } finally {
        tmpStore._setRulesTmpPath(path.resolve(__dirname, '..', 'data', 'rulesLog.tmp.json'));
        try { fs.unlinkSync(p); } catch (_) {}
    }
});

test('appendGraphTmpRelationsFs: связи Branch 3 в graph.tmp.json с дедупом; clearGraphTmpRelationsFs очищает (Save/повтор)', () => {
    const p = tmpPath('graph');
    try {
        tmpStore._setGraphTmpPath(p);
        const rel = { type: 'part_of', parent: 'run_total', child: 'run_km' };
        tmpStore.appendGraphTmpRelationsFs([rel]);
        // идемпотентность (второй прогон/дописывание из editor.js)
        tmpStore.appendGraphTmpRelationsFs([rel, { type: 'part_of', parent: 'run_total', child: 'run_speed' }]);
        let g = tmpStore.readGraphTmpFs(p);
        assert.equal(g.relations.length, 2);
        assert.deepEqual(JSON.parse(fs.readFileSync(p, 'utf8')), { relations: [
            rel, { type: 'part_of', parent: 'run_total', child: 'run_speed' },
        ] }, 'graph.tmp.json сохраняет только согласованный relations envelope');
        // «Сохранить»/«Обработать заново» очищает tmp-связи
        tmpStore.clearGraphTmpRelationsFs(p);
        g = tmpStore.readGraphTmpFs(p);
        assert.deepEqual(g, { relations: [] });
        assert.deepEqual(JSON.parse(fs.readFileSync(p, 'utf8')), { relations: [] }, 'clear оставляет только relations');
    } finally {
        tmpStore._setGraphTmpPath(path.resolve(__dirname, '..', 'data', 'graph.tmp.json'));
        try { fs.unlinkSync(p); } catch (_) {}
    }
});

// ---------------------------------------------------------------------
// vault-контекст (bundle): makeTmpStore — очистка tmp при Save и при повторной обработке
// ---------------------------------------------------------------------

function makeFakeApp() {
    const files = new Map(); // path -> string
    const vault = {
        getAbstractFileByPath: (p) => (files.has(p) ? { path: p } : null),
        read: async (f) => files.get(f.path),
        create: async (p, data) => { files.set(p, data); },
        modify: async (f, data) => { files.set(f.path, data); },
    };
    return { app: { vault }, files };
}

test('makeTmpStore: appendRulesTmp → Save-очистка clearRulesTmp/clearGraphTmp возвращает tmp в пусто', async () => {
    const { app, files } = makeFakeApp();
    const store = tmpStore.makeTmpStore(app);
    await store.appendRulesTmp([
        { key: 'press_kettlebell', role: 'stack', input: 'жим гирей 15', date: '2026-09-01' },
    ]);
    let rules = await store.readRulesTmp();
    assert.equal(rules.newKeys.length, 1);
    await store.writeGraphTmp({ relations: [{ type: 'part_of', parent: 'press_total', child: 'press_kettlebell' }] });
    let graph = await store.readGraphTmp();
    assert.equal(graph.relations.length, 1);

    // Save (или повторная «Обработка»): tmp очищается
    await store.clearRulesTmp();
    await store.clearGraphTmp();
    rules = await store.readRulesTmp();
    graph = await store.readGraphTmp();
    assert.deepEqual(rules, { rules: [], newKeys: [] });
    assert.deepEqual(graph, { relations: [] });
    assert.deepEqual(JSON.parse(files.get(store.PATHS.GRAPH_TMP_PATH)), { relations: [] });
});

test('makeTmpStore: appendMinorMapping дедуп по key+exampleText, битый JSON читается как пусто', async () => {
    const { app, files } = makeFakeApp();
    const store = tmpStore.makeTmpStore(app);
    await store.appendMinorMapping([{ key: 'run_km', chunk: 'бег 5 км' }]);
    await store.appendMinorMapping([{ key: 'run_km', chunk: 'бег 5 км' }]);
    const rules = await store.readRulesTmp();
    assert.equal(rules.newKeys.length, 1);
    assert.equal(rules.newKeys[0].source, 'minorRuleUpdate');
    // битый tmp-файл → пусто, не бросает
    await store.writeGraphTmp({ relations: [] });
    files.set(store.PATHS.RULESLOG_TMP_PATH, '{broken json');
    assert.deepEqual(await store.readRulesTmp(), { rules: [], newKeys: [] });
});

test('makeTmpStore: Branch 3 proposals append/dedupe without dropping legacy newKeys', async () => {
    const { app } = makeFakeApp();
    const store = tmpStore.makeTmpStore(app);
    await store.appendRulesTmp([{ key: 'minor_key', source: 'minorRuleUpdate' }]);
    const rule = {
        id: 'rule_001', raw: 'new input', mapping: { run_km: 'distance' },
        examples: [{ input: '~5km', values: { run_km: 5 } }],
    };
    await store.appendProposedRules([rule]);
    await store.appendProposedRules([rule]);
    const staged = await store.readRulesTmp();
    assert.deepEqual(staged.rules, [rule]);
    assert.deepEqual(staged.newKeys, [{ key: 'minor_key', source: 'minorRuleUpdate' }]);
});

test('makeTmpStore: completeSnapshot replaces retired mapping/examples; unmarked updates stay incremental', async () => {
    const { app } = makeFakeApp();
    const store = tmpStore.makeTmpStore(app);
    await store.appendProposedRules([{
        id: 'rule_008', raw: 'old source', mapping: { run_km: 'distance', run_speed: 'speed' },
        examples: [
            { input: 'old run', values: { run_km: 5 } },
            { input: 'old speed', values: { run_speed: 8 } },
        ],
    }]);
    await store.appendProposedRules([{
        id: 'rule_008', raw: 'incremental source', mapping: { ride_km: 'ride distance' },
        examples: [{ input: 'ride 4', values: { ride_km: 4 } }],
    }]);
    await store.appendProposedRules([{
        id: 'rule_008', raw: 'complete source', completeSnapshot: true,
        mapping: { run_km: 'distance revised' },
        examples: [{ input: 'current run', values: { run_km: 6 } }],
    }]);
    assert.deepEqual((await store.readRulesTmp()).rules, [{
        id: 'rule_008', raw: 'complete source', completeSnapshot: true,
        mapping: { run_km: 'distance revised' },
        examples: [{ input: 'current run', values: { run_km: 6 } }],
    }]);
});

test('graph temp ignores legacy extras and Vault writes only relations', async () => {
    const p = tmpPath('graph-legacy');
    try {
        fs.writeFileSync(p, JSON.stringify({
            relations: [{ type: 'overlay', base: 'run_km', sub: 'run_max' }],
            targets: ['legacy_target'], trends: ['legacy_trend'],
        }));
        assert.deepEqual(tmpStore.readGraphTmpFs(p), {
            relations: [{ type: 'overlay', base: 'run_km', sub: 'run_max' }],
        });

        const { app, files } = makeFakeApp();
        const store = tmpStore.makeTmpStore(app);
        files.set(store.PATHS.GRAPH_TMP_PATH, JSON.stringify({
            relations: [{ type: 'overlay', base: 'run_km', sub: 'run_max' }],
            targets: ['legacy_target'], trends: ['legacy_trend'],
        }));
        assert.deepEqual(await store.readGraphTmp(), {
            relations: [{ type: 'overlay', base: 'run_km', sub: 'run_max' }],
        });
        await store.writeGraphTmp({ relations: [{ type: 'A+B', base: 'run_km', parts: ['run_trail'] }], targets: ['ignored'] });
        assert.deepEqual(JSON.parse(files.get(store.PATHS.GRAPH_TMP_PATH)), {
            relations: [{ type: 'A+B', base: 'run_km', parts: ['run_trail'] }],
        });
        await store.clearGraphTmp();
        assert.deepEqual(JSON.parse(files.get(store.PATHS.GRAPH_TMP_PATH)), { relations: [] });
    } finally {
        try { fs.unlinkSync(p); } catch (_) {}
    }
});
