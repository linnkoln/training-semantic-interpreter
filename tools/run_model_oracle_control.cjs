'use strict';
// Diagnostic TC-001 oracle control: synthetic responses, zero model/network calls.
// Not run by ordinary guard and never counted as a tested candidate.
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, readJson, clone, writeJson } = require('./model-eval/lib.cjs');
const { runWorker } = require('./model-eval/worker.cjs');
async function main() {
    const manifest = readJson(path.join(ROOT, 'docs/testing/model-evaluation/CASE_MANIFEST.json'));
    const item = manifest.cases.find(item => item.caseId === 'TC-001');
    const reference = readJson(path.join(ROOT, item.oracle.directory, 'rulesLog.json')).rules;
    const events = readJson(path.join(ROOT, item.oracle.directory, 'data.json')).reverse();
    const relations = readJson(path.join(ROOT, item.oracle.directory, 'graph.json')).relations;
    const directory = path.join(ROOT, 'work/model-eval', 'oracle-control-' + new Date().toISOString().replace(/[:.]/g, '-'));
    fs.mkdirSync(directory);
    let routeIndex = 0;
    let parseIndex = 1;
    const fetchImpl = async (_url, init) => {
        const prompt = JSON.parse(init.body).messages[0].content;
        let payload;
        if (/нарезщик/i.test(prompt)) payload = { days: item.expectedCutterDays };
        else if (/\brouter\b|роутер/i.test(prompt)) payload = { groups: [{ group: [3, 2, 1][routeIndex++], confidence: 1 }] };
        else if (/Минорное дополнение правил/i.test(prompt)) payload = { appends: reference[1].examples.slice(5)
            .map(example => ({ key: Object.keys(example.values)[0], chunk: example.input, exampleText: example.input, values: example.values })) };
        else if (/RuleUpdate/i.test(prompt)) payload = {
            rule: { keys: Object.entries(reference[0].mapping).map(([key, meaning]) => ({ key, meaning })),
                mapping: reference[0].mapping, examples: reference[0].examples, composition: 'A+B' },
            oldKeysEvents: [], newKeys: Object.entries(reference[0].mapping).map(([key, meaning]) => {
                const example = reference[0].examples.find(example => Object.hasOwn(example.values, key));
                if (!item.expectedCutterDays[0].raw.includes(example.input)) throw new Error('Control citation not in source');
                return { key, meaning, chunk: example.input, sourceSpan: example.input, date: events[0].date, values: example.values };
            }), relations };
        else payload = [clone(events[parseIndex++])];
        return new Response(JSON.stringify({ done: true, done_reason: 'stop', message: { content: JSON.stringify({ status: 'success', payload, confidence: 1 }) },
            load_duration: 0, eval_count: 0, eval_duration: 0 }), { status: 200 });
    };
    const log = console.log;
    console.log = () => {};
    let report;
    try { report = await runWorker({ runDir: directory, item, repeat: 1,
        profile: { id: 'oracle-control', model: 'synthetic-no-model-call', endpoint: 'http://localhost:11434/api/chat',
            think: false, options: { temperature: 0, num_ctx: 16384, num_predict: 8192 }, timeoutMs: 1000 } }, fetchImpl); }
    finally { console.log = log; }
    const summary = { status: 'CONTROL_COMPLETE', modelCalls: 0, provenance: 'synthetic oracle-derived responses; not candidate evidence',
        runDir: directory, automaticVerdict: report.automaticVerdict, groups: report.groups,
        checks: report.checks.map(({ name, status, differences }) => ({ name, status, differences })),
        savedVersionCount: readJson(path.join(directory, 'state/rulesLog.json')).entries.length,
        expectedVersionCount: reference.length };
    writeJson(path.join(directory, 'control-summary.json'), summary);
    console.log(JSON.stringify(summary, null, 2));
    return summary;
}
if (require.main === module) main().then(summary => { process.exitCode = summary.automaticVerdict === 'PASS' ? 0 : 1; })
    .catch(error => { console.error(error.stack); process.exitCode = 2; });
module.exports = { main };
