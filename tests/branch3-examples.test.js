'use strict';

const test = require('node:test');
const { beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { buildProposalFromRuleUpdate, confirmProposal } = require('../core/conflict.js');
const pipeline = require('../core/pipeline.js');
const rulesLog = require('../core/rulesLog.js');
const tmpStore = require('../adapters/tmpStore.js');

beforeEach((t) => {
    const originalPath = tmpStore._getRulesTmpPath();
    const originalGraphTmpPath = tmpStore._getGraphTmpPath();
    const originalGraphPath = pipeline._getGraphFsPath();
    const prefix = 'training-branch3-rules-tmp-';
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

const DATE = '2026-09-02';
const EMPTY_RULES = { version: 0, dynamic: [], global: [] };

function updateResponse(newKeys) {
    return {
        status: 'success',
        payload: {
            rule: {
                keys: newKeys.map((item) => ({ key: item.key, meaning: item.key })),
                composition: 'single',
            },
            oldKeysEvents: [],
            newKeys,
            relations: [],
        },
        confidence: 0.95,
    };
}

test('Branch 3 keeps separate exact exercise spans and combines values for equal spans', () => {
    const input = '*09-02* ~6км; 100 отжимания (43+57)';
    const proposal = buildProposalFromRuleUpdate(updateResponse([
        { key: 'running_distance_km', chunk: '~6км', values: { running_distance_km: 6 }, date: DATE },
        { key: 'push_reps', chunk: '100 отжимания (43+57)', values: { push_reps: 43 }, date: DATE },
        { key: 'push_knees_reps', chunk: '100 отжимания (43+57)', values: { push_knees_reps: 57 }, date: DATE },
    ]), input, { date: DATE, rules: EMPTY_RULES });

    assert.deepEqual(proposal.rule.examples, [
        { input: '~6км', values: { running_distance_km: 6 } },
        { input: '100 отжимания (43+57)', values: { push_reps: 43, push_knees_reps: 57 } },
    ]);
    assert.deepEqual(proposal.exampleEvents[0].values, {
        running_distance_km: 6, push_reps: 43, push_knees_reps: 57,
    });
});

test('Branch 3 omits whole-day, missing, and ungrounded examples while retaining values', () => {
    const input = '*09-02* ~6км; 100 отжимания (43+57)';
    const newKeys = [
        { key: 'running_distance_km', chunk: input, values: { running_distance_km: 6 }, date: DATE },
        { key: 'push_reps', values: { push_reps: 43 }, date: DATE },
        { key: 'push_knees_reps', chunk: '100 отжимания (43+57))', values: { push_knees_reps: 57 }, date: DATE },
    ];
    const proposal = buildProposalFromRuleUpdate(updateResponse(newKeys), input, { date: DATE, rules: EMPTY_RULES });

    assert.ok(proposal.rules.every((rule) => rule.examples.length === 0));
    assert.deepEqual(proposal.exampleEvents[0].values, {
        running_distance_km: 6, push_reps: 43, push_knees_reps: 57,
    });
    assert.equal(proposal.newKeys.length, 3, 'unsafe citations do not remove proposed keys');
});

test('Branch 3 omits whole-input citation even for a one-exercise day', () => {
    const input = '100 отжимания (43+57)';
    const proposal = buildProposalFromRuleUpdate(updateResponse([
        { key: 'push_reps', chunk: input, values: { push_reps: 43 }, date: DATE },
        { key: 'push_knees_reps', chunk: input, values: { push_knees_reps: 57 }, date: DATE },
    ]), input, { date: DATE, rules: EMPTY_RULES });

    assert.deepEqual(proposal.rule.examples, []);
    assert.deepEqual(proposal.exampleEvents[0].values, { push_reps: 43, push_knees_reps: 57 });
});

function isolatedLog() {
    const originalPath = rulesLog._getLogPath();
    const tempPath = path.resolve(__dirname, `../data/rulesLog.branch3.${crypto.randomBytes(8).toString('hex')}.tmp.json`);
    fs.writeFileSync(tempPath, JSON.stringify({ version: 0, entries: [] }), 'utf8');
    rulesLog._resetCache();
    rulesLog._setLogPath(tempPath);
    return { tempPath, originalPath, restore() {
        rulesLog._resetCache();
        rulesLog._setLogPath(originalPath);
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } };
}

function unsafeCitedProposal() {
    const input = '*09-02* ~6км; 100 отжимания (43+57)';
    const proposal = buildProposalFromRuleUpdate(updateResponse([
        { key: 'running_distance_km', chunk: input, values: { running_distance_km: 6 }, date: DATE },
        { key: 'push_reps', chunk: input, values: { push_reps: 43 }, date: DATE },
    ]), input, { date: DATE, rules: EMPTY_RULES });
    proposal.input = input;
    proposal.candidate = { values: { running_distance_km: 6, push_reps: 43 } };
    return proposal;
}

test('RuleUpdate confirm does not regenerate a whole-day example when citations were omitted', async () => {
    const log = isolatedLog();
    try {
        const result = await confirmProposal(unsafeCitedProposal());
        assert.equal(result.status, 'success', result.message || JSON.stringify(result));
        const saved = result.payload.entry.rulesSnapshot.dynamic.find((rule) => rule.mapping?.running_distance_km);
        assert.ok(saved);
        assert.deepEqual(saved.examples, []);
    } finally {
        log.restore();
    }
});

test('Save browser fallback does not regenerate a whole-day RuleUpdate example', async () => {
    const log = isolatedLog();
    const directoryPath = path.resolve(__dirname, `../data/rulesLog.branch3.${crypto.randomBytes(8).toString('hex')}.dir`);
    fs.mkdirSync(directoryPath);
    try {
        rulesLog.getRulesLog(); // keep the valid empty log cached before simulating browser fs failure
        rulesLog._setLogPath(directoryPath);
        const proposal = unsafeCitedProposal();
        const result = await pipeline.commitRules({
            status: 'success', branch: 2, confidence: 0.95,
            payload: { proposal, events: proposal.exampleEvents, relations: [] },
        });
        assert.equal(result.status, 'success', result.message || JSON.stringify(result));
        const saved = rulesLog.getLatestRules().dynamic.find((rule) => rule.mapping?.running_distance_km);
        assert.ok(saved);
        assert.deepEqual(saved.examples, []);
    } finally {
        rulesLog._resetCache();
        rulesLog._setLogPath(log.tempPath);
        if (fs.existsSync(directoryPath)) fs.rmdirSync(directoryPath);
        log.restore();
    }
});

test('Branch 3 missing or hallucinated chunk cannot discard the proposed event preview', async () => {
    const originalPath = rulesLog._getLogPath();
    const tempPath = path.resolve(__dirname, `../data/rulesLog.branch3.${crypto.randomBytes(8).toString('hex')}.tmp.json`);
    fs.writeFileSync(tempPath, JSON.stringify({ version: 0, entries: [] }), 'utf8');
    rulesLog._resetCache();
    rulesLog._setLogPath(tempPath);
    const input = '*09-02* 100 отжимания (43+57)';
    const payloads = {
        cutter: { status: 'success', payload: { days: [{ raw: input, date: '09-02' }] }, confidence: 0.9 },
        router: { status: 'success', payload: { groups: [{ group: 3, reasoning: 'new exercise', confidence: 0.9 }] }, confidence: 0.9 },
        ruleUpdate: updateResponse([
            { key: 'push_reps', chunk: '100 отжимания (43+57))', values: { push_reps: 43 }, date: DATE },
            { key: 'push_knees_reps', values: { push_knees_reps: 57 }, date: DATE },
        ]),
    };
    const fetch = async (_url, init = {}) => {
        const prompt = JSON.parse(init.body || '{}').messages?.[0]?.content || '';
        const type = /нарезщик/i.test(prompt) ? 'cutter' : /router:/i.test(prompt) ? 'router' : /ruleupdate/i.test(prompt) ? 'ruleUpdate' : null;
        const answer = type ? JSON.stringify(payloads[type]) : JSON.stringify({ status: 'error', payload: null, confidence: 0 });
        return { ok: true, status: 200, json: async () => ({ message: { content: answer } }) };
    };
    try {
        const result = await pipeline.next(input, { date: DATE, llmOptions: { fetch } });
        assert.equal(result.status, 'success');
        assert.equal(result.payload.events.length, 1);
        assert.deepEqual(result.payload.events[0].values, { push_reps: 43, push_knees_reps: 57 });
        assert.ok(result.payload.rules.every((rule) => rule.examples.length === 0));
    } finally {
        rulesLog._resetCache();
        rulesLog._setLogPath(originalPath);
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    }
});
