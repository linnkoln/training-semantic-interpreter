'use strict';

// One process, one fixture, one configuration. Every core filesystem hook points
// into this run's scratch directory before the first model request.
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, clone, readJson, writeJson, runtimeRules, compareRun, makeTransport } = require('./lib.cjs');

async function runWorker(job, fetchImpl) {
    const { runDir, item, profile } = job;
    const allowed = path.join(ROOT, 'work', 'model-eval') + path.sep;
    if (!path.resolve(runDir).startsWith(allowed)) throw new Error('Run must be under work/model-eval');
    const stateDir = path.join(runDir, 'state');
    fs.mkdirSync(stateDir, { recursive: false });
    const names = ['data.json', 'data.tmp.json', 'rulesLog.json', 'rulesLog.tmp.json', 'graph.json', 'graph.tmp.json'];
    for (const name of names) fs.copyFileSync(path.join(ROOT, item.initialState.directory, name), path.join(stateDir, name));
    const sourceRules = readJson(path.join(stateDir, 'rulesLog.json'));
    writeJson(path.join(stateDir, 'rulesLog.json'), runtimeRules(sourceRules));
    const pipeline = require('../../core/pipeline.js');
    const rulesLog = require('../../core/rulesLog.js');
    const tmpStore = require('../../adapters/tmpStore.js');
    const trace = require('../../core/trace.js');
    rulesLog._resetCache();
    rulesLog._setLogPath(path.join(stateDir, 'rulesLog.json'));
    tmpStore._setRulesTmpPath(path.join(stateDir, 'rulesLog.tmp.json'));
    tmpStore._setGraphTmpPath(path.join(stateDir, 'graph.tmp.json'));
    pipeline._setGraphFsPath(path.join(stateDir, 'graph.json'));
    trace._setTraceDir(path.join(runDir, 'traces'));
    trace._setFsAvailable(true);
    const snapshot = () => Object.fromEntries(names.map(name => [name, fs.readFileSync(path.join(stateDir, name), 'utf8')]));
    const main = state => Object.fromEntries(['data.json', 'rulesLog.json', 'graph.json'].map(name => [name, state[name]]));
    const beforeAll = snapshot();
    writeJson(path.join(runDir, 'state-before.json'), beforeAll);
    let currentStage = 'unknown';
    const progress = event => process.send?.({ ...event, caseId: item.caseId, profileId: profile.id, repeat: job.repeat });
    const transport = makeTransport({ profile, directory: path.join(runDir, 'calls'),
        stage: () => currentStage,
        snapshot: () => ({ files: snapshot(), effectiveRules: clone(rulesLog.getLatestRules()) }), progress, fetchImpl });
    const input = readJson(path.join(ROOT, item.input.source.path)).input;
    const start = performance.now();
    const result = await pipeline.next(input, { date: item.processingDates.at(-1),
        llmOptions: { fetch: transport.fetch, model: profile.model, url: profile.endpoint,
            temperature: profile.options.temperature, retryDelays: [] },
        onStage: stageId => { currentStage = stageId; progress({ type: 'stage', stageId }); } });
    const previewMs = performance.now() - start;
    const afterPreviewAll = snapshot();
    writeJson(path.join(runDir, 'result.json'), result);
    writeJson(path.join(runDir, 'state-after-preview.json'), afterPreviewAll);
    const saved = { status: 'NOT_RUN', reason: 'Core failed or preview modified main' };
    if (result.status === 'success' && JSON.stringify(main(beforeAll)) === JSON.stringify(main(afterPreviewAll))) {
        try {
            // Project Save preparation, strictly in scratch storage. This is not
            // an Obsidian UI transaction/visual acceptance test.
            const commit = await pipeline.commitRules(result, {
                committedLog: JSON.parse(beforeAll['rulesLog.json']),
                committedGraph: JSON.parse(beforeAll['graph.json']),
                graphTmp: JSON.parse(afterPreviewAll['graph.tmp.json']),
            });
            writeJson(path.join(runDir, 'save-preparation.json'), commit);
            if (commit.status === 'error') throw new Error(commit.message);
            const graph = tmpStore.mergeGraphs(commit.payload?.graph || JSON.parse(beforeAll['graph.json']),
                JSON.parse(afterPreviewAll['graph.tmp.json']));
            // Same public persisted contracts as the editor's Save path.
            saved.rules = clone(commit.payload?.log || rulesLog.getRulesLog());
            saved.graph = { relations: graph.relations || [] };
            const base = JSON.parse(beforeAll['data.json']);
            const byDate = new Map(base.map(event => [event.date, event]));
            for (const event of result.payload?.events || []) {
                if (byDate.has(event.date)) throw new Error('Attempt to overwrite immutable date');
                byDate.set(event.date, { date: event.date, values: clone(event.values) });
            }
            saved.data = [...byDate.values()].sort((a, b) => b.date.localeCompare(a.date));
            writeJson(path.join(stateDir, 'data.json'), saved.data);
            writeJson(path.join(stateDir, 'rulesLog.json'), saved.rules);
            writeJson(path.join(stateDir, 'graph.json'), saved.graph);
            saved.status = 'SAVED';
            delete saved.reason;
        } catch (error) { saved.status = 'ERROR'; saved.reason = error.message; }
    }
    writeJson(path.join(runDir, 'state-after-save.json'), snapshot());
    const expected = Object.fromEntries(['data', 'rulesLog', 'graph'].map(name =>
        [name === 'rulesLog' ? 'rules' : name, readJson(path.join(ROOT, item.oracle.directory, name + '.json'))]));
    const evaluation = compareRun({ item, result, calls: transport.calls,
        before: main(beforeAll), afterPreview: main(afterPreviewAll), saved, expected });
    writeJson(path.join(runDir, 'automatic-diff.json'), evaluation);
    // Candidate identity and timings intentionally omitted from judge payload.
    writeJson(path.join(runDir, 'review-packet.json'), { schemaVersion: 1, caseId: item.caseId, input,
        criterionSources: [item.spec, ...item.oracle.files], initialState: beforeAll,
        calls: transport.calls.map(({ stageId, request, response, parsed, contextBefore }) =>
            ({ stageId, messages: request.messages, response: response ? { message: response.message,
                done: response.done, done_reason: response.done_reason } : null, parsed, contextBefore })), result, saved, expected, evaluation });
    const report = { schemaVersion: 1, caseId: item.caseId, profileId: profile.id, repeat: job.repeat,
        profile, executedAt: new Date().toISOString(), previewMs, totalMs: performance.now() - start,
        calls: transport.calls.map(({ callIndex, stageId, metrics, finishReason, error, rawJsonPass }) =>
            ({ callIndex, stageId, metrics, finishReason, error, rawJsonPass })),
        groups: (result.payload?.groups || []).map(group => group.group),
        ...evaluation, savedStatus: saved.status, saveError: saved.reason || null,
        coverage: { core: 'RUN', isolatedSave: saved.status, independentStageSnapshots: 'NOT_RUN', liveUI: 'NOT_RUN', heldOut: 'NOT_RUN' } };
    writeJson(path.join(runDir, 'run.json'), report);
    return report;
}

if (require.main === module) {
    console.log = (...args) => process.stdout.write(args.map(arg => typeof arg === 'string' ? arg : JSON.stringify(arg)).join(' ') + '\n');
    runWorker(readJson(process.argv[2])).then(report => { process.send?.({ type: 'complete', report }); })
        .catch(error => { console.error(error.stack); process.send?.({ type: 'worker-error', error: error.message }); process.exitCode = 2; });
}
module.exports = { runWorker };
