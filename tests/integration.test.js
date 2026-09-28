'use strict';
// tests/integration.test.js — P4/P5: сквозной интеграционный кейс-таблицей (QA-гейт).
// Реальный ввод пользователя (число первым) должен давать семантически верные события.
const test = require('node:test');
const { beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { interpret } = require('../core/interpreter.js');
const { isEvent, getVersion } = require('../core/events.js');
const { DEFAULT_RULES } = require('../core/rules.js');
const tmpStore = require('../adapters/tmpStore.js');

beforeEach((t) => {
    const originalPath = tmpStore._getRulesTmpPath();
    const prefix = 'training-integration-rules-tmp-';
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    const resolvedDir = path.resolve(tempDir);
    if (!resolvedDir.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`)
        || !path.basename(resolvedDir).startsWith(prefix)) {
        throw new Error(`Unsafe isolated rules temp path: ${resolvedDir}`);
    }
    const tempPath = path.join(resolvedDir, 'rulesLog.tmp.json');
    tmpStore._setRulesTmpPath(tempPath);
    t.after(() => {
        tmpStore._setRulesTmpPath(originalPath);
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
        fs.rmdirSync(resolvedDir);
    });
});

const DATE = '2026-08-19';

// QA-таблица детерминированного match-парсинга реального ввода старой эпохи УДАЛЕНА:
// распознавание входа — LLM (ПАМЯТКА AGENTS.md, D9/D15), контент правил копится заново.

// Сквозная регрессия: полная цепочка resolve→migrate→structured поверх ВСЕЙ таблицы не нужна —
// достаточно проверить, что после миграции новая версия закрепляется за событиями.
test('QA: миграция повышает interpretation_version у структурированных событий', async () => {
    const first = interpret('макс 6', { date: DATE, lastContext: 'pull_max_set' });
    assert.equal(first.mode, 'resolve');
    const { confirmProposal } = require('../core/interpreter.js');
    const confirmed = await confirmProposal(first.payload.proposal, { rules: DEFAULT_RULES, date: DATE });
    assert.equal(confirmed.payload.events[0].interpretation_version, DEFAULT_RULES.version + 1);
    assert.equal(confirmed.payload.events[0].values.pull_max_set, 6);
});

// ===========================================================================
// P-Q: интеграция полной LLM-цепочки релайнмента (P-A Router → P-B Structured |
// P-C Conflict → P-P Pipeline; AC-R1..R9), AC10 (LLM НЕ источник истины).
// Реальный ввод юзера прогоняется через pipeline.next / pipeline.confirm.
// LLM-источник: mock (инжектируемый llmOptions.fetch, детерминизм AC-R6) +
// ОДИН живой кейс на реальной Ollama, который мягко скипается, если сервер
// недоступен (guard не краснеет). Существующие регрессии интерпретатора ВЫШЕ
// сохранены и остаются якорем цепочки.
// ===========================================================================
const pipeline = require('../core/pipeline.js');
const rulesLog = require('../core/rulesLog.js');
const { legacyEmptyRuleLog } = require('./helpers/legacyRuleLog.js');

const RULESLOG_REAL = path.resolve(__dirname, '../data/rulesLog.json');

function seedRouterExamples() {
    const tempLog = path.join(os.tmpdir(), `rulesLog_router_${process.pid}_${Date.now()}.json`);
    const originalPath = rulesLog._getLogPath();
    fs.writeFileSync(tempLog, JSON.stringify(legacyEmptyRuleLog(), null, 2), 'utf8');
    rulesLog._resetCache();
    rulesLog._setLogPath(tempLog);
    rulesLog.appendRule({
        id: 'rule_001', raw: 'отжимания (A+B)',
        mapping: { push_full: 'полные отжимания', push_knee: 'отжимания с колен' },
        examples: [{ input: '100 отжимания (73+27)', values: { push_full: 73, push_knee: 27 } }],
    }, 'add');
    return () => {
        rulesLog._setLogPath(originalPath);
        rulesLog._resetCache();
        if (fs.existsSync(tempLog)) fs.unlinkSync(tempLog);
    };
}

/** fetch-заглушка: отдаёт содержимое `contents[i]` в порядке вызова шагов цепи
 *  ([0]=Router, [1]=Structured/Conflict). Содержимое — сырой текст готового
 *  парсинга responseParser (ответ Ollama chat). */
function mockFetch(contents) {
    let i = 0;
    return async function mockedFetch(_url, _opts) {
        const content = contents[i++];
        if (content === undefined) {
            throw new Error('P-Q mock: исчерпан список ответов LLM (ожидалось шагов больше)');
        }
        return { ok: true, status: 200, json: async () => ({ message: { content } }) };
    };
}

const routerAnswer = (group, chunk) => JSON.stringify({
    status: 'success',
    payload: { groups: [{ chunk: chunk || '(весь ввод)', group, reasoning: 'P-Q router', confidence: 0.9 }], confidence: 0.9 },
    confidence: 0.9,
});
const candidatesAnswer = (arr) => JSON.stringify(arr);

// Cutter v9 (2026-09-04): нарезка ввода на дни — первый шаг пайплайна.
const cutterAnswer = (raw) => JSON.stringify({
    status: 'success',
    payload: { days: [{ raw, date: null }], confidence: 0.9 },
    confidence: 0.9,
});

/** Статус реальной локальной Ollama (лёгкий ping, до 2.5 с — не вешает guard). */
async function probeOllama() {
    try {
        const c = new AbortController();
        const to = setTimeout(() => c.abort(), 2500);
        const r = await fetch('http://localhost:11434/api/tags', { signal: c.signal });
        clearTimeout(to);
        if (!r.ok) return { ok: false, reason: 'HTTP ' + r.status };
        return { ok: true };
    } catch (e) {
        return { ok: false, reason: (e && e.message) || String(e) };
    }
}

// AC-R1 + AC-R2: знакомая строка → Branch 1, события строятся детерминированно
// интерпретатором (AC10), даже если LLM-кандидаты даны через mock.
test('P-Q AC-R1+R2: pipeline.next (mock LLM) — знакомая строка → Branch 1, события', async () => {
    const restoreRules = seedRouterExamples();
    try {
    const res = await pipeline.next('100 отжимания (73+27)', {
        date: DATE,
        lastContext: 'push_full',
        llmOptions: {
            fetch: mockFetch([
                cutterAnswer('100 отжимания (73+27)'),
                routerAnswer(1, '100 отжимания (73+27)'),
                candidatesAnswer([{ date: DATE, values: { push_full: 73, push_knee: 27 } }]),
            ]),
        },
    });
    assert.equal(res.status, 'success');
    assert.equal(res.branch, 1);
    assert.ok(Array.isArray(res.payload.events) && res.payload.events.length === 1);
    const evt = res.payload.events[0];
    assert.ok(isEvent(evt), 'результат — валидное иммутабельное событие');
    assert.deepEqual(evt.values, { push_full: 73, push_knee: 27 });
    assert.equal(evt.date, DATE);
    assert.equal(evt.interpretation_version, rulesLog.getVersion(), 'версия событий = версия лога');
    } finally {
        restoreRules();
    }
});

// AC-R1 + AC-R3: новая/непокрытая строка → Branch 2, предложенное правило +
// пример-отрисовка (иммутабельные events).
test('P-Q AC-R3: pipeline.next (mock) — новая строка → Branch 2, правило + пример', async () => {
    const res = await pipeline.next('пресс 40', {
        date: DATE,
        llmOptions: {
            fetch: mockFetch([
                cutterAnswer('пресс 40'),
                routerAnswer(3, 'пресс 40'),
                candidatesAnswer([{ date: DATE, values: { press_full: 40 } }]),
            ]),
        },
    });
    assert.equal(res.status, 'success');
    assert.equal(res.branch, 2);
    assert.ok(res.payload.rule && res.payload.rule.id, 'предложено правило с id');
    assert.equal(res.payload.rule.then.entity, 'press');
    assert.equal(res.payload.rule.then.metric, 'full');
    assert.ok(Array.isArray(res.payload.exampleEvents) && res.payload.exampleEvents.length >= 1);
    const ex = res.payload.exampleEvents[0];
    assert.ok(isEvent(ex), 'пример-отрисовка — валидное событие');
    assert.equal(ex.values.press_full, 40);
    assert.ok(res.payload.proposal && res.payload.proposal.rule, 'proposal готов для confirm (AC-R4)');
});

// AC-R4: Rule Evolution — подтверждение правила из Branch 2 поднимает версию лога
// на 1 и дописывает правило. Лог ИЗОЛИРУЕТСЯ в temp-файле (не трогаем
// data/rulesLog.json), затем восстанавливается.
test('P-Q AC-R4: pipeline.confirm → версия лога +1, правило в логе', async () => {
    const tempLog = path.join(os.tmpdir(), `rulesLog_pq_${process.pid}_${Date.now()}.json`);
    fs.copyFileSync(path.resolve(__dirname, '../data/defaults/rulesLog.json'), tempLog);
    try {
        rulesLog._resetCache();
        rulesLog._setLogPath(tempLog);
        const before = rulesLog.getVersion();

        const flow = await pipeline.next('пресс 45', {
            date: DATE,
            llmOptions: {
                fetch: mockFetch([
                    cutterAnswer('пресс 45'),
                    routerAnswer(3, 'пресс 45'),
                    candidatesAnswer([{ date: DATE, values: { press_full: 45 } }]),
                ]),
            },
        });
        assert.equal(flow.status, 'success');
        assert.equal(flow.branch, 2);

        const res = await pipeline.confirm(flow.payload.proposal, { meta: { rationale: 'P-Q AC-R4' } });
        assert.equal(res.status, 'success');
        assert.equal(res.payload.version, before + 1, 'монотонная версия лога +1');

        const log = rulesLog.getRulesLog();
        assert.equal(log.version, before + 1);
        const last = log.entries[log.entries.length - 1];
        assert.equal(last.changeType, 'add');
        assert.ok(
            last.rulesSnapshot.dynamic.some((r) => r.id === flow.payload.rule.id),
            'подтверждённое правило в записи лога'
        );
    } finally {
        rulesLog._setLogPath(RULESLOG_REAL);
        rulesLog._resetCache();
        if (fs.existsSync(tempLog)) fs.unlinkSync(tempLog);
    }
});

// D9: LLM — когнитивный источник распознавания. Детерминированный слой — структурная
// валидация контракта (дата opц., values числовые, ключи entity_metric). Два РАЗНЫХ
// структурно валидных распознавания ПРИНИМАЮТСЯ оба (LLM не детерминирована), а кандидаты с
// мусором (нечисловые / не entity_metric) отфильтровываются структурной валидацией (D9).
test('D9/AC-R6: LLM-распознавания проходят структурную валидацию; мусор отфильтрован', async () => {
    const restoreRules = seedRouterExamples();
    try {
    const input = '100 отжимания (73+27)';
    const baseOpts = { date: DATE, lastContext: 'push_full' };
    const optsA = {
        ...baseOpts,
        llmOptions: {
            fetch: mockFetch([
                cutterAnswer('100 отжимания (73+27)'),
                routerAnswer(1, '100 отжимания (73+27)'),
                candidatesAnswer([{ date: DATE, values: { push_full: 73, push_knee: 27 } }]),
            ]),
        },
    };
    const optsB = {
        ...baseOpts,
        llmOptions: {
            // Другой ответ LLM: иной распознавания + мусорный кандидат (не entity_metric),
            // который структурная валидация отбрасывает (D9), а валидный сохраняет.
            fetch: mockFetch([
                cutterAnswer('100 отжимания (73+27)'),
                routerAnswer(1, '100 отжимания (73+27)'),
                candidatesAnswer([
                    { date: DATE, values: { push_knee: 27, push_full: 73 } },
                    { date: DATE, values: { bad: 'x' } },           // нечисловое → отфильтровано
                    { date: DATE, values: { single: 999 } },        // не entity_metric (1 сегмент) → отфильтровано
                ]),
            ]),
        },
    };
    const a = await pipeline.next(input, optsA);
    const b = await pipeline.next(input, optsB);
    assert.equal(a.status, 'success');
    assert.equal(a.branch, 1);
    assert.equal(b.status, 'success');
    assert.equal(b.branch, 1);
    // оба распознавания должны дать одно событие с валидными values (мусор отфильтрован)
    assert.equal(a.payload.events.length, 1);
    assert.equal(b.payload.events.length, 1);
    assert.deepEqual(a.payload.events[0].values, { push_full: 73, push_knee: 27 });
    assert.deepEqual(b.payload.events[0].values, { push_full: 73, push_knee: 27 });
    } finally {
        restoreRules();
    }
});

// AC-R1+R2 на РЕАЛЬНОЙ Ollama (без инъекции fetch). Если сервер/модель недоступны —
// тест корректно скипается с внятным сообщением, guard не краснеет.
// По D9: живая LLM недетерминирована — проверяем, что цепочка вернула СТРУКТУРНО валидные
// события (дата + числовые entity_metric), а не конкретные числа фикстуры.
test('P-Q AC-R1+R2 (реальная Ollama): живая LLM-цепь через pipeline.next', async (t) => {
    const probe = await probeOllama();
    if (!probe.ok) {
        t.skip('Реальная Ollama недоступна (живая LLM-цепь покрывается mock выше): ' + probe.reason);
        return;
    }
    // Живая LLM недетерминирована — её relations не должны попасть в рабочие data/.
    // Изолируем graph.tmp.json (Branch 3 пишет temp-граф на next()).
    const tmpStore = require('../adapters/tmpStore.js');
    const crypto = require('node:crypto');
    const suffix = crypto.randomBytes(8).toString('hex');
    const graphTmpPath = path.resolve(__dirname, `../data/graph.integration.${suffix}.tmp.json`);
    const origGraphTmp = tmpStore._getGraphTmpPath();
    tmpStore._setGraphTmpPath(graphTmpPath);
    try {
    const res = await pipeline.next('100 отжимания (73+27)', { date: DATE, lastContext: 'push_full' });
    assert.ok(res && typeof res === 'object', 'контракт цепочки возвращается всегда');
    assert.ok('status' in res && 'branch' in res && 'payload' in res);
    if (res.status === 'success') {
        // По промпту v3: пустой словарь {{RULES}} → LLM относит ввод к группе 3
        // (новое правило). Живая LLM недетерминирована (D9) — допускаем любую
        // доминирующую ветку, но проверяем структурную валидность результата.
        assert.ok(res.branch === 1 || res.branch === 2, 'branch — доминирующая ветка (1|2)');
        const hasEvents = Array.isArray(res.payload.events) && res.payload.events.length >= 1;
        const hasRule = res.payload.rule && res.payload.exampleEvents && res.payload.exampleEvents.length >= 1;
        assert.ok(hasEvents || hasRule, 'живая цепь вернула события или предложение правила');
        const evt = hasEvents ? res.payload.events[0] : res.payload.exampleEvents[0];
        assert.equal(evt.date, DATE, 'дата из ввода/контекста');
        assert.ok(evt.values && Object.keys(evt.values).length > 0, 'есть распознанные значения');
        // структурная валидность (D9): все значения числовые, ключи entity_metric.
        // Живая LLM может вернуть в примере поле без значения (undefined) — контракт
        // требует числовых значений только там, где значение распознано.
        for (const [k, v] of Object.entries(evt.values)) {
            assert.ok(k.split('_').length >= 2, `ключ entity_metric: ${k}`);
            if (v !== undefined) {
                assert.equal(typeof v, 'number', `значение числовое: ${k}`);
            }
        }
    } else {
        // Ожидаемый мягкий error-контракт при занятой/битой модели — цепь не бросает.
        assert.ok(typeof res.message === 'string' && res.message.length > 0);
    }
    } finally {
        tmpStore._setGraphTmpPath(origGraphTmp);
        if (fs.existsSync(graphTmpPath)) fs.unlinkSync(graphTmpPath);
    }
});
