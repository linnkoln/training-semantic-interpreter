'use strict';
// tests/tc001-conflict-ruleformat.test.js — расхождение №4: новый формат правила
// { id, raw, mapping, examples } (эталон TC-001/TC-002).
// (1) proposal Branch 3 = {id, raw, mapping, examples без дат};
// (2) formatRecentRules выдаёт raw+mapping+examples;
// (3) appendRule принимает правило нового формата, версия +1;
// (4) TC-002: аппенд newKeys с raw к СУЩЕСТВУЮЩЕМУ rule_001.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const { buildProposalFromRuleUpdate, confirmProposal } = require('../core/conflict.js');

function uniqueTestLogPath() {
    const suffix = crypto.randomBytes(8).toString('hex');
    return path.resolve(__dirname, `../data/rulesLog.tc001.${suffix}.tmp.json`);
}

/** pointRulesLogAt — temp-лог с rule_001 (для TC-002: существующее правило). */
function pointRulesLogAt(tempPath) {
    const rulesLog = require('../core/rulesLog.js');
    const origPath = rulesLog._getLogPath();
    const snapshot = {
        version: 1,
        updatedAt: '2026-01-01T00:00:00.000Z',
        dynamic: [{
            id: 'rule_001',
            __version: 1,
            raw: '| *05-29*<br>- 50 пресс<br>- 50 присяд |',
            mapping: { press_reps: 'пресс', squat_reps: 'присяд' },
            examples: [
                { input: '50 пресс', values: { press_reps: 50 } },
                { input: '50 присяд', values: { squat_reps: 50 } },
            ],
        }],
        global: [],
    };
    const fixtureLog = {
        version: 1,
        updatedAt: snapshot.updatedAt,
        entries: [{
            version: 1,
            timestamp: snapshot.updatedAt,
            changeType: 'init',
            rulesSnapshot: snapshot,
            meta: { description: 'фикстура TC-001/TC-002' },
        }],
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

// ---- Эталон TC-001: multi-group ввод (Branch 3) ----
const RAW = '| *05-29*<br>- 50 пресс<br>- 50 присяд<br>- 50 отжимания (+из них около 30 с колен(20+30))<br>~5км<br>- 25 подтягивания | *05-31*… | *06-02*…';

function tc001Response() {
    return {
        payload: {
            rule: {
                keys: [
                    { key: 'press_reps', role: 'stack', meaning: 'пресс' },
                    { key: 'squat_reps', role: 'stack', meaning: 'присяд' },
                    { key: 'push_reps', role: 'stack', meaning: 'отжимания обычные' },
                    { key: 'push_knees_reps', role: 'overlay', meaning: 'отжимания с колен' },
                    { key: 'running_distance_km', role: 'stack', meaning: 'бег, км' },
                    { key: 'pull_reps', role: 'stack', meaning: 'подтягивания обычные' },
                    { key: 'pull_rings_reps', role: 'stack', meaning: 'подтягивания на кольцах' },
                ],
                composition: 'A+B',
            },
            oldKeysEvents: [],
            newKeys: [
                { key: 'press_reps', meaning: 'пресс', chunk: '50 пресс', values: { press_reps: 50 } },
                { key: 'squat_reps', meaning: 'присяд', chunk: '50 присяд', values: { squat_reps: 50 } },
                { key: 'push_reps', meaning: 'отжимания обычные', chunk: '50 отжимания', values: { push_reps: 50 } },
                { key: 'push_knees_reps', meaning: 'отжимания с колен', chunk: '30 с колен(20+30)', values: { push_knees_reps: 30 } },
                { key: 'running_distance_km', meaning: 'бег, км', chunk: '~5км', values: { running_distance_km: 5 } },
                { key: 'pull_reps', meaning: 'подтягивания обычные', chunk: '25 подтягивания', values: { pull_reps: 25 } },
            ],
            relations: [],
        },
        confidence: 0.9,
    };
}

const EMPTY_RULES = { version: 1, dynamic: [], global: [] };

test('TC-001: proposal Branch 3 = {id, raw, mapping, examples без дат} (запрещены semantics/when/then/roles/__version)', () => {
    const built = buildProposalFromRuleUpdate(tc001Response(), RAW, { rules: EMPTY_RULES });
    assert.ok(built && Array.isArray(built.rules) && built.rules.length >= 1, 'должны быть правила');

    for (const rule of built.rules) {
        // Только {id, raw, mapping, examples}.
        assert.ok(rule.id && /^rule_\d+$/.test(rule.id), 'id rule_NNN');
        assert.equal(rule.raw, RAW, 'raw — полный ввод дословно, один раз');
        assert.ok(rule.mapping && typeof rule.mapping === 'object', 'mapping есть');
        // Запрещённые поля отсутствуют.
        assert.equal(rule.semantics, undefined, 'нет semantics');
        assert.equal(rule.when, undefined, 'нет when');
        assert.equal(rule.then, undefined, 'нет then');
        assert.equal(rule.roles, undefined, 'нет roles');
        assert.equal(rule.__version, undefined, 'нет __version');
        // examples: {input, values} БЕЗ дат.
        assert.ok(Array.isArray(rule.examples) && rule.examples.length >= 1);
        for (const ex of rule.examples) {
            assert.ok(typeof ex.input === 'string' && ex.input.length > 0, 'example.input — кусок формулировки');
            assert.ok(ex.values && typeof ex.values === 'object' && Object.keys(ex.values).length > 0);
            assert.equal(ex.date, undefined, 'в examples НЕТ даты');
            assert.equal(ex.input.includes('*'), false, 'examples — формулировка-кусок, а не дата-колонка');
        }
    }
    // mapping: ключ → кусочек смысла (из LLM-ответа).
    const main = built.rules.find((r) => r.mapping.press_reps);
    assert.ok(main, 'правило с press_reps есть');
    assert.equal(main.mapping.press_reps, 'пресс');
    assert.equal(built.rules.length, 1, 'один входной прогон образует одну версионируемую запись правила');
    assert.equal(built.rules[0].mapping.push_knees_reps, 'отжимания с колен');
    for (const key of ['squat_reps', 'running_distance_km', 'pull_reps', 'pull_rings_reps']) {
        assert.ok(Object.prototype.hasOwnProperty.call(built.rules[0].mapping, key), `общая mapping содержит ${key}`);
    }
});

test('Branch 3 preview aggregates model-proposed sibling values into one dated event', () => {
    const response = {
        status: 'success',
        payload: {
            rule: { keys: [
                { key: 'push_reps', meaning: 'обычные отжимания' },
                { key: 'push_knees_reps', meaning: 'отжимания с колен' },
            ] },
            newKeys: [
                { key: 'push_reps', chunk: '50 отжимания (+из них 30 с колен(20+30))', values: { push_reps: 20 } },
                { key: 'push_knees_reps', chunk: '50 отжимания (+из них 30 с колен(20+30))', values: { push_knees_reps: 30 } },
            ],
            oldKeysEvents: [],
            relations: [],
        },
    };
    const built = buildProposalFromRuleUpdate(response, '05-29 день', {
        rules: EMPTY_RULES,
        rawInput: 'весь дословный прогон',
        date: '2026-05-29',
    });
    assert.equal(built.rule.raw, 'весь дословный прогон');
    assert.equal(built.exampleEvents.length, 1);
    assert.equal(built.exampleEvents[0].date, '2026-05-29');
    assert.deepEqual(built.exampleEvents[0].values, { push_reps: 20, push_knees_reps: 30 });
});

test('Branch 3 retains valid newKeys when rule.keys is empty in the model response', () => {
    const built = buildProposalFromRuleUpdate({
        status: 'success',
        payload: {
            rule: { keys: [] },
            newKeys: [{ key: 'push_max_set', meaning: 'maximum repetitions in one set',
                chunk: 'max 32', values: { push_max_set: 32 } }],
            oldKeysEvents: [],
            relations: [],
        },
    }, 'press 100, max 32', { rules: EMPTY_RULES, date: '2026-05-29' });

    assert.ok(built, 'newKeys сохраняют предложение, даже если rule.keys пуст');
    assert.deepEqual(built.rule.mapping, { push_max_set: 'maximum repetitions in one set' });
    assert.deepEqual(built.rule.examples, [{ input: 'max 32', values: { push_max_set: 32 } }]);
    assert.deepEqual(built.exampleEvents[0].values, { push_max_set: 32 });
});

test('Branch 3 rejects conflicting duplicate model values in a preview date', () => {
    const response = {
        status: 'success',
        payload: {
            rule: { keys: [{ key: 'press_reps', meaning: 'пресс' }] },
            newKeys: [
                { key: 'press_reps', chunk: 'press 30', values: { press_reps: 30 } },
                { key: 'press_reps', chunk: 'press 40', values: { press_reps: 40 } },
            ],
            oldKeysEvents: [],
            relations: [],
        },
    };
    assert.equal(buildProposalFromRuleUpdate(response, 'press', { rules: EMPTY_RULES, date: '2026-05-29' }), null);
});

test('TC-001: formatRecentRules выдаёт raw+mapping+examples (новый формат)', () => {
    const tempPath = uniqueTestLogPath();
    const restore = pointRulesLogAt(tempPath);
    const rulesLog = require('../core/rulesLog.js');
    try {
        const text = rulesLog.formatRecentRules(2);
        const parsed = JSON.parse(text);
        assert.ok(Array.isArray(parsed.rules) && parsed.rules.length >= 1);
        const r = parsed.rules.find((x) => x.id === 'rule_001');
        assert.ok(r, 'rule_001 в срезе');
        assert.ok(typeof r.raw === 'string' && r.raw.includes('50 пресс'), 'raw дословный');
        assert.deepEqual(r.mapping, { press_reps: 'пресс', squat_reps: 'присяд' });
        assert.ok(Array.isArray(r.examples) && r.examples.length === 2);
        assert.deepEqual(r.examples[0], { input: '50 пресс', values: { press_reps: 50 } });
        for (const ex of r.examples) assert.equal(ex.date, undefined, 'в примерах нет даты');
        // Старых полей нет.
        assert.equal(r.semantics, undefined);
        assert.equal(r.cues, undefined);
        assert.equal(r.roles, undefined);
    } finally {
        restore();
    }
});

test('TC-001: appendRule принимает правило нового формата (без when/then), версия +1', () => {
    const tempPath = uniqueTestLogPath();
    const restore = pointRulesLogAt(tempPath);
    const rulesLog = require('../core/rulesLog.js');
    try {
        const before = rulesLog.getVersion();
        const entry = rulesLog.appendRule({
            id: 'rule_002',
            raw: '- 100 отжимания',
            mapping: { push_reps: 'отжимания обычные' },
            examples: [{ input: '100 отжимания', values: { push_reps: 100 } }],
        }, 'add', { proposedBy: 'conflict' });
        assert.equal(entry.version, before + 1, 'версия +1');
        const latest = rulesLog.getLatestRules();
        const added = latest.dynamic.find((r) => r.id === 'rule_002');
        assert.ok(added, 'правило нового формата в логе');
        assert.equal(added.raw, '- 100 отжимания');
        assert.deepEqual(added.mapping, { push_reps: 'отжимания обычные' });
        assert.deepEqual(added.examples, [{ input: '100 отжимания', values: { push_reps: 100 } }]);
        assert.equal(added.when, undefined, 'when не требуется');
        assert.equal(added.then, undefined, 'then не требуется');
        // confirmProposal тоже принимает новый формат.
        return confirmProposal({
            rule: {
                id: 'rule_003',
                raw: '- 25 подтягивания',
                mapping: { pull_reps: 'подтягивания' },
                examples: [{ input: '25 подтягивания', values: { pull_reps: 25 } }],
            },
        }).then((res) => {
            assert.equal(res.status, 'success');
        });
    } finally {
        restore();
    }
});

test('TC-002: аппенд newKeys с raw к СУЩЕСТВУЮЩЕМУ rule_001 (Branch 3, update, версия +1)', () => {
    const tempPath = uniqueTestLogPath();
    const restore = pointRulesLogAt(tempPath);
    const rulesLog = require('../core/rulesLog.js');
    try {
        const before = rulesLog.getVersion();
        const entry = rulesLog.appendRule({
            id: 'rule_001',
            raw: '| *07-17* 100 отжимания (макс подход: 32) | *07-19* 50 подтягивания макс: 6 |',
            mapping: {
                push_max_set: 'отжимания, максимальный подход',
                pull_max_set: 'подтягивания, максимальный подход',
            },
            examples: [
                { input: '100 отжимания (макс подход: 32)', values: { push_max_set: 32 } },
                { input: '50 подтягивания макс: 6', values: { pull_max_set: 6 } },
            ],
        }, 'update', { proposedBy: 'conflict' });
        assert.equal(entry.version, before + 1, 'версия +1');
        const latest = rulesLog.getLatestRules();
        const updated = latest.dynamic.find((r) => r.id === 'rule_001');
        assert.ok(updated, 'rule_001 обновлён');
        assert.equal(updated.__version, 2, '__version монотонно +1');
        assert.ok(updated.raw.includes('07-17'), 'raw обновлён (дословно)');
        assert.equal(updated.mapping.push_max_set, 'отжимания, максимальный подход');
        assert.deepEqual(
            updated.examples.find((e) => e.input === '50 подтягивания макс: 6').values,
            { pull_max_set: 6 }
        );
    } finally {
        restore();
    }
});
