'use strict';
// tests/chartconfigs.test.js — P7fix: раздельная раскладка графиков по упражнениям (AC11/AC4).
// Проверяет toChartConfigs: несколько part_of-групп → по графику на каждую, семантически из графа.
const test = require('node:test');
const assert = require('node:assert/strict');

const { toChartConfigs, toChartConfig } = require('../core/chartModel.js');

// Фикстура графа (part_of-группы + successor + targets), НЕ data/graph.json — тот пуст после сброса.
const graph = {
    relations: [
        { type: 'part_of', parent: 'push_total', child: 'push_no' },
        { type: 'part_of', parent: 'push_total', child: 'push_full' },
        { type: 'part_of', parent: 'push_total', child: 'push_knee' },
        { type: 'part_of', parent: 'pull_total', child: 'pull_no' },
        { type: 'part_of', parent: 'pull_total', child: 'pull_full' },
        { type: 'successor', parent: 'push_full', child: 'push_max_set' },
        { type: 'successor', parent: 'pull_full', child: 'pull_max_set' },
    ],
    targets: ['push_max_set', 'pull_max_set'],
};

const events = [
    { date: '2026-08-19', values: { push_full: 100, push_knee: 30, push_max_set: 73, pull_full: 50, pull_max_set: 15 } },
    { date: '2026-08-12', values: { push_full: 95, push_knee: 25, push_max_set: 70, pull_full: 45, pull_max_set: 12 } },
];

test('toChartConfigs: отдельный график на каждую part_of-группу', () => {
    const groups = toChartConfigs(events, graph);
    const titles = groups.map((g) => g.title);
    assert.ok(titles.includes('🏋️ Push'), 'есть группа Push');
    assert.ok(titles.includes('🏋️ Pull'), 'есть группа Pull');
});

test('toChartConfigs: relation base уже входящий в part_of не дублирует toggle и график', () => {
    const mixedGraph = {
        relations: [
            { type: 'part_of', parent: 'push_total', child: 'push_reps' },
            { type: 'overlay', base: 'push_reps', sub: 'push_max_set' },
            { type: 'part_of', parent: 'pull_total', child: 'pull_reps' },
            { type: 'overlay', base: 'pull_reps', sub: 'pull_max_set' },
        ],
        targets: [],
        trends: [],
    };
    const mixedEvents = [{ date: '2026-09-23', values: {
        push_reps: 50, push_max_set: 20, pull_reps: 25, pull_max_set: 6,
    } }];
    const groups = toChartConfigs(mixedEvents, mixedGraph);
    assert.deepEqual(groups.map((g) => g.title), ['🏋️ Push', '🏋️ Pull']);
    assert.deepEqual(groups.map((g) => g.config._group), ['push_total', 'pull_total']);
});

test('toChartConfigs: push-группа содержит только push-метрики', () => {
    const groups = toChartConfigs(events, graph);
    const push = groups.find((g) => g.config._group === 'push_total');
    const labels = push.config.datasets.map((d) => d.label);
    assert.ok(push.config.datasets.some((d) => d.label === 'push_full'), 'push_full в push-группе');
    assert.ok(push.config.datasets.some((d) => d.label === 'push_knee'), 'push_knee в push-группе');
    assert.ok(labels.every((l) => !l.startsWith('pull')), 'нет pull-метрик в push-группе');
});

test('toChartConfigs: группа содержит стек part_of по своему родителю', () => {
    const groups = toChartConfigs(events, graph);
    const pull = groups.find((g) => g.config._group === 'pull_total');
    const stacks = new Set(pull.config.datasets.filter((d) => d.type === 'bar' && d.order === 3).map((d) => d.stack));
    assert.deepEqual([...stacks], ['pull_total']);
});

test('trends: full (ранний) и max_set (последний) — оба линии; max_set ещё и таргет-бар', () => {
    // max_set участвует и в successor (полный тренд), и в targets (накладывающийся бар).
    const groups = toChartConfigs(events, graph);
    const push = groups.find((g) => g.config._group === 'push_total');
    const lineLabels = push.config.datasets.filter((d) => d.type === 'line').map((d) => d.label);
    // terminal-тренд (max_set) — линия, и ранний тренд (full) — тоже линия
    assert.ok(lineLabels.includes('push_max_set'), 'последний тренд (max_set) — линия на y1');
    assert.ok(lineLabels.includes('push_full (тренд)'), 'ранний тренд (full) — линия на y1');
    // max_set дополнительно рисуется накладывающимся баром (target)
    const maxBar = push.config.datasets.find((d) => d.type === 'bar' && d.label === 'push_max_set (max)');
    assert.ok(maxBar, 'max_set должен быть накладывающимся баром-целью');
    assert.equal(maxBar.yAxisID, 'y');
    // и не дублируется: ключ рисуется один раз как линия
    const maxLineCount = lineLabels.filter((l) => l === 'push_max_set').length;
    assert.equal(maxLineCount, 1, 'max_set одна линия');
});

test('groups PO возвращают конфиг по возрастанию даты (AC13)', () => {
    const groups = toChartConfigs(events, graph);
    for (const g of groups) {
        assert.deepEqual(g.config.labels, ['08-12', '08-19']);
    }
});

test('saved A+B and overlay relations produce a bounded old trend and active new trend', () => {
    const graph = {
        relations: [
            { type: 'A+B', base: 'push_reps', parts: ['push_knees_reps'], stackOrder: ['push_reps', 'push_knees_reps'] },
            { type: 'overlay', base: 'push_reps', sub: 'push_max_set' },
        ],
        targets: ['push_max_set'],
    };
    const events = [
        { date: '2026-06-01', values: { push_reps: 12, push_knees_reps: 18 } },
        { date: '2026-06-03', values: { push_reps: 16, push_knees_reps: 0 } },
        { date: '2026-06-05', values: { push_reps: 20, push_max_set: 8 } },
    ];
    const groups = toChartConfigs(events, graph);
    assert.equal(groups.length, 1);
    const datasets = groups[0].config.datasets;
    assert.deepEqual(datasets.find((d) => d.label === 'push_knees_reps').data, [18, 0, null]);
    assert.deepEqual(datasets.find((d) => d.label === 'push_reps (тренд)').data, [12, 16, null]);
    assert.deepEqual(datasets.find((d) => d.label === 'push_max_set' && d.type === 'line').data, [null, null, 8]);
    assert.deepEqual(datasets.find((d) => d.label === 'push_max_set' && d.type === 'line')._labelActive, [false, false, true]);
    const overlay = datasets.find((d) => d.label === 'push_max_set' && d.type === 'bar');
    assert.equal(overlay.yAxisID, 'y');
    assert.equal(overlay.grouped, false);
});

test('independent metrics with different key prefixes stay together by graph relation', () => {
    const graph = { relations: [{ type: 'independent', parent: 'running_distance_km', child: 'pace_min_km' }] };
    const events = [{ date: '2026-06-01', values: { running_distance_km: 5, pace_min_km: 6 } }];
    const groups = toChartConfigs(events, graph);
    assert.equal(groups.length, 1);
    assert.deepEqual(groups[0].config.datasets.map((d) => d.label), ['running_distance_km', 'pace_min_km']);
});
