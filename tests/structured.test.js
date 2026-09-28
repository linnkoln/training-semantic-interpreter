'use strict';
// tests/structured.test.js — P-B/D9 Structured Event, Branch 1 (AC-R2, D9).
// LLM — когнитивный источник распознавания: кандидаты валидируются по СТРУКТУРЕ КОНТРАКТА
// (дата YYYY-MM-DD, values — числовые, ключи entity_metric), НЕ по формату ввода (D9).
// События иммутабельны; детерминизм — контейнер/валидатор, не фильтр по формату.
// Unit-тесты БЕЗ реальной сети: инжектируемый fetch через opts.llmOptions.fetch.

const test = require('node:test');
const assert = require('node:assert/strict');

const rulesLog = require('../core/rulesLog.js');
const { getVersion, getLatestRules } = rulesLog;
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { isEvent } = require('../core/events.js');
const structured = require('../core/structured.js');

test.beforeEach((t) => {
    const originalPath = rulesLog._getLogPath();
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'training-structured-'));
    rulesLog._setLogPath(path.join(directory, 'rulesLog.json'));
    rulesLog._resetCache();
    t.after(() => {
        rulesLog._setLogPath(originalPath);
        rulesLog._resetCache();
        fs.rmdirSync(directory);
    });
});

const DATE = '2026-08-29';

/** Фейковый fetch: возвращает сырой текст LLM в data.message.content (контракт adapters/llm.js). */
function fakeFetch(llmText) {
    return async () => ({
        ok: true,
        json: async () => ({ message: { content: llmText } }),
    });
}

/** JSON-ответ LLM-наблюдателя. */
function llmParse(payload, status = 'success', confidence = 0.95) {
    return JSON.stringify({ status, payload, confidence });
}

// ---- (а) AC-R2: реальный ввод заказчика (недетерминированный) → событие из LLM-структуры ----
// FORM НЕ из правил регекса; LLM распознаёт «макс за раз» и даёт структуру. Детерминизм
// валидирует контракт и оформляет событие — НЕ отбрасывает по формату (D9).
test('AC-R2: недетерминированный ввод → событие из структуры LLM, не фильтр по формату', async () => {
    const candidate = llmParse([{ date: DATE, values: { push_max_set: 100, press_full: 100, squat_full: 100 } }]);
    const r = await structured('- 100 отжимания (макс за раз: 100), - 100 пресс, - 100 присяд', {
        date: DATE,
        llmOptions: { fetch: fakeFetch(candidate) },
    });

    assert.equal(r.status, 'success');
    assert.ok(r.payload && Array.isArray(r.payload.events));
    assert.equal(r.payload.events.length, 1);
    const evt = r.payload.events[0];
    assert.ok(isEvent(evt));
    assert.equal(evt.date, DATE);
    assert.deepEqual(evt.values, { push_max_set: 100, press_full: 100, squat_full: 100 });
    // иммутабельность
    assert.ok(Object.isFrozen(evt));
    assert.ok(Object.isFrozen(evt.values));
    assert.throws(() => { evt.values.push_max_set = 999; }, TypeError);
});

test('Branch 1 exposes only verbatim LLM per-key source spans for exercise examples', async () => {
    const input = '*05-29* ~6км; 100 отжимания (43+57)';
    const r = await structured(input, {
        date: DATE,
        llmOptions: { fetch: fakeFetch(llmParse([
            {
                date: DATE,
                values: { running_distance_km: 6 },
                sourceByKey: { running_distance_km: '~6км' },
            },
            {
                date: DATE,
                values: { push_reps: 43, push_knees_reps: 57 },
                sourceByKey: {
                    push_reps: '100 отжимания (43+57)',
                    push_knees_reps: '100 отжимания (43+57)',
                },
            },
            {
                date: DATE,
                values: { burpee_reps: 10 },
                sourceByKey: { burpee_reps: '10 burpees' },
            },
        ])) },
    });

    assert.equal(r.status, 'success');
    assert.deepEqual(r.payload.events[0].values, {
        running_distance_km: 6,
        push_reps: 43,
        push_knees_reps: 57,
        burpee_reps: 10,
    });
    const spans = Object.fromEntries(r.payload.newKeys.map((item) => [item.key, item.sourceSpan]));
    assert.deepEqual(spans, {
        running_distance_km: '~6км',
        push_reps: '100 отжимания (43+57)',
        push_knees_reps: '100 отжимания (43+57)',
        burpee_reps: undefined,
    });
});

test('explicit zero remains numeric; absent sibling key is not filled from context', async () => {
    const r = await structured('50 подтягивания (50+0)', {
        date: DATE,
        llmOptions: { fetch: fakeFetch(llmParse([{ date: DATE, values: { pull_reps: 50, pull_rings_reps: 0 } }])) },
    });
    assert.equal(r.status, 'success');
    assert.deepEqual(r.payload.events[0].values, { pull_reps: 50, pull_rings_reps: 0 });
    const withoutComponent = await structured('50 подтягивания макс: 6', {
        date: DATE,
        llmOptions: { fetch: fakeFetch(llmParse([{ date: DATE, values: { pull_reps: 50, pull_max_set: 6 } }])) },
    });
    assert.equal(withoutComponent.status, 'success');
    assert.deepEqual(withoutComponent.payload.events[0].values, { pull_reps: 50, pull_max_set: 6 });
});

// ---- (б) D9: структурная валидация контракта, а не формата; разные payload LLM ----
// LLM-A и LLM-B дают РАЗНЫЕ распознавания формы (ручное vs машинное), но ОБА проходят
// структурный контракт → каждое оформляется в событие. Детерминизм не навязывает одну форму.
test('D9/AC10: два структурно валидных LLM-распознавания → оба оформляются', async () => {
    const input = '- 100 отжимания (макс за раз: 100)';
    const resA = await structured(input, {
        date: DATE,
        llmOptions: { fetch: fakeFetch(llmParse([{ date: DATE, values: { push_full: 100 } }])) },
    });
    const resB = await structured(input, {
        date: DATE,
        llmOptions: { fetch: fakeFetch(llmParse([{ date: DATE, values: { push_max_set: 100 } }])) },
    });

    assert.equal(resA.status, 'success');
    assert.equal(resB.status, 'success');
    assert.deepEqual(resA.payload.events[0].values, { push_full: 100 });
    assert.deepEqual(resB.payload.events[0].values, { push_max_set: 100 });
});

// ---- (в) структурная валидация отклоняет мусор (не формат, а контракт) ----
test('D9: невалидная структура кандидата → отброшен (нечисловые / пусто / не entity_metric)', async () => {
    // дата теперь не фильтр в validateCandidate (идёт из opts.date/контекста, D9);
    // фильтруются только невалидные values.
    const r = await structured('100 отжимания', {
        date: DATE,
        llmOptions: {
            fetch: fakeFetch(llmParse([
                { date: 'не-дата', values: { push_full: 100 } },   // валидные values → пройдёт (дата из opts.date)
                { date: DATE, values: { a: 'строка' } },           // нечисловое → отброшен
                { date: DATE, values: {} },                        // пусто → отброшен
            ])),
        },
    });
    assert.equal(r.status, 'success');     // есть хотя бы один валидный (по values)
    assert.equal(r.payload.events.length, 1);
    assert.deepEqual(r.payload.events[0].values, { push_full: 100 });
    assert.equal(r.payload.events[0].date, DATE);  // дата из opts.date, а не из LLM
});

test('D9: смесь валидного и битого → сохраняется только валидный', async () => {
    const r = await structured('- 100 отжимания (макс за раз: 100)', {
        date: DATE,
        llmOptions: {
            fetch: fakeFetch(llmParse([
                { date: DATE, values: { push_max_set: 100 } },
                { date: 'не-дата', values: { push_full: 100 } },  // валидные values → пройдёт (дата из opts.date)
                { date: DATE, values: { bad: 'x' } },             // нечисловое → отброшен
            ])),
        },
    });
    assert.equal(r.status, 'success');
    assert.equal(r.payload.events.length, 1);
    // оба валидных кандидата слились в одно событие (D9-слияние)
    assert.deepEqual(r.payload.events[0].values, { push_max_set: 100, push_full: 100 });
});

// ---- (г) некорректный LLM → {status:'error'} ----
test('AC-R6/D9: некорректный LLM (garbage) → status error, событий нет', async () => {
    const r = await structured('100 отжимания (73+27)', {
        date: DATE,
        llmOptions: { fetch: fakeFetch('это вовсе не JSON, а сплошная проза') },
    });
    assert.equal(r.status, 'error');
    assert.equal(r.payload.events.length, 0);
});

test('AC-R6/D9: LLM вернул empty payload / ambiguous → status error', async () => {
    const r = await structured('50 подтягиваний макс: 15', {
        date: DATE,
        llmOptions: { fetch: fakeFetch(llmParse([], 'ambiguous', 0.3)) },
    });
    assert.equal(r.status, 'error');
    assert.equal(r.payload.events.length, 0);
});

// ---- (д) interpretation_version = версия правил из лога + дедуп дат (AC6) ----
test('D9/D2: interpretation_version равен версии правил из лога (getVersion)', async () => {
    const candidate = llmParse([{ date: DATE, values: { push_full: 73, push_knee: 27 } }]);
    const versionFromLog = getVersion();
    assert.ok(Number.isInteger(versionFromLog));

    const r = await structured('100 отжимания (73+27)', {
        date: DATE,
        llmOptions: { fetch: fakeFetch(candidate) },
    });
    assert.equal(r.payload.events[0].interpretation_version, versionFromLog);
    const latest = getLatestRules();
    assert.equal(r.payload.events[0].interpretation_version, latest.version);
});

test('D2/AC6: несколько кандидатов одной даты → одно событие, values слиты (последний превалирует)', async () => {
    const r = await structured('100 отжимания', {
        date: DATE,
        llmOptions: {
            fetch: fakeFetch(llmParse([
                { date: DATE, values: { push_full: 100 } },
                { date: DATE, values: { push_full: 200 } },
            ])),
        },
    });
    assert.equal(r.status, 'success');
    assert.equal(r.payload.events.length, 1);
    assert.deepEqual(r.payload.events[0].values, { push_full: 200 });
});

// ---- (е) coerceCandidates: LLM может вернуть объект {events}, одиночный кандидат, массив ----
test('D9: coerceCandidates разворачивает {events:[...]} / одиночный объект / массив', () => {
    const s = structured.coerceCandidates;
    assert.equal(s({ events: [{ date: DATE, values: { a: 1 } }] }).length, 1);
    assert.equal(s({ date: DATE, values: { a: 1 } }).length, 1);
    assert.equal(s([{ date: DATE, values: { a: 1 } }]).length, 1);
    assert.equal(s(null).length, 0);
    assert.equal(s('x').length, 0);
});

// ---- вспомогательные экспорты ----
// Фикстура правил (data/rulesLog.json пуст после сброса — версия 0, dynamic/global = []).
const TABLE_RULES = {
    version: 1,
    updatedAt: '2026-01-01',
    dynamic: [
        { id: 'rule_001', __version: 1, when: { pattern: '^фикстура\\s*(\\d+)$' }, then: { entity: 'push', metric: 'full', composition: 'single' } },
    ],
    global: [
        { id: 'rule_002', __version: 1, when: { pattern: '^(\\d+)$', context: 'pull_max' }, then: { entity: 'pull', metric: 'max_set', composition: 'single' } },
    ],
};

test('helpers: buildRulesTable собирает таблицу из переданных правил', () => {
    const table = structured.buildRulesTable(TABLE_RULES);
    assert.ok(typeof table === 'string' && table.length > 0);
    assert.match(table, /rule_001/);
    assert.match(table, /push_full/);
    // D11: явный зафиксированный вокабуляр entity_metric передан в {{RULES}}
    assert.match(table, /Зафиксированные ключи entity_metric/);
    assert.match(table, /push_full/);
    assert.match(table, /pull_max_set/);
});

test('helpers: extractVocabulary — дедуп, сортировка, исключает deprecated', () => {
    const vocab = structured.extractVocabulary(TABLE_RULES);
    assert.ok(Array.isArray(vocab));
    assert.ok(vocab.length >= 2, `вокабуляр должен содержать ключи, получено: ${JSON.stringify(vocab)}`);
    assert.ok(vocab.includes('push_full'), 'push_full должен быть во вокабуляре');
    assert.ok(vocab.includes('pull_max_set'), 'pull_max_set должен быть во вокабуляре');
    // дедуп + сортировка
    const uniqueSorted = [...new Set(vocab)].sort();
    assert.deepEqual(vocab, uniqueSorted, 'вокабуляр должен быть дедуплицирован и отсортирован');
});

test('helpers: extractVocabulary устойчив к грязи и пустоте', () => {
    assert.deepEqual(structured.extractVocabulary(null), []);
    assert.deepEqual(structured.extractVocabulary({}), []);
    const messy = {
        dynamic: [
            { then: { entity: 'push', metric: 'full' } },
            { then: { entity: 'push', metric: 'full' } }, // дубль
            { deprecated: true, then: { entity: 'ghost', metric: 'gone' } }, // исключается
            { then: { entity: 'pull', metric: 'max_set' } },
            { then: null },              // без then — игнор
            { then: { entity: 'x' } },   // без metric — игнор
        ],
        global: [{ then: { entity: 'press', metric: 'full' } }],
    };
    assert.deepEqual(structured.extractVocabulary(messy), ['press_full', 'pull_max_set', 'push_full']);
});

test('D13: buildRulesTable выводит пример входа (как семантика перевелась в json)', () => {
    const rules = {
        version: 2,
        dynamic: [
            {
                id: 'rule_010',
                when: { pattern: '^-\\s*\\d+\\s*пресс$' },
                then: { entity: 'press', metric: 'full', composition: 'single' },
                examples: [
                    { input: '- 100 пресс', date: '2026-08-24', values: { press_full: 100 } },
                    { input: '- 120 пресс', date: '2026-08-26', values: { press_full: 120 } },
                ],
            },
        ],
        global: [],
    };
    const t = structured.buildRulesTable(rules);
    assert.match(t, /пример \(2026-08-24\): "- 100 пресс" -> \{"press_full":100\}/);
    assert.match(t, /пример \(2026-08-26\): "- 120 пресс" -> \{"press_full":120\}/);
    // правило без examples не ломает вывод
    const rulesNoEx = { version: 2, dynamic: [{ id: 'r', when: { pattern: 'x' }, then: { entity: 'push', metric: 'full' } }], global: [] };
    assert.ok(structured.buildRulesTable(rulesNoEx).includes('r: "x"'), 'правило без примеров выводится');
});

test('helpers: normalizeConfidence зажимает в [0,1], нечисло → 0', () => {
    assert.equal(structured.normalizeConfidence(2), 1);
    assert.equal(structured.normalizeConfidence(-1), 0);
    assert.equal(structured.normalizeConfidence(0.55), 0.55);
    assert.equal(structured.normalizeConfidence('x'), 0);
});

test('helpers: validateCandidate валидирует values; дата хранится только если валидна', () => {
    const v = structured.validateCandidate;
    // валидная дата сохраняется; невалидная → null (дата берётся из opts.date/контекста)
    assert.deepEqual(v({ date: DATE, values: { push_full: 73 } }), { date: DATE, values: { push_full: 73 } });
    assert.deepEqual(v({ date: 'не-дата', values: { push_full: 73 } }), { date: null, values: { push_full: 73 } });
    // values валидируются строго
    assert.equal(v({ date: DATE, values: { a: 'x' } }), null);       // нечисловое
    assert.equal(v({ date: DATE, values: { single: 1 } }), null);   // не entity_metric (1 сегмент)
    assert.equal(v({ date: DATE, values: {} }), null);              // пусто
    assert.equal(v(null), null);
    assert.equal(v({ date: DATE, values: null }), null);
});
test('buildRulesTable: правило без when.pattern, но с mapping/semantics печатается по mapping/semantics', () => {
    const rules = {
        version: 3,
        dynamic: [
            {
                id: 'tmp_session_keys',
                semantics: 'Ключи текущей сессии (ещё не зафиксированы Save): tmp_push_full, tmp_pull_max',
                mapping: { tmp_push_full: 'tmp_push_full', tmp_pull_max: 'tmp_pull_max' },
                roles: { tmp_push_full: 'stack', tmp_pull_max: 'overlay' },
                cues: [],
                examples: [],
                __tmp: true,
            },
        ],
        global: [],
    };
    const t = structured.buildRulesTable(rules);
    // строка правила не пустая: id + semantics доезжают
    assert.match(t, /tmp_session_keys/);
    assert.match(t, /Ключи текущей сессии/);
    // mapping — только разночтения: ключ -> кусок текста, каждый ключ один раз
    assert.match(t, /ключ tmp_push_full: "tmp_push_full"/);
    assert.match(t, /ключ tmp_pull_max: "tmp_pull_max"/);
    // не печатается как пустая строка '-> '
    assert.doesNotMatch(t, /- tmp_session_keys: "" ->/);
    // правило с пустыми mapping и semantics (без pattern) — по-прежнему не падает
    const empty = { version: 3, dynamic: [{ id: 'bare', cues: [] }], global: [] };
    const t2 = structured.buildRulesTable(empty);
    assert.match(t2, /- bare: "" ->/);
    // семантика без mapping — печатается по semantics
    const semOnly = { version: 3, dynamic: [{ id: 's1', semantics: 'Описание семантики', cues: [] }], global: [] };
    const t3 = structured.buildRulesTable(semOnly);
    assert.match(t3, /- s1: "Описание семантики" ->/);
    // правило с when.pattern не изменило поведения
    assert.match(structured.buildRulesTable(TABLE_RULES), /rule_001: "\^фикстура/);
});

// ---------------------------------------------------------------------------
// Отказоустойчивый режим нейминга (2026-09-03): нарушение контракта именования
// бракует ТОЛЬКО пару (ключ → значение), а не весь прогон. Забракованные ключи
// возвращаются в payload.namingIssues = [{key, reason}] + кратко в message.
// Статус 'success' если хотя бы одно событие построено; 'ambiguous' — только
// если после отбраковки не осталось ни одного события.
// ---------------------------------------------------------------------------
const BAD_VARIANT_KEY = 'pull_accessory_variant'; // сегмент 'variant' — запрещённая метка

test('нейминг: 2 валидных ключа + 1 с variant → success, bad ключ отбракован в namingIssues', async () => {
    const r = await structured('тренировка', {
        date: DATE,
        llmOptions: {
            fetch: fakeFetch(llmParse([
                { date: DATE, values: { push_max_set: 100, press_full: 50, [BAD_VARIANT_KEY]: 3 } },
            ])),
        },
    });
    assert.equal(r.status, 'success');
    assert.equal(r.payload.events.length, 1);
    // событие содержит ТОЛЬКО валидные ключи
    assert.deepEqual(r.payload.events[0].values, { push_max_set: 100, press_full: 50 });
    // плохой ключ не потерян молча
    assert.ok(Array.isArray(r.payload.namingIssues));
    assert.equal(r.payload.namingIssues.length, 1);
    assert.equal(r.payload.namingIssues[0].key, BAD_VARIANT_KEY);
    assert.ok(r.payload.namingIssues[0].reason, 'reason должен быть непустым');
    assert.match(r.message || '', /pull_accessory_variant/);
    // плохой ключ не попал в newKeys (нельзя фиксировать правило по браку)
    assert.ok(!r.payload.newKeys.some((n) => n.key === BAD_VARIANT_KEY));
});

test('нейминг: ВСЕ ключи плохие → ambiguous (после отбраковки событий нет)', async () => {
    const r = await structured('тренировка', {
        date: DATE,
        llmOptions: {
            fetch: fakeFetch(llmParse([
                { date: DATE, values: { [BAD_VARIANT_KEY]: 3, way2_push: 10 } },
            ])),
        },
    });
    assert.equal(r.status, 'ambiguous');
    assert.equal(r.payload.events.length, 0);
    assert.ok(Array.isArray(r.payload.namingIssues));
    assert.deepEqual(r.payload.namingIssues.map((n) => n.key).sort(), ['pull_accessory_variant', 'way2_push']);
    assert.match(r.message || '', /pull_accessory_variant/);
});

test('нейминг: ключи из вокабуляра не пере-проверяются (регресс, инжект rulesLog)', async () => {
    // Ключ с запрещённым сегментом 'variant', но зафиксированный в вокабуляре правил:
    // вокабуляр старше контракта — его НЕ бракуем (переиспользование, D10/D11).
    const rulesLogPath = require.resolve('../core/rulesLog.js');
    const structuredPath = require.resolve('../core/structured.js');
    const origRulesLog = require.cache[rulesLogPath];
    delete require.cache[structuredPath];
    require.cache[rulesLogPath] = {
        id: rulesLogPath,
        filename: rulesLogPath,
        loaded: true,
        exports: {
            getLatestRules: () => ({
                version: 1,
                dynamic: [{ id: 'r1', then: { entity: 'pull_variant', metric: 'full' } }],
                global: [],
            }),
            getVersion: () => 1,
        },
    };
    try {
        const structuredInjected = require(structuredPath);
        const r = await structuredInjected('тренировка', {
            date: DATE,
            llmOptions: {
                fetch: fakeFetch(llmParse([
                    // pull_variant_full содержит 'variant' — нарушил бы контракт,
                    // но он во вокабуляре → не проверяется и проходит как есть.
                    { date: DATE, values: { pull_variant_full: 5, push_full: 100 } },
                ])),
            },
        });
        assert.equal(r.status, 'success');
        assert.deepEqual(r.payload.events[0].values, { pull_variant_full: 5, push_full: 100 });
        assert.equal(r.payload.namingIssues, undefined, 'вокабулярные ключи не бракуются');
    } finally {
        delete require.cache[structuredPath];
        if (origRulesLog) require.cache[rulesLogPath] = origRulesLog;
        else delete require.cache[rulesLogPath];
        require(structuredPath); // восстановить оригинальный модуль в кэше
    }
});
