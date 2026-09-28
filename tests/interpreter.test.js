'use strict';
// tests/interpreter.test.js — P4 интерпретатор: 2 прохода + 4-режимный автомат + блокер слово-порядок.
const test = require('node:test');
const assert = require('node:assert/strict');

const { DEFAULT_RULES } = require('../core/rules.js');
const { isEvent } = require('../core/events.js');
const {
    interpret,
    confirmProposal,
    reorderDialect,
    proposeIfPossible,
} = require('../core/interpreter.js');

const DATE = '2026-08-19';

// Фикстура правил (синтетический диалект), НЕ data/rules.json — тот пуст после сброса.
// Логика автомата (resolved/conflict/version/frozen) проверяется на переданных правилах.
const FIXTURE_RULES = {
    version: 1,
    updatedAt: '2026-01-01',
    dynamic: [
        { id: 'rule_001', __version: 1, when: { pattern: '^тест\\s*(\\d+)$' }, then: { entity: 'test', metric: 'full', composition: 'single' } },
    ],
    global: [
        { id: 'rule_002', __version: 1, when: { pattern: '^(\\d+)$', context: 'test_max' }, then: { entity: 'test', metric: 'max_set', composition: 'single' } },
    ],
};

// ---- Тесты распознавания реального ввода старой эпохи («100 отжимания (73+27)» и т.п.)
// УДАЛЕНЫ: распознавание входа — LLM (ПАМЯТКА AGENTS.md, D9/D15), а не регекс-match.

// ---- (4) AC6 дубликат даты ----
test('AC6: дата уже есть в baseEvents → конфликт, существующее событие НЕ перезаписывается', () => {
    const existing = { date: DATE, values: { test_full: 100 }, interpretation_version: 1, createdAt: 'x' };
    const r = interpret('тест 100', { date: DATE, rules: FIXTURE_RULES, baseEvents: [existing] });
    assert.equal(r.mode, 'resolved');
    assert.equal(r.payload.events.length, 0, 'конфликтная дата не создаёт новое событие');
    assert.deepEqual(r.payload.conflicts, [DATE]);
    // существующее событие не тронуто (иммутабельность AC6)
    assert.equal(existing.values.test_full, 100);
    assert.deepEqual(existing.values, { test_full: 100 });
});
test('reorderDialect: число первым → слово первым (A+B), слово первым остаётся без изменений', () => {
    assert.equal(reorderDialect('100 отжимания (73+27)'), 'отжимания 100 (73+27)');
    assert.equal(reorderDialect('50 подтягиваний макс: 15'), 'подтягиваний 50 макс: 15');
    assert.equal(reorderDialect('100 отжимания'), 'отжимания 100');
    // слово первым — не трогаем
    assert.equal(reorderDialect('отжимания 100 (73+27)'), 'отжимания 100 (73+27)');
    assert.equal(reorderDialect('подтягивания 50 макс: 6'), 'подтягивания 50 макс: 6');
});

test('reorderDialect: «подтягиваний» не «съедается» более коротким «подтягивания»', () => {
    // из-за прогрессивной альтернации + (?![а-яё]) длинное слово матчится целиком
    assert.equal(reorderDialect('50 подтягиваний макс: 15'), 'подтягиваний 50 макс: 15');
    assert.equal(reorderDialect('40 подтягивания (30+10)'), 'подтягивания 40 (30+10)');
});

// ---- (2) ambiguous, когда правила нет ----
test('AC1: нет правила → НЕ success, событий нет (ambiguous без контекста)', () => {
    const r = interpret('присед 30', { date: DATE });
    assert.equal(r.mode, 'ambiguous');
    assert.equal(r.status, 'ambiguous');
    assert.equal(r.payload.events, undefined);
    // нет ни одного события, несмотря на число
    assert.ok(!r.payload || !Array.isArray(r.payload.events) || r.payload.events.length === 0);
});

// ---- (3) resolve → migrate → structured ----
test('resolve→migrate→structured: число в контексте max → предложение → подтверждение → событие', async () => {
    // 'макс 6' не покрыто правилами (нет паттерна ^макс), но есть контекст pull_max
    const first = interpret('макс 6', { date: DATE, lastContext: 'pull_max_set' });
    assert.equal(first.mode, 'resolve');
    assert.equal(first.status, 'resolve');
    assert.ok(first.payload.proposal);
    assert.equal(first.payload.proposal.kind, 'propose_dynamic');
    assert.equal(first.payload.proposal.draft.then.entity, 'pull');
    assert.equal(first.payload.proposal.draft.then.metric, 'max_set');

    // подтверждение → миграция → STRUCTURED с новой версией
    const fakeLlm = async () => ({ status: 'success', payload: { ok: true }, confidence: 1 });
    const confirmed = await confirmProposal(first.payload.proposal, {
        rules: DEFAULT_RULES,
        date: DATE,
        llm: fakeLlm,
    });
    assert.equal(confirmed.mode, 'structured');
    assert.equal(confirmed.migrated, true);
    assert.equal(confirmed.status, 'success');
    assert.equal(confirmed.interpretation_version, DEFAULT_RULES.version + 1);
    assert.equal(confirmed.payload.events.length, 1);
    assert.deepEqual(confirmed.payload.events[0].values, { pull_max_set: 6 });
});

test('resolve: без контекста (нет правдоподобного) → чистый ambiguous, не resolve', () => {
    const r = interpret('макс 6', { date: DATE }); // lastContext нет
    assert.equal(r.mode, 'ambiguous');
    assert.equal(r.status, 'ambiguous');
});

// Старый AC6-тест на реальном вводе заменён фикстурной версией выше (см. шапку файла).

test('AC6: после миграции дубликат даты тоже не перезаписывается', async () => {
    const existing = { date: DATE, values: { pull_max_set: 1 }, interpretation_version: 1, createdAt: 'x' };
    const first = interpret('макс 6', { date: DATE, lastContext: 'pull_max_set' });
    const confirmed = await confirmProposal(first.payload.proposal, {
        rules: DEFAULT_RULES,
        date: DATE,
        baseEvents: [existing],
    });
    assert.equal(confirmed.payload.events.length, 0);
    assert.deepEqual(confirmed.payload.conflicts, [DATE]);
    assert.deepEqual(existing.values, { pull_max_set: 1 });
});

// ---- (5) AC1: событие только при совпавшем правиле ----
test('AC1 в автомате: блокирующее правило одно; в ambiguous событии нет', () => {
    // «15» в контексте test_max → global правило rule_002 → событие max_set
    const withCtx = interpret('15', { date: DATE, lastContext: 'test_max', rules: FIXTURE_RULES });
    assert.equal(withCtx.mode, 'resolved');
    assert.deepEqual(withCtx.payload.events[0].values, { test_max_set: 15 });
    // «15» без контекста → не success (global правило требует контекста)
    const noCtx = interpret('15', { date: DATE, rules: FIXTURE_RULES });
    assert.equal(noCtx.mode, 'ambiguous');
});

// ---- (6) interpretation_version = версии правил ----
test('AC5: interpretation_version равен версии правил, которая породила событие', () => {
    const r = interpret('тест 100', { date: DATE, rules: FIXTURE_RULES });
    assert.equal(r.interpretation_version, FIXTURE_RULES.version);
    assert.equal(FIXTURE_RULES.version, 1);
    assert.equal(r.payload.events[0].interpretation_version, FIXTURE_RULES.version);
    assert.ok(isEvent(r.payload.events[0]));
    // замедленный результат после миграции — новая версия
    assert.equal(r.payload.events[0].interpretation_version, 1);
});

test('AC5: интерпретация заморожена (событие иммутабельно, значения frozen)', () => {
    const r = interpret('тест 100', { date: DATE, rules: FIXTURE_RULES });
    const evt = r.payload.events[0];
    assert.ok(Object.isFrozen(evt));
    assert.ok(Object.isFrozen(evt.values));
    assert.throws(() => { evt.values.test_full = 999; }, TypeError);
});

// ---- helper-уровень ----
test('proposeIfPossible: число+контекст → предложение; без числа/контекста → null', () => {
    const p = proposeIfPossible('макс 6', 'pull_max_set', DEFAULT_RULES);
    assert.ok(p);
    assert.equal(p.kind, 'propose_dynamic');
    assert.equal(p.draft.when.pattern, '^макс\\s*(\\d+)$');
    assert.equal(proposeIfPossible('макс 6', null, DEFAULT_RULES), null);
    assert.equal(proposeIfPossible('макс без числа', 'pull_max_set', DEFAULT_RULES), null);
});

test('не-строковый/пустой ввод → error (никогда не бросаем бизнес-ошибку)', () => {
    const r = interpret('   ', { date: DATE });
    assert.equal(r.mode, 'error');
    assert.equal(r.status, 'error');
});