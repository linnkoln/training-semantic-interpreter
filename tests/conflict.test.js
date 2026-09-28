'use strict';
// tests/conflict.test.js — P-C (Branch 2): Unknown/Conflict + Rule Proposal / Rule Evolution.
// AC-R3: фикстура новых данных (пресс/присяд/велосипед) → предложенное правило + пример-отрисовка.
// AC-R4: принятое правило попадает в лог отрисовки (appendRule) — монотонная версия.
// AC10: LLM — не источник истины: только ПРЕДЛАГАЕТ; confirms пишет в лог через appendRule.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const { proposeRule, confirmProposal } = require('../core/conflict.js');
const { isEvent } = require('../core/events.js');
const { DEFAULT_RULES } = require('../core/rules.js');

const REAL_LOG_PATH = path.resolve(__dirname, '../data/rulesLog.json');

// ---- mock-fetch (как в llm/llmGateway тестах) ----
function mockFetch({ ok = true, status = 200, answer = '', throwBefore = null } = {}) {
    const fn = async (url, init = {}) => {
        if (throwBefore) throw throwBefore;
        return {
            ok,
            status,
            json: async () => (ok ? { message: { content: answer } } : {}),
        };
    };
    return fn;
}

// ---- helpers для temp-лога правил (не трогаем data/rulesLog.json) ----
function uniqueTestLogPath() {
    const suffix = crypto.randomBytes(8).toString('hex');
    return path.resolve(__dirname, `../data/rulesLog.conflict.${suffix}.tmp.json`);
}

/** Переключаем rulesLog на temp-путь (затем вернём обратно). Returns restore().
 *  В temp пишется СИНТЕТИЧЕСКАЯ фикстура: data/rulesLog.json пуст после сброса (версия 0).
 *  Фикстура содержит rule_001 (для проверки дубля id) и rule_009 (чтобы следующий
 *  сгенерированный id был rule_010) — контракт appendRule/confirmProposal не меняется. */
function pointRulesLogAt(tempPath) {
    const rulesLog = require('../core/rulesLog.js');
    const origPath = rulesLog._getLogPath();
    const rule = (id) => ({ id, __version: 1, when: { pattern: `^фикстура${id}\\s*(\\d+)$` }, then: { entity: 'fix', metric: 'full', composition: 'single' } });
    const snapshot = {
        version: 1,
        updatedAt: '2026-01-01T00:00:00.000Z',
        dynamic: [rule('rule_001'), rule('rule_009')],
        global: [],
    };
    const fixtureLog = {
        version: 1,
        updatedAt: snapshot.updatedAt,
        entries: [
            {
                version: 1,
                timestamp: snapshot.updatedAt,
                changeType: 'init',
                rulesSnapshot: snapshot,
                meta: { description: 'фикстура тестов conflict' },
            },
        ],
    };
    fs.writeFileSync(tempPath, JSON.stringify(fixtureLog, null, 2), 'utf8');
    rulesLog._resetCache();
    rulesLog._setLogPath(tempPath);
    return function restore() {
        rulesLog._resetCache();
        rulesLog._setLogPath(origPath);
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    };
}

// ============================================================
// (а) AC-R3: фикстура новых данных → предложенное правило + пример-отрисовка
// ============================================================

test('AC-R3: НОВЫЕ данные (пресс) → предложенное правило + иммутабельные пример-события', async () => {
    const fake = mockFetch({
        answer: '[{"date":"2026-08-29","values":{"press_full":30}}]',
    });
    const input = 'пресс 30 присяд 50 велосипед 10';
    const r = await proposeRule(input, { llmOptions: { fetch: fake }, date: '2026-08-29' });

    assert.equal(r.status, 'success');
    assert.ok(r.confidence >= 0 && r.confidence <= 1);

    // Предложенное правило — контрактная форма {id?, when, then}.
    const rule = r.payload.rule;
    assert.ok(rule.when && rule.when.pattern, 'rule должен иметь when.pattern');
    assert.ok(rule.then, 'rule должен иметь then');
    assert.equal(rule.then.entity, 'press');
    assert.equal(rule.then.metric, 'full');
    assert.equal(rule.then.composition, 'single');
    assert.ok(rule.id, 'rule должен иметь id (модуль генерирует уникальный)');

    // пример-отрисовка: события иммутабельны и являются событиями
    const events = r.payload.exampleEvents;
    assert.ok(Array.isArray(events) && events.length >= 1, 'должен быть хотя бы 1 пример-event');
    for (const e of events) {
        assert.ok(isEvent(e), 'пример-событие должно проходить isEvent');
        assert.ok(Object.isFrozen(e), 'пример-событие должно быть заморожено');
        assert.ok(Object.isFrozen(e.values), 'values события должны быть заморожены');
        assert.ok(Number.isInteger(e.interpretation_version));
    }
    // рендер правила на входе: press_full = 30 (первое число из входа)
    assert.equal(events[0].values.press_full, 30);
});

test('AC-R3: pattern правила детерминирован из входа (^..., (\d+), гибкие пробелы)', async () => {
    const fake = mockFetch({ answer: '[{"values":{"bike_dist":10}}]' });
    const r = await proposeRule('велосипед 10', { llmOptions: { fetch: fake } });
    assert.equal(r.status, 'success');
    assert.equal(r.payload.rule.then.entity, 'bike');
    assert.equal(r.payload.rule.when.pattern, '^велосипед\\s*(\\d+)$');
});

test('AC-R3: LLM даёт композицию A+B → rule.then.composition A+B', async () => {
    const fake = mockFetch({ answer: '[{"values":{"press_full":30,"press_knee":20}}]' });
    const r = await proposeRule('пресс 30 (20+10)', { llmOptions: { fetch: fake } });
    assert.equal(r.status, 'success');
    assert.equal(r.payload.rule.then.composition, 'A+B');
    // пример: primary press_full = 30
    assert.equal(r.payload.exampleEvents[0].values.press_full, 30);
});

test('AC-R3: LLM даёт max-форму → rule.then.composition max', async () => {
    const fake = mockFetch({ answer: '[{"values":{"press_full":30,"press_max_set":10}}]' });
    const r = await proposeRule('пресс 30 макс: 10', { llmOptions: { fetch: fake } });
    assert.equal(r.status, 'success');
    assert.equal(r.payload.rule.then.composition, 'max');
});

// ============================================================
// (б) AC-R4: подтверждение → appendRule → лог содержит правило, версия +1
// ============================================================

test('AC-R4: confirmProposal записывает правило в лог (appendRule), версия +1', async () => {
    const tempPath = uniqueTestLogPath();
    const restore = pointRulesLogAt(tempPath);
    const rulesLog = require('../core/rulesLog.js');
    try {
        const beforeVersion = rulesLog.getVersion();
        const proposal = {
            rule: {
                id: 'rule_010',
                when: { pattern: '^пресс\\s*(\\d+)$' },
                then: { entity: 'press', metric: 'full', composition: 'single' },
            },
            exampleEvents: [],
            rationale: 'Новое упражнение пресс (Branch 2)',
        };
        const res = await confirmProposal(proposal, { meta: { test: true } });

        assert.equal(res.status, 'success');
        assert.equal(res.payload.entry.changeType, 'add');
        assert.equal(res.payload.version, beforeVersion + 1);
        assert.equal(res.payload.entry.version, beforeVersion + 1);

        // Лог содержит новое правило + версия увеличилась ровно на 1.
        assert.equal(rulesLog.getVersion(), beforeVersion + 1);
        const latest = rulesLog.getLatestRules();
        const added = [...latest.dynamic, ...latest.global].find((r) => r.id === 'rule_010');
        assert.ok(added, 'правило rule_010 должно попасть в лог');
        assert.equal(added.then.entity, 'press');
        assert.equal(added.when.pattern, '^пресс\\s*(\\d+)$');
        assert.equal(added.__version, 1);
    } finally {
        restore();
    }
});

test('D13: confirmProposal/buildProposal сохраняют пример «как семантика перевелась в json»', async () => {
    const tempPath = uniqueTestLogPath();
    const restore = pointRulesLogAt(tempPath);
    const rulesLog = require('../core/rulesLog.js');
    const { buildProposal, confirmProposal } = require('../core/conflict.js');
    try {
        const beforeVersion = rulesLog.getVersion();
        // 1) buildProposal кладёт examples из ввода/даты/values
        //    (id задан явно: data/rules.json пуст после сброса → автогенерация дала бы rule_001,
        //     который занят в фикстуре лога; контракт примера D13 тест не меняет)
        const prop = buildProposal(
            { payload: [{ date: '2026-08-24', values: { press_full: 100 } }] },
            '- 100 пресс',
            { date: '2026-08-24', id: 'rule_020' }
        );
        assert.ok(prop && prop.rule, 'buildProposal должен построить правило');
        assert.ok(Array.isArray(prop.rule.examples) && prop.rule.examples.length === 1,
            'правило должно содержать ровно один пример');
        assert.deepEqual(prop.rule.examples[0], {
            input: '- 100 пресс',
            date: '2026-08-24',
            values: { press_full: 100 },
        });

        // 2) confirmProposal сохраняет пример в лог
        const res = await confirmProposal({ rule: prop.rule, input: '- 100 пресс', date: '2026-08-24' }, {});
        assert.equal(res.status, 'success');
        assert.equal(res.payload.version, beforeVersion + 1);
        const snap = res.payload.entry.rulesSnapshot;
        const added = snap.dynamic.find((r) => r.then && r.then.entity === 'press');
        assert.ok(added, 'правило пресс должно быть в логе');
        assert.ok(Array.isArray(added.examples) && added.examples.length === 1,
            'сохранённое правило должно содержать пример');
        assert.equal(added.examples[0].input, '- 100 пресс');
        assert.equal(added.examples[0].date, '2026-08-24');
        assert.deepEqual(added.examples[0].values, { press_full: 100 });
    } finally {
        restore();
    }
});

test('D13: правило без input/date не обязано иметь examples (обратная совместимость)', async () => {
    const tempPath = uniqueTestLogPath();
    const restore = pointRulesLogAt(tempPath);
    const rulesLog = require('../core/rulesLog.js');
    const { confirmProposal } = require('../core/conflict.js');
    try {
        const proposal = {
            rule: {
                id: 'rule_legacy',
                when: { pattern: 'x' },
                then: { entity: 'pull', metric: 'full', composition: 'single' },
            },
            // нет input/date/values — пример не строится
        };
        const res = await confirmProposal(proposal, {});
        assert.equal(res.status, 'success');
        const snap = res.payload.entry.rulesSnapshot;
        const added = snap.dynamic.find((r) => r.id === 'rule_legacy');
        assert.ok(added, 'правило добавлено');
        assert.ok(!added.examples || added.examples.length === 0,
            'без входа examples может отсутствовать (опциональное поле)');
    } finally {
        restore();
    }
});

test('AC-R4: appendRule защищает от дубля id (монотонность/уникальность)', async () => {
    const tempPath = uniqueTestLogPath();
    const restore = pointRulesLogAt(tempPath);
    const rulesLog = require('../core/rulesLog.js');
    try {
        const proposal = {
            rule: { id: 'rule_001', when: { pattern: 'x' }, then: { entity: 'x', metric: 'y' } },
        };
        await assert.rejects(
            () => confirmProposal(proposal),
            /уже существует/,
            'дубль id на add должен быть отклонён appendRule'
        );
    } finally {
        restore();
    }
});

test('AC-R4: confirmProposal генерирует уникальный id, если его нет', async () => {
    const tempPath = uniqueTestLogPath();
    const restore = pointRulesLogAt(tempPath);
    const rulesLog = require('../core/rulesLog.js');
    try {
        const proposal = {
            rule: { when: { pattern: '^присяд\\s*(\\d+)$' }, then: { entity: 'squat', metric: 'full' } },
        };
        const res = await confirmProposal(proposal);
        assert.equal(res.status, 'success');
        const latest = rulesLog.getLatestRules();
        const ids = [...latest.dynamic, ...latest.global].map((r) => r.id);
        assert.ok(ids.includes('rule_010'), 'должен сгенерировать следующий id (rule_010)');
    } finally {
        restore();
    }
});

test('AC-R4: confirmProposal отклоняет правило без then (невалидное)', async () => {
    await assert.rejects(
        () => confirmProposal({ rule: { id: 'rule_x', when: { pattern: 'x' } } }),
        TypeError
    );
});

// ============================================================
// (в) некорректный LLM → {status:'error'} / отказ генерации
// ============================================================

test('AC10: сбой сети → {status:error}, ничего не предлагается', async () => {
    const fake = mockFetch({ throwBefore: new Error('ECONNREFUSED') });
    const r = await proposeRule('пресс 30', { llmOptions: { fetch: fake } });
    assert.equal(r.status, 'error');
    assert.equal(r.payload, null);
});

test('AC10: HTTP-ошибка → {status:error}', async () => {
    const fake = mockFetch({ ok: false, status: 500 });
    const r = await proposeRule('пресс 30', { llmOptions: { fetch: fake } });
    assert.equal(r.status, 'error');
    assert.equal(r.payload, null);
});

test('AC10: LLM честно вернул ambiguous → отказ генерации {status:error}', async () => {
    const fake = mockFetch({ answer: '{ "status": "ambiguous", "payload": { "issue": "unknown" }, "confidence": 0.3 }' });
    const r = await proposeRule('пресс 30', { llmOptions: { fetch: fake } });
    assert.equal(r.status, 'error');
    assert.equal(r.payload, null);
});

test('AC10: пустой/не-распознанный payload → отказ генерации {status:error}', async () => {
    const fake = mockFetch({ answer: '[]' });
    const r = await proposeRule('пресс 30', { llmOptions: { fetch: fake } });
    assert.equal(r.status, 'error');
    assert.equal(r.payload, null);
});

test('AC10: мусорный текст LLM (нет JSON) → {status:error}', async () => {
    const fake = mockFetch({ answer: 'ой, извините, ничего не понял' });
    const r = await proposeRule('пресс 30', { llmOptions: { fetch: fake } });
    assert.equal(r.status, 'error');
    assert.equal(r.payload, null);
});

test('AC10: кандидат без values → отказ генерации', async () => {
    const fake = mockFetch({ answer: '[{"date":"2026-08-29","values":{}}]' });
    const r = await proposeRule('пресс 30', { llmOptions: { fetch: fake } });
    assert.equal(r.status, 'error');
});

test('AC10: пустой ввод → {status:error} без вызова LLM', async () => {
    const fake = mockFetch({ answer: '[{"values":{"press_full":1}}]' });
    const r = await proposeRule('   ', { llmOptions: { fetch: fake } });
    assert.equal(r.status, 'error');
    assert.equal(r.payload, null);
});

// ============================================================
// (г) два разных LLM-ответа → согласованный результат там, где инвариантно
// ============================================================

test('AC10: два разных LLM-ответа с той же семантикой → одинаковый pattern и пример', async () => {
    const input = 'пресс 30';
    // Ответ 1: массив-кандидат.
    const fake1 = mockFetch({ answer: '[{"date":"2026-08-29","values":{"press_full":30}}]' });
    // Ответ 2: объект с явным status + другим оформлением confidence.
    const fake2 = mockFetch({
        answer: '{ "status": "success", "payload": [{ "values": { "press_full": 30 } }], "confidence": 0.7 }',
    });

    const r1 = await proposeRule(input, { llmOptions: { fetch: fake1 }, date: '2026-08-29' });
    const r2 = await proposeRule(input, { llmOptions: { fetch: fake2 }, date: '2026-08-29' });

    assert.equal(r1.status, 'success');
    assert.equal(r2.status, 'success');
    // Инварианты: when.pattern и пример-отрисовка не зависят от слов/оформления LLM.
    assert.equal(r1.payload.rule.when.pattern, r2.payload.rule.when.pattern);
    assert.equal(r1.payload.rule.then.entity, r2.payload.rule.then.entity);
    assert.equal(r1.payload.rule.then.metric, r2.payload.rule.then.metric);
    assert.deepEqual(r1.payload.exampleEvents[0].values, r2.payload.exampleEvents[0].values);
    // id детерминирован (одинаковые правила на одинаковом входе).
    assert.equal(r1.payload.rule.id, r2.payload.rule.id);
});
