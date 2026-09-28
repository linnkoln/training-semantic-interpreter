'use strict';
// Тесты расхождения №3 (TC-001/TC-002): роли отрисовки → только в граф, без _total.
// Формат связей: A+B {base, parts, stackOrder} (stackOrder СНИЗУ ВВЕРХ: снизу сложное,
// сверху лёгкое) и overlay {base, sub} (base сзади целиком, sub спереди поверх).
const test = require('node:test');
const assert = require('node:assert');
const RR = require('../core/renderRules.js');
const CM = require('../core/chartModel.js');

// ---------------------------------------------------------------- (1) graphFromKeys
test('TC-001: graphFromKeys не создаёт синтетических _total/part_of', () => {
    const keys = ['push_reps', 'push_knees_reps', 'push_max_set'];
    const g = RR.graphFromKeys(keys, new Set());
    assert.equal(g.relations.length, 0, 'связей из имён ключей больше не выводится');
    assert.ok(!g.relations.some((r) => String(r.parent || '').endsWith('_total')), 'нет _total');
    assert.deepEqual(g.targets, ['push_max_set']);
});

test('TC-001: graphFromKeys принимает явные связи без изменений (дедуп)', () => {
    const rel = { type: 'A+B', base: 'push_reps', parts: ['push_knees_reps'], stackOrder: ['push_reps', 'push_knees_reps'] };
    const g = RR.graphFromKeys(['push_reps', 'push_knees_reps'], new Set(), [rel, rel]);
    assert.deepEqual(g.relations, [rel]);
});

// ------------------------------------------------------- (2) relationsFromLLM форматы
test('TC-001: relationsFromLLM пропускает новый формат A+B/overlay и маппит старый', () => {
    const out = RR.relationsFromLLM([
        { type: 'A+B', base: 'push_reps', parts: ['push_knees_reps'], stackOrder: ['push_reps', 'push_knees_reps'], note: 'n' },
        { type: 'overlay', base: 'push_reps', sub: 'push_max_set' },
        { type: 'A+B', old: 'a_x', new: 'b_y', note: 'legacy' },
        { type: 'subset', old: 'a_x', new: 'b_y', note: 'legacy' },
        { type: 'A+B', base: 'push_reps', parts: ['push_knees_reps'], stackOrder: ['push_reps', 'push_knees_reps'] }, // дубль
        { type: 'wat', base: 'a', parts: ['b'] },   // мусор
        { type: 'A+B', base: '', parts: ['x'] },    // мусор
        null,
    ]);
    assert.deepEqual(out, [
        { type: 'A+B', base: 'push_reps', parts: ['push_knees_reps'], stackOrder: ['push_reps', 'push_knees_reps'] },
        { type: 'overlay', base: 'push_reps', sub: 'push_max_set' },
        { type: 'A+B', base: 'a_x', parts: ['b_y'], stackOrder: ['a_x', 'b_y'] },
        { type: 'overlay', base: 'a_x', sub: 'b_y' },
    ]);
});

// ------------------------------------------------------------- (3) chartModel: стек
test('TC-001: A+B стек по stackOrder снизу-вверх (base снизу, parts сверху)', () => {
    const graph = {
        relations: [{ type: 'A+B', base: 'push_reps', parts: ['push_knees_reps'], stackOrder: ['push_reps', 'push_knees_reps'] }],
        targets: [],
        trends: [],
    };
    const events = [
        { date: '2026-06-01', values: { push_reps: 30 } },
        { date: '2026-06-02', values: { push_reps: 20, push_knees_reps: 10 } },
    ];
    const cfg = CM.toChartConfig(events, graph);
    const stackBars = cfg.datasets.filter((d) => d.type === 'bar' && d.stack === 'push_reps');
    assert.deepEqual(stackBars.map((d) => d.label), ['push_reps', 'push_knees_reps'],
        'порядок датасетов = stackOrder: снизу base (сложное), сверху parts (лёгкое)');
    assert.ok(stackBars.every((d) => d.yAxisID === 'y'));
});

test('TC-002: overlay рисует base сзади и sub поверх на общей шкале', () => {
    const graph = {
        relations: [{ type: 'overlay', base: 'push_reps', sub: 'push_max_set' }],
        targets: [],
        trends: [],
    };
    const events = [
        { date: '2026-06-01', values: { push_reps: 100, push_max_set: 32 } },
    ];
    const cfg = CM.toChartConfig(events, graph);
    const base = cfg.datasets.find((d) => d.label === 'push_reps');
    const sub = cfg.datasets.find((d) => d.label === 'push_max_set');
    assert.ok(base && sub, 'оба датасета есть');
    assert.equal(base.type, 'bar');
    assert.equal(base.yAxisID, 'y');
    assert.equal(base.order, 3, 'base сзади');
    assert.deepEqual(base.data, [100]);
    assert.equal(sub.type, 'bar');
    assert.equal(sub.yAxisID, 'y', 'sub на шкале base, чтобы высоты оставались сопоставимы');
    assert.equal(sub.grouped, false, 'sub накладывается в то же положение по x');
    assert.equal(sub.order, 2, 'sub спереди');
    assert.ok(String(sub.backgroundColor).endsWith('99'), 'sub полупрозрачный — видна base');
    assert.deepEqual(sub.data, [32]);
});

// --------------------------------------------------- (4) ушедшая метрика не рисуется
test('A+B: нулевая/ушедшая часть (нет данных) не рисуется', () => {
    const graph = {
        relations: [{ type: 'A+B', base: 'push_reps', parts: ['push_knees_reps'], stackOrder: ['push_reps', 'push_knees_reps'] }],
        targets: [],
        trends: [],
    };
    const events = [{ date: '2026-06-01', values: { push_reps: 30 } }]; // push_knees_reps ушёл
    const cfg = CM.toChartConfig(events, graph);
    const labels = cfg.datasets.map((d) => d.label);
    assert.ok(labels.includes('push_reps'));
    assert.ok(!labels.includes('push_knees_reps'), 'часть без данных не рисуется');
});
