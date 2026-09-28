'use strict';
// tests/cutter.test.js — Cutter: LLM-нарезка сырого ввода на дни (канва 2026-09-04).
// Через инжектируемый opts.fetch (fake-fetch), БЕЗ реальной сети и без LLM.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
    cut,
    llmDays,
    normDate,
    loadCutterTemplate,
    PROMPTS_DIR,
    _resetTemplateCache,
} = require('../core/cutter.js');

// ============================================================
// Фабрика mock-fetch (как в router.test.js)
// ============================================================
function mockFetch({ ok = true, status = 200, answer = '', throwBefore = null } = {}) {
    const calls = [];
    const fn = async (url, init = {}) => {
        calls.push({ url, init, body: JSON.parse(init.body || '{}'), prompt: init.body ? JSON.parse(init.body).messages[0].content : '' });
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

/** Валидный ответ cutter-формата. */
function cutterAnswer(days, confidence = 0.9) {
    return JSON.stringify({ status: 'success', payload: { days, confidence }, confidence });
}

// Таблица недели на 3 дня (с мусором: разделители, шапка, пустая ячейка).
const WEEK_TABLE = [
    '| Неделя с 2026-05-25 |  |  |  |  |',
    '| --- | --- | --- | --- | --- |',
    '| *05-29*<br>супер сет 100 (73+27)<br>пояснение: тяжело | *05-30*<br> | *05-31*<br>40 | | |',
];

test('cut: таблица на 3 дня → 3 дня в порядке следования, куски дословны, мусор убран', async () => {
    const raw1 = '*05-29*<br>супер сет 100 (73+27)<br>пояснение: тяжело';
    const raw3 = '*05-31*<br>40';
    const { fn, calls } = mockFetch({
        answer: cutterAnswer([
            { raw: raw1, date: '05-29' },
            { raw: '*05-31*<br>40', date: '05-31' },
            { raw: 'вечер: 30', date: null },
        ]),
    });
    const r = await cut(WEEK_TABLE.join('\n'), { fetch: fn });

    assert.equal(r.status, 'success');
    assert.equal(r.payload.days.length, 3);
    assert.equal(r.payload.days[0].raw, raw1, 'кусок дня дословен (включая <br>)');
    assert.equal(r.payload.days[0].date, '05-29');
    assert.equal(r.payload.days[1].date, '05-31');
    assert.equal(r.payload.days[2].date, null, 'дата не определена → null');
    assert.equal(r.confidence, 0.9);

    // Весь ввод ушёл в {{INPUT}}; слоты подставлены.
    const prompt = calls[0].prompt;
    assert.ok(!prompt.includes('{{INPUT}}'), '{{INPUT}} должен быть заменён');
    assert.ok(prompt.includes('*05-29*'), 'ввод должен попасть в промпт');
});

test('cut: LLМ убрал мусор (линии/шапки/пустые ячейки) — дни без них', async () => {
    const { fn } = mockFetch({
        answer: cutterAnswer([
            { raw: '*05-29*<br>супер сет 100 (73+27)<br>пояснение: тяжело', date: '05-29' },
        ]),
    });
    const r = await cut(WEEK_TABLE.join('\n'), { fetch: fn });
    assert.equal(r.status, 'success');
    for (const d of r.payload.days) {
        assert.ok(!d.raw.includes('| --- |'), 'линии-разделители убраны');
        assert.ok(!d.raw.includes('Неделя с'), 'шапка убрана');
        assert.ok(d.raw.trim() !== '', 'пустых дней нет');
    }
});

test('llmDays: валидные дни проходят, мусор отбрасывается; raw без trim (дословность)', () => {
    const days = llmDays({
        days: [
            { raw: '  *05-29* запись 10  ', date: '05-29' },
            { raw: '   ' },                 // пустой → отброшен
            { raw: 'день без даты', date: 'не дата' }, // битая дата → null
            null,                            // мусор → отброшен
            { raw: 'день 2', date: '07-01' },
        ],
    });
    assert.equal(days.length, 3);
    assert.equal(days[0].raw, '  *05-29* запись 10  ', 'raw переносится дословно, без trim');
    assert.equal(days[1].date, null);
    assert.equal(days[2].date, '07-01');
});

test('llmDays: нет массива days / всё невалидно → null', () => {
    assert.equal(llmDays(null), null);
    assert.equal(llmDays({}), null);
    assert.equal(llmDays({ days: 'не массив' }), null);
    assert.equal(llmDays({ days: [{ raw: '', date: '01-01' }] }), null);
    assert.equal(llmDays({ days: [{ date: '01-01' }] }), null);
});

test('normDate: MM-DD строки → как есть; прочее → null', () => {
    assert.equal(normDate('05-29'), '05-29');
    assert.equal(normDate(' 12-31 '), '12-31');
    assert.equal(normDate('2026-05-29'), null, 'полная дата не MM-DD → null (пайплайн передаст как есть)');
    assert.equal(normDate(null), null);
    assert.equal(normDate(5), null);
});

// ============================================================
// Сбой → контрактный error, никогда не бросает
// ============================================================
test('cut: garbage/ambiguous/сетевой сбой → {status:error, payload.days:[]}, не бросает', async () => {
    for (const spec of [
        { answer: 'это не JSON' },
        { answer: JSON.stringify({ status: 'ambiguous', payload: { issue: 'x' }, confidence: 0.3 }) },
        { answer: JSON.stringify({ status: 'success', payload: { note: 'без days' }, confidence: 0.5 }) },
        { throwBefore: new Error('ECONNREFUSED') },
        { ok: false, status: 500 },
    ]) {
        const { fn } = mockFetch(spec);
        const r = await cut('*05-29* запись 10', { fetch: fn });
        assert.deepEqual(r, { status: 'error', payload: { days: [] }, confidence: 0 }, JSON.stringify(spec));
    }
});

test('cut: пустой/не-строковый ввод → контрактный error без вызова LLM', async () => {
    const { fn, calls } = mockFetch({ answer: cutterAnswer([]) });
    for (const input of ['   ', null, 123]) {
        const r = await cut(input, { fetch: fn });
        assert.equal(r.status, 'error');
        assert.deepEqual(r.payload.days, []);
    }
    assert.equal(calls.length, 0, 'LLM не должен вызываться на пустом вводе');
});

test('cut: НИКОГДА не бросает (garbage fetch)', async () => {
    const explode = async () => { throw new Error('взрыв'); };
    const r = await cut('*05-29* запись 10', { fetch: explode });
    assert.equal(r.status, 'error');
    assert.deepEqual(r.payload.days, []);
});

test('cut: пробрасывает options (url, model) в chat', async () => {
    const { fn, calls } = mockFetch({ answer: cutterAnswer([{ raw: 'день', date: null }]) });
    await cut('день', { fetch: fn, url: 'http://test:11434/api/chat', model: 'cutter-test' });
    assert.equal(calls[0].body.model, 'cutter-test');
    assert.ok(calls[0].url.includes('test:11434'));
});

// ============================================================
// Шаблон mode_cutter.md
// ============================================================
test('шаблон mode_cutter.md существует, содержит {{INPUT}}, не содержит {{RULES}}/{{CONTEXT}}/{{TABLE}}', () => {
    const t = loadCutterTemplate();
    assert.ok(t.includes('{{INPUT}}'));
    assert.ok(!t.includes('{{RULES}}'));
    assert.ok(!t.includes('{{CONTEXT}}'));
    assert.ok(!t.includes('{{TABLE}}'));
    assert.ok(fs.existsSync(path.join(PROMPTS_DIR, 'mode_cutter.md')));
    _resetTemplateCache();
});

test('шаблон mode_cutter.md требует JSON-формат {status, payload:{days:[{raw,date}]}}', () => {
    const raw = fs.readFileSync(path.join(PROMPTS_DIR, 'mode_cutter.md'), 'utf8');
    assert.match(raw, /"payload"/);
    assert.match(raw, /"days"/);
    assert.match(raw, /"raw"/);
    assert.match(raw, /"date"/);
    assert.match(raw, /version: 1/);
});

test('шаблон mode_cutter.md: без запрещённых деталей тест-кейсов (даты/упражнения)', () => {
    const raw = fs.readFileSync(path.join(PROMPTS_DIR, 'mode_cutter.md'), 'utf8');
    const banned = ['05-29', '05-31', '06-02', '07-17', '07-19', '07-21', 'пресс', 'присяд', 'отжиман',
        'подтягиван', 'press_reps', 'pushup', 'squat_reps', '(10+40)', 'клининт'];
    for (const b of banned) assert.ok(!raw.includes(b), `шаблон не должен содержать '${b}'`);
});
