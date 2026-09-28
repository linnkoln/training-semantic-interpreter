'use strict';
// tests/chartModel.test.js — декларативный конфиг из семантики (AC4, AC11, AC13).
const test = require('node:test');
const assert = require('node:assert/strict');

const { toChartConfig } = require('../core/chartModel.js');

// Фикстура графа (part_of/successor/independent), НЕ data/graph.json — тот пуст после сброса.
const graph = {
    relations: [
        { type: 'part_of', parent: 'push_total', child: 'push_no' },
        { type: 'part_of', parent: 'push_total', child: 'push_full' },
        { type: 'part_of', parent: 'push_total', child: 'push_knee' },
        { type: 'part_of', parent: 'push_total', child: 'push_assisted' },
        { type: 'part_of', parent: 'pull_total', child: 'pull_no' },
        { type: 'part_of', parent: 'pull_total', child: 'pull_full' },
        { type: 'part_of', parent: 'pull_total', child: 'pull_knee' },
        { type: 'part_of', parent: 'pull_total', child: 'pull_assisted' },
        { type: 'successor', parent: 'push_full', child: 'push_max_set' },
        { type: 'successor', parent: 'pull_full', child: 'pull_max_set' },
        { type: 'independent', parent: 'push_max_set', child: 'push_max' },
        { type: 'independent', parent: 'pull_max_set', child: 'pull_max' },
    ],
    targets: ['push_max_set', 'pull_max_set'],
};

// События в ПРОИЗВОЛЬНОМ порядке — конфиг сам сортирует по дате (AC13).
const events = [
    { date: '2026-08-19',
      values: { push_no: 20, push_full: 100, push_knee: 30, push_assisted: 10,
                pull_no: 10, pull_full: 50, pull_max_set: 60, push_max: 110 } },
    { date: '2026-08-12',
      values: { push_no: 18, push_full: 95, push_knee: 25, push_assisted: 8,
                pull_no: 9, pull_full: 45, pull_max_set: 55, push_max: 105 } },
];

test('part_of → одна стекнутая группа (стek по родителю), ось y', () => {
    const cfg = toChartConfig(events, graph);
    const bars = cfg.datasets.filter(d => d.type === 'bar');
    // push_total: push_no, push_full, push_knee, push_assisted (все есть в данных)
    const pushBars = bars.filter(d => d.stack === 'push_total');
    assert.equal(pushBars.length, 4);
    assert.ok(pushBars.every(d => d.yAxisID === 'y'));
    assert.ok(pushBars.every(d => Array.isArray(d.data)));
    // бары отсортированы по дате (8-12 раньше 8-19)
    const fullBar = pushBars.find(d => d.label === 'push_full');
    assert.deepEqual(fullBar.data, [95, 100]);
});

test('part_of: дети берутся из графа, не из обрезания по префиксу', () => {
    const cfg = toChartConfig(events, graph);
    const stacks = new Set(cfg.datasets.filter(d => d.type === 'bar').map(d => d.stack));
    // стек называется по имени родителя из графа (push_total), а не по префиксу "push"
    assert.ok(stacks.has('push_total'));
    assert.ok(stacks.has('pull_total'));
    assert.ok(!stacks.has('push'), 'группировка происходит по графу, а не по split("_")');
});

test('successor → есть линия-таймлайн на второй оси y1', () => {
    // Реалистичные события: max_set появляется только на поздней дате → full-тренд
    // рисуется до перехода, max_set — с появления.
    const evt = [
        { date: '2026-08-12', values: { pull_full: 45 } },
        { date: '2026-08-19', values: { pull_full: 50, pull_max_set: 60 } },
    ];
    const cfg = toChartConfig(evt, graph);
    const lines = cfg.datasets.filter(d => d.type === 'line');
    // terminal (последний) узел цепи — max_set — рисуется линией на y1
    const timeline = lines.find(d => d.yAxisID === 'y1' && d.label === 'pull_max_set');
    assert.ok(timeline, 'должна быть successor-линия по максимальному значению на оси y1');
    assert.deepEqual(timeline.data, [null, 60]);
    // previous узел (full) — линия-тренд, но ТОЛЬКО до появления max_set (переход),
    // чтобы не засорять верхние значения точками.
    const fullTrend = lines.find(d => d.label === 'pull_full (тренд)');
    assert.ok(fullTrend, 'full тоже должен быть линией-трендом');
    assert.deepEqual(fullTrend.data, [45, null], 'full обрезается на границе перехода к max_set');
    // оба имеют подписи-активности (сериализуемо)
    const timTs = timeline._labelActive, fullTs = fullTrend._labelActive;
    assert.ok(Array.isArray(timTs) && Array.isArray(fullTs));
    assert.equal(timTs.length, timeline.data.length);
    assert.equal(fullTs.length, fullTrend.data.length);
});

test('independent → отдельные multi-line на y1', () => {
    const cfg = toChartConfig(events, graph);
    const rows = cfg.datasets.filter(d => d.type === 'line');
    // push_max участвует в independent (push_max_set ↔ push_max)
    assert.ok(rows.some(d => d.label === 'push_max' && d.yAxisID === 'y1'));
});

test('конфиг — сериализуемый объект, без функций и DOM (AC13)', () => {
    const cfg = toChartConfig(events, graph);
    assert.equal(typeof cfg.datasets, 'object');
    assert.ok(Array.isArray(cfg.datasets));
    assert.ok(!Array.isArray(cfg));
    // JSON-кругозвон даёт равный объект → все значения сериализуемы (ни функций, ни Date-handle)
    const roundtrip = JSON.parse(JSON.stringify(cfg));
    assert.deepEqual(roundtrip, cfg);
    // нет функций нигде в конфиге
    const walk = (x) => {
        if (x === null) return;
        if (Array.isArray(x)) { x.forEach(walk); return; }
        if (typeof x === 'object') { Object.values(x).forEach(walk); return; }
        assert.notEqual(typeof x, 'function', 'в конфиге не должно быть функций');
    };
    walk(cfg);
});

test('сортировка по дате (AC13): выходной порядок меток неубывающий', () => {
    const shuffled = [events[1], events[0]]; // сначала 8-19, потом 8-12
    const cfg = toChartConfig(shuffled, graph);
    assert.deepEqual(cfg.labels, ['08-12', '08-19']);
});

test('метрика без отношений/связей рисуется обычным баром без тренда', () => {
    const orphanEvents = [{ date: '2026-08-12', values: { foo_unknown: 5 } }];
    const cfg = toChartConfig(orphanEvents, graph);
    assert.equal(cfg.datasets.length, 1);
    assert.equal(cfg.datasets[0].type, 'bar');
    assert.equal(cfg.datasets.filter((d) => d.type === 'line').length, 0);
    assert.deepEqual(cfg.datasets[0].data, [5]);
    assert.deepEqual(cfg.labels, ['08-12']);
});

test('пустые события → валидный пустой конфиг', () => {
    const cfg = toChartConfig([], graph);
    assert.deepEqual(cfg.labels, []);
    assert.deepEqual(cfg.datasets, []);
    assert.equal(cfg._source, 'semantic', 'AC11: конфиг помечен как семантический');
});
