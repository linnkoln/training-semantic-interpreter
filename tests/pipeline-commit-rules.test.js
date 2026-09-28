'use strict';
const { legacyEmptyRuleLog } = require('./helpers/legacyRuleLog.js');
// tests/pipeline-commit-rules.test.js — D10: авто-накопление правил в rulesLog на «Сохранить данные».
//
// Проверяет pipeline.commitRules (unit, fake-fetch, без реальной сети и реального лога):
//   • branch 1 с новыми ключами (press_full и т.п., отсутствующие в вокабуляре) →
//     commitRules дописывает ОДНО правило в rulesLog (temp-лог через _setLogPath),
//     версия монотонна;
//   • повторный commitRules с теми же ключами НЕ дублирует правило (dedupe по
//     вокабуляру mapping-ключей);
//   • branch 2 (pendingProposal) фиксируется через commitRules;
//   • INV-5: правила попадают в лог ТОЛЬКО через appendRule, версии монотонны.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');

const pipeline = require('../core/pipeline.js');
const rulesLog = require('../core/rulesLog.js');
const tmpStore = require('../adapters/tmpStore.js');

// Every Save-path test runs against isolated graph files, including tests that
// only inspect the rule log: commitRules may merge an existing temp graph.
const originalGraphPath = pipeline._getGraphFsPath();
const originalGraphTmpPath = tmpStore._getGraphTmpPath();
const originalRulesTmpPath = tmpStore._getRulesTmpPath();
const graphTestSuffix = `${process.pid}.${crypto.randomBytes(8).toString('hex')}`;
const graphTestPath = path.join(os.tmpdir(), `training-commit-graph.${graphTestSuffix}.json`);
const graphTestTmpPath = path.join(os.tmpdir(), `training-commit-graph-tmp.${graphTestSuffix}.json`);
const rulesTestTmpPath = path.join(os.tmpdir(), `training-commit-rules-tmp.${graphTestSuffix}.json`);
pipeline._setGraphFsPath(graphTestPath);
tmpStore._setGraphTmpPath(graphTestTmpPath);
tmpStore._setRulesTmpPath(rulesTestTmpPath);
test.after(() => {
    pipeline._setGraphFsPath(originalGraphPath);
    tmpStore._setGraphTmpPath(originalGraphTmpPath);
    tmpStore._setRulesTmpPath(originalRulesTmpPath);
    for (const file of [graphTestPath, graphTestTmpPath, rulesTestTmpPath]) {
        if (fs.existsSync(file)) fs.unlinkSync(file);
    }
});

const DATE = '2026-08-29';
const INPUT = 'пресс 40';

// ============================================================
// Fake-fetch: различает Router (промпт содержит «Роутер») и parse-вызовы
// ============================================================

function makeFetch({ cutter, router, parse, ruleUpdate } = {}) {
    const fn = async (url, init = {}) => {
        const body = JSON.parse(init.body || '{}');
        const prompt = (body.messages && body.messages[0] && body.messages[0].content) || '';
        const isCutter = /нарезщик/i.test(prompt);
        const isRouter = !isCutter && /(?:Роутер|Router)/i.test(prompt);
        const isRuleUpdate = !isCutter && !isRouter && /RuleUpdate/i.test(prompt);
        const resolve = (spec) => (typeof spec === 'function' ? spec(prompt) : spec);
        const answer = isCutter ? resolve(cutter)
            : (isRouter ? resolve(router) : (isRuleUpdate ? resolve(ruleUpdate) : resolve(parse)));
        return { ok: true, status: 200, json: async () => ({ message: { content: answer } }) };
    };
    return fn;
}

/** Ответ Cutter (v9): дни [{raw, date}] — нарезка ввода на дни. */
function cutterAnswer(days) {
    return JSON.stringify({ status: 'success', payload: { days, confidence: 0.9 }, confidence: 0.9 });
}

/** Ответ ruleUpdate (Branch 3, mode_RuleUpdate.md): правило + разделение старое/новое. */
function ruleUpdateAnswer({ semantics = 'новый тип данных', keys = [], oldKeysEvents = [],
    newKeys = [], relations = [], composition = 'single', confidence = 0.85 } = {}) {
    return JSON.stringify({
        status: 'success',
        payload: { rule: { semantics, keys, composition }, oldKeysEvents, newKeys, relations, confidence },
        confidence,
    });
}

function routerAnswer(group, chunk, confidence = 0.9) {
    return JSON.stringify({ status: 'success', payload: { groups: [{ chunk, group, reasoning: 'x', confidence }], confidence }, confidence });
}

function parseAnswer(candidates, confidence = 0.95) {
    return JSON.stringify({ status: 'success', payload: candidates, confidence });
}

// ============================================================
// Temp-лог (не трогаем data/rulesLog.json)
// ============================================================

const REAL_LOG_PATH = path.resolve(__dirname, '../docs/testing/fixtures/TC-001-empty-state/rulesLog.json');

function pointRulesLogAtTemp() {
    const suffix = crypto.randomBytes(8).toString('hex');
    const tempPath = path.resolve(__dirname, `../data/rulesLog.commitrules.${suffix}.tmp.json`);
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

/** Прогон пайплайна branch 1 с новым ключом press_full. */
function runBranch1WithNewKey() {
    // commitRules is a Save-gate unit: provide a valid Branch 1 result directly.
    // Router group 1 cannot be requested against an empty rulebook.
    return {
        status: 'success', branch: 1, confidence: 0.95,
        payload: {
            raw: '*08-29* пресс 40',
            events: [{ date: DATE, values: { press_full: 40 } }],
            newKeys: [{ key: 'press_full', input: '*08-29* пресс 40', sourceSpan: 'пресс 40', date: DATE, values: { press_full: 40 } }],
        },
    };
}

// ============================================================
// Тесты
// ============================================================

test('Save не переносит временные правила и pipeline-overlay в основной журнал', async () => {
    const restore = pointRulesLogAtTemp();
    try {
        const committedLog = legacyEmptyRuleLog();
        rulesLog.setCachedLog(committedLog);
        const latest = committedLog.entries.at(-1)?.rulesSnapshot || { version: 0, dynamic: [], global: [] };
        rulesLog.setCachedLog({ ...committedLog, entries: [...committedLog.entries, {
            version: committedLog.version,
            changeType: 'pipeline-overlay',
            timestamp: new Date().toISOString(),
            rulesSnapshot: { ...latest, dynamic: [...latest.dynamic, {
                id: 'tmp_rule_001', raw: 'временная запись', mapping: { provisional_metric: 'временная метрика' },
            }] },
        }] });
        const result = { status: 'success', branch: 3, payload: {
            events: [], newKeys: [], proposal: { rules: [{
                id: 'rule_900', raw: 'подтверждённая запись',
                mapping: { confirmed_metric: 'подтверждённая метрика' },
                examples: [{ input: 'подтверждённая запись', values: { confirmed_metric: 1 } }],
            }] },
        } };
        const saved = await pipeline.commitRules(result, { committedLog });
        assert.equal(saved.status, 'success');
        assert.equal(saved.payload.log.entries.length, committedLog.entries.length + 1,
            JSON.stringify(saved.payload.log.entries.map((entry) => entry.changeType)));
        assert.equal(saved.payload.log.entries.at(-1).changeType, 'add');
        assert.ok(!(saved.payload.log.entries.at(-1).rulesSnapshot.dynamic || [])
            .some((rule) => rule.id === 'tmp_rule_001'));
        assert.ok(saved.payload.log.entries.at(-1).rulesSnapshot.dynamic.some((rule) => rule.id === 'rule_900'));
    } finally { restore(); }
});
test('D10/commitRules: branch 1 с новыми ключами → правило добавлено в rulesLog через appendRule, версия +1', async () => {
    const restore = pointRulesLogAtTemp();
    try {
        const versionBefore = rulesLog.getVersion();
        const res = await runBranch1WithNewKey();

        assert.equal(res.status, 'success');
        assert.equal(res.branch, 1);
        assert.ok(Array.isArray(res.payload.newKeys) && res.payload.newKeys.length === 1, 'structured должен отдать newKeys');
        assert.equal(res.payload.newKeys[0].key, 'press_full');
        assert.equal(res.payload.newKeys[0].input, '*08-29* пресс 40');
        assert.equal(res.payload.newKeys[0].date, DATE);

        const cr = await pipeline.commitRules(res, {});
        assert.equal(cr.status, 'success', cr.message || 'commitRules should succeed');
        assert.equal(cr.added, 1);
        assert.equal(cr.version, versionBefore + 1, 'версия лога монотонно +1');

        const latest = rulesLog.getLatestRules();
        const added = latest.dynamic[latest.dynamic.length - 1];
        assert.equal(added.id, rulesLog.nextRuleId(JSON.parse(JSON.stringify({ dynamic: latest.dynamic.slice(0, -1), global: latest.global }))),
            'id — следующий свободный rule_NNN');
        assert.equal(added.mapping.press_full, 'press_full');
        // Расхождение №4: формат правила {id, raw, mapping, examples} — без
        // semantics/roles/cues, примеры без даты.
        assert.equal(added.raw, '*08-29* пресс 40');
        assert.equal(added.semantics, undefined);
        assert.equal(added.roles, undefined);
        assert.equal(added.cues, undefined);
        assert.ok(Array.isArray(added.examples) && added.examples.length === 1);
        assert.equal(added.examples[0].input, 'пресс 40');
        assert.equal(added.examples[0].date, undefined);
        assert.deepEqual(added.examples[0].values, { press_full: 40 });
    } finally {
        restore();
    }
});

test('D10/commitRules: повторный Save с теми же ключами НЕ дублирует правило (dedupe по вокабуляру)', async () => {
    const restore = pointRulesLogAtTemp();
    try {
        const res = await runBranch1WithNewKey();

        const first = await pipeline.commitRules(res, {});
        assert.equal(first.status, 'success');
        assert.equal(first.added, 1);

        const versionAfterFirst = rulesLog.getVersion();
        const rulesAfterFirst = JSON.stringify(rulesLog.getLatestRules());

        const second = await pipeline.commitRules(res, {});
        assert.equal(second.status, 'noop', 'повторная фиксация тех же ключей → noop');
        assert.equal(second.added, 0);
        assert.equal(second.version, versionAfterFirst, 'версия НЕ растёт без добавления (монотонность)');
        assert.equal(JSON.stringify(rulesLog.getLatestRules()), rulesAfterFirst, 'правила не изменились при повторном Save');
    } finally {
        restore();
    }
});

test('D10/commitRules: branch 2 proposal фиксируется (pendingProposal → appendRule)', async () => {
    const restore = pointRulesLogAtTemp();
    try {
        const fetch = makeFetch({
            router: routerAnswer(3, 'присяд 50'),
            ruleUpdate: ruleUpdateAnswer({
                keys: [{ key: 'squat_reps', role: 'stack' }],
                newKeys: [{ key: 'squat_reps', chunk: 'присяд 50', date: DATE, values: { squat_reps: 50 } }],
            }),
        });
        const res = await pipeline.next('присяд 50', { date: DATE, llmOptions: { fetch } });
        assert.equal(res.branch, 2);
        assert.ok(res.payload.proposal && res.payload.proposal.rule);

        const versionBefore = rulesLog.getVersion();
        const cr = await pipeline.commitRules(res, {});
        assert.equal(cr.status, 'success');
        assert.equal(cr.added, 1);
        assert.equal(cr.branch, 2);
        assert.equal(cr.version, versionBefore + 1);

        const latest = rulesLog.getLatestRules();
        const all = [...latest.dynamic, ...latest.global];
        assert.ok(all.some((r) => r.id === res.payload.proposal.rule.id), 'правило proposal зафиксировано в логе');
    } finally {
        restore();
    }
});

test('D10/commitRules: предложение Branch 3 сохраняется для смешанного результата Branch 1', async () => {
    const restore = pointRulesLogAtTemp();
    try {
        const before = rulesLog.getVersion();
        const result = {
            status: 'success',
            branch: 1,
            payload: {
                events: [{ date: DATE, values: { press_reps: 50 } }],
                newKeys: [],
                proposal: {
                    rules: [{
                        id: 'rule_900', raw: 'новая запись',
                        mapping: { new_metric: 'новая метрика' },
                        examples: [{ input: 'новая запись', values: { new_metric: 3 } }],
                    }],
                },
            },
        };
        const saved = await pipeline.commitRules(result);
        assert.equal(saved.status, 'success');
        assert.equal(saved.added, 1);
        assert.equal(saved.version, before + 1);
        assert.ok(saved.payload && saved.payload.log,
            'mixed Branch 1 result must return proposal rulesLog for the Vault transaction even when graph is unchanged');
        assert.ok(rulesLog.getLatestRules().dynamic.some((r) => r.id === 'rule_900'));
    } finally { restore(); }
});

test('INV-5: правила только через appendRule, версии монотонны (commitRules не правит лог напрямую)', async () => {
    const restore = pointRulesLogAtTemp();
    try {
        const res = await runBranch1WithNewKey();
        const v0 = rulesLog.getVersion();

        const cr1 = await pipeline.commitRules(res, {});
        const cr2 = await pipeline.commitRules(res, {});
        const v1 = rulesLog.getVersion();
        const v2 = rulesLog.getVersion();

        assert.equal(cr1.status, 'success');
        assert.equal(v1, v0 + 1);
        assert.equal(v2, v1, 'дубль не поднимает версию');
        assert.ok(v1 > v0 && Number.isInteger(v1));

        // Каждая запись лога имеет монотонную version и changeType 'add' от commitRules.
        // Фикс 2026-09-05: между 'add'-записями теперь бывают temp-оверлеи
        // (changeType 'pipeline-overlay', только кэш) — applyOverlay кладёт их с
        // version = текущей (не поднимает), поэтому строгая монотонность требуется
        // для 'add'-записей, а оверлеи проверяем на неубывание.
        const log = rulesLog.getRulesLog();
        for (let i = 1; i < log.entries.length; i++) {
            const prev = log.entries[i - 1];
            const cur = log.entries[i];
            if (cur.changeType === 'pipeline-overlay' || prev.changeType === 'pipeline-overlay') {
                assert.ok(cur.version >= prev.version, 'оверлеи не убивают монотонность');
            } else {
                assert.ok(cur.version > prev.version, 'версии строго монотонны');
            }
        }
        const last = log.entries[log.entries.length - 1];
        assert.equal(last.changeType, 'add');
        assert.equal(last.meta.proposedBy, 'commitRules');
    } finally {
        restore();
    }
});

test('D10/commitRules: никогда не бросает; пустой/ошибочный результат → noop, ничего не пишет', async () => {
    const restore = pointRulesLogAtTemp();
    try {
        const v0 = rulesLog.getVersion();
        const rulesBefore = JSON.stringify(rulesLog.getLatestRules());

        await assert.doesNotReject(async () => {
            const r1 = await pipeline.commitRules(null, {});
            assert.equal(r1.status, 'noop');
            const r2 = await pipeline.commitRules({ status: 'error', branch: 1, payload: null }, {});
            assert.equal(r2.status, 'noop');
        });
        assert.equal(rulesLog.getVersion(), v0);
        assert.equal(JSON.stringify(rulesLog.getLatestRules()), rulesBefore);
    } finally {
        restore();
    }
});

// Хелпер: число правил в срезе.
function countRules(latest) {
    return (latest.dynamic || []).length + (latest.global || []).length;
}

// ============================================================
// Branch 3 LLM-relations → граф (tmp при «Обработать», merge при Save)
// ============================================================

/** Изолированные пути graph.json (main) и graph.tmp.json (temp) на время теста. */
function pointGraphsAtTemp() {
    const suffix = crypto.randomBytes(8).toString('hex');
    const mainPath = path.resolve(__dirname, `../data/graph.rels.${suffix}.tmp.json`);
    const tmpPath = path.resolve(__dirname, `../data/graph.rels.${suffix}.tmp.tmp.json`);
    const origMain = pipeline._getGraphFsPath();
    const origTmp = tmpStore._getGraphTmpPath();
    pipeline._setGraphFsPath(mainPath);
    tmpStore._setGraphTmpPath(tmpPath);
    return function restore() {
        pipeline._setGraphFsPath(origMain);
        tmpStore._setGraphTmpPath(origTmp);
        for (const p of [mainPath, tmpPath]) {
            if (fs.existsSync(p)) fs.unlinkSync(p);
        }
    };
}

test('TC-002 Save: Branch 3 extends the selected existing rule and preserves its prior mapping/examples', async () => {
    const restoreLog = pointRulesLogAtTemp();
    const restoreGraph = pointGraphsAtTemp();
    try {
        const base = {
            version: 1,
            updatedAt: new Date().toISOString(),
            entries: [{
                version: 1,
                timestamp: new Date().toISOString(),
                changeType: 'add',
                rulesSnapshot: {
                    version: 1,
                    dynamic: [{
                        id: 'rule_001',
                        raw: 'old raw',
                        mapping: { push_reps: 'обычные отжимания' },
                        examples: [{ input: '50 отжимания', values: { push_reps: 50 } }],
                    }],
                    global: [],
                },
            }],
        };
        fs.writeFileSync(rulesLog._getLogPath(), JSON.stringify(base, null, 2), 'utf8');
        rulesLog._resetCache();
        fs.writeFileSync(pipeline._getGraphFsPath(), JSON.stringify({ relations: [], targets: [], trends: [] }), 'utf8');

        const proposalRule = {
            id: 'rule_001',
            raw: 'full TC-002 raw input',
            mapping: { push_max_set: 'максимум за один подход' },
            examples: [{ input: '100 отжимания (макс подход: 32)', values: { push_max_set: 32 } }],
        };
        const saved = await pipeline.commitRules({
            status: 'success',
            branch: 2,
            confidence: 0.95,
            payload: {
                proposal: { updateRuleId: 'rule_001', rule: proposalRule, rules: [proposalRule], relations: [] },
                relations: [],
                events: [],
            },
        });

        assert.equal(saved.status, 'success');
        assert.equal(saved.added, 1);
        const updated = rulesLog.getLatestRules().dynamic.find((rule) => rule.id === 'rule_001');
        assert.equal(updated.__version, 2);
        assert.equal(updated.raw, 'full TC-002 raw input');
        assert.deepEqual(updated.mapping, {
            push_reps: 'обычные отжимания',
            push_max_set: 'максимум за один подход',
        });
        assert.deepEqual(updated.examples, [
            { input: '50 отжимания', values: { push_reps: 50 } },
            { input: '100 отжимания (макс подход: 32)', values: { push_max_set: 32 } },
        ]);
    } finally {
        restoreGraph();
        restoreLog();
    }
});

test('completeSnapshot update replaces current rule mapping/examples while preserving prior version history', async () => {
    const restoreLog = pointRulesLogAtTemp();
    const restoreGraph = pointGraphsAtTemp();
    try {
        const oldRule = {
            id: 'rule_001', raw: 'old day',
            mapping: { push_reps: 'push-ups', retired_push_key: 'retired form' },
            examples: [
                { input: 'old example 1', values: { push_reps: 10 } },
                { input: 'old example 2', values: { retired_push_key: 2 } },
            ],
        };
        const base = {
            version: 1,
            entries: [{ version: 1, timestamp: new Date().toISOString(), changeType: 'add', rulesSnapshot: {
                version: 1, dynamic: [oldRule], global: [],
            } }],
        };
        fs.writeFileSync(rulesLog._getLogPath(), JSON.stringify(base, null, 2), 'utf8');
        rulesLog._resetCache();
        fs.writeFileSync(pipeline._getGraphFsPath(), JSON.stringify({ relations: [] }), 'utf8');

        const currentExamples = [
            { input: 'current run 1', values: { run_km: 1 } },
            { input: 'current run 2', values: { run_km: 2 } },
            { input: 'current run 3', values: { run_km: 3 } },
            { input: 'current run 4', values: { run_km: 4 } },
            { input: 'current run 5', values: { run_km: 5 } },
        ];
        const completeRule = {
            id: 'rule_001', completeSnapshot: true, raw: 'current running rule set',
            mapping: { run_km: 'running distance in kilometers' },
            examples: currentExamples,
        };
        const saved = await pipeline.commitRules({
            status: 'success', branch: 2,
            payload: { proposal: {
                updateRuleId: 'rule_001', rule: completeRule, rules: [completeRule],
            }, relations: [], events: [] },
        });

        assert.equal(saved.status, 'success');
        const log = rulesLog.getRulesLog();
        assert.equal(log.version, 2);
        assert.equal(log.entries.length, 2);
        const latest = rulesLog.getLatestRules().dynamic.find((rule) => rule.id === 'rule_001');
        assert.deepEqual(latest.mapping, { run_km: 'running distance in kilometers' });
        assert.deepEqual(latest.examples, currentExamples);
        assert.equal(latest.completeSnapshot, undefined, 'control marker is not persisted');
        assert.deepEqual(log.entries[0].rulesSnapshot.dynamic[0], oldRule,
            'the prior version remains unchanged in rulesLog history');
    } finally {
        restoreGraph();
        restoreLog();
    }
});

test('Branch 3: LLM-relations при next() пишутся в graph.tmp.json в новом формате (A+B/overlay), graph.json не трогается', async () => {
    const restoreLog = pointRulesLogAtTemp();
    const restoreGraph = pointGraphsAtTemp();
    try {
        const fetch = makeFetch({
            router: routerAnswer(3, 'ноги вместе с прессом 70'),
            ruleUpdate: ruleUpdateAnswer({
                keys: [{ key: 'legs_press_total', role: 'stack' }],
                newKeys: [{ key: 'legs_press_total', chunk: 'ноги вместе с прессом 70', date: DATE, values: { legs_press_total: 70 } }],
                relations: [
                    { type: 'A+B', old: 'press_total', new: 'legs_press_total', note: 'пресс вошёл в сумму' },
                    { type: 'subset', old: 'press_full', new: 'legs_press_total', note: 'усложнение' },
                    { type: 'wat', old: 'a', new: 'b' }, // мусор — отбраковка
                ],
            }),
        });
        const res = await pipeline.next('ноги вместе с прессом 70', { date: DATE, llmOptions: { fetch } });
        assert.equal(res.status, 'success');
        assert.deepEqual(res.payload.relations.map((r) => r.type), ['A+B', 'subset', 'wat']);

        // Temp-слой: связи в новом графовом формате (TC-001), note отброшен.
        // A+B {old,new} → {type:'A+B', base=old, parts=[new], stackOrder:[old, new] (снизу ВВЕРХ)}
        const tmpGraph = JSON.parse(fs.readFileSync(tmpStore._getGraphTmpPath(), 'utf8'));
        assert.ok(tmpGraph.relations.some((r) => JSON.stringify(r) === JSON.stringify({ type: 'A+B', base: 'press_total', parts: ['legs_press_total'], stackOrder: ['press_total', 'legs_press_total'] })),
            'A+B {old,new} → A+B {base, parts, stackOrder}');
        // subset {old,new} → {type:'overlay', base=old, sub=new}
        assert.ok(tmpGraph.relations.some((r) => JSON.stringify(r) === JSON.stringify({ type: 'overlay', base: 'press_full', sub: 'legs_press_total' })),
            'subset → overlay (base=old, sub=new)');
        assert.ok(tmpGraph.relations.some((r) => r.type !== 'part_of'), 'part_of больше не пишется');
        assert.ok(tmpGraph.relations.every((r) => !('note' in r)), 'note не попадает в граф');

        // Main-граф при «Обработать» не пишется (INV-2/3).
        assert.equal(fs.existsSync(pipeline._getGraphFsPath()), false, 'graph.json не создан на next()');
    } finally {
        restoreGraph();
        restoreLog();
    }
});

test('Branch 3 Save: сохраняет пустой graph baseline и только явную overlay-связь', async () => {
    const restoreLog = pointRulesLogAtTemp();
    const restoreGraph = pointGraphsAtTemp();
    try {
        fs.writeFileSync(pipeline._getGraphFsPath(), JSON.stringify({ relations: [], targets: [], trends: [] }), 'utf8');
        const rule = {
            id: rulesLog.nextRuleId(rulesLog.getLatestRules()),
            raw: '100 отжимания (макс подход: 32)',
            mapping: { push_max_set: 'максимум за один подход' },
            examples: [{ input: '100 отжимания (макс подход: 32)', values: { push_max_set: 32 } }],
        };
        const relation = { type: 'overlay', base: 'push_reps', sub: 'push_max_set' };
        const saved = await pipeline.commitRules({
            status: 'success',
            branch: 2,
            confidence: 0.95,
            payload: {
                rule,
                proposal: { rule, rules: [rule], newKeys: [{ key: 'push_max_set' }], relations: [relation] },
                newKeys: [],
                relations: [relation],
            },
        });
        assert.equal(saved.status, 'success');
        const graph = JSON.parse(fs.readFileSync(pipeline._getGraphFsPath(), 'utf8'));
        assert.deepEqual(graph, { relations: [relation] });
    } finally {
        restoreGraph();
        restoreLog();
    }
});

test('Branch 3 → Save: commitRules мержит LLM-связи и temp-связи в graph.json без дублей, temp очищается', async () => {
    const restoreLog = pointRulesLogAtTemp();
    const restoreGraph = pointGraphsAtTemp();
    try {
        // Day 1 may be routed to group 1 only when a matching exercise example
        // exists. The mock parse below still introduces press_full for the
        // Branch 1 Save-path assertion.
        rulesLog.appendRule({
            id: 'known_press_rule', raw: 'пресс 40',
            mapping: { press_basic: 'упражнения на пресс' },
            examples: [{ input: 'пресс 40', values: { press_basic: 40 } }],
        }, 'add');
        // Смешанный прогон: день 1 → группа 1 (новый ключ press_full),
        // день 2 → группа 3 (relations). v9: каждый день — отдельный вызов Router.
        const day1 = 'пресс 40';
        const day2 = 'пресс полный 60';
        const fetch = makeFetch({
            cutter: cutterAnswer([{ raw: day1, date: null }, { raw: day2, date: null }]),
            router: (prompt) => {
                if (prompt.includes(day2)) return routerAnswer(3, day2);
                return routerAnswer(1, day1);
            },
            parse: parseAnswer([{ date: DATE, values: { press_full: 40 } }]),
            ruleUpdate: ruleUpdateAnswer({
                keys: [{ key: 'press_full_extra', role: 'stack' }],
                newKeys: [{ key: 'press_full_extra', chunk: 'пресс полный 60', date: DATE, values: { press_full_extra: 60 } }],
                relations: [
                    { type: 'A+B', old: 'press_basic', new: 'press_full', note: 'полный пресс = база + надстройка' },
                    // Дубль-проверка дедупа temp-графа: subset {old press_total, new press_full}
                    // развернётся в {type:'overlay', base: press_total, sub: press_full};
                    // дедуп по JSON-сигнатуре сохраняется при мерже.
                    { type: 'subset', old: 'press_total', new: 'press_full', note: 'dup-проверка' },
                ],
            }),
        });
        const res = await pipeline.next(`${day1}\n${day2}`, { date: DATE, llmOptions: { fetch } });
        assert.equal(res.status, 'success');
        assert.equal(res.branch, 1, 'доминирующая ветка — 1 (есть дни группы 1)');
        console.log('DBG warnings:', JSON.stringify(res.payload.warnings), 'groups:', JSON.stringify(res.payload.groups));
        assert.ok(Array.isArray(res.payload.relations) && res.payload.relations.length, 'relations прошли в payload');

        // Дубль заранее в temp-графе: та же LLM-связь A+B в новом формате, что придёт
        // из payload → при мерже схлопнется по JSON-сигнатуре.
        tmpStore.appendGraphTmpRelationsFs([
            { type: 'A+B', base: 'press_basic', parts: ['press_full'], stackOrder: ['press_basic', 'press_full'] },
        ]);

        const cr = await pipeline.commitRules(res, {});
        assert.equal(cr.status, 'success');
        assert.equal(cr.added, 2, 'смешанный прогон фиксирует правило Branch 1 и предложение Branch 3');

        const graph = JSON.parse(fs.readFileSync(pipeline._getGraphFsPath(), 'utf8'));
        // Часть 1: LLM-связь A+B смержена в новом формате (base СНИЗУ, parts НАД ней).
        const abSig = JSON.stringify({ type: 'A+B', base: 'press_basic', parts: ['press_full'], stackOrder: ['press_basic', 'press_full'] });
        assert.ok(graph.relations.some((r) => JSON.stringify(r) === abSig),
            'LLM A+B → {base, parts, stackOrder} смержена');
        // Часть 2: LLM subset смержена как overlay.
        assert.ok(graph.relations.some((r) => JSON.stringify(r) === JSON.stringify({ type: 'overlay', base: 'press_total', sub: 'press_full' })),
            'subset → overlay смержена');
        // Часть 3: без дублей (никакая связь не встречается дважды).
        const sigs = graph.relations.map((r) => JSON.stringify(r));
        assert.equal(new Set(sigs).size, sigs.length, 'дубликатов связей нет');
        // Часть 4: синтетических part_of → <группа>_total от ключей больше нет.
        assert.ok(!graph.relations.some((r) => r.type === 'part_of' && String(r.child || '').endsWith('_total')),
            'синтетические part_of → *_total не генерируются');

        // Temp-слой очищен после Save.
        const tmpAfter = tmpStore.readGraphTmpFs();
        assert.equal(tmpAfter.relations.length, 0, 'graph.tmp.json очищен после мержа');
    } finally {
        restoreGraph();
        restoreLog();
    }
});

test('renderRules.relationsFromLLM: маппинг форматов и отбраковка мусора', () => {
    const rr = require('../core/renderRules.js');
    const out = rr.relationsFromLLM([
        { type: 'A+B', old: 'a_x', new: 'b_y', note: 'n' },
        { type: 'subset', old: 'a_x', new: 'b_y' },
        { type: 'A+B', old: 'a_x', new: 'b_y' }, // дубль
        { type: 'A+B', old: '', new: 'b_y' },     // пустой old
        { type: 'A+B', old: 'a_x' },              // нет new
        null,
        { type: 'weird', old: 'a', new: 'b' },    // неизвестный тип
    ]);
    assert.deepEqual(out, [
        // A+B {old,new} → {type:'A+B', base=old, parts=[new], stackOrder:[old, new] (снизу ВВЕРХ)}
        { type: 'A+B', base: 'a_x', parts: ['b_y'], stackOrder: ['a_x', 'b_y'] },
        // subset → overlay
        { type: 'overlay', base: 'a_x', sub: 'b_y' },
        // дубль (та же JSON-сигнатура) схлопнулся
    ]);
    // Новый формат проходит напрямую: parts-набор и stackOrder фильтруются/дополняются.
    assert.deepEqual(rr.relationsFromLLM([
        { type: 'A+B', base: 'm', parts: ['n', 'o'], stackOrder: ['o', 'n', 'm'] },
        { type: 'overlay', base: 'm', sub: 'n' },
    ]), [
        { type: 'A+B', base: 'm', parts: ['n', 'o'], stackOrder: ['o', 'n', 'm'] },
        { type: 'overlay', base: 'm', sub: 'n' },
    ]);
});
