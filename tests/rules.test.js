'use strict';
// tests/rules.test.js — Слой 2 (AC3/AC5/AC7/AC8): семантические правила.
const test = require('node:test');
const assert = require('node:assert/strict');

const { DEFAULT_RULES, match, proposeDynamicRule, applyMigration } = require('../core/rules.js');

test('AC1: событие возможно только если правило сработало (ruled=false → production нет)', () => {
    const r = match('присед 30', null, DEFAULT_RULES);
    assert.equal(r.ruled, false);
    assert.deepEqual(r.candidates, []);
});

// Тесты детерминированного match-парсинга реальных строк старой эпохи
// («отжимания (50+50)», «подтягивания 50 макс: 6» и т.п.) УДАЛЕНЫ:
// распознавание входа — LLM (ПАМЯТКА AGENTS.md), контент data/rules.json копится заново.

test('контекст: число без подходящего контекста не срабатывает', () => {
    const r = match('15', 'push_full', DEFAULT_RULES);   // контекст не max
    assert.equal(r.ruled, false);
    const r2 = match('15', null, DEFAULT_RULES);          // контекста нет вообще
    assert.equal(r2.ruled, false);
});

test('приоритет: dynamic побеждает global при совпадении обоих', () => {
    const custom = {
        version: 1,
        updatedAt: '2026-08-28',
        dynamic: [{ id: 'rule_100', __version: 1, when: { pattern: '^(\\d+)$' }, then: { entity: 'push', metric: 'full', composition: 'single' } }],
        global: [{ id: 'rule_200', __version: 1, when: { pattern: '^(\\d+)$' }, then: { entity: 'pull', metric: 'full', composition: 'single' } }],
    };
    const r = match('5', null, custom);
    assert.equal(r.ruled, true);
    assert.equal(r.candidates.length, 1, 'при совпадении dynamic/global выбирается только dynamic');
    assert.equal(r.candidates[0].rule.id, 'rule_100', 'dynamic имеет приоритет');
    assert.deepEqual(r.candidates[0].production, { push_full: 5 });
});

// Фикстура правил: deprecated-правило-«гость», активное правило-«актив» (AC8).
const DEPRECATED_RULES = {
    version: 1,
    updatedAt: '2026-01-01',
    dynamic: [],
    global: [
        { id: 'rule_002', __version: 1, deprecated: true, when: { pattern: '^гость\\s*(\\d+)$' }, then: { entity: 'ghost', metric: 'gone', composition: 'single' } },
        { id: 'rule_003', __version: 1, when: { pattern: '^актив\\s*(\\d+)$' }, then: { entity: 'act', metric: 'full', composition: 'single' } },
    ],
};

test('AC8: deprecated-правило исключено из match', () => {
    const r = match('гость 20', null, DEPRECATED_RULES);
    assert.equal(r.ruled, false, 'deprecated-правило не должно давать совпадение');
    assert.ok(!r.candidates.some((c) => c.rule.id === 'rule_002'));
    // контроль: не-deprecated правило с другим паттерном всё ещё работает
    const ok = match('актив 20', null, DEPRECATED_RULES);
    assert.equal(ok.ruled, true);
});

// Фикстура для AC7: есть rule_009 → следующий id = rule_010.
const SEED_RULES = {
    version: 1,
    updatedAt: '2026-01-01',
    dynamic: [{ id: 'rule_009', __version: 1, when: { pattern: '^старое\\s*(\\d+)$' }, then: { entity: 'old', metric: 'full', composition: 'single' } }],
    global: [],
};

test('AC7: proposeDynamicRule возвращает предложение, не мутируя правила', () => {
    const nBefore = SEED_RULES.dynamic.length;
    const proposal = proposeDynamicRule('подтягивания 30 чередуя 10', { entity: 'pull', metric: 'full', composition: 'A+B' }, SEED_RULES);
    assert.equal(proposal.kind, 'propose_dynamic');
    assert.equal(proposal.draft.id, 'rule_010', 'следующий id после rule_009');
    assert.ok(proposal.draft.__version >= 1);
    assert.equal(proposal.draft.then.entity, 'pull');
    assert.ok(typeof proposal.rationale === 'string' && proposal.rationale.includes('подтягивания'));
    assert.ok(proposal.proposedAt instanceof Date);
    // исходные правила не тронуты
    assert.equal(SEED_RULES.dynamic.length, nBefore);
    assert.equal(match('подтягивания 30 чередуя 10', null, SEED_RULES).ruled, false, 'предложение ещё не действует');
});

// Фикстура для AC5: версия 1, dynamic[0] = rule_001 c __version 1.
const MIGRATION_BASE = {
    version: 1,
    updatedAt: '2026-01-01',
    dynamic: [{ id: 'rule_001', __version: 1, when: { pattern: '^тест\\s*(\\d+)$' }, then: { entity: 'test', metric: 'full', composition: 'single' } }],
    global: [],
};

test('AC5: applyMigration поднимает корневую version иммутабельно', () => {
    const old = MIGRATION_BASE;
    const oldDeep = JSON.parse(JSON.stringify(old));
    const next = applyMigration(old, [
        {
            id: 'rule_001',
            rule: { when: { pattern: '^тест\\d+$' }, then: { entity: 'test', metric: 'full', composition: 'single' } },
        },
    ]);
    assert.notEqual(next, old, 'новый объект правил');
    assert.equal(next.version, old.version + 1);
    assert.equal(next.dynamic[0].id, 'rule_001');
    assert.equal(next.dynamic[0].__version, old.dynamic[0].__version + 1, 'заменённое правило получает __version+1');
    assert.deepEqual(next.dynamic[0].when.pattern, '^тест\\d+$');
    // исходник не изменился
    assert.deepEqual(old, oldDeep, 'исходный объект правил не мутирован');
    assert.equal(old.version, 1);
    assert.equal(old.dynamic[0].__version, 1);
    assert.equal(old.dynamic[0].when.pattern, '^тест\\s*(\\d+)$');
});

test('AC5: applyMigration обновляет updatedAt и исключает неизвестные id ошибкой', () => {
    const next = applyMigration(MIGRATION_BASE, []);
    assert.equal(next.version, MIGRATION_BASE.version + 1);
    assert.ok(typeof next.updatedAt === 'string' && next.updatedAt.length > 0);
    assert.throws(() => applyMigration(MIGRATION_BASE, [{ id: 'rule_999', rule: {} }]), /не найдено/);
});