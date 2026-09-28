'use strict';
// tests/tc001-pipeline-fixes.test.js — эталоны TC-001/TC-002 под новой архитектурой
// (2026-09-04: cutter → цикл дней; сквозная оценка — через tmp-кэш, не через промпт).
//
// Проверяется:
//   (а) цикл: день1 (гр.3, conflict) создаёт правило → оно в tmp-кэше → день2 (гр.2,
//       minor) видит его в {{RULES}}; день3 (гр.1) → structured;
//   (б) commitRules branch-1 строит правило {id, raw, mapping, examples} —
//       без semantics/roles/cues, примеры по формулировке БЕЗ даты.

const test = require('node:test');
const { beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('node:os');
const crypto = require('crypto');

const pipeline = require('../core/pipeline.js');
const rulesLog = require('../core/rulesLog.js');
const tmpStore = require('../adapters/tmpStore.js');

beforeEach((t) => {
    const originalPath = tmpStore._getRulesTmpPath();
    const originalGraphTmpPath = tmpStore._getGraphTmpPath();
    const originalGraphPath = pipeline._getGraphFsPath();
    const prefix = 'training-tc001-rules-tmp-';
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    const resolvedDir = path.resolve(tempDir);
    if (!resolvedDir.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`)
        || !path.basename(resolvedDir).startsWith(prefix)) {
        throw new Error(`Unsafe isolated rules temp path: ${resolvedDir}`);
    }
    const tempPath = path.join(resolvedDir, 'rulesLog.tmp.json');
    const graphTmpPath = path.join(resolvedDir, 'graph.tmp.json');
    const graphPath = path.join(resolvedDir, 'graph.json');
    tmpStore._setRulesTmpPath(tempPath);
    tmpStore._setGraphTmpPath(graphTmpPath);
    pipeline._setGraphFsPath(graphPath);
    t.after(() => {
        tmpStore._setRulesTmpPath(originalPath);
        tmpStore._setGraphTmpPath(originalGraphTmpPath);
        pipeline._setGraphFsPath(originalGraphPath);
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
        if (fs.existsSync(graphTmpPath)) fs.unlinkSync(graphTmpPath);
        if (fs.existsSync(graphPath)) fs.unlinkSync(graphPath);
        fs.rmdirSync(resolvedDir);
    });
});

const DATE = '2026-05-29';
const REAL_LOG_PATH = path.resolve(__dirname, '../data/defaults/rulesLog.json');

// ============================================================
// Fake-fetch: Cutter / Router / minor / ruleUpdate / parse по промпту.
// Ответы-функции получают prompt (для цикла по дням).
// ============================================================
function resolveAnswer(spec, prompt) {
    return (typeof spec === 'function') ? spec(prompt) : (spec ?? '');
}
function makeFetch({ cutter, router, parse, minor, ruleUpdate, throwMinor = null } = {}) {
    const calls = [];
    const fn = async (url, init = {}) => {
        const body = JSON.parse(init.body || '{}');
        const prompt = (body.messages && body.messages[0] && body.messages[0].content) || '';
        const isCutter = /нарезщик/i.test(prompt);
        const isRouter = !isCutter && /(?:Роутер|Router)/i.test(prompt);
        const isMinor = !isCutter && !isRouter && /Минорное/i.test(prompt);
        const isRuleUpdate = !isCutter && !isRouter && !isMinor && /RuleUpdate/i.test(prompt);
        calls.push({ url, prompt, isCutter, isRouter, isMinor, isRuleUpdate });
        if (isMinor && throwMinor) throw throwMinor;
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

const cutterAnswer = (days, confidence = 0.9) =>
    JSON.stringify({ status: 'success', payload: { days, confidence }, confidence });
const routerAnswer = (group, chunk, confidence = 0.9) =>
    JSON.stringify({ status: 'success', payload: { groups: [{ chunk, group, reasoning: 'TC', confidence }], confidence }, confidence });
const parseAnswer = (candidates, confidence = 0.95) =>
    JSON.stringify({ status: 'success', payload: candidates, confidence });
const ruleUpdateAnswer = ({ keys = [], newKeys = [], oldKeysEvents = [] } = {}) =>
    JSON.stringify({
        status: 'success',
        confidence: 0.85,
        payload: {
            rule: { semantics: 'новое упражнение', keys, composition: 'single' },
            oldKeysEvents,
            newKeys,
            relations: [],
            confidence: 0.85,
        },
    });
const minorAnswer = (appends, confidence = 0.88) =>
    JSON.stringify({ status: 'success', payload: { appends, confidence }, confidence });

// ============================================================
// Temp-лог / tmp (не трогаем data/rulesLog.json)
// ============================================================
function pointRulesLogAt() {
    const suffix = crypto.randomBytes(8).toString('hex');
    const tempPath = path.resolve(__dirname, `../data/rulesLog.tc001.${suffix}.tmp.json`);
    const origPath = rulesLog._getLogPath();
    const orig = JSON.parse(fs.readFileSync(REAL_LOG_PATH, 'utf8'));
    fs.writeFileSync(tempPath, JSON.stringify(orig, null, 2), 'utf8');
    rulesLog._resetCache();
    rulesLog._setLogPath(tempPath);
    return function restore() {
        rulesLog._resetCache();
        rulesLog._setLogPath(origPath);
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    };
}
function pointRulesTmpAt() {
    const origPath = tmpStore._getRulesTmpPath();
    const suffix = crypto.randomBytes(8).toString('hex');
    const tempPath = path.resolve(__dirname, `../data/rulesLog.tc001tmp.${suffix}.tmp.json`);
    tmpStore._setRulesTmpPath(tempPath);
    return function restore() {
        tmpStore._setRulesTmpPath(origPath);
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    };
}

// ============================================================
// (1) ЭТАЛОН TC-001: [день1→гр.3, день2→гр.2, день3→гр.1] —
//     день 05-31 идёт в Branch 2 (minor); правило дня1 в {{RULES}} дня2 (tmp-кэш).
// ============================================================
test('TC-001: [3,2,1] через цикл — minor для 05-31, правило дня1 видно дню2 и дню3 в {{RULES}}', async () => {
    const restoreLog = pointRulesLogAt();
    const restoreTmp = pointRulesTmpAt();
    try {
        rulesLog.appendRule({ id: 'legacy_sit_rule', raw: 'sit-up', mapping: { sit_full: 'sit-up repetitions' }, examples: [] }, 'add');
        rulesLog.appendRule({
            id: 'legacy_push_rule', raw: '100 отжимания (73+27)',
            mapping: { push_full: 'обычные отжимания', push_knee: 'отжимания с колен' },
            examples: [{ input: '100 отжимания (73+27)', values: { push_full: 73, push_knee: 27 } }],
        }, 'add');
        const day1 = '*05-29* жим лёжа макс 70';
        const day2 = '*05-31* жим лёжа семдесят';
        const day3 = '*06-02* 100 отжимания (73+27)';
        function ruleAns(group, chunk) {
            return JSON.stringify({ status: 'success', payload: { groups: [{ chunk, group, reasoning: 'TC', confidence: 0.9 }], confidence: 0.9 }, confidence: 0.9 });
        }
        const fetch = makeFetch({
            cutter: cutterAnswer([{ raw: day1, date: '05-29' }, { raw: day2, date: '05-31' }, { raw: day3, date: '06-02' }]),
            router: (prompt) => {
                if (prompt.includes(day3)) return ruleAns(1, day3);
                if (prompt.includes(day2)) return ruleAns(2, day2);
                return ruleAns(3, day1);
            },
            ruleUpdate: ruleUpdateAnswer({
                keys: [{ key: 'bench_full', role: 'stack', meaning: 'жим лёжа, макс' }],
                newKeys: [{ key: 'bench_full', chunk: day1, date: '2026-05-29', values: { bench_full: 70 } }],
                oldKeysEvents: [{ key: 'sit_full', chunk: 'посадка 5', date: '2026-05-29', values: { sit_full: 5 } }],
            }),
            minor: minorAnswer([
                { key: 'bench_full', chunk: day2, exampleText: 'жим лёжа семдесят', confidence: 0.9 },
            ]),
            parse: (prompt) => {
                // Не ищем по всему промпту: предыдущие правила и примеры
                // могут повторять слова другого дня.
                const currentInput = prompt.slice(-300);
                if (currentInput.includes(day3)) return parseAnswer([{ date: '2026-06-02', values: { push_full: 73, push_knee: 27 } }]);
                if (currentInput.includes(day2)) return parseAnswer([{ date: '2026-05-31', values: { bench_full: 70 } }]);
                return parseAnswer([{ date: '2026-05-29', values: { sit_full: 5 } }]);
            },
        });

        const r = await pipeline.next([day1, day2, day3].join('\n'), {
            date: DATE, llmOptions: { fetch },
        });

        assert.equal(r.status, 'success', `success: ${r.message || JSON.stringify(r.payload && r.payload.warnings)}`);
        // Вердикты по дням — как есть [3,2,1], без меток downgraded.
        assert.deepEqual(r.payload.groups.map((g) => g.group), [3, 2, 1]);
        assert.ok(r.payload.groups.every((g) => g.downgraded === undefined));
        // minorChunks содержит день 05-31 → Branch 2 запущен.
        assert.deepEqual(r.payload.minorChunks, [day2]);
        const minorCall = fetch.calls.find((c) => c.isMinor);
        assert.ok(minorCall, 'minorRuleUpdate (Branch 2) должен быть вызван');
        // minor выполняется ПОСЛЕ Branch 3 дня1 (овере правил предыдущих дней в кэше).
        const ruleUpdateIdx = fetch.calls.findIndex((c) => c.isRuleUpdate);
        const minorIdx = fetch.calls.findIndex((c) => c.isMinor);
        assert.ok(ruleUpdateIdx >= 0 && minorIdx > ruleUpdateIdx,
            `minor после Branch 3, есть: ${fetch.calls.map((c) => (c.isCutter ? 'cutter' : c.isRouter ? 'router' : c.isMinor ? 'minor' : c.isRuleUpdate ? 'ruleUpdate' : 'parse')).join(',')}`);
        // Router дня2 видит правило дня1 (tmp-кэш): ключ bench_full в {{RULES}}.
        const routerCalls = fetch.calls.filter((c) => c.isRouter);
        assert.equal(routerCalls.length, 3, 'Router выполняется отдельно для каждого Cutter day');
        assert.ok(routerCalls.every((call, index) => call.prompt.includes([day1, day2, day3][index])),
            'Router получает дни в исходном порядке, по одному за вызов');
        assert.ok(routerCalls[1].prompt.includes('bench_full'),
            'день2: {{RULES}} содержит ключ bench_full (правило дня1 из tmp-кэша)');
        assert.ok(routerCalls[2].prompt.includes('жим лёжа семдесят'),
            'день3: Router видит grounded Branch 2 example from day2');
        // Аппенды → rulesLog.tmp.json (не main).
        const tmpObj = JSON.parse(fs.readFileSync(tmpStore._getRulesTmpPath(), 'utf8'));
        assert.ok(tmpObj.newKeys.some((nk) => nk.key === 'bench_full' && nk.source === 'minorRuleUpdate'
            && nk.values && nk.values.bench_full === 70),
        'minor example is enriched from Structured values before entering the next Router context');
        // События трёх дней.
        assert.ok(Array.isArray(r.payload.events) && r.payload.events.length === 3);
        // INV-2: main rulesLog.json не тронут.
        assert.ok(Number.isInteger(rulesLog.getVersion()));
    } finally {
        restoreTmp();
        restoreLog();
    }
});

// ============================================================
// (2) commitRules branch-1: правило {id, raw, mapping, examples}
//     — БЕЗ date/semantics/roles/cues; примеры по формулировке.
// ============================================================
test('Расхождение №4: commitRules branch-1 строит правило raw+mapping+examples без date/semantics/roles', async () => {
    const restoreLog = pointRulesLogAt();
    try {
        const r = {
            status: 'success', branch: 1, confidence: 0.95,
            payload: {
                raw: 'пресс 40, спина 30',
                events: [{ date: DATE, values: { press_full: 40, back_full: 30 } }],
                newKeys: [
                    { key: 'press_full', input: 'пресс 40, спина 30', sourceSpan: 'пресс 40', date: DATE, values: { press_full: 40 } },
                    { key: 'back_full', input: 'пресс 40, спина 30', sourceSpan: 'спина 30', date: DATE, values: { back_full: 30 } },
                ],
            },
        };
        assert.equal(r.payload.raw, 'пресс 40, спина 30', 'payload.raw — полный ввод прогона');

        const before = rulesLog.getVersion();
        const cr = await pipeline.commitRules(r, {});
        assert.equal(cr.status, 'success');
        assert.equal(cr.added, 1);
        assert.equal(cr.version, before + 1);

        const latest = rulesLog.getLatestRules();
        const added = latest.dynamic[latest.dynamic.length - 1];
        assert.equal(added.raw, 'пресс 40, спина 30');
        assert.equal(added.semantics, undefined);
        assert.equal(added.roles, undefined);
        assert.equal(added.cues, undefined);
        assert.ok(added.id && /^rule_\d+$/.test(added.id));
        assert.ok(added.mapping.press_full === 'press_full' && added.mapping.back_full === 'back_full');
        assert.ok(Array.isArray(added.examples) && added.examples.length === 2);
        assert.deepEqual(added.examples.map((example) => example.input), ['пресс 40', 'спина 30']);
        assert.ok(added.examples.every((example) => example.date === undefined));
        assert.deepEqual(added.examples.map((example) => example.values), [{ press_full: 40 }, { back_full: 30 }]);
    } finally {
        restoreLog();
    }
});
