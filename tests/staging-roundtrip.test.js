'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeStaging, STAGE_PATH } = require('../adapters/staging.js');

function makeMockVault(initial = {}) {
    const files = new Map(Object.entries(initial));
    const writes = [];
    const vault = {
        getAbstractFileByPath(filePath) {
            return files.has(filePath) ? filePath : null;
        },
        async read(filePath) {
            return files.get(filePath);
        },
        async create(filePath, content) {
            writes.push(filePath);
            files.set(filePath, content);
        },
        async modify(filePath, content) {
            writes.push(filePath);
            files.set(filePath, content);
        },
    };
    return { vault, files, writes };
}

test('staging object envelope round-trips, clear preserves state, and main data is untouched', async () => {
    const initialMain = JSON.stringify([{ date: '2026-05-28', values: { press_reps: 40 } }]);
    const { vault, files, writes } = makeMockVault({ 'data/training/data.json': initialMain });
    const staging = makeStaging({ vault });
    const events = [{ date: '2026-05-29', values: { press_reps: 50 } }];

    await staging.write(events);
    assert.deepEqual(await staging.read(), events);
    await staging.writeState({ hiddenGroups: ['push'] });
    assert.deepEqual(await staging.read(), events);
    assert.deepEqual(await staging.readState(), { hiddenGroups: ['push'] });

    await staging.clear();
    assert.deepEqual(await staging.read(), []);
    assert.deepEqual(await staging.readState(), { hiddenGroups: ['push'] });
    assert.equal(files.get('data/training/data.json'), initialMain);
    assert.ok(writes.length > 0);
    assert.ok(writes.every((filePath) => filePath === STAGE_PATH));
});

test('staging reads legacy bare-array file', async () => {
    const events = [{ date: '2026-05-29', values: { squat_reps: 50 } }];
    const { vault } = makeMockVault({ [STAGE_PATH]: JSON.stringify(events) });
    const staging = makeStaging({ vault });

    assert.deepEqual(await staging.read(), events);
});
