'use strict';
const { legacyEmptyRuleLog } = require('./helpers/legacyRuleLog.js');
// tests/fix-round3-ui-bugs.test.js — фиксы корневых багов живого UI-прогона 2026-09-05.
//
// БАГ-1: fallback роутера при ПУСТЫХ правилах отдавал группу 1 — новая суть
//        маскировалась под «перевод по правилам», правило не создавалось.
//        Фикс: пустой {{RULES}} → fallback группа 3 (Branch 3, conflict).
// БАГ-2: newKeys Branch 1 (structured) не попадали в tmp-словарь прогона →
//        день 2 видел rules:[] → группа 3 → Branch 3 переоткрывал сущности
//        с выдуманными ключами. Фикс: после Branch 1 оверлей сессийного
//        правила (tmp_session_keys_b1_<dayNo>) в кэш rulesLog.

const test = require('node:test');
const { beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('node:os');
const crypto = require('crypto');

const { route } = require('../core/router.js');
const pipeline = require('../core/pipeline.js');
const rulesLog = require('../core/rulesLog.js');
const tmpStore = require('../adapters/tmpStore.js');

beforeEach((t) => {
    const originalPath = tmpStore._getRulesTmpPath();
    const prefix = 'training-fix-round3-rules-tmp-';
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

// ============================================================
// Заглушки (как в router.test.js / tc001-pipeline-fixes.test.js)
// ============================================================

/** fetch-заглушка, всегда бросающая ошибку (сбой LLM). */
const explodingFetch = async () => { throw new Error('ECONNREFUSED'); };

/** Фабрика mock-fetch: режет промпты по маркерам, как в tc001. */
function makeFetch({ cutter, router, parse } = {}) {
    const calls = [];
    const fn = async (url, init = {}) => {
        const body = JSON.parse(init.body || '{}');
        const prompt = (body.messages && body.messages[0] && body.messages[0].content) || '';
        const isCutter = /нарезщик/i.test(prompt);
        const isRouter = !isCutter && /# Router\b/i.test(prompt);
        calls.push({ url, prompt, isCutter, isRouter });
        const answer = isCutter ? cutter(prompt)
            : isRouter ? router(prompt)
                : parse(prompt);
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

// Temp-лог / tmp — НЕ трогаем data/rulesLog.json (как в tc001-pipeline-fixes.test.js)
function pointRulesLogAt() {
    const suffix = crypto.randomBytes(8).toString('hex');
    const tempPath = path.resolve(__dirname, `../data/rulesLog.fixr3.${suffix}.tmp.json`);
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
function pointRulesTmpAt() {
    const origPath = tmpStore._getRulesTmpPath();
    const suffix = crypto.randomBytes(8).toString('hex');
    const tempPath = path.resolve(__dirname, `../data/rulesLog.fixr3tmp.${suffix}.tmp.json`);
    tmpStore._setRulesTmpPath(tempPath);
    return function restore() {
        tmpStore._setRulesTmpPath(origPath);
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    };
}

function seedKnownRules() {
    const fragments = {
        press_reps: '*05-29* 50 пресс',
        squat_reps: '50 присяд',
        pushup_reps: '50 отжимания',
    };
    rulesLog.appendRule({
        id: 'rule_001', raw: 'известные упражнения',
        mapping: Object.fromEntries(Object.keys(fragments).map((key) => [key, key])),
        examples: Object.entries(fragments).map(([key, input]) => ({ input, values: { [key]: 50 } })),
    }, 'add');
}

// ============================================================
// (а) Сбой Router не должен маскироваться классификационным fallback
// ============================================================

test('route: сбой LLM при пустых правилах → явная ошибка без группы', async () => {
    const r = await route('X', { fetch: explodingFetch, rules: '' });
    assert.equal(r.status, 'error');
    assert.equal(r.payload, null);
});

test('route: сбой LLM вообще без opts.rules → явная ошибка', async () => {
    const r = await route('X', { fetch: explodingFetch });
    assert.equal(r.status, 'error');
    assert.equal(r.payload, null);
});

// ============================================================
// (б) сбой не может молча отправить существующие правила в Branch 1
// ============================================================

test('route: сбой LLM при ЕСТЬ правилах → явная ошибка, не группа 1', async () => {
    const r = await route('X', { fetch: explodingFetch, rules: '{"rules": [{"id": "rule_011"}]}' });
    assert.equal(r.status, 'error');
    assert.equal(r.payload, null);
});

// ============================================================
// (в) БАГ-2: newKeys Branch 1 видны роутеру дня 2 в {{RULES}}
// ============================================================

test('pipeline: ключи Branch 1 дня 1 попадают в {{RULES}} роутера дня 2 (tmp_session_keys_b1)', async () => {
    const mainPath = path.resolve(__dirname, '../data/rulesLog.json');
    const readMain = () => fs.existsSync(mainPath) ? fs.readFileSync(mainPath, 'utf8') : null;
    const mainBefore = readMain();
    const restoreLog = pointRulesLogAt();
    const restoreTmp = pointRulesTmpAt();
    try {
        seedKnownRules();
        const day1 = '*05-29* 50 пресс 50 присяд 50 отжимания';
        const day2 = '*05-31* 50 пресс 50 присяд 50 отжимания';
        const routerPrompts = [];
        const fetch = makeFetch({
            cutter: () => cutterAnswer([{ raw: day1, date: '05-29' }, { raw: day2, date: '05-31' }]),
            router: (prompt) => {
                if (prompt.includes(day2)) routerPrompts.push(prompt);
                return routerAnswer(1, prompt.includes(day2) ? day2 : day1);
            },
            parse: (prompt) => {
                if (prompt.includes('05-31')) return parseAnswer([{ date: '2026-05-31', values: { press_reps: 50, squat_reps: 50 } }]);
                return parseAnswer([{ date: '2026-05-29', values: { press_reps: 50, squat_reps: 50, pushup_reps: 50 } }]);
            },
        });

        const r = await pipeline.next([day1, day2].join('\n'), { date: '2026-05-29', llmOptions: { fetch } });
        assert.equal(r.status, 'success', `success: ${r.message || JSON.stringify(r.payload && r.payload.warnings)}`);

        // Роутер дня 2 вызван и в его промпте {{RULES}} содержит ключи Branch 1 дня 1.
        assert.equal(routerPrompts.length, 1, 'роутер дня 2 вызван ровно один раз');
        assert.ok(routerPrompts[0].includes('press_reps'), 'press_reps из Branch 1 дня 1 в {{RULES}} дня 2');
        assert.ok(routerPrompts[0].includes('squat_reps'), 'squat_reps в {{RULES}} дня 2');
        assert.ok(routerPrompts[0].includes('pushup_reps'), 'pushup_reps в {{RULES}} дня 2');

        // Известные упражнения остаются в правиле; Branch 1 не открывает их повторно.
        const latest = rulesLog.getLatestRules();
        const b1 = (latest.dynamic || []).filter((x) => x && x.id === 'tmp_session_keys_b1_1');
        assert.equal(b1.length, 0, 'известные ключи не создают сессионное правило повторно');
        const known = (latest.dynamic || []).find((x) => x && x.id === 'rule_001');
        assert.ok(known && known.mapping.press_reps, 'исходное правило с известными ключами сохранено');

        // INV-2/3: main не тронут — сессийные ключи живут только в tmp-кэше.
        assert.equal(readMain(), mainBefore,
            'прогон не изменяет основной rulesLog.json');
    } finally {
        restoreLog();
        restoreTmp();
    }
});

test('pipeline: день 2 после Branch 1 НЕ переоткрывает ключи дня 1 (newKeys дня 2 пусты)', async () => {
    const restoreLog = pointRulesLogAt();
    const restoreTmp = pointRulesTmpAt();
    try {
        seedKnownRules();
        const day1 = '*05-29* 50 пресс 50 присяд 50 отжимания';
        const day2 = '*05-31* 50 пресс 50 присяд 50 отжимания';
        const fetch = makeFetch({
            cutter: () => cutterAnswer([{ raw: day1, date: '05-29' }, { raw: day2, date: '05-31' }]),
            router: (prompt) => routerAnswer(1, prompt.includes(day2) ? day2 : day1),
            parse: (prompt) => {
                if (prompt.includes('05-31')) return parseAnswer([{ date: '2026-05-31', values: { press_reps: 50, squat_reps: 50 } }]);
                return parseAnswer([{ date: '2026-05-29', values: { press_reps: 50, squat_reps: 50, pushup_reps: 50 } }]);
            },
        });

        const r = await pipeline.next([day1, day2].join('\n'), { date: '2026-05-29', llmOptions: { fetch } });
        assert.equal(r.status, 'success');
        // Ключи дня 1 (press_reps, squat_reps, pushup_reps) уже в словаре прогона —
        // structured дня 2 не должен отдавать их как newKeys (нет «переоткрытия»).
        // payload.newKeys агрегирует все дни — смотрим только newKeys дня 2 (по дате).
        const day2NewKeys = (r.payload.newKeys || [])
            .filter((nk) => nk && nk.date === '2026-05-31')
            .map((nk) => nk.key)
            .filter((k) => ['press_reps', 'squat_reps', 'pushup_reps'].includes(k));
        assert.deepEqual(day2NewKeys, [], 'ключи дня 1 не переоткрываются в день 2');
    } finally {
        restoreLog();
        restoreTmp();
    }
});
