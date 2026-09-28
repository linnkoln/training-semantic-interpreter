'use strict';
// tests/events.test.js — дата-модель: иммутабельное событие + interpretation snapshot
const test = require('node:test');
const assert = require('node:assert/strict');

const { makeEvent, isEvent, getVersion } = require('../core/events.js');

test('makeEvent создаёт событие с interpretation_version и createdAt', () => {
    const evt = makeEvent({ date: '2026-08-19', values: { push_full: 100 } }, 3);
    assert.equal(evt.date, '2026-08-19');
    assert.deepEqual(evt.values, { push_full: 100 });
    assert.equal(evt.interpretation_version, 3);   // AC5, D2
    assert.ok(evt.createdAt, 'должен быть createdAt');
    assert.ok(evt.createdAt instanceof Date || typeof evt.createdAt === 'string');
});

test('событие заморожено (Immutable)', () => {
    const evt = makeEvent({ date: '2026-08-19', values: { push_full: 100 } }, 0);
    assert.ok(Object.isFrozen(evt), 'объект верхнего уровня frozen');
    assert.ok(Object.isFrozen(evt.values), 'values frozen');
    assert.throws(() => { evt.values.push_full = 999; }, TypeError);
    // неявная версия (без версии) не разрешена: событие без интерпретации не бывает
    assert.throws(() => { makeEvent({ date: 'x' }); }, /interpretation_version/);
});

test('значение по умолчанию interpretation_version при отсутствии', () => {
    const evt = makeEvent({ date: '2026-08-19', values: {} }, 0);
    assert.equal(evt.interpretation_version, 0);
});

test('isEvent различает корректное событие от мусора', () => {
    assert.equal(isEvent({ date: '2026-08-19', values: {}, interpretation_version: 0, createdAt: 'x' }), true);
    assert.equal(isEvent({ date: '2026-08-19', values: {} }), false);           // нет version
    assert.equal(isEvent({ date: '2026-08-19', values: {}, interpretation_version: 0 }), false); // нет createdAt
    assert.equal(isEvent(null), false);
});

test('getVersion возвращает interpretation_version', () => {
    const evt = makeEvent({ date: '2026-08-19', values: {} }, 4);
    assert.equal(getVersion(evt), 4);
    assert.equal(getVersion(null), null);
});