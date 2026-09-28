'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, readJson, clone, diff, runtimeRules, ruleProjection, makeTransport, compareRun } = require('../tools/model-eval/lib.cjs');
const { aggregate, completionExitCode, parseArgs } = require('../tools/run_model_matrix.cjs');

test('evaluation differences preserve absent vs zero, unexpected fields and array order', () => {
    assert.equal(diff({ values: {} }, { values: { knees: 0 } })[0].kind, 'unexpected');
    assert.equal(diff({ count: 1 }, {})[0].kind, 'missing');
    assert.equal(diff([1, 2], [2, 1]).length, 2);
    assert.equal(diff({ a: 1, b: 2 }, { b: 2, a: 1 }).length, 0);
    assert.equal(diff({ a: [1] }, { a: [1], metadata: true })[0].path, '/metadata');
});

test('reference adapter preserves all old versions without mutating fixture', () => {
    const reference = readJson(path.join(ROOT, 'docs/testing/fixtures/TC-002-after-TC-001/rulesLog.json'));
    const original = clone(reference);
    const runtime = runtimeRules(reference);
    assert.deepEqual(reference, original);
    assert.equal(runtime.entries.length, 2);
    assert.deepEqual(ruleProjection(runtime), ruleProjection(reference).map(rule => ({ ...rule, ruleCount: 1 })));
    runtime.entries[0].rulesSnapshot.dynamic[0].mapping.press_reps = 'changed';
    assert.deepEqual(reference, original);
});

function scratch(t) {
    const parent = path.join(ROOT, 'work/model-eval');
    fs.mkdirSync(parent, { recursive: true });
    const directory = fs.mkdtempSync(path.join(parent, 'unit-'));
    t.after(() => {
        const resolved = path.resolve(directory);
        assert.ok(resolved.startsWith(parent + path.sep) && path.basename(resolved).startsWith('unit-'));
        fs.rmSync(resolved, { recursive: true });
    });
    return directory;
}
const profile = { id: 'unit-profile', model: 'candidate', endpoint: 'http://localhost:11434/api/chat',
    think: false, options: { temperature: 0, num_ctx: 8192, num_predict: 100 }, timeoutMs: 1000 };

test('transport records actual profile overrides, raw failure and server timing without repairing responses', async t => {
    let request;
    const directory = scratch(t);
    const transport = makeTransport({ profile, directory, stage: () => 'router', snapshot: () => ({ rules: [] }),
        fetchImpl: async (url, init) => {
            request = JSON.parse(init.body);
            assert.equal(init.redirect, 'error');
            return new Response(JSON.stringify({ done: true, done_reason: 'length', message: { content: '{broken' },
                eval_count: 100, eval_duration: 2000000000, load_duration: 4000000000 }), { status: 200 });
        } });
    const response = await transport.fetch(profile.endpoint, { body: JSON.stringify({ model: 'wrong-default', options: { temperature: 1 }, messages: [{ role: 'user', content: 'test' }] }) });
    assert.equal((await response.json()).message.content, '{broken');
    assert.equal(request.model, 'candidate');
    assert.equal(request.think, false);
    assert.equal(request.options.temperature, 0);
    assert.equal(transport.calls[0].finishReason, 'length');
    assert.equal(transport.calls[0].parsed.status, 'error');
    assert.equal(transport.calls[0].metrics.loadMs, 4000);
    assert.equal(transport.calls[0].metrics.tokensPerSecond, 50);
    await assert.rejects(transport.fetch('http://example.com/api/chat', {}), /local Ollama/);
    assert.equal(transport.calls.length, 1);
});

test('transport failure is captured once; evaluator does not hide it with retries', async t => {
    const directory = scratch(t);
    const transport = makeTransport({ profile, directory, stage: () => 'cutter', snapshot: () => ({}),
        fetchImpl: async () => { throw new Error('test timeout'); } });
    await assert.rejects(transport.fetch(profile.endpoint, { body: JSON.stringify({ messages: [] }) }), /test timeout/);
    assert.equal(transport.calls.length, 1);
    assert.equal(transport.calls[0].error.message, 'test timeout');
    assert.equal(readJson(path.join(directory, 'call-001.json')).error.message, 'test timeout');
});

test('matrix summaries cannot turn incomplete runs or partial checks into PASS', () => {
    const reports = [{ profileId: 'a', caseId: 'TC-001', repeat: 1, automaticVerdict: 'PASS', previewMs: 1000,
        checks: [{ name: 'events', status: 'PASS' }, { name: 'router.groups', status: 'PASS' }], calls: [] }];
    const rows = aggregate(reports, [{ id: 'a' }], [{ caseId: 'TC-001' }], 3);
    assert.equal(rows[0].verdict, 'NOT_RUN');
    assert.equal(rows[0].recommendation, 'NOT_QUALIFIED');
    assert.equal(rows[0].semanticVerdict, 'NOT_REVIEWED');
    assert.throws(() => parseArgs(['--repeats', '0']), /Repeats/);
    assert.throws(() => parseArgs(['--profiles']), /Missing/);
    assert.equal(completionExitCode([{ verdict: 'PASS' }], [{ automaticVerdict: 'PASS' }]), 0);
    assert.equal(completionExitCode(rows, reports), 1);
    assert.equal(completionExitCode([{ verdict: 'FAIL' }], [{ automaticVerdict: 'INFRA_ERROR' }]), 2);
});

test('correct preview cannot PASS an unexecuted or failed serialization step', () => {
    const item = readJson(path.join(ROOT, 'docs/testing/model-evaluation/CASE_MANIFEST.json')).cases[0];
    const expected = { data: readJson(path.join(ROOT, item.oracle.directory, 'data.json')) };
    const result = { status: 'success', payload: { groups: item.expectedRouterGroups.map(group => ({ group })), events: [...expected.data].reverse() } };
    const calls = [{ stageId: 'cutter', parsed: { payload: { days: item.expectedCutterDays } }, httpStatus: 200, done: true, finishReason: 'stop' }];
    const input = { item, expected, result, calls, before: {}, afterPreview: {} };
    assert.equal(compareRun({ ...input, saved: { status: 'NOT_RUN', reason: 'not executed' } }).automaticVerdict, 'NOT_RUN');
    assert.equal(compareRun({ ...input, saved: { status: 'ERROR', reason: 'write failed' } }).automaticVerdict, 'FAIL');
});

test('core worker processes TC-002 in scratch, matches full oracle and preserves seed', async t => {
    const directory = scratch(t);
    const manifest = readJson(path.join(ROOT, 'docs/testing/model-evaluation/CASE_MANIFEST.json'));
    const item = manifest.cases.find(item => item.caseId === 'TC-002');
    const seedFile = path.join(ROOT, item.initialState.directory, 'rulesLog.json');
    const seedBefore = fs.readFileSync(seedFile);
    const oracle = readJson(path.join(ROOT, item.oracle.directory, 'rulesLog.json')).rules.at(-1);
    const events = readJson(path.join(ROOT, item.oracle.directory, 'data.json')).slice(0, 3).reverse();
    let routes = 0;
    let parses = 0;
    const fetchImpl = async (_url, init) => {
        const prompt = JSON.parse(init.body).messages[0].content;
        let payload;
        if (/нарезщик/i.test(prompt)) payload = { days: item.expectedCutterDays };
        else if (/\brouter\b|роутер/i.test(prompt)) {
            payload = { groups: [{ chunk: item.expectedCutterDays[routes].raw, group: [1, 1, 3][routes++], confidence: 1 }] };
        } else if (/RuleUpdate/i.test(prompt)) {
            const raw = item.expectedCutterDays[2].raw;
            payload = { updateRuleId: 'rule_001', rule: { keys: ['push_max_set', 'pull_max_set'].map(key => ({ key, meaning: oracle.mapping[key] })),
                mapping: oracle.mapping, examples: oracle.examples, composition: 'max' },
                oldKeysEvents: oracle.examples.map(example => {
                    const values = Object.fromEntries(Object.entries(example.values)
                        .filter(([key]) => !['push_max_set', 'pull_max_set'].includes(key)));
                    return { key: Object.keys(values)[0], chunk: example.input, date: '2026-07-21', values };
                }),
                newKeys: ['push_max_set', 'pull_max_set'].map(key => {
                    const example = oracle.examples.find(example => Object.hasOwn(example.values, key));
                    assert.ok(raw.includes(example.input));
                    return { key, meaning: oracle.mapping[key], chunk: example.input, sourceSpan: example.input,
                        date: '2026-07-21', values: { [key]: example.values[key] } };
                }), relations: [{ type: 'overlay', base: 'push_reps', sub: 'push_max_set' }, { type: 'overlay', base: 'pull_reps', sub: 'pull_max_set' }] };
        } else {
            const event = clone(events[parses++]);
            if (event.date === '2026-07-21') { delete event.values.push_max_set; delete event.values.pull_max_set; }
            payload = [event];
        }
        return new Response(JSON.stringify({ done: true, done_reason: 'stop', message: { content: JSON.stringify({ status: 'success', payload, confidence: 1 }) },
            load_duration: 0, eval_count: 100, eval_duration: 1000000000 }), { status: 200 });
    };
    const originalLog = console.log;
    console.log = () => {};
    let report;
    try { report = await require('../tools/model-eval/worker.cjs').runWorker({ runDir: directory, item, profile, repeat: 1 }, fetchImpl); }
    finally { console.log = originalLog; }
    assert.equal(report.isolationVerdict, 'PASS');
    assert.deepEqual(report.groups, [1, 1, 3]);
    assert.equal(report.checks.find(check => check.name === 'events').status, 'PASS');
    assert.equal(report.savedStatus, 'SAVED', report.saveError);
    assert.equal(report.checks.find(check => check.name === 'saved.graph').status, 'PASS');
    assert.equal(report.automaticVerdict, 'PASS', JSON.stringify(report.checks.filter(check => check.status !== 'PASS')));
    assert.deepEqual(fs.readFileSync(seedFile), seedBefore);
    assert.ok(fs.existsSync(path.join(directory, 'review-packet.json')));
});
