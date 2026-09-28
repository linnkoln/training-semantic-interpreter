'use strict';

// Isolated three-day TC-001 pseudo-LLM cycle: Branch 3 → Branch 2 → Branch 1.
// Every filesystem hook is redirected into a private os.tmpdir directory.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const pipeline = require('../core/pipeline.js');
const rulesLog = require('../core/rulesLog.js');
const tmpStore = require('../adapters/tmpStore.js');
const trace = require('../core/trace.js');
const { makeStaging } = require('../adapters/staging.js');

const day1 = '*05-29*\n- 50 пресс\n- 50 присяд\n- 50 отжимания (+из них около 30 с колен(20+30))\n~5км\n- 25 подтягивания (+из них около 20 австралийскими отжиманиями на кольцах (5+20))';
const day2 = '*05-31*\nкорпус и выше болит и клининт НО\n- 50 пресс\n- 50 присяд\n- 50 отжимания (10+40)\n~5км\n- 25 подтягивания (3 + 22)';
const day3 = '*06-02*\n- 50 пресс\n- 50 присяд\n- 50 отжимания (11+39)\n~5км\n- 25 подтягивания (3 + 22)';
const expectedEvents = [
    { date: '2026-05-29', values: {
        press_reps: 50, squat_reps: 50, push_reps: 20, push_knees_reps: 30,
        running_distance_km: 5, pull_reps: 5, pull_rings_reps: 20,
    } },
    { date: '2026-05-31', values: {
        press_reps: 50, squat_reps: 50, push_reps: 10, push_knees_reps: 40,
        running_distance_km: 5, pull_reps: 3, pull_rings_reps: 22,
    } },
    { date: '2026-06-02', values: {
        press_reps: 50, squat_reps: 50, push_reps: 11, push_knees_reps: 39,
        running_distance_km: 5, pull_reps: 3, pull_rings_reps: 22,
    } },
];

function llmResponse(content) {
    return { ok: true, status: 200, json: async () => ({ message: { content: JSON.stringify(content) } }) };
}

function pseudoFetch({ failFirstRuleUpdate = false } = {}) {
    let routeIndex = 0;
    let parseIndex = 0;
    let ruleUpdateIndex = 0;
    const routes = failFirstRuleUpdate ? [3, 3, 1] : [3, 2, 1];
    return async (_url, init = {}) => {
        const prompt = JSON.parse(init.body || '{}').messages?.[0]?.content || '';
        if (/нарезщик/i.test(prompt)) {
            return llmResponse({ status: 'success', payload: { days: [
                { raw: day1, date: '05-29' },
                { raw: day2, date: '05-31' },
                { raw: day3, date: '06-02' },
            ] }, confidence: 0.99 });
        }
        if (/\brouter\b|роутер/i.test(prompt)) {
            const day = [day1, day2, day3][routeIndex];
            const group = routes[routeIndex++];
            assert.ok(day && prompt.includes(day), `Router call ${routeIndex} receives its one source day`);
            return llmResponse({ status: 'success', payload: { groups: [{ chunk: day, group, confidence: 0.99 }] }, confidence: 0.99 });
        }
        if (/Минорное дополнение правил/i.test(prompt)) {
            assert.ok(prompt.includes(day2), 'Branch 2 receives day 2');
            return llmResponse({ status: 'success', payload: { appends: [
                { key: 'push_reps', chunk: '50 отжимания (10+40)', exampleText: '50 отжимания (10+40)', values: { push_reps: 10, push_knees_reps: 40 } },
                { key: 'pull_reps', chunk: '25 подтягивания (3 + 22)', exampleText: '25 подтягивания (3 + 22)', values: { pull_reps: 3, pull_rings_reps: 22 } },
            ] }, confidence: 0.99 });
        }
        if (/RuleUpdate/i.test(prompt)) {
            const thisRuleUpdate = ruleUpdateIndex++;
            if (failFirstRuleUpdate && thisRuleUpdate === 0) {
                return llmResponse({ status: 'success', payload: {
                    rule: { keys: [], composition: 'A+B' }, oldKeysEvents: [], newKeys: [], relations: [],
                }, confidence: 0.99 });
            }
            const sourceDay = thisRuleUpdate === 0 ? day1 : day2;
            assert.ok(prompt.includes(sourceDay), `Branch 3 receives source day ${thisRuleUpdate + 1}`);
            const rows = (sourceDay === day1 ? [
                ['press_reps', 'пресс', '50 пресс', { press_reps: 50 }],
                ['squat_reps', 'присяд', '50 присяд', { squat_reps: 50 }],
                ['push_reps', 'отжимания обычные', '50 отжимания (+из них около 30 с колен(20+30))', { push_reps: 20, push_knees_reps: 30 }],
                ['push_knees_reps', 'отжимания с колен', '50 отжимания (+из них около 30 с колен(20+30))', { push_reps: 20, push_knees_reps: 30 }],
                ['running_distance_km', 'бег, км', '~5км', { running_distance_km: 5 }],
                ['pull_reps', 'подтягивания обычные', '25 подтягивания (+из них около 20 австралийскими отжиманиями на кольцах (5+20))', { pull_reps: 5, pull_rings_reps: 20 }],
                ['pull_rings_reps', 'подтягивания на кольцах', '25 подтягивания (+из них около 20 австралийскими отжиманиями на кольцах (5+20))', { pull_reps: 5, pull_rings_reps: 20 }],
            ] : [
                ['press_reps', 'пресс', '50 пресс', { press_reps: 50 }],
                ['squat_reps', 'присяд', '50 присяд', { squat_reps: 50 }],
                ['push_reps', 'отжимания обычные', '50 отжимания (10+40)', { push_reps: 10, push_knees_reps: 40 }],
                ['push_knees_reps', 'отжимания с колен', '50 отжимания (10+40)', { push_reps: 10, push_knees_reps: 40 }],
                ['running_distance_km', 'бег, км', '~5км', { running_distance_km: 5 }],
                ['pull_reps', 'подтягивания обычные', '25 подтягивания (3 + 22)', { pull_reps: 3, pull_rings_reps: 22 }],
                ['pull_rings_reps', 'подтягивания на кольцах', '25 подтягивания (3 + 22)', { pull_reps: 3, pull_rings_reps: 22 }],
            ]);
            const snapshotExamples = [
                { input: '50 пресс', values: { press_reps: 50 } },
                { input: '50 присяд', values: { squat_reps: 50 } },
                { input: rows[2][2], values: {
                    push_reps: sourceDay === day1 ? 20 : 10,
                    push_knees_reps: sourceDay === day1 ? 30 : 40,
                } },
                { input: '~5км', values: { running_distance_km: 5 } },
                // Mirrors the live Gemma answer: one extra closing parenthesis makes
                // this citation fail an exact-source check, while its values are valid.
                { input: sourceDay === day1
                    ? '25 подтягивания (+из них около 20 австралийскими отжиманиями на кольцах (5+20)))'
                    : '25 подтягивания (3 + 22)',
                values: sourceDay === day1 ? { pull_reps: 5, pull_rings_reps: 20 } : { pull_reps: 3, pull_rings_reps: 22 } },
            ];
            return llmResponse({ status: 'success', payload: {
                rule: {
                        semantics: 'силовые упражнения и бег',
                        keys: rows.map(([key, meaning]) => ({ key, meaning })),
                        mapping: Object.fromEntries(rows.map(([key, meaning]) => [key, meaning])),
                        examples: snapshotExamples,
                        composition: 'A+B',
                    },
                oldKeysEvents: [],
                newKeys: rows.map(([key, meaning, chunk, values]) => ({ key, meaning, chunk, date: sourceDay === day1 ? '2026-05-29' : '2026-05-31', values })),
                relations: [
                    { type: 'A+B', base: 'push_reps', parts: ['push_knees_reps'], stackOrder: ['push_reps', 'push_knees_reps'] },
                    { type: 'A+B', base: 'pull_reps', parts: ['pull_rings_reps'], stackOrder: ['pull_reps', 'pull_rings_reps'] },
                ],
                confidence: 0.99,
            }, confidence: 0.99 });
        }
        if (/Structured/i.test(prompt) || /JSON для графика/i.test(prompt)
            || /Режим ПЕРЕВОДА В JSON/i.test(prompt) || prompt.includes('режим разбора')) {
            const candidate = prompt.includes(day2)
                ? { date: '2026-05-31', values: expectedEvents[1].values }
                : { date: '2026-06-02', values: expectedEvents[2].values };
            parseIndex++;
            return llmResponse({ status: 'success', payload: [candidate], confidence: 0.99 });
        }
        throw new Error(`Unexpected pseudo-LLM prompt: ${prompt.slice(0, 100)}`);
    };
}

test('TC-001 three-day Branch 3 → 2 → 1 cycle is isolated and stages the expected data', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'training-node11-cycle-'));
    const resolvedDir = path.resolve(dir);
    const resolvedTmp = path.resolve(os.tmpdir());
    assert.ok(resolvedDir.startsWith(`${resolvedTmp}${path.sep}`), 'test writes stay below os.tmpdir');
    assert.match(path.basename(resolvedDir), /^training-node11-cycle-/);
    const paths = {
        rulesMain: path.join(dir, 'rulesLog.main.json'),
        graphMain: path.join(dir, 'graph.main.json'),
        rulesTmp: path.join(dir, 'rulesLog.tmp.json'),
        graphTmp: path.join(dir, 'graph.tmp.json'),
        trace: path.join(dir, 'trace'),
    };
    const original = {
        rulesMain: rulesLog._getLogPath(),
        rulesTmp: tmpStore._getRulesTmpPath(),
        graphTmp: tmpStore._getGraphTmpPath(),
        graphMain: pipeline._getGraphFsPath(),
        traceDir: trace._getTraceDir(),
    };
    t.after(() => {
        rulesLog._resetCache();
        rulesLog._setLogPath(original.rulesMain);
        tmpStore._setRulesTmpPath(original.rulesTmp);
        tmpStore._setGraphTmpPath(original.graphTmp);
        pipeline._setGraphFsPath(original.graphMain);
        trace._setTraceDir(original.traceDir);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    const fixtureDir = path.resolve(__dirname, '../docs/testing/fixtures/TC-001-empty-state');
    fs.writeFileSync(paths.rulesMain, fs.readFileSync(path.join(fixtureDir, 'rulesLog.json')));
    fs.writeFileSync(paths.graphMain, fs.readFileSync(path.join(fixtureDir, 'graph.json')));
    fs.writeFileSync(paths.rulesTmp, JSON.stringify({ rules: [], newKeys: [] }));
    fs.writeFileSync(paths.graphTmp, JSON.stringify({ relations: [] }));
    const rulesMainBytes = fs.readFileSync(paths.rulesMain);
    const graphMainBytes = fs.readFileSync(paths.graphMain);

    rulesLog._resetCache();
    rulesLog._setLogPath(paths.rulesMain);
    tmpStore._setRulesTmpPath(paths.rulesTmp);
    tmpStore._setGraphTmpPath(paths.graphTmp);
    pipeline._setGraphFsPath(paths.graphMain);
    trace._setTraceDir(paths.trace);

    const result = await pipeline.next([day1, day2, day3].join('\n'), {
        date: '2026-05-29', llmOptions: { fetch: pseudoFetch() },
    });

    assert.equal(result.status, 'success', result.message || JSON.stringify(result.payload?.warnings));
    assert.deepEqual(result.payload.groups.map((group) => group.group), [3, 2, 1]);
    assert.deepEqual(result.payload.events.map(({ date, values }) => ({ date, values })), expectedEvents);
    assert.equal(result.payload.failedDays, undefined, 'a bad model citation drops only that example, not the day');
    assert.equal(result.payload.rules.length, 1, 'Branch 3 proposes one combined seven-key rule');
    assert.equal(Object.keys(result.payload.rules[0].mapping).length, 7);
    assert.deepEqual(result.payload.events.map((event) => event.date), ['2026-05-29', '2026-05-31', '2026-06-02']);

    const rulesTmp = tmpStore.readRulesTmpFs(paths.rulesTmp);
    assert.equal(rulesTmp.rules.length, 1);
    assert.equal(Object.keys(rulesTmp.rules[0].mapping).length, 7);
    assert.equal(rulesTmp.newKeys.length, 2, 'Branch 2 stages two exercise-specific forms');
    assert.ok(rulesTmp.newKeys.some((item) => item.key === 'push_reps' && item.exampleText === '50 отжимания (10+40)'
        && item.values.push_reps === 10 && item.values.push_knees_reps === 40));
    assert.ok(rulesTmp.newKeys.some((item) => item.key === 'pull_reps' && item.exampleText === '25 подтягивания (3 + 22)'
        && item.values.pull_reps === 3 && item.values.pull_rings_reps === 22));

    const graphTmp = JSON.parse(fs.readFileSync(paths.graphTmp, 'utf8'));
    assert.deepEqual(graphTmp.relations, [
        { type: 'A+B', base: 'push_reps', parts: ['push_knees_reps'], stackOrder: ['push_reps', 'push_knees_reps'] },
        { type: 'A+B', base: 'pull_reps', parts: ['pull_rings_reps'], stackOrder: ['pull_reps', 'pull_rings_reps'] },
    ]);
    assert.deepEqual(Object.keys(graphTmp), ['relations']);

    const vaultFiles = new Map();
    const app = { vault: {
        getAbstractFileByPath: (filePath) => vaultFiles.has(filePath) ? filePath : null,
        read: async (filePath) => vaultFiles.get(filePath),
        create: async (filePath, content) => { vaultFiles.set(filePath, content); },
        modify: async (filePath, content) => { vaultFiles.set(filePath, content); },
    } };
    const staging = makeStaging(app);
    await staging.write(result.payload.events);
    assert.deepEqual(JSON.parse(vaultFiles.get(staging.PATH)).events.map(({ date, values }) => ({ date, values })), expectedEvents);

    assert.deepEqual(fs.readFileSync(paths.rulesMain), rulesMainBytes, 'main rules bytes are unchanged before Save');
    assert.deepEqual(fs.readFileSync(paths.graphMain), graphMainBytes, 'main graph bytes are unchanged before Save');
});

test('TC-001 partial cycle reports a failed day with its date while retaining later events', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'training-node11-day-loss-'));
    const paths = {
        rulesMain: path.join(dir, 'rulesLog.main.json'),
        graphMain: path.join(dir, 'graph.main.json'),
        rulesTmp: path.join(dir, 'rulesLog.tmp.json'),
        graphTmp: path.join(dir, 'graph.tmp.json'),
        trace: path.join(dir, 'trace'),
    };
    const original = {
        rulesMain: rulesLog._getLogPath(), rulesTmp: tmpStore._getRulesTmpPath(),
        graphTmp: tmpStore._getGraphTmpPath(), graphMain: pipeline._getGraphFsPath(), traceDir: trace._getTraceDir(),
    };
    t.after(() => {
        rulesLog._resetCache();
        rulesLog._setLogPath(original.rulesMain);
        tmpStore._setRulesTmpPath(original.rulesTmp);
        tmpStore._setGraphTmpPath(original.graphTmp);
        pipeline._setGraphFsPath(original.graphMain);
        trace._setTraceDir(original.traceDir);
        fs.rmSync(dir, { recursive: true, force: true });
    });
    const fixtureDir = path.resolve(__dirname, '../docs/testing/fixtures/TC-001-empty-state');
    fs.writeFileSync(paths.rulesMain, fs.readFileSync(path.join(fixtureDir, 'rulesLog.json')));
    fs.writeFileSync(paths.graphMain, fs.readFileSync(path.join(fixtureDir, 'graph.json')));
    fs.writeFileSync(paths.rulesTmp, JSON.stringify({ rules: [], newKeys: [] }));
    fs.writeFileSync(paths.graphTmp, JSON.stringify({ relations: [] }));
    rulesLog._resetCache();
    rulesLog._setLogPath(paths.rulesMain);
    tmpStore._setRulesTmpPath(paths.rulesTmp);
    tmpStore._setGraphTmpPath(paths.graphTmp);
    pipeline._setGraphFsPath(paths.graphMain);
    trace._setTraceDir(paths.trace);

    const result = await pipeline.next([day1, day2, day3].join('\n'), {
        date: '2026-05-29', llmOptions: { fetch: pseudoFetch({ failFirstRuleUpdate: true }) },
    });
    assert.equal(result.status, 'success', result.message);
    assert.deepEqual(result.payload.events.map((event) => event.date), ['2026-05-31', '2026-06-02']);
    assert.deepEqual(result.payload.failedDays, [{
        dayIndex: 1, date: '2026-05-29', reason: 'Не удалось построить правило из ответа LLM',
    }]);
});
