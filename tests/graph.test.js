'use strict';
// tests/graph.test.js — слой 3: Semantic graph (AC4). Чистый, без dv/app/DOM.
const test = require('node:test');
const assert = require('node:assert/strict');

const { childrenOf, relationBetween, relationsOfType } = require('../core/graph.js');

// Фикстура графа (логика детей/отношений), НЕ data/graph.json — тот пуст после сброса.
const graph = {
    relations: [
        { type: 'part_of', parent: 'push_total', child: 'push_no' },
        { type: 'part_of', parent: 'push_total', child: 'push_full' },
        { type: 'part_of', parent: 'push_total', child: 'push_knee' },
        { type: 'part_of', parent: 'push_total', child: 'push_assisted' },
        { type: 'part_of', parent: 'pull_total', child: 'pull_no' },
        { type: 'part_of', parent: 'pull_total', child: 'pull_full' },
        { type: 'successor', parent: 'push_full', child: 'push_max_set' },
        { type: 'successor', parent: 'pull_full', child: 'pull_max_set' },
        { type: 'independent', parent: 'push_max_set', child: 'push_max' },
    ],
    targets: ['push_max_set', 'pull_max_set'],
};

test('childrenOf: push_total собирает всех part_of-детей (включая push_no)', () => {
    const kids = childrenOf('push_total', graph);
    assert.ok(Array.isArray(kids));
    assert.ok(kids.includes('push_no'));     // legacy-маппинг push_no → part_of → push_total
    assert.ok(kids.includes('push_full'));
    assert.ok(kids.includes('push_knee'));
    assert.ok(kids.includes('push_assisted'));
});

test('childrenOf: pull_total симметрично', () => {
    const kids = childrenOf('pull_total', graph);
    assert.ok(kids.includes('pull_no'));
    assert.ok(kids.includes('pull_full'));
});

test('childrenOf: неизвестная сущность → пустой массив', () => {
    assert.deepEqual(childrenOf('nonexistent', graph), []);
    assert.deepEqual(childrenOf('push_max', graph), []); // не part_of-родитель
});

test('relationBetween возвращает тип отношения', () => {
    assert.equal(relationBetween('push_no', 'push_total', graph), 'part_of');
    assert.equal(relationBetween('pull_full', 'pull_max_set', graph), 'successor');
    assert.equal(relationBetween('push_max_set', 'push_max', graph), 'independent');
});

test('relationBetween поиск двусторонний (направление не важно)', () => {
    assert.equal(relationBetween('push_total', 'push_no', graph), 'part_of');
    assert.equal(relationBetween('pull_max_set', 'pull_full', graph), 'successor');
});

test('relationBetween: нет связи → null', () => {
    assert.equal(relationBetween('push_no', 'pull_no', graph), null);
    assert.equal(relationBetween('unknown', 'whatever', graph), null);
});

test('relationBetween: битый граф → null', () => {
    assert.equal(relationBetween('a', 'b', null), null);
    assert.equal(relationBetween('a', 'b', { relations: [] }), null);
    assert.equal(relationBetween('a', 'b', {}), null);
});

test('relationsOfType фильтрует по типу', () => {
    const succ = relationsOfType(graph, 'successor');
    assert.ok(succ.length >= 1);
    assert.ok(succ.every(r => r.type === 'successor'));
    assert.equal(relationsOfType(null, 'part_of').length, 0);
    assert.equal(relationsOfType({ relations: [] }, 'part_of').length, 0);
});