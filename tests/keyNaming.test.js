'use strict';
// tests/keyNaming.test.js — контракт именования ключей entity_metric (2026-08-31):
// латиница, snake_case, >=2 сегментов (группа_тип), семантические имена.
// Валидатор структурный (форма вывода LLM), без доменных имён упражнений в коде.

const test = require('node:test');
const assert = require('node:assert/strict');

const { validateKeyName, namingViolations } = require('../core/keyNaming.js');
const structured = require('../core/structured.js');

test('naming: принимает канонические ключи group_type', () => {
    for (const k of ['push_standard', 'pull_rings', 'running_distance_km', 'press_reps', 'push_max_set']) {
        assert.equal(validateKeyName(k).ok, true, `${k} должен проходить`);
    }
});

test('naming: отклоняет кириллицу', () => {
    const v = validateKeyName('пресс_reps');
    assert.equal(v.ok, false);
    assert.match(v.reason, /латиница/i);
});

test('naming: отклоняет транслит', () => {
    assert.equal(validateKeyName('otzhimaniya_standard').ok, false);
    assert.equal(validateKeyName('prisyad_reps').ok, false);
});

test('naming: отклоняет безликие метки (Type A / way1)', () => {
    assert.equal(validateKeyName('type_a_reps').ok, false);
    assert.equal(validateKeyName('push_type1').ok, false);
    assert.equal(validateKeyName('pull_way2_max').ok, false);
    assert.equal(validateKeyName('press_var1').ok, false);
});

test('naming: отклоняет форму вне контракта', () => {
    assert.equal(validateKeyName('push').ok, false);            // < 2 сегментов
    assert.equal(validateKeyName('Push_Standard').ok, false);   // заглавные
    assert.equal(validateKeyName('push__reps').ok, false);      // двойное подчёркивание
    assert.equal(validateKeyName('_push_reps').ok, false);      // ведущее подчёркивание
    assert.equal(validateKeyName('push_reps_').ok, false);      // хвостовое подчёркивание
    assert.equal(validateKeyName('').ok, false);
    assert.equal(validateKeyName(null).ok, false);
    assert.equal(validateKeyName('push 10').ok, false);         // пробелы
});

test('naming: namingViolations перечисляет нарушившие ключи с причиной', () => {
    const v = namingViolations({ push_standard: 1, 'пресс_reps': 2, type_a_reps: 3 });
    assert.equal(v.length, 2);
    assert.ok(v[0].startsWith('пресс_reps — '));
    assert.ok(v[1].startsWith('type_a_reps — '));
});

// --- Интеграция: structured НЕ принимает вывод LLM, нарушающий контракт (status ambiguous) ---

function makeFetch(answer) {
    return async () => ({ ok: true, status: 200, json: async () => ({ message: { content: answer } }) });
}

test('structured: ключ-нарушитель контракта → status ambiguous, событий нет', async () => {
    const res = await structured('пресс 40', {
        date: '2026-08-29',
        llmOptions: { fetch: makeFetch(JSON.stringify({ status: 'success', payload: [{ date: '2026-08-29', values: { 'пресс_reps': 40 } }], confidence: 0.95 })) },
    });
    assert.equal(res.status, 'ambiguous');
    assert.deepEqual(res.payload.events, []);
    assert.match(res.message, /пресс_reps/);
});

test('structured: ключ по контракту проходит как раньше (success)', async () => {
    const res = await structured('пресс 40', {
        date: '2026-08-29',
        llmOptions: { fetch: makeFetch(JSON.stringify({ status: 'success', payload: [{ date: '2026-08-29', values: { press_reps: 40 } }], confidence: 0.95 })) },
    });
    assert.equal(res.status, 'success');
    assert.equal(res.payload.events.length, 1);
});
