'use strict';
// tests/router.test.js — P-A Router v9: классификация ОДНОГО дня (канва 2026-09-04).
// Через инжектируемый opts.fetch, БЕЗ реальной сети.
// С 2026-09-04 нарезку на дни делает cutter; Router получает УЖЕ один день и
// выдаёт РОВНО ОДНУ группу (массив groups с одним элементом — контракт пайплайна).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
    route,
    llmGroups,
    normGroup,
    loadRouterTemplate,
    PROMPTS_DIR,
    _resetTemplateCache,
} = require('../core/router.js');

// ============================================================
// Фабрика mock-fetch (как в llmGateway.test.js / cutter.test.js)
// ============================================================

/** Возвращает { fn, calls }, где fn — injectable fetch, отдающий JSON из answer. */
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

/** Готовый валидный ответ router-формата v9 (одна группа). */
function routerAnswer(chunk, group, extra = {}, confidence = 0.9) {
    return JSON.stringify({
        status: 'success',
        payload: {
            groups: [{ chunk, group, reasoning: 'классификация', confidence, ...extra }],
            confidence,
        },
        confidence,
    });
}

// ============================================================
// (а) v9: один день на вход, одна группа на выходе
// ============================================================

test('route v9: один день → массив groups с РОВНО ОДНИМ элементом (группа 1)', async () => {
    const { fn, calls } = mockFetch({
        answer: routerAnswer('*08-24* запись дня (73+27)', 1, { ruleId: 'rule_011', reasoning: 'совпадает с примером rule_011', confidence: 0.95 }, 0.95),
    });
    const r = await route('*08-24* запись дня (73+27)', { fetch: fn, rules: JSON.stringify({ rules: [{ id: 'rule_011', mapping: { x: 'exercise' }, examples: [] }] }) });

    assert.equal(r.status, 'success');
    assert.equal(r.payload.groups.length, 1, 'ровно один вердикт — вход один день');
    assert.equal(r.payload.groups[0].group, 1);
    assert.equal(r.payload.groups[0].chunk, '*08-24* запись дня (73+27)');
    assert.equal(r.payload.groups[0].ruleId, undefined);
    assert.equal(r.payload.groups[0].reasoning, 'совпадает с примером rule_011');
    assert.equal(r.payload.confidence, 0.95);
    assert.equal(r.payload.fallback, false);
});

test('route v9: группа 2 (та же суть, другая формулировка)', async () => {
    const { fn } = mockFetch({ answer: routerAnswer('день словами', 2, { ruleId: 'rule_011' }) });
    const r = await route('день словами', { fetch: fn, rules: JSON.stringify({ rules: [{ id: 'rule_011', mapping: { x: 'exercise' }, examples: [] }] }) });
    assert.equal(r.status, 'success');
    assert.equal(r.payload.groups[0].group, 2);
});

test('route v9: группа 3 (новой сути в правилах нет)', async () => {
    const { fn } = mockFetch({ answer: routerAnswer('день', 3, { ruleId: null, reasoning: 'нет в правилах' }, 0.85) });
    const r = await route('день', { fetch: fn });
    assert.equal(r.status, 'success');
    assert.equal(r.payload.groups[0].group, 3);
    assert.ok(r.payload.groups[0].ruleId == null, 'группа 3 → без ruleId (правил нет)');
});

test('route v9: пробрасывает options (url, model) в chat', async () => {
    const { fn, calls } = mockFetch({ answer: routerAnswer('день', 1) });
    await route('день', { fetch: fn, url: 'http://test:11434/api/chat', model: 'router-test' });
    assert.equal(calls[0].body.model, 'router-test');
    assert.ok(calls[0].url.includes('test:11434'));
});

// ============================================================
// (б) Детерминированная валидация групп (unit, AC10 guardrail)
// ============================================================

test('llmGroups: валидные куски проходят, мусор отбрасывается (не переклассифицируется)', () => {
    const groups = llmGroups({
        groups: [
            { chunk: 'день записи', group: 1, ruleId: 'rule_011', reasoning: 'ok', confidence: 1.5 },
            { chunk: '   ', group: 1 },            // пустой кусок → отброшен
            { chunk: 'день', group: 7 },           // невалидная группа → отброшен
            { chunk: 'день' },                     // нет группы → отброшен
            null,                                  // мусор → отброшен
            { chunk: 'день', group: '3' },         // строка '3' → валидна
        ],
    });
    assert.equal(groups.length, 2);
    assert.equal(groups[0].group, 1);
    assert.equal(groups[0].confidence, 1, 'confidence зажат в [0,1]');
    assert.equal(groups[1].group, 3);
});

test('llmGroups: нет массива groups / все куски невалидны → null', () => {
    assert.equal(llmGroups(null), null);
    assert.equal(llmGroups({}), null);
    assert.equal(llmGroups({ groups: 'не массив' }), null);
    assert.equal(llmGroups({ groups: [{ chunk: '', group: 1 }] }), null);
    assert.equal(llmGroups({ groups: [{ chunk: 'x', group: 9 }] }), null);
});

test('llmGroups: игнорирует LLM ruleId и принимает group-only verdict', () => {
    const groups = llmGroups({ groups: [{ chunk: 'день', group: 3 }] });
    assert.deepEqual(groups, [{ chunk: 'день', group: 3 }]);
    assert.deepEqual(llmGroups({ groups: [{ chunk: 'день', group: 1, ruleId: 'invented' }] }), [{ chunk: 'день', group: 1 }]);
    assert.deepEqual(llmGroups({ groups: [3] }, 'исходный день'), [{ chunk: 'исходный день', group: 3 }]);
});

test('route uses deterministic temperature 0 by default and preserves explicit override', async () => {
    for (const [override, expected] of [[undefined, 0], [0.35, 0.35]]) {
        const { fn, calls } = mockFetch({ answer: routerAnswer('день', 3) });
        await route('день', { fetch: fn, ...(override === undefined ? {} : { temperature: override }) });
        assert.deepEqual(calls[0].body.options, { temperature: expected });
    }
});

test("normGroup: 1/2/3, строки '1'/'2'/'3' → число; прочее → null", () => {
    assert.equal(normGroup(1), 1);
    assert.equal(normGroup(2), 2);
    assert.equal(normGroup(3), 3);
    assert.equal(normGroup('1'), 1);
    assert.equal(normGroup('3'), 3);
    assert.equal(normGroup(0), null);
    assert.equal(normGroup(4), null);
    assert.equal(normGroup('x'), null);
    assert.equal(normGroup(true), null);
    assert.equal(normGroup(null), null);
});

// ============================================================
// (в) сбой/невалидный ответ → явная ошибка без классификационного fallback
// ============================================================

// Сбой LLM не превращается кодом в придуманную группу.

test('route: LLM без валидных групп → ошибка без fallback', async () => {
    const { fn } = mockFetch({
        answer: JSON.stringify({ status: 'success', payload: { note: 'не распознал' }, confidence: 0.7 }),
    });
    const r = await route('день записи', { fetch: fn });
    assert.equal(r.status, 'error');
    assert.equal(r.payload, null);
    assert.match(r.message, /ровно одну валидную группу|chunk.*не совпадает/i);
});

test('route: отклоняет несколько групп для одного дня вместо выбора fallback-класса', async () => {
    const chunk = 'день записи';
    const answer = JSON.stringify({ status: 'success', payload: { groups: [
        { chunk, group: 1 }, { chunk, group: 3 },
    ] }, confidence: 0.9 });
    const r = await route(chunk, { fetch: mockFetch({ answer }).fn });
    assert.equal(r.status, 'error');
    assert.equal(r.payload, null);
    assert.match(r.message, /ровно одну валидную группу|chunk.*не совпадает/i);
});

test('route: ошибка, если Router вернул изменённый/продублированный день (не переводить молча по группе 1)', async () => {
    const input = 'день записи';
    const answer = routerAnswer('день записи день записи', 1);
    const r = await route(input, { fetch: mockFetch({ answer }).fn, rules: '{"rules":[{"id":"rule_001"}]}' });
    assert.equal(r.status, 'error');
    assert.equal(r.payload, null);
    assert.match(r.message, /chunk.*не совпадает/i);
});

test('route: HTML-переносы модели эквивалентны строкам, исходный chunk сохраняется', async () => {
    const input = 'день<br>запись';
    const answer = routerAnswer('день\nзапись', 2, { ruleId: 'rule_011' });
    const r = await route(input, { fetch: mockFetch({ answer }).fn, rules: '{"rules":[{"id":"rule_011","mapping":{"x":"exercise"}}]}' });
    assert.equal(r.payload.fallback, false);
    assert.deepEqual(r.payload.groups, [{ chunk: input, group: 2, reasoning: 'классификация', confidence: 0.9 }]);
});

test('route: Router may omit chunk; original user day is attached by the orchestrator', async () => {
    const answer = JSON.stringify({ status: 'success', payload: { groups: [
        { group: 1, ruleId: 'rule_011', reasoning: 'known form' },
    ] }, confidence: 0.9 });
    const r = await route('исходный день', { fetch: mockFetch({ answer }).fn, rules: '{"rules":[{"id":"rule_011","mapping":{"x":"exercise"}}]}' });
    assert.equal(r.status, 'success');
    assert.equal(r.payload.groups[0].chunk, 'исходный день');
});

test('route: empty user rulebook rejects model group 1/2 instead of reclassifying it', async () => {
    const answer = routerAnswer('50 пресс', 2, { ruleId: null });
    const r = await route('50 пресс', { fetch: mockFetch({ answer }).fn, rules: '{"rules":[]}' });
    assert.equal(r.status, 'error');
    assert.equal(r.payload, null);
    assert.match(r.message, /группу 1\/2 при пустом словаре/);
});

test('route: empty rulebook accepts explicit group 3 and rejects groups 1 and 2 without rewriting', async () => {
    for (const group of [1, 2, 3]) {
        const r = await route('05-29: полный день упражнений', {
            fetch: mockFetch({ answer: routerAnswer('05-29: полный день упражнений', group, { ruleId: 'hallucinated-id' }) }).fn,
            rules: JSON.stringify({ rules: [] }),
        });
        if (group === 3) {
            assert.equal(r.status, 'success');
            assert.equal(r.payload.groups[0].group, 3);
            assert.equal(r.payload.groups[0].ruleId, undefined);
        } else {
            assert.equal(r.status, 'error');
            assert.equal(r.payload, null);
            assert.match(r.message, /группу 1\/2 при пустом словаре/);
        }
    }
});

test('route: legacy model ruleId is ignored and never trusted or guessed', async () => {
    const r = await route('день', {
        fetch: mockFetch({ answer: routerAnswer('день', 1, { ruleId: 'hallucinated-id' }) }).fn,
        rules: JSON.stringify({ rules: [{ id: 'stored-rule', mapping: { x: 'exercise' }, examples: [] }] }),
    });
    assert.equal(r.payload.groups[0].ruleId, undefined);
});

test('route: unwraps dotted payload.groups field without changing model verdict', async () => {
    const answer = JSON.stringify({ status: 'success', 'payload.groups': [{ group: 3 }], confidence: 0.8 });
    const r = await route('исходный день', { fetch: mockFetch({ answer }).fn, rules: '{"rules":[]}' });
    assert.equal(r.status, 'success');
    assert.deepEqual(r.payload.groups, [{ chunk: 'исходный день', group: 3 }]);
});

test('route: shape classification remains the model verdict; code does not parse workout notation', async () => {
    const rules = JSON.stringify({ rules: [{
        id: 'rule_001', mapping: { push_reps: 'push', push_knees_reps: 'knees' },
        examples: [{
            input: '50 отжимания (+из них около 30 с колен(20+30))',
            values: { push_reps: 20, push_knees_reps: 30 },
        }],
    }] });
    const input = '50 отжимания (10+40)';
    const r = await route(input, { fetch: mockFetch({ answer: routerAnswer(input, 1, { ruleId: 'rule_001' }) }).fn, rules });
    assert.equal(r.status, 'success');
    assert.equal(r.payload.groups[0].group, 1);
    assert.equal(r.payload.groups[0].ruleId, undefined);
    assert.equal(r.payload.modelGroup, undefined);
});

test('route: a saved standalone A+B example keeps later numeric variants in Branch 1', async () => {
    const rules = JSON.stringify({ rules: [{
        id: 'rule_001', mapping: { push_reps: 'push', push_knees_reps: 'knees' },
        examples: [
            { input: '50 отжимания (+из них около 30 с колен(20+30))', values: { push_reps: 20, push_knees_reps: 30 } },
            { input: '50 отжимания (10+40)', values: { push_reps: 10, push_knees_reps: 40 } },
        ],
    }] });
    const input = '50 отжимания (11+39)';
    const r = await route(input, { fetch: mockFetch({ answer: routerAnswer(input, 1, { ruleId: 'rule_001' }) }).fn, rules });
    assert.equal(r.payload.groups[0].group, 1);
    assert.equal(r.payload.modelGroup, undefined);
});

test('route: сетевая ошибка → ошибка без fallback (пустые правила)', async () => {
    const { fn } = mockFetch({ throwBefore: new Error('ECONNREFUSED') });
    const r = await route('день', { fetch: fn });
    assert.equal(r.status, 'error');
    assert.equal(r.payload, null);
    assert.match(r.message, /не дал валидного ответа/i);
    assert.equal(r.confidence, 0);
});

test('route: сетевая ошибка при существующих правилах не должна маскироваться группой 1', async () => {
    const { fn } = mockFetch({ throwBefore: new Error('ECONNREFUSED') });
    const r = await route('день', { fetch: fn, rules: '{"rules": [{"id": "rule_011"}]}' });
    assert.equal(r.status, 'error');
    assert.equal(r.payload, null);
});

test('route: HTTP-ошибка (500) → ошибка без fallback', async () => {
    const { fn } = mockFetch({ ok: false, status: 500 });
    const r = await route('день', { fetch: fn });
    assert.equal(r.status, 'error');
    assert.equal(r.payload, null);
});

test('route: LLM вернул ambiguous → ошибка без fallback', async () => {
    const { fn } = mockFetch({
        answer: JSON.stringify({ status: 'ambiguous', payload: { issue: 'непонятно' }, confidence: 0.4 }),
    });
    const r = await route('день', { fetch: fn });
    assert.equal(r.status, 'error');
    assert.equal(r.payload, null);
});

test('route: не-JSON/garbage текст → ошибка без fallback', async () => {
    const { fn } = mockFetch({ answer: 'привет, это не JSON' });
    const r = await route('день', { fetch: fn });
    assert.equal(r.status, 'error');
    assert.equal(r.payload, null);
});

test('route: пустой/не-строковый ввод → контрактный error', async () => {
    assert.deepEqual(await route('   ', { fetch: mockFetch({ answer: routerAnswer('x', 1) }).fn }), { status: 'error', payload: null, confidence: 0 });
    assert.deepEqual(await route(null, { fetch: mockFetch({ answer: routerAnswer('x', 1) }).fn }), { status: 'error', payload: null, confidence: 0 });
    assert.deepEqual(await route(123, { fetch: mockFetch({ answer: routerAnswer('x', 1) }).fn }), { status: 'error', payload: null, confidence: 0 });
});

test('route: НИКОГДА не бросает исключений (garbage fetch), возвращает error без групп', async () => {
    const explode = async () => {
        throw new Error('взрыв');
    };
    const r = await route('день', { fetch: explode });
    assert.equal(r.status, 'error');
    assert.equal(r.payload, null);
});

// ============================================================
// (г) Шаблон mode_router.md (v9)
// ============================================================

test('Router projection includes exercise-specific examples and strips rule metadata and values', async () => {
    const { fn, calls } = mockFetch({
        answer: routerAnswer('день записи', 1, { ruleId: 'rule_011' }, 0.95),
    });
    const rulesJson = JSON.stringify({ rules: [{ id: 'secret-rule', version: 9, raw: 'полный день с секретом', mapping: { push_reps: 'отжимания', running_distance_km: 'бег' }, examples: [
        { input: '50 отжимания (10+40)', values: { push_reps: 10, push_knees_reps: 40 } },
        { input: '~5км', values: { running_distance_km: 5 } },
    ] }] });
    const r = await route('день записи', { fetch: fn, rules: rulesJson });
    assert.equal(r.status, 'success');
    const prompt = calls[0].prompt;
    assert.ok(!prompt.includes('{{RULES}}'), '{{RULES}} должен быть заменён');
    assert.ok(prompt.includes('50 отжимания (10+40)'));
    assert.ok(prompt.includes('~5км'));
    assert.ok(prompt.includes('push_reps'));
    assert.ok(!prompt.includes('secret-rule'));
    assert.ok(!prompt.includes('полный день с секретом'));
    assert.ok(!prompt.includes('"values"'));
    assert.ok(!prompt.includes('"version"'));
    assert.ok(!prompt.includes('"10"'));
});

test('Router projection keeps keys and only their own grounded fragments across rule versions', () => {
    const { routerRules } = require('../core/router.js');
    const projection = routerRules(JSON.stringify({ rules: [
        { id: 'v1-secret', raw: 'do not send', mapping: { run: 'бег, полный день' }, examples: [
            { input: '~5км', values: { run: 5 } },
        ] },
        { id: 'v2-secret', version: 2, mapping: { run: 'other leaked label', push: 'полный день', press: 'пресс' }, examples: [
            { input: 'старый push фрагмент', values: { push: 5 } },
            { input: '50 отжимания (10+40)', values: { push: 10, knees: 40 } },
            { input: '~6км', values: { run: 6 } },
        ] },
    ] }));
    assert.deepEqual(projection, { rules: { run: ['~6км', '~5км'], push: ['50 отжимания (10+40)', 'старый push фрагмент'], press: [] } });
});

test('D14: route() без rules — промпт остаётся валидным (пустой словарь)', async () => {
    const { fn, calls } = mockFetch({ answer: routerAnswer('день', 3) });
    const r = await route('день', { fetch: fn });
    assert.equal(r.status, 'success');
    assert.ok(!calls[0].prompt.includes('{{RULES}}'));
});

test('route: prompt includes day and excludes auxiliary context', async () => {
    const { fn, calls } = mockFetch({ answer: routerAnswer('день', 3) });
    const context = 'Последние: 2026-08-23 push_full=90';
    const r = await route('день', { fetch: fn, context });
    assert.equal(r.status, 'success');
    const sentPrompt = calls[0].prompt;
    assert.ok(!sentPrompt.includes(context));
    assert.ok(!sentPrompt.includes('{{CONTEXT}}'));
    assert.ok(!sentPrompt.includes('{{INPUT}}'));
    assert.ok(!sentPrompt.includes('{{RULES}}'));
});

test('шаблон Router содержит {{INPUT}} и {{RULES}}, но не auxiliary context', () => {
    const t = loadRouterTemplate();
    assert.ok(!t.includes('{{CONTEXT}}'));
    assert.ok(t.includes('{{RULES}}'));
    assert.ok(t.includes('{{INPUT}}'));
    assert.ok(fs.existsSync(path.join(PROMPTS_DIR, 'mode_router.md')));
    _resetTemplateCache();
});

test('шаблоны Router: обычные и временные правила, по одному вызову', async () => {
    const raw = fs.readFileSync(path.join(PROMPTS_DIR, 'mode_router.md'), 'utf8');
    const session = fs.readFileSync(path.join(PROMPTS_DIR, 'mode_routerSession.md'), 'utf8');
    assert.match(raw, /version: 36/);
    assert.match(session, /version: 35/);
    const regularFetch = mockFetch({ answer: routerAnswer('день', 1, { ruleId: 'rule_001' }) });
    const provisionalFetch = mockFetch({ answer: routerAnswer('день', 1, { ruleId: 'tmp_001' }) });
    await route('день', { fetch: regularFetch.fn, rules: JSON.stringify({ rules: [{ id: 'rule_001' }] }) });
    await route('день', { fetch: provisionalFetch.fn, rules: JSON.stringify({ rules: [{ id: 'tmp_001' }] }) });
    assert.equal(regularFetch.calls.length, 1);
    assert.equal(provisionalFetch.calls.length, 1);
    assert.ok(!regularFetch.calls[0].prompt.includes('tmp_001'));
    assert.ok(!provisionalFetch.calls[0].prompt.includes('tmp_001'));
    assert.match(raw, /payload\.groups/);
    assert.ok(!raw.includes('"chunk":'), 'вердикт связывается с исходным днём кодом, модель не копирует raw');
    assert.match(raw, /group.*число 1, 2 или 3/);
    assert.ok(raw.length <= 2700, `промпт должен быть ≤2700 символов, есть: ${raw.length}`);
    // Сквозная оценка и гранулярность день=кусок остаются ответственностью кода цикла.
    assert.ok(!raw.includes('Сквозная оценка'), 'сквозная оценка — работа цикла');
    assert.ok(!raw.includes('Гранулярность'), 'гранулярность — работа cutter');
    assert.match(raw, /Рассмотри каждую группу упражнений/);
    assert.match(raw, /Не делай вывод по одному совпавшему упражнению/);
    assert.match(raw, /ID правил/);
    assert.match(raw, /Дата и заголовок дня — метаданные/);
    assert.match(raw, /независимо от чисел/);
    assert.match(raw, /отдельное измерение максимума/);
    assert.match(raw, /независимо от чисел/);
    assert.ok(!raw.includes('{{CONTEXT}}'));
});

test('шаблон mode_router.md: без запрещённых деталей тест-кейсов (даты/упражнения/ключи)', () => {
    const raw = fs.readFileSync(path.join(PROMPTS_DIR, 'mode_router.md'), 'utf8');
    const banned = ['05-29', '05-31', '06-02', '07-17', '07-19', '07-21', 'пресс', 'присяд', 'отжиман',
        'подтягиван', 'press_reps', 'pushup', 'squat_reps', 'клининт'];
    for (const b of banned) assert.ok(!raw.includes(b), `шаблон не должен содержать '${b}'`);
});

test('AC10: route не пишет на диск и не мутирует вход', async () => {
    const before = fs.readdirSync(PROMPTS_DIR).sort().join('|');
    const { fn } = mockFetch({ answer: routerAnswer('день записи', 1, { ruleId: 'rule_011' }) });
    const input = 'день записи';
    const snapshot = input + '';
    const r = await route(input, { fetch: fn, rules: JSON.stringify({ rules: [{ mapping: { x: 'exercise' }, examples: [] }] }) });
    assert.equal(r.payload.groups[0].group, 1);
    assert.equal(input, snapshot);
    assert.equal(fs.readdirSync(PROMPTS_DIR).sort().join('|'), before);
});
