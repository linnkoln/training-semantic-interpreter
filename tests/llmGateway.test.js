'use strict';
// tests/llmGateway.test.js — тесты для шлюза LLM (P-E).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { callLLM, loadTemplate, substitute, validateResponse, PROMPTS_DIR } = require('../core/llmGateway.js');
const { chat, MODE_TO_STATUS, VALID_MODES } = require('../adapters/llm.js');

// --- Фабрика mock-fetch (как в llm.test.js) ---
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

// Вспомогательная: читает исходный шаблон для проверки плейсхолдеров
function readPrompt(mode) {
    return fs.readFileSync(path.join(PROMPTS_DIR, `mode_${mode}.md`), 'utf8');
}

// ============================================================
// loadTemplate / substitute (unit, без сети)
// ============================================================

test('loadTemplate читает все 4 режима и кэширует', () => {
    for (const mode of VALID_MODES) {
        const t1 = loadTemplate(mode);
        const t2 = loadTemplate(mode); // второй вызов — из кэша
        assert.ok(typeof t1 === 'string' && t1.length > 0);
        assert.strictEqual(t1, t2);
    }
});

test('loadTemplate выбрасывает TypeError на неизвестный mode', () => {
    assert.throws(() => loadTemplate('nope'), TypeError);
});

test('substitute заменяет {{TABLE}}, {{CONTEXT}}, {{INPUT}}, {{RULES}}', () => {
    const template = 'T={{TABLE}} C={{CONTEXT}} I={{INPUT}} R={{RULES}}';
    const out = substitute(template, { table: 'TABLE_VAL', context: 'CTX_VAL', input: 'IN_VAL' });
    assert.equal(out, 'T=TABLE_VAL C=CTX_VAL I=IN_VAL R=');
});

test('substitute оставляет пустые строки для отсутствующих переменных', () => {
    const template = 'T={{TABLE}} C={{CONTEXT}} I={{INPUT}} R={{RULES}}';
    const out = substitute(template, {});
    assert.equal(out, 'T= C= I= R=');
});

test('substitute заменяет все вхождения (global)', () => {
    const template = '{{RULES}}-{{RULES}}';
    const out = substitute(template, { rules: 'X' });
    assert.equal(out, 'X-X');
});

// ============================================================
// validateResponse (контракт D4)
// ============================================================

test('validateResponse пропускает валидный {status, payload, confidence}', () => {
    const r = validateResponse({ status: 'success', payload: [{ date: '2026-07-21', values: {} }], confidence: 0.9 });
    assert.equal(r.status, 'success');
    assert.deepEqual(r.payload, [{ date: '2026-07-21', values: {} }]);
    assert.equal(r.confidence, 0.9);
});

test('validateResponse зажимает confidence в [0,1]', () => {
    assert.equal(validateResponse({ status: 'success', payload: {}, confidence: 5 }).confidence, 1);
    assert.equal(validateResponse({ status: 'success', payload: {}, confidence: -3 }).confidence, 0);
});

test('validateResponse выбрасывает на не-объект', () => {
    assert.throws(() => validateResponse(null), TypeError);
    assert.throws(() => validateResponse('string'), TypeError);
    assert.throws(() => validateResponse(123), TypeError);
});

test('validateResponse выбрасывает при отсутствии status', () => {
    assert.throws(() => validateResponse({ payload: {}, confidence: 0.5 }), TypeError);
    assert.throws(() => validateResponse({ status: '', payload: {}, confidence: 0.5 }), TypeError);
});

test('validateResponse выбрасывает при отсутствии payload', () => {
    assert.throws(() => validateResponse({ status: 'success', confidence: 0.5 }), TypeError);
});

test('validateResponse выбрасывает при некорректном confidence', () => {
    assert.throws(() => validateResponse({ status: 'success', payload: {} }), TypeError);
    assert.throws(() => validateResponse({ status: 'success', payload: {}, confidence: 'high' }), TypeError);
    assert.throws(() => validateResponse({ status: 'success', payload: {}, confidence: NaN }), TypeError);
});

// ============================================================
// Интеграция: callLLM с mock-fetch (end-to-end через chat)
// ============================================================

test('callLLM(parse) подставляет RULES (через options) и CONTEXT в шаблон parse', async () => {
    const { fn, calls } = mockFetch({ answer: '[{"date":"2026-07-21","values":{"push_full":100}}]' });
    const rules = 'Правила: push_full, pull_max_set (D14)';
    const context = 'Последние записи: 2026-07-20 push_full=90';

    const r = await callLLM('parse', '', context, '', { fetch: fn, rules });

    assert.equal(r.status, 'success');
    assert.deepEqual(r.payload, [{ date: '2026-07-21', values: { push_full: 100 } }]);

    // Проверяем, что в promptText попали подстановки
    const sentPrompt = calls[0].body.messages[0].content;
    assert.ok(sentPrompt.includes(rules), 'prompt должен содержать RULES');
    assert.ok(sentPrompt.includes(context), 'prompt должен содержать CONTEXT');
    assert.ok(!sentPrompt.includes('{{TABLE}}'), 'плейсхолдер TABLE должен быть заменён');
    assert.ok(!sentPrompt.includes('{{RULES}}'), 'плейсхолдер RULES должен быть заменён');
    assert.ok(!sentPrompt.includes('{{CONTEXT}}'), 'плейсхолдер CONTEXT должен быть заменён');
});

test('callLLM пробрасывает options (fetch, url, model) в chat', async () => {
    const { fn, calls } = mockFetch({ answer: '[]' });
    await callLLM('parse', '', '', '', { fetch: fn, url: 'http://test:11434/api/chat', model: 'test-model' });

    assert.equal(calls[0].body.model, 'test-model');
    assert.ok(calls[0].url.includes('test:11434'));
});

test('callLLM возвращает error-контракт при сетевом сбое (chat -> error)', async () => {
    const { fn } = mockFetch({ throwBefore: new Error('ECONNREFUSED') });
    const r = await callLLM('parse', '', '', '', { fetch: fn });

    assert.equal(r.status, 'error');
    assert.equal(r.payload, null);
    assert.equal(r.confidence, 0);
});

test('callLLM возвращает error-контракт при HTTP ошибке', async () => {
    const { fn } = mockFetch({ ok: false, status: 500 });
    const r = await callLLM('parse', '', '', '', { fetch: fn });

    assert.equal(r.status, 'error');
    assert.equal(r.payload, null);
    assert.equal(r.confidence, 0);
});

test('callLLM валидирует ответ chat: если chat вернул error-объект, он проходит валидацию', async () => {
    // chat при ошибке возвращает {status:'error', payload:null, confidence:0} — это валидный контракт
    const { fn } = mockFetch({ ok: false, status: 503 });
    const r = await callLLM('parse', '', '', '', { fetch: fn });

    assert.equal(r.status, 'error');
    assert.equal(r.payload, null);
    assert.equal(r.confidence, 0);
});

// ============================================================
// Проверка, что исходные шаблоны содержат нужные плейсхолдеры
// ============================================================

test('шаблон parse содержит {{CONTEXT}} и {{RULES}}', () => {
    const t = readPrompt('parse');
    assert.ok(t.includes('{{CONTEXT}}'));
    assert.ok(t.includes('{{RULES}}'));
});

// ============================================================
// Регрессия: явный status в ответе модели побеждает mode->status
// ============================================================

test('явный status в ответе модели перекрывает mode->status (AC10)', async () => {
    // mode=parse обычно даёт success, но модель вернула ambiguous — должен выиграть ambiguous
    const { fn } = mockFetch({
        answer: '{ "status": "ambiguous", "payload": { "issue": "x" }, "confidence": 0.3 }',
    });
    const r = await callLLM('parse', '', '', '', { fetch: fn });
    assert.equal(r.status, 'ambiguous');
    assert.equal(r.confidence, 0.3);
});

test('mode->status применяется, когда в ответе нет явного status', async () => {
    // parse -> success по умолчанию
    const { fn } = mockFetch({ answer: '[{"date":"2026-07-21","values":{"push_full":100}}]' });
    const r = await callLLM('parse', '', '', '', { fetch: fn });
    assert.equal(r.status, 'success');


});