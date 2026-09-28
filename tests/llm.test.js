'use strict';
// tests/llm.test.js — типизированный Ollama-адаптер (P1, AC9/AC13)
const test = require('node:test');
const assert = require('node:assert/strict');

const { chat, MODE_TO_STATUS, DEFAULT_MODEL, DEFAULT_URL } = require('../adapters/llm.js');

// Фабрика mock-fetch: перехватывает вызов и возвращает фиксированный ответ.
// Колл-лог доступен и через `calls`, и через свойство fn.calls (для тестов, где
// отдаём наружу только fn).
function mockFetch({ ok = true, status = 200, answer = '', throwBefore = null } = {}) {
    const calls = [];
    const fn = async (url, init = {}) => {
        calls.push({ url, init, body: JSON.parse(init.body || '{}') });
        if (throwBefore) throw throwBefore;
        return {
            ok,
            status,
            json: async () => (ok ? { message: { content: answer } } : {}),
        };
    };
    fn.calls = calls;
    return { fn, calls };
}

test('chat запрашивает http://localhost:11434/api/chat, POST, model gemma4, stream:false', async () => {
    const { fn, calls } = mockFetch({ answer: '[{"date":"2026-07-21","values":{"push_full":100}}]' });
    const r = await chat('Привет', 'parse', { fetch: fn });
    assert.equal(r.status, 'success');
    assert.equal(calls.length, 1);
    const call = calls[0];
    assert.equal(call.url, DEFAULT_URL);
    assert.equal(call.init.method, 'POST');
    assert.deepEqual(call.init.headers, { 'Content-Type': 'application/json' });
    assert.equal(call.body.model, DEFAULT_MODEL);            // gemma4
    assert.equal(call.body.stream, false);
    assert.equal(call.body.messages[0].role, 'user');
    assert.equal(call.body.messages[0].content, 'Привет');   // promptText уходит как есть
});

test('chat adds Ollama temperature only for a finite in-range option', async () => {
    for (const temperature of [0, 0.4, 2]) {
        const { fn, calls } = mockFetch({ answer: '[]' });
        await chat('prompt', 'parse', { fetch: fn, temperature });
        assert.deepEqual(calls[0].body.options, { temperature });
    }
    for (const temperature of [NaN, Infinity, -0.1, 2.1, '0']) {
        const { fn, calls } = mockFetch({ answer: '[]' });
        await chat('prompt', 'parse', { fetch: fn, temperature });
        assert.ok(!Object.hasOwn(calls[0].body, 'options'));
    }
});

test('other modes keep their request body unchanged unless temperature is explicitly supplied', async () => {
    const { fn, calls } = mockFetch({ answer: '[]' });
    await chat('prompt', 'minorRuleUpdate', { fetch: fn });
    assert.deepEqual(calls[0].body, {
        model: DEFAULT_MODEL,
        messages: [{ role: 'user', content: 'prompt' }],
        stream: false,
    });
});

test('mode->status (AC9): parse/ambiguous/resolve/migrate дают свой статус', async () => {
    // Один и тот же массив-ответ, но mode двигает status.
    const answer = '[{"date":"2026-07-21","values":{"push_full":100}}]';
    for (const mode of Object.keys(MODE_TO_STATUS)) {
        const { fn } = mockFetch({ answer });
        const r = await chat('prompt', mode, { fetch: fn });
        assert.equal(r.status, MODE_TO_STATUS[mode], `mode ${mode} должен дать ${MODE_TO_STATUS[mode]}`);
    }
});

test('разные сырые ответы -> разные статусы через явное поле status', async () => {
    const { fn } = mockFetch({
        answer: '{ "status": "ambiguous", "payload": { "issue": "x" }, "confidence": 0.3 }',
    });
    const r = await chat('prompt', 'parse', { fetch: fn });
    assert.equal(r.status, 'ambiguous'); // явный статус в тексте ВЫИГРЫВАЕТ у mode->status
    assert.equal(r.payload.issue, 'x');
    assert.equal(r.confidence, 0.3);
});

test('сетевой throw -> {status:error, payload:null, confidence:0}', async () => {
    const { fn } = mockFetch({ throwBefore: new Error('ECONNREFUSED 11434') });
    const r = await chat('prompt', 'parse', { fetch: fn });
    assert.equal(r.status, 'error');
    assert.equal(r.payload, null);
    assert.equal(r.confidence, 0);
});

test('HTTP-ошибка (не ok) -> {status:error}', async () => {
    const { fn } = mockFetch({ ok: false, status: 503 });
    const r = await chat('prompt', 'parse', { fetch: fn });
    assert.equal(r.status, 'error');
    assert.equal(r.payload, null);
});

test('пустой/битый message.content -> {status:error}', async () => {
    const { fn } = mockFetch({ answer: '' });
    const r = await chat('prompt', 'parse', { fetch: fn });
    assert.equal(r.status, 'error');
});

test('ответ с markdown-ограждением от мусора проходит через responseParser', async () => {
    const { fn } = mockFetch({
        answer: 'Вот результат:\n```json\n[{"date":"2026-07-21","values":{"pull_max_set":8}}]\n```',
    });
    const r = await chat('prompt', 'parse', { fetch: fn });
    assert.equal(r.status, 'success');
    assert.deepEqual(r.payload, [{ date: '2026-07-21', values: { pull_max_set: 8 } }]);
});

test('неизвестный mode -> TypeError (программистская ошибка, до сети)', async () => {
    const { fn } = mockFetch({ answer: '[]' });
    await assert.rejects(() => chat('p', 'nope', { fetch: fn }), TypeError);
    assert.equal(fn.calls.length, 0); // сеть не дёргалась
});

test('пустой promptText -> TypeError', async () => {
    const { fn } = mockFetch({ answer: '[]' });
    await assert.rejects(() => chat('  ', 'parse', { fetch: fn }), TypeError);
    assert.equal(fn.calls.length, 0); // сеть не дёргалась
});

test('без передаваемого fetch в среде без глобального fetch -> status error (нет сети)', async () => {
    // Симулируем отсутствие globalThis.fetch: chat обязан вести себя контрактно.
    const saved = globalThis.fetch;
    globalThis.fetch = undefined;
    try {
        const r = await chat('prompt', 'parse', {});
        assert.equal(r.status, 'error');
        assert.equal(r.payload, null);
        assert.equal(r.confidence, 0);
    } finally {
        globalThis.fetch = saved;
    }
});
