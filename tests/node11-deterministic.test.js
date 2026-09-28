'use strict';

// Isolated Branch 3 pseudo-LLM oracle for TC-001's first day.
// No network, Vault, prompt, production, or reference-data writes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const pipeline = require('../core/pipeline.js');
const rulesLog = require('../core/rulesLog.js');
const tmpStore = require('../adapters/tmpStore.js');
const { makeStaging } = require('../adapters/staging.js');

const day = '*05-29*\n- 50 пресс\n- 50 присяд\n- 50 отжимания (+из них около 30 с колен(20+30))\n~5км\n- 25 подтягивания (+из них около 20 австралийскими отжиманиями на кольцах (5+20))';
const expectedValues = {
    press_reps: 50,
    squat_reps: 50,
    push_reps: 20,
    push_knees_reps: 30,
    running_distance_km: 5,
    pull_reps: 5,
    pull_rings_reps: 20,
};

function response(content) {
    return { ok: true, status: 200, json: async () => ({ message: { content: JSON.stringify(content) } }) };
}

function mockFetch() {
    return async (_url, init = {}) => {
        const prompt = JSON.parse(init.body || '{}').messages?.[0]?.content || '';
        if (/нарезщик/i.test(prompt)) {
            return response({ status: 'success', payload: { days: [{ raw: day, date: '05-29' }] }, confidence: 0.99 });
        }
        if (/\brouter\b|роутер/i.test(prompt)) {
            return response({ status: 'success', payload: { groups: [{ chunk: day, group: 3, confidence: 0.99 }] }, confidence: 0.99 });
        }
        if (/RuleUpdate/i.test(prompt)) {
            const rows = [
                ['press_reps', 'пресс', '50 пресс', { press_reps: 50 }],
                ['squat_reps', 'присяд', '50 присяд', { squat_reps: 50 }],
                ['push_reps', 'отжимания обычные', '50 отжимания (+из них около 30 с колен(20+30))', { push_reps: 20, push_knees_reps: 30 }],
                ['push_knees_reps', 'отжимания с колен', '50 отжимания (+из них около 30 с колен(20+30))', { push_reps: 20, push_knees_reps: 30 }],
                ['running_distance_km', 'бег, км', '~5км', { running_distance_km: 5 }],
                ['pull_reps', 'подтягивания обычные', '25 подтягивания (+из них около 20 австралийскими отжиманиями на кольцах (5+20))', { pull_reps: 5, pull_rings_reps: 20 }],
                ['pull_rings_reps', 'подтягивания на кольцах', '25 подтягивания (+из них около 20 австралийскими отжиманиями на кольцах (5+20))', { pull_reps: 5, pull_rings_reps: 20 }],
            ];
            return response({
                status: 'success',
                payload: {
                    rule: { semantics: 'Силовые упражнения, бег и варианты выполнения', keys: rows.map(([key, meaning]) => ({ key, meaning })), composition: 'A+B' },
                    oldKeysEvents: [],
                    newKeys: rows.map(([key, meaning, chunk, values]) => ({ key, meaning, chunk, sourceSpan: chunk, date: '2026-05-29', values })),
                    relations: [
                        { type: 'A+B', base: 'push_reps', parts: ['push_knees_reps'], stackOrder: ['push_reps', 'push_knees_reps'] },
                        { type: 'A+B', base: 'pull_reps', parts: ['pull_rings_reps'], stackOrder: ['pull_reps', 'pull_rings_reps'] },
                    ],
                    confidence: 0.99,
                },
                confidence: 0.99,
            });
        }
        throw new Error('Unexpected Structured call in first TC-001 day');
    };
}

test('TC-001 first-day Branch 3 stages semantically correct proposal in isolated files', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'training-node11-'));
    const resolvedDir = path.resolve(dir);
    assert.ok(resolvedDir.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`));
    assert.match(path.basename(resolvedDir), /^training-node11-/);
    const paths = {
        rulesMain: path.join(dir, 'rulesLog.main.json'),
        graphMain: path.join(dir, 'graph.main.json'),
        rulesTmp: path.join(dir, 'rulesLog.tmp.json'),
        graphTmp: path.join(dir, 'graph.tmp.json'),
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
        for (const file of Object.values(paths)) if (fs.existsSync(file)) fs.unlinkSync(file);
        fs.rmdirSync(dir);
    });

    const fixtureRules = fs.readFileSync(path.resolve(__dirname, '../docs/testing/fixtures/TC-001-empty-state/rulesLog.json'), 'utf8');
    const fixtureGraph = fs.readFileSync(path.resolve(__dirname, '../docs/testing/fixtures/TC-001-empty-state/graph.json'), 'utf8');
    fs.writeFileSync(paths.rulesMain, fixtureRules);
    fs.writeFileSync(paths.graphMain, fixtureGraph);
    fs.writeFileSync(paths.rulesTmp, JSON.stringify({ newKeys: [] }, null, 2));
    fs.writeFileSync(paths.graphTmp, JSON.stringify({ relations: [] }, null, 2));
    const beforeRulesMain = fs.readFileSync(paths.rulesMain, 'utf8');
    const beforeGraphMain = fs.readFileSync(paths.graphMain, 'utf8');

    rulesLog._resetCache();
    rulesLog._setLogPath(paths.rulesMain);
    tmpStore._setRulesTmpPath(paths.rulesTmp);
    tmpStore._setGraphTmpPath(paths.graphTmp);
    pipeline._setGraphFsPath(paths.graphMain);

    const result = await pipeline.next(day, { date: '2026-05-29', llmOptions: { fetch: mockFetch() } });

    assert.equal(result.status, 'success', result.message);
    assert.equal(result.payload.groups[0].group, 3);
    assert.deepEqual(result.payload.events.map(({ date, values }) => ({ date, values })), [
        { date: '2026-05-29', values: expectedValues },
    ]);
    assert.equal(result.payload.rules.length, 1);
    assert.deepEqual(result.payload.rules[0].mapping, {
        press_reps: 'пресс',
        squat_reps: 'присяд',
        push_reps: 'отжимания обычные',
        push_knees_reps: 'отжимания с колен',
        running_distance_km: 'бег, км',
        pull_reps: 'подтягивания обычные',
        pull_rings_reps: 'подтягивания на кольцах',
    });
    assert.equal(result.payload.rules[0].examples.length, 5);
    assert.deepEqual(result.payload.rules[0].examples, [
        { input: '50 пресс', values: { press_reps: 50 } },
        { input: '50 присяд', values: { squat_reps: 50 } },
        { input: '50 отжимания (+из них около 30 с колен(20+30))', values: { push_reps: 20, push_knees_reps: 30 } },
        { input: '~5км', values: { running_distance_km: 5 } },
        { input: '25 подтягивания (+из них около 20 австралийскими отжиманиями на кольцах (5+20))', values: { pull_reps: 5, pull_rings_reps: 20 } },
    ]);

    // The app persists the preview result to the staged event temp, not to main data.
    const vaultFiles = new Map();
    const app = { vault: {
        getAbstractFileByPath: (filePath) => vaultFiles.has(filePath) ? filePath : null,
        read: async (filePath) => vaultFiles.get(filePath),
        create: async (filePath, content) => { vaultFiles.set(filePath, content); },
        modify: async (filePath, content) => { vaultFiles.set(filePath, content); },
    } };
    const staging = makeStaging(app);
    await staging.write(result.payload.events);
    assert.deepEqual(JSON.parse(vaultFiles.get(staging.PATH)).events.map(({ date, values }) => ({ date, values })), [
        { date: '2026-05-29', values: expectedValues },
    ]);

    const graphTmp = JSON.parse(fs.readFileSync(paths.graphTmp, 'utf8'));
    assert.deepEqual(graphTmp.relations, [
        { type: 'A+B', base: 'push_reps', parts: ['push_knees_reps'], stackOrder: ['push_reps', 'push_knees_reps'] },
        { type: 'A+B', base: 'pull_reps', parts: ['pull_rings_reps'], stackOrder: ['pull_reps', 'pull_rings_reps'] },
    ]);
    assert.deepEqual(JSON.parse(fs.readFileSync(paths.rulesMain, 'utf8')), JSON.parse(beforeRulesMain));
    assert.deepEqual(JSON.parse(fs.readFileSync(paths.graphMain, 'utf8')), JSON.parse(beforeGraphMain));

    // The intermediate envelope is not prescribed byte-for-byte, but semantically
    // the proposed rule should be represented in this temp file before Save.
    const rulesTmp = JSON.parse(fs.readFileSync(paths.rulesTmp, 'utf8'));
    const requiredKeys = Object.keys(expectedValues);
    const containsRule = (value) => {
        if (!value || typeof value !== 'object') return false;
        if (Array.isArray(value)) return value.some(containsRule);
        if (value.mapping && requiredKeys.every((key) => Object.hasOwn(value.mapping, key))) return true;
        if (Array.isArray(value.newKeys) && requiredKeys.every((key) => value.newKeys.some((entry) => entry?.key === key))) return true;
        return Object.values(value).some(containsRule);
    };
    assert.ok(containsRule(rulesTmp), 'rulesLog.tmp must semantically stage all seven proposed TC-001 keys');
});
