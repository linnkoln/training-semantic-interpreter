'use strict';

// QA regression: a later-day Router contract error must roll back all earlier
// day temp/cache changes from the current interpret run.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const pipeline = require('../core/pipeline.js');
const rulesLog = require('../core/rulesLog.js');
const tmpStore = require('../adapters/tmpStore.js');
const trace = require('../core/trace.js');

const day1 = '*05-29*\n12 км бег';
const day2 = '*05-31*\nпресс 40';

function llmResponse(content) {
    return { ok: true, status: 200, json: async () => ({ message: { content: JSON.stringify(content) } }) };
}

function pseudoFetch() {
    let routerCalls = 0;
    return async (_url, init = {}) => {
        const prompt = JSON.parse(init.body || '{}').messages?.[0]?.content || '';
        if (/нарезщик/i.test(prompt)) {
            return llmResponse({ status: 'success', payload: { days: [
                { raw: day1, date: '05-29' },
                { raw: day2, date: '05-31' },
            ] }, confidence: 0.99 });
        }
        if (/\brouter\b|роутер/i.test(prompt)) {
            if (routerCalls++ === 0) {
                assert.ok(prompt.includes(day1), 'first Router call receives day 1');
                return llmResponse({ status: 'success', payload: { groups: [{ chunk: day1, group: 3, confidence: 0.99 }] }, confidence: 0.99 });
            }
            assert.ok(prompt.includes(day2), 'second Router call receives day 2');
            return llmResponse({ status: 'error', message: 'mock Router contract failure' });
        }
        if (/RuleUpdate/i.test(prompt)) {
            assert.ok(prompt.includes(day1), 'Branch 3 receives day 1');
            return llmResponse({ status: 'success', payload: {
                rule: { semantics: 'running distance', keys: [{ key: 'running_distance_km', meaning: 'бег, км' }] },
                oldKeysEvents: [],
                newKeys: [{ key: 'running_distance_km', meaning: 'бег, км', chunk: '12 км бег', date: '2026-05-29', values: { running_distance_km: 12 } }],
                relations: [{ type: 'overlay', base: 'running_distance_km', sub: 'run_max' }],
            }, confidence: 0.99 });
        }
        throw new Error(`Unexpected pseudo-LLM prompt: ${prompt.slice(0, 100)}`);
    };
}

test('Router error on day 2 rolls back day 1 rule/graph temps and session rule cache', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'training-node11-error-temp-'));
    const resolvedDir = path.resolve(dir);
    const resolvedTmp = path.resolve(os.tmpdir());
    assert.ok(resolvedDir.startsWith(`${resolvedTmp}${path.sep}`), 'test workspace is below os.tmpdir');
    assert.match(path.basename(resolvedDir), /^training-node11-error-temp-/);

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
        fs.rmSync(resolvedDir, { recursive: true, force: true });
    });

    const fixtureDir = path.resolve(__dirname, '../docs/testing/fixtures/TC-001-empty-state');
    fs.writeFileSync(paths.rulesMain, fs.readFileSync(path.join(fixtureDir, 'rulesLog.json')));
    fs.writeFileSync(paths.graphMain, fs.readFileSync(path.join(fixtureDir, 'graph.json')));
    const initialRulesTmp = Buffer.from(JSON.stringify({ rules: [], newKeys: [{ key: 'legacy_key', source: 'prior-session' }] }, null, 2) + '\n');
    const initialGraphTmp = Buffer.from(JSON.stringify({ relations: [{ type: 'overlay', base: 'legacy_base', sub: 'legacy_sub' }] }, null, 2) + '\n');
    fs.writeFileSync(paths.rulesTmp, initialRulesTmp);
    fs.writeFileSync(paths.graphTmp, initialGraphTmp);
    const initialRulesMain = fs.readFileSync(paths.rulesMain);
    const initialGraphMain = fs.readFileSync(paths.graphMain);

    rulesLog._resetCache();
    rulesLog._setLogPath(paths.rulesMain);
    tmpStore._setRulesTmpPath(paths.rulesTmp);
    tmpStore._setGraphTmpPath(paths.graphTmp);
    pipeline._setGraphFsPath(paths.graphMain);
    trace._setTraceDir(paths.trace);
    const cacheBefore = rulesLog.getRulesLog();

    const result = await pipeline.next(`${day1}\n${day2}`, {
        date: '2026-05-29', llmOptions: { fetch: pseudoFetch() },
    });

    assert.equal(result.status, 'error', 'day 2 Router contract error aborts the run');
    assert.deepEqual(fs.readFileSync(paths.rulesTmp), initialRulesTmp, 'day 1 proposed rule did not remain in rules temp');
    assert.deepEqual(fs.readFileSync(paths.graphTmp), initialGraphTmp, 'day 1 relation did not remain in graph temp');
    assert.deepEqual(fs.readFileSync(paths.rulesMain), initialRulesMain, 'main rules bytes are untouched');
    assert.deepEqual(fs.readFileSync(paths.graphMain), initialGraphMain, 'main graph bytes are untouched');
    assert.deepEqual(rulesLog.getRulesLog(), cacheBefore, 'session cache is restored to its pre-run rules');
});
