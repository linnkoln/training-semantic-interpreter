'use strict';
const { legacyEmptyRuleLog } = require('./helpers/legacyRuleLog.js');
// tests/pipeline.test.js — P-P Orchestrator, новая архитектура (канва 2026-09-04):
//   CUTTER (нарезка на дни) → ЦИКЛ { Router (1 день) → Branch 1|2|3 }.
//   Сквозная оценка — из цикла: правила предыдущих дней живут в tmp-кэше
//   (rulesLog.setCachedLog, оверлей не откатывается между днями).
//
// LLM инжектируется через opts.llmOptions.fetch (fake-fetch, БЕЗ реальной сети).
// Fake-fetch различает Cutter / Router / minor / ruleUpdate / parse по тексту промпта.
// Temp-логи изолируются (rulesLog._setLogPath, tmpStore._setRulesTmpPath): data/rulesLog.json не трогается.

const test = require('node:test');
const { beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('node:os');
const crypto = require('crypto');

const pipeline = require('../core/pipeline.js');
const { isEvent } = require('../core/events.js');
const rulesLog = require('../core/rulesLog.js');
const tmpStore = require('../adapters/tmpStore.js');

beforeEach((t) => {
    const originalPath = tmpStore._getRulesTmpPath();
    const prefix = 'training-pipeline-rules-tmp-';
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

const DATE = '2026-08-29';

test('minor-пример берётся из исходного текста при опечатке модели в пунктуации', () => {
    const source = '*05-31*<br>- 50 отжимания (10+40)<br>- 25 подтягивания (3 + 22)';
    const append = {
        key: 'pull_reps',
        chunk: '- 25 подтягивания (3 + 22))',
        exampleText: '- 25 подтягивания (3 + 22))',
    };
    const grounded = pipeline.snapMinorAppendToSource(append, source);
    assert.equal(grounded.key, 'pull_reps');
    assert.equal(grounded.exampleText, '- 25 подтягивания (3 + 22)');
    assert.equal(grounded.chunk, grounded.exampleText);
    assert.equal(pipeline.snapMinorAppendToSource({ key: 'pull_reps', exampleText: 'другая запись' }, source), null);
    const wholeDay = '*05-29*<br>- 50 пресс<br>~5км';
    const copiedWithLineBreakAndTypo = '*05-29*\n- 50 пресс\n~5км)';
    assert.equal(pipeline.snapMinorAppendToSource({ exampleText: copiedWithLineBreakAndTypo }, wholeDay).chunk, wholeDay);
});

// ============================================================
// Fake-fetch: различает Cutter / Router / minor / ruleUpdate / parse
// ============================================================
//
// Cutter-промпт содержит «нарезщик»; Router — «Router»/«Роутер»; minor — «Минорное»;
// ruleUpdate — «RuleUpdate»; parse (structured) — ни одного из маркеров.
// Каждый spec-ответ может быть: строкой ИЛИ функцией (prompt) => answer —
// для цикла по дням (вердикт Router зависит от дня в {{INPUT}}).
function resolveAnswer(spec, prompt) {
    return (typeof spec === 'function') ? spec(prompt) : (spec ?? '');
}

function routerInputOf(prompt) {
    const marker = /(?:Day|День):\r?\n/.exec(prompt);
    if (!marker) return '';
    return prompt.slice(marker.index + marker[0].length).split(/\r?\n\s*\r?\n/)[0].trim();
}

function makeFetch({ cutter, router, parse, minor, ruleUpdate,
    throwCutter = null, throwRouter = null, throwParse = null, throwMinor = null, throwRuleUpdate = null } = {}) {
    const calls = [];
    const fn = async (url, init = {}) => {
        const body = JSON.parse(init.body || '{}');
        const prompt = (body.messages && body.messages[0] && body.messages[0].content) || '';
        const isCutter = /нарезщик/i.test(prompt);
        const isRouter = !isCutter && /\brouter\b|роутер/i.test(prompt);
        const isMinor = !isCutter && !isRouter && /Минорное/i.test(prompt);
        const isRuleUpdate = !isCutter && !isRouter && !isMinor && /RuleUpdate/i.test(prompt);
        calls.push({ url, prompt, isCutter, isRouter, isMinor, isRuleUpdate });
        if (isCutter && throwCutter) throw throwCutter;
        if (isRouter && throwRouter) throw throwRouter;
        if (isMinor && throwMinor) throw throwMinor;
        if (isRuleUpdate && throwRuleUpdate) throw throwRuleUpdate;
        if (!isCutter && !isRouter && !isMinor && !isRuleUpdate && throwParse) throw throwParse;
        const answer = isCutter ? resolveAnswer(cutter, prompt)
            : isRouter ? resolveAnswer(router, prompt)
                : isMinor ? resolveAnswer(minor, prompt)
                    : isRuleUpdate ? resolveAnswer(ruleUpdate, prompt)
                        : resolveAnswer(parse, prompt);
        return { ok: true, status: 200, json: async () => ({ message: { content: answer } }) };
    };
    fn.calls = calls;
    return fn;
}

/** Ответ Cutter: дни [{raw, date}] в порядке следования. */
function cutterAnswer(days, confidence = 0.9) {
    return JSON.stringify({ status: 'success', payload: { days, confidence }, confidence });
}

/** Ответ Router v9: ОДИН день → ОДНА группа (chunk — реальный текст дня). */
function routerAnswer(group, chunk, reasoning = 'классификация', confidence = 0.9) {
    return JSON.stringify({
        status: 'success',
        payload: { groups: [{ chunk, group, reasoning, confidence }], confidence },
        confidence,
    });
}

/** Ответ parse (массив кандидатов {date, values}). */
function parseAnswer(candidates, status = 'success', confidence = 0.95) {
    return JSON.stringify({ status, payload: candidates, confidence });
}

/** Ответ ruleUpdate (Branch 3, mode_RuleUpdate.md): правило + разделение старое/новое. */
function ruleUpdateAnswer({ semantics = 'новый тип данных', keys = [], oldKeysEvents = [],
    newKeys = [], relations = [], composition = 'single', confidence = 0.85 } = {}) {
    return JSON.stringify({
        status: 'success',
        payload: {
            rule: { semantics, keys, composition },
            oldKeysEvents,
            newKeys,
            relations,
            confidence,
        },
        confidence,
    });
}

/** Ответ minorRuleUpdate (Branch 2): аппенды «ключ → новый пример употребления». */
function minorAnswer(appends, confidence = 0.88) {
    return JSON.stringify({ status: 'success', payload: { appends, confidence }, confidence });
}

// ============================================================
// Temp-лог / tmp / graph.tmp (не трогаем data/rulesLog.json)
// ============================================================

const REAL_LOG_PATH = path.resolve(__dirname, '../docs/testing/fixtures/TC-001-empty-state/rulesLog.json');

function uniqueTestLogPath() {
    const suffix = crypto.randomBytes(8).toString('hex');
    return path.resolve(__dirname, `../data/rulesLog.pipeline.${suffix}.tmp.json`);
}

function pointRulesLogAt(tempPath) {
    const origPath = rulesLog._getLogPath();
    const orig = legacyEmptyRuleLog();
    fs.writeFileSync(tempPath, JSON.stringify(orig, null, 2), 'utf8');
    rulesLog._resetCache();
    rulesLog._setLogPath(tempPath);
    return function restore() {
        rulesLog._resetCache();
        rulesLog._setLogPath(origPath);
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    };
}

function seedTestRulebook(rules) {
    const restore = pointRulesLogAt(uniqueTestLogPath());
    for (const rule of rules || []) rulesLog.appendRule(rule, 'add');
    return restore;
}

function pointRulesTmpAt() {
    const origPath = tmpStore._getRulesTmpPath();
    const suffix = crypto.randomBytes(8).toString('hex');
    const tempPath = path.resolve(__dirname, `../data/rulesLog.pipeline.${suffix}.tmp.json`);
    tmpStore._setRulesTmpPath(tempPath);
    return function restore() {
        tmpStore._setRulesTmpPath(origPath);
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    };
}

function pointGraphTmpAt() {
    const origPath = tmpStore._getGraphTmpPath();
    const suffix = crypto.randomBytes(8).toString('hex');
    const tempPath = path.resolve(__dirname, `../data/graph.pipeline.${suffix}.tmp.json`);
    tmpStore._setGraphTmpPath(tempPath);
    return function restore() {
        tmpStore._setGraphTmpPath(origPath);
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    };
}

// ============================================================
// (а) Branch 1: один день → группа 1 → structured
// ============================================================

test('AC-R1+R2: один день, группа 1 → branch 1, события push_full/push_knee иммутабельны', async () => {
    const restoreLog = seedTestRulebook([{
        id: 'push_rule', raw: '100 отжимания (73+27)',
        mapping: { push_full: 'отжимания обычные', push_knee: 'отжимания с колен' },
        examples: [{ input: '100 отжимания (73+27)', values: { push_full: 73, push_knee: 27 } }],
    }]);
    try {
    const fetch = makeFetch({
        cutter: cutterAnswer([{ raw: '100 отжимания (73+27)', date: '08-29' }]),
        router: routerAnswer(1, '100 отжимания (73+27)', 'знакомое упражнение', 0.95),
        parse: parseAnswer([{ date: DATE, values: { push_full: 73, push_knee: 27 } }]),
    });

    const r = await pipeline.next('100 отжимания (73+27)', { date: DATE, llmOptions: { fetch } });

    assert.equal(r.status, 'success');
    assert.equal(r.branch, 1);
    assert.ok(Array.isArray(r.payload.events) && r.payload.events.length === 1);
    const evt = r.payload.events[0];
    assert.ok(isEvent(evt));
    assert.deepEqual(evt.values, { push_full: 73, push_knee: 27 });
    assert.equal(evt.date, DATE);
    assert.ok(Object.isFrozen(evt) && Object.isFrozen(evt.values));
    assert.throws(() => { evt.values.push_full = 999; }, TypeError);
    assert.ok(r.confidence >= 0 && r.confidence <= 1);
    // Порядок вызовов: cutter → router → parse.
    const kinds = fetch.calls.map((c) => (c.isCutter ? 'cutter' : c.isRouter ? 'router' : c.isMinor ? 'minor' : c.isRuleUpdate ? 'ruleUpdate' : 'parse'));
    assert.deepEqual(kinds, ['cutter', 'router', 'parse']);
    } finally {
        restoreLog();
    }
});

// ============================================================
// (б) ГЛАВНЫЙ СЦЕНАРИЙ TC-001 через ЦИКЛ (канва «Цикл обработки данных»):
//     cutter → 3 дня; день1 router→3 (conflict создаёт правило → кэш!),
//     день2 router ВИДИТ правило дня1 в {{RULES}} → minor;
//     день3 router→1 → structured; события 3 дней в payload.events.
// ============================================================

test('TC-001 (цикл): cutter → 3 дня; правило дня1 видно дню2 в {{RULES}} (tmp-кэш); [3,2,1] → 3 события', async () => {
    const restoreLog = pointRulesLogAt(uniqueTestLogPath());
    const restoreTmp = pointRulesTmpAt();
    const restoreGraphTmp = pointGraphTmpAt();
    try {
        rulesLog.appendRule({ id: 'legacy_sit_rule', raw: 'sit-up', mapping: { sit_full: 'sit-up repetitions' }, examples: [] }, 'add');
        rulesLog.appendRule({
            id: 'legacy_push_rule', raw: '*06-02* 100 отжимания (73+27)',
            mapping: { push_full: 'отжимания обычные', push_knee: 'отжимания с колен' },
            examples: [{ input: '*06-02* 100 отжимания (73+27)', values: { push_full: 73, push_knee: 27 } }],
        }, 'add');
        const day1 = '*05-29* жим лёжа макс 70';
        const day2 = '*05-31* жим лёжа семдесят';
        const day3 = '*06-02* 100 отжимания (73+27)';

        const fetch = makeFetch({
            cutter: cutterAnswer([
                { raw: day1, date: '05-29' },
                { raw: day2, date: '05-31' },
                { raw: day3, date: '06-02' },
            ]),
            // Router: вердикт по дню, найденному в промпте (каждый день — свой вызов).
            // Порядок проверки: день3 → день2 → день1 (raw правила дня1 попадает в
            // {{RULES}} промптов следующих дней — сверяемся по самому свежему дню).
            router: (prompt) => {
                const currentDay = routerInputOf(prompt);
                if (currentDay === day3) return routerAnswer(1, day3, 'повтор формулировки', 0.95);
                if (currentDay === day2) return routerAnswer(2, day2, 'та же суть (правило уже появилось)', 0.9);
                if (currentDay === day1) return routerAnswer(3, day1, 'новое правило', 0.9);
                throw new Error(`неизвестный router-день: ${currentDay}`);
            },
            // day1 → conflict: правило bench_max; старый кусок (sit) — на structured.
            ruleUpdate: ruleUpdateAnswer({
                semantics: 'жим лёжа — макс за подход',
                keys: [{ key: 'bench_max', role: 'stack', meaning: 'жим лёжа, макс' }],
                oldKeysEvents: [
                    { key: 'sit_full', chunk: 'посадка 10', date: '2026-05-29', values: { sit_full: 10 } },
                ],
                newKeys: [
                    { key: 'bench_max', chunk: day1, date: '2026-05-29', values: { bench_max: 70 } },
                ],
            }),
            // day2 → minor: аппенд bench_max → пример.
            minor: minorAnswer([
                { key: 'bench_max', chunk: day2, exampleText: 'жим лёжа семдесят', confidence: 0.9 },
            ]),
            // parse по содержимому куска (старые куски day1 / день2 / день3).
            parse: (prompt) => {
                // Input is the final slot; rules may also contain earlier days as examples.
                const currentInput = prompt.trimEnd();
                if (currentInput.endsWith(day3)) return parseAnswer([{ date: '2026-06-02', values: { push_full: 73, push_knee: 27 } }]);
                if (currentInput.endsWith(day2)) return parseAnswer([{ date: '2026-05-31', values: { bench_max: 70 } }]);
                return parseAnswer([{ date: '2026-05-29', values: { sit_full: 10 } }]);
            },
        });

        const r = await pipeline.next([day1, day2, day3].join('\n'), { date: DATE, llmOptions: { fetch } });

        assert.equal(r.status, 'success', `success: ${r.message || JSON.stringify(r.payload && r.payload.warnings)}`);
        assert.ok(!r.payload.warnings, `без warnings: ${JSON.stringify(r.payload.warnings)}`);

        // Вердикты роутера по дням — как есть: [3, 2, 1].
        assert.deepEqual(
            r.payload.groups.map((g) => g.group),
            [3, 2, 1],
            `группы должны быть [3,2,1], получено ${JSON.stringify(r.payload.groups)}`,
        );
        assert.ok(r.payload.groups.every((g) => g.downgraded === undefined), 'без меток downgraded');
        assert.deepEqual(r.payload.minorChunks, [day2], '05-31 — в minorChunks (Branch 2)');

        // Правило дня1 попало в КЭШ: router-промпты дней 2 и 3 содержат его ключи.
        const routerCalls = fetch.calls.filter((c) => c.isRouter);
        assert.equal(routerCalls.length, 3, 'каждый день — отдельный вызов Router');
        assert.ok(routerCalls[1].prompt.includes('bench_max'),
            'день2: {{RULES}} должен содержать ключ bench_max (правило дня1 из tmp-кэша)');
        assert.ok(routerCalls[2].prompt.includes('bench_max'),
            'день3: {{RULES}} по-прежнему содержит правило дня1');
        assert.ok(routerCalls[2].prompt.includes('bench_max'),
            'день3: проекция правил сохраняет ключ Branch 2');
        assert.ok(routerCalls[2].prompt.includes('жим лёжа семдесят'),
            'day 3 Router projection contains the grounded Branch 2 example from day 2');
        assert.ok(routerCalls[1].prompt.includes(day2),
            'день2: {{INPUT}} содержит свой день');

        // day1 → Branch 3 (conflict), day2 → minor, day3 → parse (structured).
        const ruleUpdateCall = fetch.calls.find((c) => c.isRuleUpdate);
        const minorCall = fetch.calls.find((c) => c.isMinor);
        assert.ok(ruleUpdateCall, 'Branch 3 invokes RuleUpdate');
        assert.ok(minorCall && minorCall.prompt.includes(day2), 'minor вызван для дня2');

        // Аппенды дня2 → rulesLog.tmp.json (temp, INV-2/3); rulesLog.json не тронут.
        const tmpObj = JSON.parse(fs.readFileSync(tmpStore._getRulesTmpPath(), 'utf8'));
        assert.ok(tmpObj.newKeys.some((nk) => nk.key === 'bench_max' && nk.source === 'minorRuleUpdate'));

        // События 3 дней в payload.events: day1 (старые куски), day2 (повторный structured), day3.
        assert.ok(Array.isArray(r.payload.events) && r.payload.events.length === 3,
            `3 события в payload, есть: ${r.payload.events && r.payload.events.length}`);
        assert.deepEqual(r.payload.events.map((event) => event.date), [
            '2026-05-29', '2026-05-31', '2026-06-02',
        ], 'preview сохраняет порядок дат исходного ввода между разными ветками');
        assert.ok(r.payload.rule, 'правило Branch 3 (день1) присутствует');
        assert.ok(r.payload.appends && r.payload.appends.length === 1);

        const order = fetch.calls.map((c) => (c.isCutter ? 'cutter' : c.isRouter ? 'router' : c.isMinor ? 'minor' : c.isRuleUpdate ? 'ruleUpdate' : 'parse'));
        assert.deepEqual(order, ['cutter', 'router', 'ruleUpdate', 'parse', 'router', 'minor', 'parse', 'router', 'parse'],
            `порядок вызовов: ${order.join(',')}`);
    } finally {
        restoreGraphTmp();
        restoreTmp();
        restoreLog();
    }
});

// ============================================================
// (в) Branch 3: один день → правило + пример-отрисовка, branch 2
// ============================================================

test('AC-R1+R3: день «пресс 40» → группа 3 → branch 2, payload {rule, exampleEvents, proposal}', async () => {
    const restoreGraphTmp = pointGraphTmpAt();
    try {
        const fetch = makeFetch({
            cutter: cutterAnswer([{ raw: 'пресс 40', date: null }]),
            router: routerAnswer(3, 'пресс 40', 'новое', 0.85),
            ruleUpdate: ruleUpdateAnswer({
                semantics: 'пресс — количество повторений за подход',
                keys: [{ key: 'press_full', role: 'stack' }],
                newKeys: [{ key: 'press_full', chunk: 'пресс 40', date: DATE, values: { press_full: 40 } }],
            }),
        });
        const r = await pipeline.next('пресс 40', { date: DATE, llmOptions: { fetch } });

        assert.equal(r.status, 'success');
        assert.equal(r.branch, 2);
        const { rule, exampleEvents, proposal } = r.payload;
        assert.ok(rule && rule.id && typeof rule.raw === 'string');
        assert.equal(rule.raw, 'пресс 40');
        assert.deepEqual(rule.mapping, { press_full: 'press_full' });
        assert.ok(Array.isArray(exampleEvents) && exampleEvents.length >= 1);
        assert.ok(isEvent(exampleEvents[0]) && Object.isFrozen(exampleEvents[0]));
        assert.equal(exampleEvents[0].values.press_full, 40);
        assert.ok(proposal && proposal.rule === rule);
    } finally {
        restoreGraphTmp();
    }
});

// ============================================================
// (г) Branch 2: minor → аппенд в rulesLog.tmp.json + повторный structured
// ============================================================

test('Branch 2: день группы 2 → аппенд в rulesLog.tmp.json, повторный parse видит пример (INV-2/3)', async () => {
    const tmpLogPath = uniqueTestLogPath();
    const restoreLog = pointRulesLogAt(tmpLogPath);
    // Сид: правило с ключом press_full в словаре — minor-аппенд уточняет СУЩЕСТВУЮЩИЙ
    // ключ (фикс раунда 2: аппенды с key вне словаря актуальных правил отбрасываются).
    const seeded = { version: 1, entries: [{ version: 1, timestamp: new Date().toISOString(), changeType: 'seed', rulesSnapshot: { version: 1, dynamic: [{ id: 'rule_001', raw: 'пресс 30', mapping: { press_full: 'пресс, повторения' }, examples: [{ input: 'жим от груди тридцать раз', values: { press_full: 30 } }] }], global: [] }, meta: { proposedBy: 'seed' } }] };
    fs.writeFileSync(tmpLogPath, JSON.stringify(seeded, null, 2), 'utf8');
    rulesLog._resetCache();
    const restoreTmp = pointRulesTmpAt();
    const tmpPath = tmpStore._getRulesTmpPath();
    const mainLogBefore = fs.readFileSync(REAL_LOG_PATH, 'utf8');
    try {
        const parsePrompts = [];
        const base = makeFetch({
            cutter: cutterAnswer([{ raw: 'жим от груди сорок раз', date: '08-29' }]),
            router: routerAnswer(2, 'жим от груди сорок раз', 'другая формулировка', 0.9),
            minor: minorAnswer([
                { key: 'press_full', chunk: 'жим от груди сорок раз', exampleText: 'жим от груди сорок раз', confidence: 0.88 },
            ]),
            parse: parseAnswer([{ date: DATE, values: { press_full: 40 } }]),
        });
        const fetch = async (url, init = {}) => {
            const body = JSON.parse(init.body || '{}');
            const prompt = (body.messages && body.messages[0] && body.messages[0].content) || '';
            if (!/нарезщик|\brouter\b|роутер|Минорное|RuleUpdate/i.test(prompt)) parsePrompts.push(prompt);
            return base(url, init);
        };

        const r = await pipeline.next('жим от груди сорок раз', { date: DATE, llmOptions: { fetch } });

        assert.equal(r.status, 'success');
        assert.ok(Array.isArray(r.payload.appends) && r.payload.appends.length === 1);
        assert.equal(r.payload.appends[0].key, 'press_full');
        assert.ok(Array.isArray(r.payload.events) && r.payload.events.length === 1,
            'повторный structured группы 2 дал событие');
        // Повторный parse получил дополненный словарь (main ∪ tmp).
        assert.equal(parsePrompts.length, 1);
        assert.ok(parsePrompts[0].includes('жим от груди сорок раз'), 'пример употребления в промпте parse');
        // Аппенд дописан в rulesLog.tmp.json.
        assert.ok(fs.existsSync(tmpPath));
        const tmpObj = JSON.parse(fs.readFileSync(tmpPath, 'utf8'));
        assert.ok(tmpObj.newKeys.some((nk) => nk.key === 'press_full'));
        // INV-2/3: main rulesLog.json НЕ тронут.
        assert.equal(fs.readFileSync(REAL_LOG_PATH, 'utf8'), mainLogBefore);
    } finally {
        restoreTmp();
        restoreLog();
    }
});

// ============================================================
// (д) Cutter: сбой нарезки → fallback «весь ввод одним днём», не роняет прогон
// ============================================================

test('Cutter: сбой нарезки → warning, ввод идёт одним днём (Branch 1 жив)', async () => {
    const restoreLog = seedTestRulebook([{
        id: 'push_rule', raw: '100 отжимания (73+27)',
        mapping: { push_full: 'отжимания обычные', push_knee: 'отжимания с колен' },
        examples: [{ input: '100 отжимания (73+27)', values: { push_full: 73, push_knee: 27 } }],
    }]);
    try {
    const fetch = makeFetch({
        throwCutter: new Error('cutter LLM упал'),
        router: routerAnswer(1, '100 отжимания (73+27)', 'знакомое', 0.9),
        parse: parseAnswer([{ date: DATE, values: { push_full: 73, push_knee: 27 } }]),
    });
    const r = await pipeline.next('100 отжимания (73+27)', { date: DATE, llmOptions: { fetch } });
    assert.equal(r.status, 'success');
    assert.equal(r.branch, 1);
    assert.ok(Array.isArray(r.payload.events) && r.payload.events.length === 1);
    assert.ok(r.payload.warnings.some((w) => /Cutter/.test(w)));
    } finally {
        restoreLog();
    }
});

// ============================================================
// (е) Ошибка одного дня НЕ роняет остальные
// ============================================================

test('Цикл: сбой Branch 1 дня1 → warning, день2 обрабатывается', async () => {
    const restoreGraphTmp = pointGraphTmpAt();
    try {
        const day1 = '*05-29* день один';
        const day2 = '*05-31* день два';
        const fetch = makeFetch({
            cutter: cutterAnswer([{ raw: day1, date: '05-29' }, { raw: day2, date: '05-31' }]),
            router: (prompt) => {
                if (prompt.includes(day1)) return routerAnswer(1, day1);
                return routerAnswer(1, day2);
            },
            throwParse: new Error('parse LLM упал'),
        });
        const r = await pipeline.next(`${day1}\n${day2}`, { date: DATE, llmOptions: { fetch } });
        assert.equal(r.status, 'error', 'оба дня не дали событий → error-контракт');
        assert.ok(!('payload' in r) || r.payload === null);
    } finally {
        restoreGraphTmp();
    }
});

test('Цикл: сбой parse дня1 (гр.1) → warning, день2 (гр.1) даёт события', async () => {
    const restoreLog = seedTestRulebook([{
        id: 'days_rule', raw: '*05-29* день один',
        mapping: { push_full: 'упражнение' },
        examples: [
            { input: '*05-29* день один', values: { push_full: 40 } },
            { input: '*05-31* день два', values: { push_full: 50 } },
        ],
    }]);
    try {
    const day1 = '*05-29* день один';
    const day2 = '*05-31* день два';
    let parseCalls = 0;
    const base = makeFetch({
        cutter: cutterAnswer([{ raw: day1, date: '05-29' }, { raw: day2, date: '05-31' }]),
        router: (prompt) => {
            const currentDay = routerInputOf(prompt);
            return routerAnswer(1, currentDay === day1 ? day1 : day2);
        },
        parse: (prompt) => {
            parseCalls++;
            if (prompt.trimEnd().endsWith(day1)) return JSON.stringify({ status: 'error', payload: null, confidence: 0 });
            return parseAnswer([{ date: '2026-05-31', values: { push_full: 50 } }]);
        },
    });
    const r = await pipeline.next(`${day1}\n${day2}`, { date: DATE, llmOptions: { fetch: base } });
    assert.equal(r.status, 'success', `сбой дня1 не роняет день2: ${r.message || ''}`);
    assert.ok(Array.isArray(r.payload.events) && r.payload.events.length === 1, 'событие только дня2');
    assert.ok(Array.isArray(r.payload.warnings) && r.payload.warnings.some((w) => /День 1/.test(w)),
        `warning по дню1: ${JSON.stringify(r.payload.warnings)}`);
    assert.deepEqual(r.payload.groups.map((g) => g.group), [1, 1]);
    } finally {
        restoreLog();
    }
});

// ============================================================
// (ж) AC-R4: confirm (Rule Evolution)
// ============================================================

test('AC-R4: pipeline.confirm записывает правило в лог (appendRule), версия +1', async () => {
    const tempPath = uniqueTestLogPath();
    const restore = pointRulesLogAt(tempPath);
    try {
        const beforeVersion = rulesLog.getVersion();

        const fetch = makeFetch({
            cutter: cutterAnswer([{ raw: 'пресс 40', date: null }]),
            router: routerAnswer(3, 'пресс 40', 'пресс', 0.9),
            ruleUpdate: ruleUpdateAnswer({
                keys: [{ key: 'press_full', role: 'stack' }],
                newKeys: [{ key: 'press_full', chunk: 'пресс 40', date: DATE, values: { press_full: 40 } }],
            }),
        });
        const r = await pipeline.next('пресс 40', { date: DATE, llmOptions: { fetch } });
        assert.equal(r.status, 'success');
        assert.equal(r.branch, 2);

        const confirmRes = await pipeline.confirm(r.payload.proposal, { meta: { test: true } });
        assert.equal(confirmRes.status, 'success');
        assert.equal(confirmRes.branch, 2);
        assert.equal(confirmRes.payload.entry.changeType, 'add');
        assert.equal(confirmRes.payload.version, beforeVersion + 1);
        assert.equal(rulesLog.getVersion(), beforeVersion + 1);
        const latest = rulesLog.getLatestRules();
        const added = [...latest.dynamic, ...latest.global]
            .find((x) => x && x.mapping && x.mapping.press_full === 'press_full');
        assert.ok(added, 'правило press должно попасть в правила отрисовки (лог)');
    } finally {
        restore();
    }
});

test('AC-R4: confirm невалидного правила → {status:error}, не бросает', async () => {
    const tempPath = uniqueTestLogPath();
    const restore = pointRulesLogAt(tempPath);
    try {
        const beforeVersion = rulesLog.getVersion();
        const res = await pipeline.confirm({ rule: { id: 'rule_bad', when: { pattern: 'x' } } });
        assert.equal(res.status, 'error');
        assert.equal(rulesLog.getVersion(), beforeVersion, 'версия не должна измениться при сбое confirm');
    } finally {
        restore();
    }
});

// ============================================================
// (з) Транспорт LLM (retry/таймаут/причина ошибки)
// ============================================================

const { chat } = require('../adapters/llm.js');
const { proposeRule } = require('../core/conflict.js');

test('LLM transport: retry — fake-fetch падает 1 раз, второй вызов → success', async () => {
    let calls = 0;
    const flakyFetch = async () => {
        calls++;
        if (calls === 1) throw new Error('ECONNREFUSED (Ollama занята)');
        return { ok: true, status: 200, json: async () => ({ message: { content: JSON.stringify({ status: 'success', payload: { ok: true }, confidence: 0.5 }) } }) };
    };
    const res = await chat('привет', 'parse', { fetch: flakyFetch, retryDelays: [1, 1] });
    assert.equal(res.status, 'success');
    assert.equal(calls, 2);
});

test('LLM transport: 5xx ретраится (3 попытки, причина), 4xx — нет', async () => {
    let calls = 0;
    const busyFetch = async () => { calls++; return { ok: false, status: 503 }; };
    const res = await chat('привет', 'parse', { fetch: busyFetch, retryDelays: [1, 1] });
    assert.equal(res.status, 'error');
    assert.equal(calls, 3);
    assert.equal(res.error, 'HTTP 503');

    let calls4xx = 0;
    const badFetch = async () => { calls4xx++; return { ok: false, status: 400 }; };
    const res4xx = await chat('привет', 'parse', { fetch: badFetch, retryDelays: [1, 1] });
    assert.equal(res4xx.status, 'error');
    assert.equal(calls4xx, 1);
    assert.equal(res4xx.error, 'HTTP 400');
});

// ============================================================
// (з) AC10/INV: next() не пишет rulesLog.json; события иммутабельны;
//     инварианты/stage-колбэк/helpers
// ============================================================

test('AC10/INV: next() не пишет на диск (rulesLog.json не меняется), оверлей не переживает прогон в main', async () => {
    const tempPath = uniqueTestLogPath();
    const restore = pointRulesLogAt(tempPath);
    try {
        rulesLog.appendRule({
            id: 'push_rule', raw: '100 отжимания (73+27)',
            mapping: { push_full: 'отжимания обычные', push_knee: 'отжимания с колен' },
            examples: [{ input: '100 отжимания (73+27)', values: { push_full: 73, push_knee: 27 } }],
        }, 'add');
        const logBefore = fs.readFileSync(tempPath, 'utf8');
        const fetch1 = makeFetch({
            cutter: cutterAnswer([{ raw: '100 отжимания (73+27)', date: '08-29' }]),
            router: routerAnswer(1, '100 отжимания (73+27)', 'отжимания', 0.9),
            parse: parseAnswer([{ date: DATE, values: { push_full: 73, push_knee: 27 } }]),
        });
        const r1 = await pipeline.next('100 отжимания (73+27)', { date: DATE, llmOptions: { fetch: fetch1 } });
        assert.equal(r1.status, 'success');
        assert.equal(r1.branch, 1);

        const fetch2 = makeFetch({
            cutter: cutterAnswer([{ raw: 'пресс 40', date: null }]),
            router: routerAnswer(3, 'пресс 40', 'пресс', 0.9),
            ruleUpdate: ruleUpdateAnswer({
                keys: [{ key: 'press_full', role: 'stack' }],
                newKeys: [{ key: 'press_full', chunk: 'пресс 40', date: DATE, values: { press_full: 40 } }],
            }),
        });
        const r2 = await pipeline.next('пресс 40', { date: DATE, llmOptions: { fetch: fetch2 } });
        assert.equal(r2.status, 'success');
        assert.equal(r2.branch, 2);

        // next() не должен писать лог (ни main, ни temp-копию).
        assert.equal(fs.readFileSync(tempPath, 'utf8'), logBefore, 'next() не пишет rulesLog.json');
        // Но оверлей Branch 3 остаётся в КЭШЕ (temp-слой, живёт до Save);
        // в main-логе правила нет, а кэш-копия помечена tmp_.
        const latest = rulesLog.getLatestRules();
        const overlayRule = [...latest.dynamic, ...latest.global]
            .find((x) => x && x.mapping && x.mapping.press_full);
        assert.ok(overlayRule && String(overlayRule.id).startsWith('tmp_'),
            'правило Branch 3 в кэше под tmp_-id (не в main-логе)');

        const evt = r1.payload.events[0];
        assert.ok(Object.isFrozen(evt) && Object.isFrozen(evt.values));
        assert.throws(() => { evt.date = '2000-01-01'; }, TypeError);
    } finally {
        restore();
    }
});

test('helpers: normalizeConfidence зажимает в [0,1], нечисло → 0', () => {
    assert.equal(pipeline.normalizeConfidence(2), 1);
    assert.equal(pipeline.normalizeConfidence(-1), 0);
    assert.equal(pipeline.normalizeConfidence(0.55), 0.55);
    assert.equal(pipeline.normalizeConfidence('x'), 0);
});

test('LX: onStage — cutter → router → structured (branch 1)', async () => {
    const restoreLog = seedTestRulebook([{
        id: 'push_rule', raw: '100 отжимания (73+27)',
        mapping: { push_full: 'отжимания обычные', push_knee: 'отжимания с колен' },
        examples: [{ input: '100 отжимания (73+27)', values: { push_full: 73, push_knee: 27 } }],
    }]);
    try {
    const stages = [];
    const fetch = makeFetch({
        cutter: cutterAnswer([{ raw: '100 отжимания (73+27)', date: '08-29' }]),
        router: routerAnswer(1, '100 отжимания (73+27)', 'отжимания', 0.9),
        parse: parseAnswer([{ date: DATE, values: { push_full: 73, push_knee: 27 } }]),
    });
    const r = await pipeline.next('100 отжимания (73+27)', {
        date: DATE,
        llmOptions: { fetch },
        onStage: (key) => stages.push(key),
    });
    assert.equal(r.status, 'success');
    assert.equal(r.branch, 1);
    assert.deepEqual(stages, [pipeline.STAGES.CUTTER, pipeline.STAGES.ROUTER, pipeline.STAGES.STRUCTURED]);
    assert.ok(pipeline.stageTextOf(pipeline.STAGES.CUTTER).length > 0);
    } finally {
        restoreLog();
    }
});

test('LX: stageTextOf — человекочитаемые подписи стадий', () => {
    assert.equal(pipeline.stageTextOf(pipeline.STAGES.ROUTER),
        'Просматриваем данные и определяем тип обработки…');
    assert.equal(pipeline.stageTextOf(pipeline.STAGES.STRUCTURED),
        'Переводим данные в события (существующие и новые сущности)…');
    assert.equal(pipeline.stageTextOf(pipeline.STAGES.CONFLICT),
        'Формируем новое правило отрисовки…');
    assert.equal(pipeline.stageTextOf('nope', 'Обработка…'), 'Обработка…');
});

test('AC10: пайплайн НЕ мутирует вход и baseEvents (если дан)', async () => {
    const restoreLog = seedTestRulebook([{
        id: 'push_rule', raw: '100 отжимания (73+27)',
        mapping: { push_full: 'отжимания обычные', push_knee: 'отжимания с колен' },
        examples: [{ input: '100 отжимания (73+27)', values: { push_full: 73, push_knee: 27 } }],
    }]);
    try {
    const fetch = makeFetch({
        cutter: cutterAnswer([{ raw: '100 отжимания (73+27)', date: '08-29' }]),
        router: routerAnswer(1, '100 отжимания (73+27)', 'отжимания', 0.9),
        parse: parseAnswer([{ date: DATE, values: { push_full: 73, push_knee: 27 } }]),
    });
    const input = '100 отжимания (73+27)';
    const snapshot = input + '';
    const baseEvents = [{ date: DATE, values: Object.freeze({ push_full: 70 }) }];
    const baseSnapshot = JSON.stringify(baseEvents);
    const r = await pipeline.next(input, { date: DATE, baseEvents, llmOptions: { fetch } });
    assert.equal(r.status, 'success');
    assert.equal(input, snapshot, 'вход не должен мутироваться');
    assert.equal(JSON.stringify(baseEvents), baseSnapshot, 'baseEvents не должен мутироваться');
    } finally {
        restoreLog();
    }
});

test('pipeline: неверный Router chunk останавливает весь прогон без частичного preview', async () => {
    const restoreLog = seedTestRulebook([{
        id: 'press_rule', raw: '*08-29* пресс 40',
        mapping: { press_reps: 'пресс, повторения' },
        examples: [{ input: '*08-29* пресс 40', values: { press_reps: 40 } }],
    }]);
    const restoreTmp = pointRulesTmpAt();
    const restoreGraphTmp = pointGraphTmpAt();
    try {
        const day1 = '*08-29* пресс 40';
        const day2 = '*08-30* максимум 8';
        const fetch = makeFetch({
            cutter: cutterAnswer([
                { raw: day1, date: '08-29' },
                { raw: day2, date: '08-30' },
            ]),
            router: (prompt) => prompt.includes(day1)
                ? routerAnswer(1, day1)
                : routerAnswer(1, `эхо промпта: ${day2}`),
            parse: parseAnswer([{ date: '2026-08-29', values: { press_reps: 40 } }]),
        });

        const result = await pipeline.next(`${day1} | ${day2}`, {
            date: DATE,
            llmOptions: { fetch },
        });

        assert.equal(result.status, 'error');
        assert.equal(result.payload, null, 'не отдавать события первого дня как частичное превью');
        assert.match(result.message, /день 2:.*chunk.*не совпадает/i);
        assert.deepEqual(result.message.includes(day2), false);
        assert.equal(fetch.calls.filter((call) => !call.isCutter && !call.isRouter && !call.isMinor && !call.isRuleUpdate).length, 1,
            'после нарушения Router-контракта следующий узел не запускается');
    } finally {
        restoreGraphTmp();
        restoreTmp();
        restoreLog();
    }
});

test('Branch 3: old-key Structured reuses the pre-update vocabulary and Cutter date', async () => {
    const restoreLog = pointRulesLogAt(uniqueTestLogPath());
    const restoreTmp = pointRulesTmpAt();
    const restoreGraph = pointGraphTmpAt();
    try {
        rulesLog.appendRule({
            id: 'rule_001',
            raw: 'press 100',
            mapping: { press_reps: 'repetitions' },
            examples: [{ input: 'press 100', output: { press_reps: 100 } }],
        }, 'add');
        const day = '*07-21* press 100, max 32';
        const fetch = makeFetch({
            cutter: cutterAnswer([{ raw: day, date: '07-21' }]),
            router: routerAnswer(3, day),
            ruleUpdate: ruleUpdateAnswer({
                keys: [{ key: 'press_max_set', meaning: 'maximum repetitions in one set' }],
                oldKeysEvents: [{ key: 'press_reps', chunk: 'press 100', date: '2024-07-21', values: { press_reps: 100 } }],
                newKeys: [{ key: 'press_max_set', chunk: day, values: { press_max_set: 32 } }],
                relations: [{ type: 'overlay', base: 'press_reps', sub: 'press_max_set' }],
            }),
            // Omit date to verify that the Cutter's date, not run-level fallback, is used.
            parse: parseAnswer([{ values: { press_reps: 100 } }]),
        });
        const result = await pipeline.next(day, { date: '2026-07-17', llmOptions: { fetch } });
        assert.equal(result.status, 'success');
        assert.equal(result.payload.events.length, 1);
        assert.equal(result.payload.events[0].date, '2026-07-21');
        assert.deepEqual(result.payload.events[0].values, { press_reps: 100, press_max_set: 32 });
        const parseCall = fetch.calls.find((call) => !call.isCutter && !call.isRouter && !call.isMinor && !call.isRuleUpdate);
        assert.ok(parseCall);
        assert.ok(parseCall.prompt.includes('press_reps'));
        assert.ok(!parseCall.prompt.includes('press_max_set'), 'старые значения не читаются по уже обновлённому словарю');
    } finally {
        restoreGraph();
        restoreTmp();
        restoreLog();
    }
});

test('Branch 3: conflicting old-key model views stop the preview instead of choosing one', async () => {
    const restoreLog = pointRulesLogAt(uniqueTestLogPath());
    const restoreTmp = pointRulesTmpAt();
    const restoreGraph = pointGraphTmpAt();
    try {
        rulesLog.appendRule({
            id: 'rule_001', raw: 'press 100', mapping: { press_reps: 'repetitions' },
            examples: [{ input: 'press 100', output: { press_reps: 100 } }],
        }, 'add');
        const day = '*07-21* press 100, max 32';
        const fetch = makeFetch({
            cutter: cutterAnswer([{ raw: day, date: '07-21' }]),
            router: routerAnswer(3, day),
            ruleUpdate: ruleUpdateAnswer({
                keys: [{ key: 'press_max_set', meaning: 'maximum repetitions in one set' }],
                oldKeysEvents: [{ key: 'press_reps', chunk: 'press 100', date: '07-21', values: { press_reps: 100 } }],
                newKeys: [{ key: 'press_max_set', chunk: day, values: { press_max_set: 32 } }],
            }),
            parse: parseAnswer([{ values: { press_reps: 32 } }]),
        });
        const result = await pipeline.next(day, { date: '2026-07-17', llmOptions: { fetch } });
        assert.equal(result.status, 'error');
        assert.match(result.message, /противоречивые значения в превью/);
        assert.match(result.message, /2026-07-21\/press_reps/);
    } finally {
        restoreGraph();
        restoreTmp();
        restoreLog();
    }
});

test('mixed-branch preview: Branch 3 example и Branch 1/2 события объединяются по дате', () => {
    const merged = pipeline.mergePreviewEvents([
        { date: DATE, values: { press_reps: 50 }, interpretation_version: 1, createdAt: 'a' },
        { date: DATE, values: { squat_reps: 50 }, interpretation_version: 1, createdAt: 'b' },
        { date: '2026-08-30', values: { press_reps: 55 }, interpretation_version: 2, createdAt: 'c' },
    ]);
    assert.deepEqual(merged.conflicts, []);
    assert.equal(merged.events.length, 2);
    assert.deepEqual(merged.events[0].values, { press_reps: 50, squat_reps: 50 });
    assert.deepEqual(merged.events[1].values, { press_reps: 55 });
});

test('mixed-branch preview: несовпадающие значения не разрешаются кодом', () => {
    const merged = pipeline.mergePreviewEvents([
        { date: DATE, values: { press_reps: 50 }, interpretation_version: 1, createdAt: 'a' },
        { date: DATE, values: { press_reps: 55 }, interpretation_version: 1, createdAt: 'b' },
    ]);
    assert.deepEqual(merged.conflicts, [{ date: DATE, key: 'press_reps', values: [50, 55] }]);
});

test('Save preparation: minor example stores the measured pair under its existing rule', () => {
    const rules = [{ id: 'rule_001', mapping: { push_reps: 'base', push_knees_reps: 'knees' },
        examples: [{ input: 'старый пример', values: { push_reps: 20, push_knees_reps: 30 } }] }];
    const merged = pipeline.mergeMinorExamplesIntoRules(rules,
        [{ key: 'push_reps', exampleText: 'новый пример', date: '05-31' }],
        [{ date: '2026-05-31', values: { push_reps: 10, push_knees_reps: 40 } }],
        [{ type: 'A+B', base: 'push_reps', parts: ['push_knees_reps'], stackOrder: ['push_reps', 'push_knees_reps'] }]);
    assert.deepEqual(merged[0].examples[1], {
        input: 'новый пример', values: { push_reps: 10, push_knees_reps: 40 },
    });
    assert.equal(rules[0].examples.length, 1, 'исходное правило не мутируется');
});
