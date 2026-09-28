'use strict';

// Isolated Branch 3 pseudo-LLM oracle for TC-002's 07-21 max-metric day.
// The test uses only temporary filesystem paths and never calls a real LLM/Vault.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const pipeline = require('../core/pipeline.js');
const rulesLog = require('../core/rulesLog.js');
const tmpStore = require('../adapters/tmpStore.js');
const { legacyEmptyRuleLog } = require('./helpers/legacyRuleLog.js');

const day = '*07-21*\n- 100 пресс\n- 100 присяд\n- 100 отжимания (макс подход: 32)\n~10км\n- 50 подтягивания макс: 6';
const oldValues = {
    press_reps: 100,
    squat_reps: 100,
    push_reps: 100,
    running_distance_km: 10,
    pull_reps: 50,
};
const expectedLatestMapping = {
    press_reps: 'пресс',
    squat_reps: 'присяд',
    push_reps: 'отжимания',
    running_distance_km: 'бег, км',
    push_max_set: 'максимальный подход отжиманий',
    pull_reps: 'подтягивания',
    pull_max_set: 'максимальный подход подтягиваний',
};
const expectedLatestExamples = [
    { input: '100 пресс', values: { press_reps: 100 } },
    { input: '100 присяд', values: { squat_reps: 100 } },
    { input: '100 отжимания (макс подход: 32)', values: { push_reps: 100, push_max_set: 32 } },
    { input: '~10км', values: { running_distance_km: 10 } },
    { input: '50 подтягивания макс: 6', values: { pull_reps: 50, pull_max_set: 6 } },
];

function llmResponse(content) {
    return { ok: true, status: 200, json: async () => ({ message: { content: JSON.stringify(content) } }) };
}

function mockFetch() {
    return async (_url, init = {}) => {
        const prompt = JSON.parse(init.body || '{}').messages?.[0]?.content || '';
        if (/нарезщик/i.test(prompt)) {
            return llmResponse({ status: 'success', payload: { days: [{ raw: day, date: '07-21' }] }, confidence: 0.99 });
        }
        if (/\brouter\b|роутер/i.test(prompt)) {
            return llmResponse({ status: 'success', payload: { groups: [{ chunk: day, group: 3, confidence: 0.99 }] }, confidence: 0.99 });
        }
        if (/RuleUpdate/i.test(prompt)) {
            const oldRows = [
                ['press_reps', '100 пресс', 100],
                ['squat_reps', '100 присяд', 100],
                ['push_reps', '100 отжимания (макс подход: 32)', 100],
                ['running_distance_km', '~10км', 10],
                ['pull_reps', '50 подтягивания макс: 6', 50],
            ];
            return llmResponse({
                status: 'success',
                payload: {
                    updateRuleId: 'rule_001',
                    rule: {
                        semantics: 'Тренировки: повторения и максимальный подход',
                        keys: [
                            { key: 'push_max_set', meaning: 'максимальный подход отжиманий' },
                            { key: 'pull_max_set', meaning: 'максимальный подход подтягиваний' },
                        ],
                        // LLM supplies the complete active snapshot so obsolete
                        // knees/rings keys can be retired without code guessing.
                        mapping: {
                            press_reps: 'пресс',
                            squat_reps: 'присяд',
                            push_reps: 'отжимания',
                            running_distance_km: 'бег, км',
                            push_max_set: 'максимальный подход отжиманий',
                            pull_reps: 'подтягивания',
                            pull_max_set: 'максимальный подход подтягиваний',
                        },
                        examples: [
                            { input: '- 100 пресс', values: { press_reps: 100 } },
                            { input: '100 присяд', values: { squat_reps: 100 } },
                            { input: '100 отжимания (макс подход: 32)', values: { push_reps: 100, push_max_set: 32 } },
                            { input: '~10км', values: { running_distance_km: 10 } },
                            { input: '50 подтягивания макс: 6', values: { pull_reps: 50, pull_max_set: 6 } },
                        ],
                        composition: 'max',
                    },
                    oldKeysEvents: oldRows.map(([key, chunk, value]) => ({
                        key,
                        chunk,
                        date: '2026-07-21',
                        values: { [key]: value },
                    })),
                    newKeys: [
                        {
                            key: 'push_max_set',
                            meaning: 'максимальный подход отжиманий',
                            chunk: '100 отжимания (макс подход: 32)',
                            sourceSpan: '100 отжимания (макс подход: 32)',
                            date: '2026-07-21',
                            values: { push_max_set: 32 },
                        },
                        {
                            key: 'pull_max_set',
                            meaning: 'максимальный подход подтягиваний',
                            chunk: '50 подтягивания макс: 6',
                            sourceSpan: '50 подтягивания макс: 6',
                            date: '2026-07-21',
                            values: { pull_max_set: 6 },
                        },
                    ],
                    relations: [
                        { type: 'overlay', base: 'push_reps', sub: 'push_max_set' },
                        { type: 'overlay', base: 'pull_reps', sub: 'pull_max_set' },
                    ],
                    confidence: 0.99,
                },
                confidence: 0.99,
            });
        }
        // Branch 3 reparses the whole day against the pre-update vocabulary.
        return llmResponse({
            status: 'success',
            payload: [{ date: '2026-07-21', values: oldValues }],
            confidence: 0.99,
        });
    };
}

function seedTc001Rulebook(tempLogPath) {
    const seed = legacyEmptyRuleLog();
    rulesLog._resetCache();
    rulesLog._setLogPath(tempLogPath);
    fs.writeFileSync(tempLogPath, JSON.stringify(seed, null, 2));
    const mapping = {
        press_reps: 'пресс',
        squat_reps: 'присяд',
        push_reps: 'отжимания обычные',
        push_knees_reps: 'отжимания с колен',
        running_distance_km: 'бег, км',
        pull_reps: 'подтягивания обычные',
        pull_rings_reps: 'подтягивания на кольцах',
    };
    const baseExamples = [
        { input: '50 пресс', values: { press_reps: 50 } },
        { input: '50 присяд', values: { squat_reps: 50 } },
        { input: '50 отжимания (+из них около 30 с колен(20+30))', values: { push_reps: 20, push_knees_reps: 30 } },
        { input: '~5км', values: { running_distance_km: 5 } },
        { input: '25 подтягивания (+из них около 20 австралийскими отжиманиями на кольцах (5+20))', values: { pull_reps: 5, pull_rings_reps: 20 } },
    ];
    rulesLog.appendRule({ id: 'rule_001', raw: 'TC-001 05-29', mapping, examples: baseExamples }, 'add');
    rulesLog.appendRule({
        id: 'rule_001',
        raw: 'TC-001 05-31',
        mapping,
        examples: [
            ...baseExamples,
            { input: '50 отжимания (10+40)', values: { push_reps: 10, push_knees_reps: 40 } },
            { input: '25 подтягивания (3 + 22)', values: { pull_reps: 3, pull_rings_reps: 22 } },
        ],
    }, 'update');
}

test('TC-002 07-21 Branch 3 stages max event, latest rule update, and overlay graph', async (t) => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'training-tc002-node11-'));
    const resolvedRoot = path.resolve(tempRoot);
    assert.ok(resolvedRoot.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`));
    assert.match(path.basename(resolvedRoot), /^training-tc002-node11-/);

    const paths = {
        rulesMain: path.join(tempRoot, 'rulesLog.main.json'),
        graphMain: path.join(tempRoot, 'graph.main.json'),
        rulesTmp: path.join(tempRoot, 'rulesLog.tmp.json'),
        graphTmp: path.join(tempRoot, 'graph.tmp.json'),
    };
    const original = {
        rulesLog: rulesLog._getLogPath(),
        rulesTmp: tmpStore._getRulesTmpPath(),
        graphTmp: tmpStore._getGraphTmpPath(),
        graphMain: pipeline._getGraphFsPath(),
    };
    t.after(() => {
        rulesLog._resetCache();
        rulesLog._setLogPath(original.rulesLog);
        tmpStore._setRulesTmpPath(original.rulesTmp);
        tmpStore._setGraphTmpPath(original.graphTmp);
        pipeline._setGraphFsPath(original.graphMain);
        for (const filePath of Object.values(paths)) if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        fs.rmdirSync(tempRoot);
    });

    const tc001Graph = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../docs/testing/reference-data/TC-001/graph.json'), 'utf8'));
    fs.writeFileSync(paths.graphMain, JSON.stringify(tc001Graph, null, 2));
    fs.writeFileSync(paths.graphTmp, JSON.stringify({ relations: [] }, null, 2));
    fs.writeFileSync(paths.rulesTmp, JSON.stringify({ rules: [], newKeys: [] }, null, 2));
    seedTc001Rulebook(paths.rulesMain);

    // All production filesystem hooks are redirected before pipeline.next starts.
    tmpStore._setRulesTmpPath(paths.rulesTmp);
    tmpStore._setGraphTmpPath(paths.graphTmp);
    pipeline._setGraphFsPath(paths.graphMain);
    const mainRulesBefore = fs.readFileSync(paths.rulesMain, 'utf8');
    const mainGraphBefore = fs.readFileSync(paths.graphMain, 'utf8');

    const result = await pipeline.next(day, {
        date: '2026-07-21',
        llmOptions: { fetch: mockFetch() },
    });

    assert.equal(result.status, 'success', result.message);
    assert.deepEqual(result.payload.groups.map(({ group }) => group), [3]);
    assert.deepEqual(result.payload.events.map(({ date, values }) => ({ date, values })), [
        {
            date: '2026-07-21',
            values: {
                ...oldValues,
                push_max_set: 32,
                pull_max_set: 6,
            },
        },
    ]);
    assert.ok(!Object.hasOwn(result.payload.events[0].values, 'push_knees_reps'));
    assert.ok(!Object.hasOwn(result.payload.events[0].values, 'pull_rings_reps'));

    const graphTmp = JSON.parse(fs.readFileSync(paths.graphTmp, 'utf8'));
    assert.deepEqual(graphTmp.relations, [
        { type: 'overlay', base: 'push_reps', sub: 'push_max_set' },
        { type: 'overlay', base: 'pull_reps', sub: 'pull_max_set' },
    ]);
    assert.equal(fs.readFileSync(paths.rulesMain, 'utf8'), mainRulesBefore);
    assert.equal(fs.readFileSync(paths.graphMain, 'utf8'), mainGraphBefore);

    const rulesTmp = JSON.parse(fs.readFileSync(paths.rulesTmp, 'utf8'));
    assert.ok(Array.isArray(rulesTmp.rules) && rulesTmp.rules.length === 1, 'rulesLog.tmp contains the update proposal');
    const proposed = rulesTmp.rules[0];
    assert.equal(proposed.id, 'rule_001');
    assert.equal(proposed.completeSnapshot, true);
    assert.deepEqual(proposed.mapping, expectedLatestMapping,
        'latest rule keeps active old keys, adds max keys, and drops old knees/rings keys');
    assert.deepEqual(proposed.examples, expectedLatestExamples,
        'latest rule examples describe the five current 07-21 measurements');
});
