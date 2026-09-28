'use strict';
const { legacyEmptyRuleLog } = require('./helpers/legacyRuleLog.js');
// tests/save-preview.test.js — SAVE FIX + ПРЕВЬЮ-ГРАФ (2026-08-31):
//   • commitRules при сбое fs-записи (браузерный fs-shim) НЕ бросает: вычисляет новый
//     rulesLog + rebuilt graph В ПАМЯТИ и возвращает payload { log, graph };
//   • превью-граф: новые ключи последнего прогона дают part_of-группы в merged графе;
//     пустые ключи → никаких новых групп (диск-граф не тронут).

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');

const pipeline = require('../core/pipeline.js');
const rulesLog = require('../core/rulesLog.js');
const renderRules = require('../core/renderRules.js');
const loadGraph = require('../core/loadGraph.js');
const tmpStore = require('../adapters/tmpStore.js');

const REAL_LOG_PATH = path.resolve(__dirname, '../docs/testing/fixtures/TC-001-empty-state/rulesLog.json');

test.beforeEach((t) => {
    const originalGraphPath = pipeline._getGraphFsPath();
    const originalGraphTmpPath = tmpStore._getGraphTmpPath();
    const prefix = 'training-save-preview-graphs-';
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    const resolvedDir = path.resolve(tempDir);
    if (!resolvedDir.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`)
        || !path.basename(resolvedDir).startsWith(prefix)) {
        throw new Error(`Unsafe isolated graph paths: ${resolvedDir}`);
    }
    const graphPath = path.join(resolvedDir, 'graph.json');
    const graphTmpPath = path.join(resolvedDir, 'graph.tmp.json');
    pipeline._setGraphFsPath(graphPath);
    tmpStore._setGraphTmpPath(graphTmpPath);
    loadGraph.setLatestGraph({ relations: [], targets: [] });
    t.after(() => {
        loadGraph.clearLatestGraph();
        pipeline._setGraphFsPath(originalGraphPath);
        tmpStore._setGraphTmpPath(originalGraphTmpPath);
        for (const file of [graphPath, graphTmpPath]) {
            if (fs.existsSync(file)) fs.unlinkSync(file);
        }
        fs.rmdirSync(resolvedDir);
    });
});

// ============================================================
// Temp-лог: режим «чтение работает, запись ломается» — имитация
// браузерного fs-shim (writeFileSync бросает, кэш чтения жив).
// ============================================================
function makeBrowserLikeLog() {
    const suffix = crypto.randomBytes(8).toString('hex');
    const tempPath = path.resolve(__dirname, `../data/rulesLog.savepreview.${suffix}.tmp.json`);
    const origPath = rulesLog._getLogPath();
    const orig = legacyEmptyRuleLog();
    fs.writeFileSync(tempPath, JSON.stringify(orig, null, 2), 'utf8');
    rulesLog._resetCache();
    rulesLog._setLogPath(tempPath);
    const baseVersion = rulesLog.getVersion(); // кэш теперь прогрет (как в браузере после загрузки)
    // ломаем ЗАПИСЬ: путь указывает в несуществующий каталог (writeFileSync → ENOENT),
    // но кэш чтения уже прогрет — ровно как fs-shim в браузере.
    const brokenPath = path.resolve(tempPath, '../no-such-dir/rulesLog.json');
    rulesLog._setLogPath(brokenPath);
    return { tempPath, origPath, baseVersion };
}

function restoreLog(state) {
    rulesLog._setLogPath(state.origPath);
    rulesLog._resetCache();
    try { fs.unlinkSync(state.tempPath); } catch (_) {}
}

function branch1Result(newKey) {
    return {
        status: 'success',
        branch: 1,
        payload: {
            events: [{ date: '2026-08-29', values: { [newKey]: 40 }, interpretation_version: 1 }],
            newKeys: [{ key: newKey, input: 'пресс 40', date: '2026-08-29', values: { [newKey]: 40 } }],
        },
        confidence: 0.9,
    };
}

// ============================================================
// commitRules: браузерный режим (fs-запись бросает)
// ============================================================

test('commitRules: fs-запись падает → статус success, payload {log, graph}, НЕ бросает', async () => {
    const state = makeBrowserLikeLog();
    try {
        const res = await pipeline.commitRules(branch1Result('press_reps'), {});
        assert.equal(res.status, 'success');
        assert.equal(res.branch, 1);
        assert.equal(res.added, 1);
        assert.ok(res.payload, 'payload обязателен');
        assert.ok(res.payload.log, 'log обязателен');
        assert.ok(res.payload.graph, 'graph обязателен');
        // новый лог вычислен в памяти: версия монотонно выросла, правило внутри
        assert.equal(res.payload.log.version, state.baseVersion + 1);
        const lastEntry = res.payload.log.entries[res.payload.log.entries.length - 1];
        assert.ok(lastEntry.rulesSnapshot.dynamic.some((r) => r.mapping && r.mapping.press_reps));
        // граф: связи только явные — синтетический part_of press_total→press_reps
        // из имён ключей больше не строится (расхождение №3)
        const rels = res.payload.graph.relations;
        assert.ok(!rels.some((r) => r.type === 'part_of' && r.child === 'press_reps' && r.parent === 'press_total'),
            'нет синтетического _total от ключей');
        // реальный файл лога НЕ тронут (INV-2: в браузере записи нет — пишет vaultWriter)
        const onDisk = JSON.parse(fs.readFileSync(state.tempPath, 'utf8'));
        assert.equal(onDisk.version, state.baseVersion);
    } finally {
        restoreLog(state);
    }
});

test('commitRules: Branch 2 proposal в браузерном режиме готовит rulesLog для Save без записи через fs', async () => {
    const state = makeBrowserLikeLog();
    const origGraphPath = pipeline._getGraphFsPath();
    pipeline._setGraphFsPath(path.resolve(__dirname, '../data/no-such-browser-dir/graph.json'));
    try {
        const res = await pipeline.commitRules({
            status: 'success', branch: 2,
            payload: { events: [], proposal: { rule: { id: 'browser_branch2_rule', raw: 'становая тяга 50', mapping: { deadlift_kg: 'вес становой тяги' } } } },
        });
        assert.equal(res.status, 'success');
        assert.equal(res.added, 1);
        assert.equal(res.payload.log.version, state.baseVersion + 1);
        assert.ok(res.payload.log.entries.at(-1).rulesSnapshot.dynamic.some((rule) => rule.id === 'browser_branch2_rule'));
        assert.equal(JSON.parse(fs.readFileSync(state.tempPath, 'utf8')).version, state.baseVersion,
            'в браузерном режиме исходный файл не пишется до storage.saveData');
    } finally {
        pipeline._setGraphFsPath(origGraphPath);
        restoreLog(state);
    }
});

test('commitRules: Branch 3 multi-rule proposal выдаёт последовательные версии браузерного rulesLog', async () => {
    const state = makeBrowserLikeLog();
    const origGraphPath = pipeline._getGraphFsPath();
    pipeline._setGraphFsPath(path.resolve(__dirname, '../data/no-such-browser-dir/graph.json'));
    try {
        const res = await pipeline.commitRules({
            status: 'success', branch: 3,
            payload: { events: [], proposal: { rules: [
                { id: 'browser_branch3_rule_a', raw: 'тяга 1', mapping: { pull_a: 'тяга a' } },
                { id: 'browser_branch3_rule_b', raw: 'тяга 2', mapping: { pull_b: 'тяга b' } },
            ] } },
        });
        assert.equal(res.status, 'success');
        assert.equal(res.added, 2);
        assert.equal(res.payload.log.version, state.baseVersion + 2);
        assert.deepEqual(res.payload.log.entries.slice(-2).map((entry) => entry.version), [state.baseVersion + 1, state.baseVersion + 2]);
        assert.equal(JSON.parse(fs.readFileSync(state.tempPath, 'utf8')).version, state.baseVersion);
    } finally {
        pipeline._setGraphFsPath(origGraphPath);
        restoreLog(state);
    }
});

test('commitRules: node-режим (fs работает) — прежнее поведение + payload {log, graph}', async () => {
    const suffix = crypto.randomBytes(8).toString('hex');
    const tempPath = path.resolve(__dirname, `../data/rulesLog.savepreview.node.${suffix}.tmp.json`);
    const origPath = rulesLog._getLogPath();
    const orig = legacyEmptyRuleLog();
    fs.writeFileSync(tempPath, JSON.stringify(orig, null, 2), 'utf8');
    rulesLog._resetCache();
    rulesLog._setLogPath(tempPath);
    // data/graph.json не загрязняем: commitRules в node-режиме пишет граф fs-ом —
    // уводим путь графа в изолированный temp (хук _setGraphFsPath из Branch 3).
    const graphPath = path.resolve(__dirname, `../data/graph.savepreview.node.${suffix}.tmp.json`);
    const origGraphPath = pipeline._getGraphFsPath();
    pipeline._setGraphFsPath(graphPath);
    try {
        const baseVersion = rulesLog.getVersion();
        const res = await pipeline.commitRules(branch1Result('pull_rings'), {});
        assert.equal(res.status, 'success');
        assert.equal(res.payload.log.version, baseVersion + 1);
        assert.ok(fs.existsSync(tempPath));
        const onDisk = JSON.parse(fs.readFileSync(tempPath, 'utf8'));
        assert.equal(onDisk.version, baseVersion + 1); // node-режим реально пишет
        assert.ok(fs.existsSync(graphPath), 'граф записан в изолированный путь');
    } finally {
        rulesLog._setLogPath(origPath);
        rulesLog._resetCache();
        pipeline._setGraphFsPath(origGraphPath);
        try { fs.unlinkSync(tempPath); } catch (_) {}
        try { fs.unlinkSync(graphPath); } catch (_) {}
    }
});

test('commitRules: невалидный result → noop, без броска', async () => {
    const res = await pipeline.commitRules(null, {});
    assert.equal(res.status, 'noop');
});

// ============================================================
// Превью-граф: rebuildGraphFromRules(extraKeys) + mergeGraph
// ============================================================

test('превью-граф: новые ключи НЕ дают part_of-групп (связи только явные, расхождение №3)', () => {
    const g = renderRules.rebuildGraphFromRules(['push_standard', 'push_knees', 'running_distance_km']);
    assert.ok(!g.relations.some((r) => r.type === 'part_of' && r.parent === 'push_total'));
    assert.ok(!g.relations.some((r) => r.parent === 'running_total'));
});

test('превью-граф: пустой ЛОГ → связей из ключей нет; сохранённые явные связи диска переживают (расхождение №3)', () => {
    // Фикс (2026-09-01): тест зависел от состояния реального data/rulesLog.json (v2 пустой —
    // проходил, v6 с правилами — падал). Изолируем лог: пустой снапшот через _setLogPath.
    // Расхождение №3 (2026-09-03): из ключей связи больше не выводятся; ЯВНЫЕ связи
    // из data/graph.json (ручные/LLM) при этом сохраняются — это новый контракт.
    const os = require('os');
    const tmpLog = path.join(os.tmpdir(), 'save-preview_empty-log_' + Date.now() + '.json');
    fs.writeFileSync(tmpLog, JSON.stringify({ version: 0, updatedAt: null, entries: [] }), 'utf8');
    const rulesLog = require('../core/rulesLog.js');
    const origPath = rulesLog._getLogPath();
    rulesLog._resetCache(); rulesLog._setLogPath(tmpLog);
    const savedGraph = { relations: [{ type: 'part_of', parent: 'pull_total', child: 'pull_reps' }] };
    loadGraph.setLatestGraph(savedGraph);
    try {
        const g = renderRules.rebuildGraphFromRules([]);
        assert.ok(Array.isArray(g.relations));
        // никаких связей, выведенных из имён ключей правил (их нет — лог пуст)
        assert.deepEqual(g.relations, savedGraph.relations);
        assert.deepEqual(g.targets, []);
        const g2 = renderRules.rebuildGraphFromRules();
        assert.ok(Array.isArray(g2.relations));
    } finally {
        rulesLog._setLogPath(origPath); rulesLog._resetCache();
        if (fs.existsSync(tmpLog)) fs.unlinkSync(tmpLog);
    }
});

test('mergeGraph: диск-граф сохраняется; новые ключи БЕЗ явных связей ничего не добавляют', () => {
    const base = { relations: [{ type: 'part_of', parent: 'pull_total', child: 'pull_reps' }], targets: ['pull_max'] };
    const merged = renderRules.mergeGraph(base, ['pull_rings', 'pull_reps']);
    // старое отношение осталось
    assert.ok(merged.relations.some((r) => r.parent === 'pull_total' && r.child === 'pull_reps'));
    // новое из имён ключей НЕ выводится (расхождение №3)
    assert.ok(!merged.relations.some((r) => r.child === 'pull_rings'));
    // без дублей
    const countPullReps = merged.relations.filter((r) => r.child === 'pull_reps').length;
    assert.equal(countPullReps, 1);
    // targets: старый остался, дубликат не появился
    assert.deepEqual(merged.targets, ['pull_max']);
    // вход не мутирован (INV-4)
    assert.deepEqual(base.relations, [{ type: 'part_of', parent: 'pull_total', child: 'pull_reps' }]);
});

test('mergeGraph: пустые/битые входы не бросают', () => {
    assert.deepEqual(renderRules.mergeGraph(null, []).relations, []);
    assert.equal(renderRules.mergeGraph({ relations: [], targets: [] }, undefined).relations.length, 0);
});

// ============================================================
// Пункт 5 (2026-09-02): Save-транзакция — tmp → main для ВСЕХ ТРЁХ файлов
// ============================================================
//   rulesLog.tmp.json → rulesLog.json (через commitRules, ключи tmp — в newKeys);
//   graph.tmp.json    → graph.json (commitGraphRelations мержит связи tmp-графа);
//   tmp-файлы очищаются. data.tmp.json ↔ data.tmp.json покрывает adapters/staging.js
//   (см. tests/tmpStore.test.js — контракт очистки tmp).

test('Save-транзакция: связи graph.tmp.json мержатся в graph.json, tmp-связи очищаются', async () => {
    const suffix = crypto.randomBytes(8).toString('hex');
    const graphPath = path.resolve(__dirname, `../data/graph.savepreview.p5.${suffix}.tmp.json`);
    const graphTmpPath = path.resolve(__dirname, `../data/graph.tmp.savepreview.p5.${suffix}.tmp.json`);
    const tmpLogPath = path.resolve(__dirname, `../data/rulesLog.savepreview.p5.${suffix}.tmp.json`);
    const origLogPath = rulesLog._getLogPath();
    const origGraphPath = pipeline._getGraphFsPath();
    const origGraphTmpPath = tmpStore._getGraphTmpPath();
    fs.writeFileSync(tmpLogPath, JSON.stringify({ version: 0, updatedAt: null, entries: [] }), 'utf8');
    const rel = { type: 'part_of', parent: 'swim_total', child: 'swim_distance_m' };
    fs.writeFileSync(graphTmpPath, JSON.stringify({ relations: [rel], targets: [], trends: [] }, null, 2) + '\n', 'utf8');
    rulesLog._resetCache(); rulesLog._setLogPath(tmpLogPath);
    pipeline._setGraphFsPath(graphPath);
    tmpStore._setGraphTmpPath(graphTmpPath);
    try {
        const res = await pipeline.commitRules(branch1Result('swim_stroke'), {});
        assert.equal(res.status, 'success');
        // main-граф получил связь из tmp-графа (graph.tmp → graph.json merge)
        assert.ok(fs.existsSync(graphPath), 'graph.json записан');
        const mainGraph = JSON.parse(fs.readFileSync(graphPath, 'utf8'));
        assert.ok(mainGraph.relations.some((r) => r.type === rel.type && r.child === rel.child),
            'связь из graph.tmp.json переехала в main');
        // tmp-граф очищен (транзакция Save)
        assert.deepEqual(tmpStore.readGraphTmpFs(graphTmpPath).relations, []);
        // tmp-ключи прогона зафиксированы в main-логе (rulesLog.tmp → rulesLog.json контракт)
        const onDiskLog = JSON.parse(fs.readFileSync(tmpLogPath, 'utf8'));
        assert.ok(onDiskLog.entries.some((e) => (e.rulesSnapshot.dynamic || []).some((r) => r.mapping && r.mapping.swim_stroke)));
    } finally {
        rulesLog._setLogPath(origLogPath); rulesLog._resetCache();
        pipeline._setGraphFsPath(origGraphPath);
        tmpStore._setGraphTmpPath(origGraphTmpPath);
        for (const p of [graphPath, graphTmpPath, tmpLogPath]) { try { fs.unlinkSync(p); } catch (_) {} }
    }
});

test('Save-транзакция: tmp-ключи сессии (rulesLog.tmp) попадают в newKeys → правило в main-логе', async () => {
    // Путь editor.js (handleSave): extra-ключи из rulesLog.tmp.json дописываются в
    // payload.newKeys последнего прогона, затем commitRules. Проверяем контракт:
    // mergeMinorAppends-дедуп + appendRule через commitRules.
    const suffix = crypto.randomBytes(8).toString('hex');
    const tmpLogPath = path.resolve(__dirname, `../data/rulesLog.savepreview.p5b.${suffix}.tmp.json`);
    const graphPath = path.resolve(__dirname, `../data/graph.savepreview.p5b.${suffix}.tmp.json`);
    const origLogPath = rulesLog._getLogPath();
    const origGraphPath = pipeline._getGraphFsPath();
    fs.writeFileSync(tmpLogPath, JSON.stringify({ version: 0, updatedAt: null, entries: [] }), 'utf8');
    rulesLog._resetCache(); rulesLog._setLogPath(tmpLogPath);
    pipeline._setGraphFsPath(graphPath);
    try {
        const tmpKeys = tmpStore.mergeMinorAppends([], [{ key: 'row_machine', chunk: 'тяга в тренажёре 10', role: 'stack' }]);
        const res = await pipeline.commitRules(branch1Result('row_machine').payload ? {
            status: 'success', branch: 1,
            payload: { events: [], newKeys: tmpKeys.map((nk) => ({ ...nk, values: {} })) },
        } : {}, {});
        assert.equal(res.status, 'success');
        assert.equal(res.added, 1);
        const onDisk = JSON.parse(fs.readFileSync(tmpLogPath, 'utf8'));
        assert.ok(onDisk.entries.some((e) => (e.rulesSnapshot.dynamic || []).some((r) => r.mapping && r.mapping.row_machine)),
            'tmp-ключ сессии зафиксирован в main-логе на Save');
    } finally {
        rulesLog._setLogPath(origLogPath); rulesLog._resetCache();
        pipeline._setGraphFsPath(origGraphPath);
        for (const p of [tmpLogPath, graphPath]) { try { fs.unlinkSync(p); } catch (_) {} }
    }
});
