'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const pipeline = require('../core/pipeline.js');

test('Branch 1 examples retain LLM-grounded running and push-pair snippets separately', () => {
    const day = '*05-29* ~6км; 100 отжимания одним подходом (43 в одной планке)';
    const examples = pipeline.examplesFromGroundedKeys([
        {
            key: 'running_distance_km',
            sourceSpan: '~6км',
            values: { running_distance_km: 6 },
        },
        {
            key: 'push_reps',
            sourceSpan: '100 отжимания одним подходом (43 в одной планке)',
            values: { push_reps: 100 },
        },
        {
            key: 'push_max_set',
            sourceSpan: '100 отжимания одним подходом (43 в одной планке)',
            values: { push_max_set: 43 },
        },
    ], day);

    assert.deepEqual(examples, [
        { input: '~6км', values: { running_distance_km: 6 } },
        {
            input: '100 отжимания одним подходом (43 в одной планке)',
            values: { push_reps: 100, push_max_set: 43 },
        },
    ]);
    assert.ok(examples.every((example) => example.input !== day));
});

test('Branch 1 drops an ungrounded or whole-day span without dropping its event values', () => {
    const day = '*05-29* ~6км; 100 отжимания (43+57)';
    const keys = [
        { key: 'running_distance_km', sourceSpan: day, values: { running_distance_km: 6 } },
        { key: 'push_reps', sourceSpan: 'отжимания 100', values: { push_reps: 100 } },
        { key: 'push_knees_reps', input: '100 отжимания (43+57)', values: { push_knees_reps: 57 } },
    ];
    const valuesBefore = JSON.stringify(keys.map((item) => item.values));
    const examples = pipeline.examplesFromGroundedKeys(keys, day);

    assert.deepEqual(examples, []);
    assert.equal(JSON.stringify(keys.map((item) => item.values)), valuesBefore);
    assert.equal(keys.length, 3, 'keys and their event values remain available to pipeline/save');
});
