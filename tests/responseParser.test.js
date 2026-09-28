'use strict';
// tests/responseParser.test.js — робастный парсер сырого текста LLM (AC10 gateway)
const test = require('node:test');
const assert = require('node:assert/strict');

const { parseResponse } = require('../core/responseParser.js');

const SAMPLE = { date: '2026-07-21', values: { push_full: 100, push_knee: 0, pull_full: 50 } };

test('чистый массив JSON -> status success (fallback), payload = массив', () => {
    const r = parseResponse(`[{"date":"2026-07-21","values":{"push_full":100,"push_knee":0,"pull_full":50}}]`);
    assert.equal(r.status, 'success');
    assert.deepEqual(r.payload, [SAMPLE]);
    assert.equal(typeof r.confidence, 'number');
    assert.ok(r.confidence >= 0 && r.confidence <= 1);
});

test('fallbackStatus из контекста переходит в status (AC9 mode->status)', () => {
    const r = parseResponse('[{"date":"2026-07-21","values":{}}]', { fallbackStatus: 'resolve' });
    assert.equal(r.status, 'resolve');
});

test('```json ограждение извлекается, проза вне его отбрасывается', () => {
    const text = 'Ответ модели:\n```json\n[{"date":"2026-07-21","values":{"push_full":60}}]\n```\nКонец.';
    const r = parseResponse(text);
    assert.equal(r.status, 'success');
    assert.deepEqual(r.payload, [{ date: '2026-07-21', values: { push_full: 60 } }]);
});

test('обрамляющая проза без ограждения (wrapping prose) -> вырезаем внешний массив', () => {
    const text = 'Вот новые записи: [ {"date":"2026-07-21","values":{"pull_max_set":6}} ] Спасибо!';
    const r = parseResponse(text);
    assert.equal(r.status, 'success');
    assert.deepEqual(r.payload, [{ date: '2026-07-21', values: { pull_max_set: 6 } }]);
});

test('хвостовая запятая (trailing comma) перед ] не ломает парсинг', () => {
    const text = '[{"date":"2026-07-21","values":{"push_full":40}}, ]';
    const r = parseResponse(text);
    assert.equal(r.status, 'success');
    assert.deepEqual(r.payload, [{ date: '2026-07-21', values: { push_full: 40 } }]);
});

test('объектный литерал: явные status/payload/confidence почитаются', () => {
    const text = '{ "status": "ambiguous", "payload": { "issue": "A+B vs solo" }, "confidence": 0.42 }';
    const r = parseResponse(text);
    assert.equal(r.status, 'ambiguous');            // явный status ВЫИГРЫВАЕТ у fallback
    assert.deepEqual(r.payload, { issue: 'A+B vs solo' });
    assert.equal(r.confidence, 0.42);
});

test('объект без status/confidence: payload = сам объект, дефолты по fallback', () => {
    const r = parseResponse('{ "date": "2026-07-21", "values": { "push_full": 100 } }');
    assert.equal(r.status, 'success');
    assert.deepEqual(r.payload, { date: '2026-07-21', values: { push_full: 100 } });
    assert.equal(r.confidence, 1); // success -> confidence по умолчанию 1
});

test('status вне контрактного набора игнорируется (не гадим статусом)', () => {
    const r = parseResponse('{"status":"whatever","payload":[1,2,3]}');
    assert.equal(r.status, 'success'); // fallback, не 'whatever'
});

test('confidence зажат в [0,1]', () => {
    assert.equal(parseResponse('{"confidence": 5, "payload": 1}').confidence, 1);
    assert.equal(parseResponse('{"confidence": -3, "payload": 1}').confidence, 0);
});

test('мусор (garbage) не бросает, returns status error', () => {
    const r = parseResponse('это не JSON вообще, просто абракадабра 123!!!');
    assert.equal(r.status, 'error');
    assert.equal(r.payload, null);
    assert.equal(r.confidence, 0);
});

test('пустая строка и не-строка -> status error, без throw', () => {
    assert.equal(parseResponse('').status, 'error');
    assert.equal(parseResponse('   ').status, 'error');
    assert.equal(parseResponse(null).status, 'error');
    assert.equal(parseResponse(undefined).status, 'error');
});

test('незакрытый/обрывочный JSON-фрагмент в прозе -> error, без throw', () => {
    const r = parseResponse('Здесь данные: [{ "date": "2026-08-01", "values": { ... ');
    assert.equal(r.status, 'error');
});

test('массив в одном ещё внешнем массиве / глубоко вложенный payload извлекается', () => {
    const r = parseResponse('{"status":"migrate","payload":{"records":[{"date":"2026-07-21","values":{"pull_full":30}}]}}');
    assert.equal(r.status, 'migrate');
    assert.deepEqual(r.payload, { records: [{ date: '2026-07-21', values: { pull_full: 30 } }] });
});