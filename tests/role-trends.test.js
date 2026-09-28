'use strict';
// Tests: role-based trends (variant A, user-approved 2026-08-31)
const test = require('node:test');
const assert = require('node:assert');
const CM = require('../core/chartModel.js');
const RR = require('../core/renderRules.js');

test('trends: rule.roles trend-ключ уходит в graph.trends', () => {
    const snap = { dynamic: [{ id: 'r1', mapping: { push_standard: 'push_standard', push_knees: 'push_knees' }, roles: { push_standard: 'stack', push_knees: 'overlay' } }], global: [] };
    const g = RR.graphFromKeys(RR.keysFromRules(snap), RR.trendsFromRules(snap));
    assert.deepEqual(g.trends, ['push_knees']);
    assert.ok(g.relations.every(r => r.child !== 'push_knees' || r.type === 'part_of'));
});

test('trends (детерминизм, 2026-09-01): A+B → тренд на НИЖНЮЮ полоску (появилась раньше); без тегов', () => {
    const g = { relations: [{ type: 'part_of', parent: 'push_total', child: 'push_standard' }, { type: 'part_of', parent: 'push_total', child: 'push_knees' }], targets: [], trends: [] };
    const events = [
        { date: '2026-06-01', values: { push_standard: 15 } },                       // база раньше
        { date: '2026-06-02', values: { push_standard: 16, push_knees: 45 } },
        { date: '2026-06-03', values: { push_standard: 20, push_knees: 40 } },
    ];
    const cfg = CM.toChartConfig(events, g);
    const lines = cfg.datasets.filter(d => d.type === 'line');
    assert.equal(lines.length, 1);
    assert.equal(lines[0].label, 'push_standard'); // нижняя (база) полоска
    assert.deepEqual(lines[0].data, [15, 16, 20]);
    // обе полоски остаются в стеке (тренд = поверх, «вместе», не вместо)
    const bars = cfg.datasets.filter(d => d.type === 'bar').map(d => d.label).sort();
    assert.deepEqual(bars, ['push_knees', 'push_standard']);
});

test('trends: пара без явной очерёдности (одинаковый старт) → тренд на более полную серию', () => {
    const g = { relations: [{ type: 'part_of', parent: 'push_total', child: 'push_standard' }, { type: 'part_of', parent: 'push_total', child: 'push_knees' }], targets: [], trends: [] };
    const events = [
        { date: '2026-06-01', values: { push_standard: 15, push_knees: 45 } },
        { date: '2026-06-03', values: { push_standard: 20 } },
        { date: '2026-06-05', values: { push_standard: 22 } },
    ];
    const cfg = CM.toChartConfig(events, g);
    const line = cfg.datasets.find(d => d.type === 'line');
    assert.ok(line);
    assert.equal(line.label, 'push_standard'); // больше непустых точек = база
});

test('trends: одиночная компонента (не пара) — линий нет', () => {
    const g = { relations: [{ type: 'part_of', parent: 'push_total', child: 'push_standard' }], targets: [], trends: [] };
    const events = [{ date: '2026-06-01', values: { push_standard: 15 } }];
    const cfg = CM.toChartConfig(events, g);
    assert.equal(cfg.datasets.filter(d => d.type === 'line').length, 0);
    assert.equal(cfg.datasets.filter(d => d.type === 'bar').length, 1);
});

test('trends: роли без trend — граф без трендов (не падает на пустых roles)', () => {
    const snap = { dynamic: [{ id: 'r1', mapping: { a_reps: 'a_reps' }, roles: { a_reps: 'stack' } }], global: [] };
    const g = RR.graphFromKeys(RR.keysFromRules(snap), RR.trendsFromRules(snap));
    assert.deepEqual(g.trends, []);
});

test('trends: mergeGraph переносит trends; новые ключи БЕЗ связей не дают part_of (расхождение №3)', () => {
    const base = { relations: [], targets: [], trends: ['push_knees'] };
    const merged = RR.mergeGraph(base, new Set(['pull_standard']));
    assert.deepEqual(merged.trends, ['push_knees']);
    assert.equal(merged.relations.length, 0, 'связи из имён ключей больше не синтезируются');
});
