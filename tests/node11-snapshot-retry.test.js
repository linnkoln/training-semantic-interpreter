'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { proposeRule } = require('../core/conflict.js');

const INPUT = '*07-21*<br>- run 1<br>- lift 2';
const RULES = { version: 1, dynamic: [{ id: 'rule_001', mapping: { run_km: 'running' }, examples: [] }], global: [] };

function payload(snapshot, extras = {}) {
    return {
        updateRuleId: 'rule_001',
        rule: {
            keys: [
                { key: 'run_km', meaning: 'running distance' },
                { key: 'lift_reps', meaning: 'lift repetitions' },
            ], composition: 'single', ...snapshot,
        },
        oldKeysEvents: [{ key: 'run_km', chunk: 'run 1', values: { run_km: 1 } }],
        newKeys: [{ key: 'lift_reps', meaning: 'lift repetitions', chunk: 'lift 2', values: { lift_reps: 2 } }],
        relations: [], ...extras,
    };
}

function answer(value) {
    return { ok: true, status: 200, json: async () => ({ message: { content: JSON.stringify(value) } }) };
}

const validSnapshot = {
    mapping: { run_km: 'running distance', lift_reps: 'lift repetitions' },
    examples: [
        { input: 'run 1', values: { run_km: 1 } },
        { input: 'lift 2', values: { lift_reps: 2 } },
    ],
};

test('Node11 update: inconsistent complete snapshot gets one compact retry and uses verified snapshot', async () => {
    const requests = [];
    const first = payload({
        mapping: { run_km: 'running', lift_reps: 'lift', retired_old_key: 'historic' },
        examples: [{ input: 'lift 2', values: { lift_reps: 2 } }],
    });
    const fetch = async (_url, init) => {
        const body = JSON.parse(init.body);
        requests.push(body.messages[0].content);
        return answer(requests.length === 1 ? { status: 'success', payload: first } : { status: 'success', payload: { rule: validSnapshot } });
    };

    const result = await proposeRule(INPUT, { rules: RULES, llmOptions: { fetch, retryDelays: [] } });
    assert.equal(result.status, 'success');
    assert.equal(requests.length, 2);
    assert.equal(result.payload.rule.completeSnapshot, true);
    assert.deepEqual(result.payload.rule.mapping, validSnapshot.mapping);
    assert.match(requests[1], /oldKeysEvents/);
    assert.match(requests[1], /Original raw input[\s\S]*run 1<br>- lift 2/);
    assert.match(requests[1], /Readable view[\s\S]*run 1\n- lift 2/);
    assert.doesNotMatch(requests[1], /retired_old_key|historic"/);
});

test('Node11 update: consistent snapshot is accepted without a second call', async () => {
    let count = 0;
    const fetch = async () => {
        count += 1;
        return answer({ status: 'success', payload: payload(validSnapshot) });
    };
    const result = await proposeRule(INPUT, { rules: RULES, llmOptions: { fetch, retryDelays: [] } });
    assert.equal(result.status, 'success');
    assert.equal(count, 1);
});

test('Node11 update: retry rejects examples returned as strings and fails closed', async () => {
    let count = 0;
    const first = payload({ mapping: { run_km: 'running', lift_reps: 'lift', retired: 'old' }, examples: [] });
    const fetch = async () => {
        count += 1;
        return answer({ status: 'success', payload: count === 1 ? first : { rule: {
            mapping: validSnapshot.mapping,
            examples: ['run 1', 'lift 2'],
        } } });
    };
    const result = await proposeRule(INPUT, { rules: RULES, llmOptions: { fetch, retryDelays: [] } });
    assert.equal(result.status, 'error');
    assert.equal(result.payload, null);
    assert.equal(count, 2);
});

test('Node11 creation path (TC-001 shape) is unchanged and uses one LLM call', async () => {
    let count = 0;
    const creation = {
        rule: { keys: [{ key: 'lift_reps', meaning: 'lift repetitions' }], composition: 'single' },
        newKeys: [{ key: 'lift_reps', meaning: 'lift repetitions', chunk: 'lift 2', values: { lift_reps: 2 } }],
    };
    const fetch = async () => {
        count += 1;
        return answer({ status: 'success', payload: creation });
    };
    const result = await proposeRule(INPUT, { rules: RULES, llmOptions: { fetch, retryDelays: [] } });
    assert.equal(result.status, 'success');
    assert.equal(count, 1);
});
