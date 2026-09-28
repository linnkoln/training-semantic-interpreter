'use strict';
// tests/fix-round2.test.js — фиксы корневых багов пайплайна (раунд 2, 2026-09-05):
//   FIX-A: minor-append с key вне словаря актуальных правил (напр. key='tmp_rule_004')
//          отбрасывается с warning, в rulesLog.tmp.json мусор не попадает;
//   FIX-B: {{RULES}} внутри прогона — ВСЕ tmp-правила (formatRecentRules(Infinity)),
//          а не последние 2: после Branch 3 на 5 групп роутер видит все 5;
//   FIX-C: nextRuleId учитывает tmp_rule_NNN (оверлей) + дедупликация id в proposeRule.

const test = require('node:test');
const { beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('node:os');
const crypto = require('crypto');

const pipeline = require('../core/pipeline.js');
const rulesLog = require('../core/rulesLog.js');
const conflict = require('../core/conflict.js');
const tmpStore = require('../adapters/tmpStore.js');

beforeEach((t) => {
    const originalPath = tmpStore._getRulesTmpPath();
    const prefix = 'training-fix-round2-rules-tmp-';
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

const DATE = '2026-05-29';
const REAL_LOG_PATH = path.resolve(__dirname, '../data/defaults/rulesLog.json');

// ============================================================
// Fake-fetch (как в tc001-pipeline-fixes.test.js)
// ============================================================
function resolveAnswer(spec, prompt) {
    return (typeof spec === 'function') ? spec(prompt) : (spec ?? '');
}
function makeFetch({ cutter, router, parse, minor, ruleUpdate } = {}) {
    const calls = [];
    const fn = async (url, init = {}) => {
        const body = JSON.parse(init.body || '{}');
        const prompt = (body.messages && body.messages[0] && body.messages[0].content) || '';
        const isCutter = /нарезщик/i.test(prompt);
        const isRouter = !isCutter && /# Router\b/i.test(prompt);
        const isMinor = !isCutter && !isRouter && /Минорное/i.test(prompt);
        const isRuleUpdate = !isCutter && !isRouter && !isMinor && /RuleUpdate/i.test(prompt);
        calls.push({ url, prompt, isCutter, isRouter, isMinor, isRuleUpdate });
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
const routerAnswer = (group, chunk) =>
    JSON.stringify({ status: 'success', payload: { groups: [{ chunk, group, reasoning: 'R2', confidence: 0.9 }], confidence: 0.9 }, confidence: 0.9 });
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
// Изоляция: копия rulesLog.json в tmp, tmp-словарь в tmp
// ============================================================
function pointRulesLogAt() {
    const suffix = crypto.randomBytes(8).toString('hex');
    const tempPath = path.resolve(__dirname, `../data/rulesLog.fix2.${suffix}.tmp.json`);
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
    const tempPath = path.resolve(__dirname, `../data/rulesLog.fix2tmp.${suffix}.tmp.json`);
    tmpStore._setRulesTmpPath(tempPath);
    return function restore() {
        tmpStore._setRulesTmpPath(origPath);
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    };
}

// ============================================================
// FIX-A: minor-append с ключом-мусором (tmp_rule_004) отбрасывается
// ============================================================
test('FIX-A: minor-append key=tmp_rule_004 (не в словаре правил) фильтруется, tmp-файл чист', async () => {
    const restoreLog = pointRulesLogAt();
    const restoreTmp = pointRulesTmpAt();
    try {
        const day1 = '*05-29* жим лёжа макс 70';
        const day2 = '*05-31* жим лёжа семдесят';
        const fetch = makeFetch({
            cutter: cutterAnswer([{ raw: day1, date: '05-29' }, { raw: day2, date: '05-31' }]),
            router: (prompt) => {
                if (prompt.includes(day2)) return routerAnswer(2, day2);
                return routerAnswer(3, day1);
            },
            ruleUpdate: ruleUpdateAnswer({
                keys: [{ key: 'bench_full', role: 'stack', meaning: 'жим лёжа, макс' }],
                newKeys: [{ key: 'bench_full', chunk: day1, date: '2026-05-29', values: { bench_full: 70 } }],
                oldKeysEvents: [],
            }),
            // Мусор из трассы: LLM вернула ID правила вместо ключа маппинга.
            minor: minorAnswer([
                { key: 'tmp_rule_004', chunk: day2, exampleText: 'подтягивания (3 + 22)', confidence: 0.9 },
                { key: 'bench_full', chunk: day2, exampleText: 'жим лёжа семдесят', confidence: 0.9 },
            ]),
            parse: parseAnswer([{ date: '2026-05-31', values: { bench_full: 70 } }]),
        });

        const r = await pipeline.next([day1, day2].join('\n'), { date: DATE, llmOptions: { fetch } });
        assert.equal(r.status, 'success', r.message || '');
        // Валидный аппенд прошёл, мусор — нет.
        assert.deepEqual(r.payload.appends.map((a) => a.key), ['bench_full']);
        // Warning про отброшенный ключ.
        const warns = r.payload.warnings || [];
        assert.ok(warns.some((w) => w.includes('tmp_rule_004')),
            `warning про отброшенный key, есть: ${JSON.stringify(warns)}`);
        // rulesLog.tmp.json НЕ содержит мусора.
        const tmpObj = JSON.parse(fs.readFileSync(tmpStore._getRulesTmpPath(), 'utf8'));
        assert.ok(tmpObj.newKeys.every((nk) => nk.key !== 'tmp_rule_004'),
            `tmp-словарь без мусора: ${JSON.stringify(tmpObj.newKeys)}`);
        assert.ok(tmpObj.newKeys.some((nk) => nk.key === 'bench_full'));
        // {{RULES}} роутера дня2 не содержит «ключ tmp_rule_004».
        const routerCalls = fetch.calls.filter((c) => c.isRouter);
        assert.ok(!routerCalls[1].prompt.includes('tmp_rule_004'),
            'router дня2: {{RULES}} без ключа-мусора');
    } finally {
        restoreTmp();
        restoreLog();
    }
});

// ============================================================
// FIX-B: {{RULES}} внутри прогона — все tmp-правила Branch 3
// ============================================================
test('FIX-B: после Branch 3 на 5 групп роутер дня2 видит ВСЕ 5 групп в {{RULES}}', async () => {
    const restoreLog = pointRulesLogAt();
    const restoreTmp = pointRulesTmpAt();
    try {
        const day1 = '*05-29* пресс 40, спина 30, ноги 50, руки 20, грудь 25';
        const day2 = '*05-31* что-то новое совсем';
        const groupKeys = ['press', 'back', 'legs', 'arms', 'chest'];
        const keys = groupKeys.map((p) => ({ key: `${p}_full`, role: 'stack', meaning: `${p} смысл` }));
        const newKeys = groupKeys.map((p) => ({ key: `${p}_full`, chunk: day1, date: '2026-05-29', values: { [`${p}_full`]: 10 } }));
        const fetch = makeFetch({
            cutter: cutterAnswer([{ raw: day1, date: '05-29' }, { raw: day2, date: '05-31' }]),
            router: (prompt) => routerAnswer(prompt.includes(day2) ? 3 : 3, prompt.includes(day2) ? day2 : day1),
            ruleUpdate: (prompt) => {
                const currentDay = prompt.includes(`Приходят данные (${day2})`) ? day2 : day1;
                return ruleUpdateAnswer({ keys, newKeys: newKeys.map((item) => ({ ...item, chunk: currentDay })), oldKeysEvents: [] });
            },
            parse: parseAnswer([{ date: '2026-05-31', values: { new_full: 5 } }]),
        });

        const r = await pipeline.next([day1, day2].join('\n'), { date: DATE, llmOptions: { fetch } });
        assert.equal(r.status, 'success', r.message || '');
        // Branch 3 создаёт одну запись правила с mapping всех измеряемых групп.
        assert.equal(r.payload.rules.length, 2, `по одной записи на два Branch 3 дня: ${r.payload.rules.length}`);
        // Роутер дня2 получил все ключи общего правила в {{RULES}}.
        const routerCalls = fetch.calls.filter((c) => c.isRouter);
        const rulesDay2 = routerCalls[1].prompt;
        for (const p of groupKeys) {
            assert.ok(rulesDay2.includes(`${p}_full`), `{{RULES}} дня2 содержит ${p}_full`);
        }
        // Router получает проекцию ключей и примеров, а не ID правила.
        assert.ok(rulesDay2.includes('press_full'), 'ключ правила дня1 виден роутеру дня2');
    } finally {
        restoreTmp();
        restoreLog();
    }
});

// ============================================================
// FIX-C: уникальность id правил
// ============================================================
test('FIX-C: nextRuleId учитывает tmp_rule_NNN из оверлея', () => {
    assert.equal(conflict.nextRuleId({ dynamic: [{ id: 'tmp_rule_001' }], global: [] }), 'rule_002');
    assert.equal(conflict.nextRuleId({ dynamic: [{ id: 'rule_001' }, { id: 'tmp_rule_003' }], global: [] }), 'rule_004');
    assert.equal(rulesLog.nextRuleId({ dynamic: [{ id: 'tmp_rule_005' }], global: [] }), 'rule_006');
});

test('FIX-C: proposeRule на multi-group вводе — все id уникальны', async () => {
    const restoreLog = pointRulesLogAt();
    try {
        const input = 'пресс 40, спина 30, ноги 50';
        const prefixes = ['press', 'back', 'legs'];
        const keys = prefixes.map((p) => ({ key: `${p}_full`, role: 'stack', meaning: `${p} смысл` }));
        const newKeys = prefixes.map((p) => ({ key: `${p}_full`, chunk: input, date: '2026-05-29', values: { [`${p}_full`]: 10 } }));
        const response = {
            status: 'success',
            confidence: 0.85,
            payload: {
                rule: { semantics: 'новое упражнение', keys, composition: 'single' },
                oldKeysEvents: [],
                newKeys,
                relations: [],
                confidence: 0.85,
            },
        };
        const res = await conflict.proposeRule(input, { llmOptions: { fetch: async () => ({ ok: true, status: 200, json: async () => ({ message: { content: JSON.stringify(response) } }) }) } });
        assert.equal(res.status, 'success');
        const ids = res.payload.rules.map((r) => r.id);
        assert.equal(new Set(ids).size, ids.length, `id уникальны: ${ids.join(',')}`);
    } finally {
        restoreLog();
    }
});

test('FIX-C: два Branch 3 дня подряд — id второго не дублирует первый (tmp_оверлей учтён)', async () => {
    const restoreLog = pointRulesLogAt();
    const restoreTmp = pointRulesTmpAt();
    try {
        const day1 = '*05-29* жим лёжа макс 70';
        const day2 = '*05-31* становая макс 100';
        const mkKeys = (p, chunk) => ([{ key: `${p}_full`, role: 'stack', meaning: `${p} смысл` }]);
        const mkNew = (p, chunk) => ([{ key: `${p}_full`, chunk, date: '2026-05-29', values: { [`${p}_full`]: 10 } }]);
        let dayNo = 0;
        const fetch = makeFetch({
            cutter: cutterAnswer([{ raw: day1, date: '05-29' }, { raw: day2, date: '05-31' }]),
            router: (prompt) => {
                dayNo++;
                return routerAnswer(3, prompt.includes(day2) ? day2 : day1);
            },
            ruleUpdate: (prompt) => {
                const p = prompt.includes(day2) ? 'deadlift' : 'bench';
                const chunk = prompt.includes(day2) ? day2 : day1;
                return ruleUpdateAnswer({ keys: mkKeys(p, chunk), newKeys: mkNew(p, chunk), oldKeysEvents: [] });
            },
            parse: parseAnswer([{ date: '2026-05-31', values: { x_full: 5 } }]),
        });

        const r = await pipeline.next([day1, day2].join('\n'), { date: DATE, llmOptions: { fetch } });
        assert.equal(r.status, 'success', r.message || '');
        const allIds = r.payload.rules.map((r) => r.id);
        assert.equal(new Set(allIds).size, allIds.length, `id двух дней уникальны: ${allIds.join(',')}`);
    } finally {
        restoreTmp();
        restoreLog();
    }
});
