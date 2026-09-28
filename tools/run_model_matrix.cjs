'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { fork, spawnSync } = require('node:child_process');
const { ROOT, sha, readJson, writeJson, validateProfile, localEndpoint } = require('./model-eval/lib.cjs');
let activeChild = null;
let stopRequested = false;

function parseArgs(argv) {
    const args = { config: 'docs/testing/model-evaluation/MATRIX.json', repeats: null, profiles: null, caseIds: null, dryRun: false };
    for (let index = 0; index < argv.length; index++) {
        const flag = argv[index];
        if (flag === '--dry-run') args.dryRun = true;
        else if (['--config', '--repeats', '--profiles', '--cases'].includes(flag)) {
            const value = argv[++index];
            if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
            if (flag === '--config') args.config = value;
            if (flag === '--repeats') args.repeats = Number(value);
            if (flag === '--profiles') args.profiles = value.split(',');
            if (flag === '--cases') args.caseIds = value.split(',');
        } else throw new Error(`Unknown argument ${flag}`);
    }
    if (args.repeats !== null && (!Number.isInteger(args.repeats) || args.repeats < 1 || args.repeats > 20)) throw new Error('Repeats must be 1..20');
    return args;
}

function fileSnapshot() {
    const files = [];
    const visit = dir => {
        for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
            const relative = dir + '/' + entry.name;
            if (entry.isDirectory()) visit(relative);
            else files.push(relative);
        }
    };
    for (const dir of ['core', 'adapters', 'prompts']) visit(dir);
    visit('tools/model-eval');
    files.push('package.json', 'tools/run_model_matrix.cjs', 'tools/validate_model_evaluation.cjs',
        'docs/testing/model-evaluation/CASE_MANIFEST.json', 'docs/testing/model-evaluation/MATRIX.json');
    const manifest = readJson(path.join(ROOT, 'docs/testing/model-evaluation/CASE_MANIFEST.json'));
    files.push(...[...manifest.authoritySources, ...manifest.baselinePrompts,
        ...manifest.cases.flatMap(item => [item.input.source, item.spec, ...item.initialState.files, ...item.oracle.files])].map(record => record.path));
    for (const name of ['data.json', 'data.tmp.json', 'rulesLog.json', 'rulesLog.tmp.json', 'graph.json', 'graph.tmp.json']) {
        files.push('data/' + name);
        if (name.startsWith('data.')) files.push('../../data/training/' + name);
    }
    return Object.fromEntries([...new Set(files)].sort().map(relative => {
        const file = path.resolve(ROOT, relative);
        return [relative, fs.existsSync(file) ? sha(fs.readFileSync(file)) : null];
    }));
}

async function environment(profile) {
    const origin = localEndpoint(profile.endpoint).origin;
    const get = async route => {
        try {
            const response = await fetch(origin + route, { signal: AbortSignal.timeout(10000) });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return await response.json();
        } catch (error) { return { error: error.message }; }
    };
    const gpu = spawnSync('nvidia-smi', ['--query-gpu=name,memory.total,memory.used,utilization.gpu,driver_version', '--format=csv'],
        { encoding: 'utf8', timeout: 10000, windowsHide: true });
    const running = await get('/api/ps');
    return { at: new Date().toISOString(), node: process.version, platform: process.platform,
        gpu: gpu.status === 0 ? gpu.stdout.trim() : { error: gpu.error?.message || gpu.stderr }, running };
}

function runChild(jobFile, runDir, timeoutMs, label) {
    return new Promise(resolve => {
        const log = fs.openSync(path.join(runDir, 'worker.log'), 'wx');
        const child = fork(path.join(__dirname, 'model-eval/worker.cjs'), [jobFile], {
            stdio: ['ignore', log, log, 'ipc'], windowsHide: true,
        });
        activeChild = child;
        let report = null;
        let error = null;
        let timedOut = false;
        let lastStage = 'starting';
        const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
        const heartbeat = setInterval(() => console.log(JSON.stringify({ type: 'progress', run: label, stage: lastStage })), 30000);
        child.on('message', message => {
            if (message.type === 'complete') report = message.report;
            else if (message.type === 'worker-error') error = message.error;
            else {
                if (message.stageId) lastStage = message.stageId;
                console.log(JSON.stringify({ run: label, ...message }));
            }
        });
        child.on('error', cause => { error = cause.message; });
        child.on('exit', (code, signal) => {
            if (activeChild === child) activeChild = null;
            clearTimeout(timer); clearInterval(heartbeat); fs.closeSync(log);
            if (report && code === 0) resolve(report);
            else {
                const failure = { profileId: readJson(jobFile).profile.id, caseId: readJson(jobFile).item.caseId,
                    repeat: readJson(jobFile).repeat, automaticVerdict: 'INFRA_ERROR', semanticVerdict: 'NOT_REVIEWED',
                    isolationVerdict: 'UNKNOWN', error: timedOut ? `Worker timed out after ${timeoutMs}ms` : error || `Worker exit ${code}, signal ${signal}`,
                    previewMs: null, calls: [] };
                writeJson(path.join(runDir, 'run.json'), failure);
                resolve(failure);
            }
        });
    });
}

function median(numbers) {
    const values = numbers.filter(Number.isFinite).sort((a, b) => a - b);
    if (!values.length) return null;
    const middle = Math.floor(values.length / 2);
    return values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
}

function completionExitCode(rows, reports) {
    if (reports.some(report => report.automaticVerdict === 'INFRA_ERROR')) return 2;
    return rows.some(row => row.verdict !== 'PASS') ? 1 : 0;
}

function aggregate(reports, profiles, cases, repeats) {
    const rows = [];
    for (const profile of profiles) for (const item of cases) {
        const runs = reports.filter(run => run.profileId === profile.id && run.caseId === item.caseId);
        const passed = runs.filter(run => run.automaticVerdict === 'PASS');
        const eventPass = runs.filter(run => run.checks?.find(check => check.name === 'events')?.status === 'PASS').length;
        const routerPass = runs.filter(run => run.checks?.find(check => check.name === 'router.groups')?.status === 'PASS').length;
        const times = runs.map(run => run.previewMs);
        const warm = runs.filter(run => run.calls?.length && run.calls.every(call => Number.isFinite(call.metrics?.loadMs) && call.metrics.loadMs < 1000));
        rows.push({ profileId: profile.id, caseId: item.caseId, completedRuns: runs.length, requestedRepeats: repeats,
            automaticPasses: passed.length, eventPasses: eventPass, routerPasses: routerPass,
            verdict: runs.length !== repeats ? 'NOT_RUN' : passed.length === repeats ? 'PASS' : 'FAIL',
            qualification: runs.length !== repeats ? 'INCOMPLETE' : repeats >= 3 ? 'three-or-more-independent-runs' : 'smoke-only',
            semanticVerdict: 'NOT_REVIEWED', recommendation: 'NOT_QUALIFIED',
            previewTimesMs: times, medianAllPreviewMs: median(times), maxAllPreviewMs: times.filter(Number.isFinite).length ? Math.max(...times.filter(Number.isFinite)) : null,
            warmRunCount: warm.length, warmMedianPreviewMs: median(warm.map(run => run.previewMs)),
            successfulRunCount: passed.length, medianCorrectPreviewMs: median(passed.map(run => run.previewMs)),
            failedChecks: [...new Set(runs.flatMap(run => run.checks?.filter(check => check.status !== 'PASS').map(check => check.name) || [run.error]))] });
    }
    return rows;
}

function writeReport(batchDir, batch, reports) {
    const rows = aggregate(reports, batch.profiles, batch.cases, batch.repeats);
    writeJson(path.join(batchDir, 'summary.json'), { schemaVersion: 1, batchId: path.basename(batchDir),
        status: batch.status, scope: batch.scope, rows, reports: reports.map(run => ({
            profileId: run.profileId, caseId: run.caseId, repeat: run.repeat, automaticVerdict: run.automaticVerdict,
        })) });
    const seconds = value => value === null ? '—' : (value / 1000).toFixed(1);
    const lines = ['# Матрица локальных моделей', '', `Статус: ${batch.status}. Повторы: ${batch.repeats}. Scope: ${batch.scope}.`, '',
        'Строгий PASS требует совпадения событий, Router, правил и графа и сохранности состояния. Смысловой review пока NOT_REVIEWED. Живая приёмка Obsidian и закрытый контроль не выполнялись.', '',
        '| Конфигурация | Кейс | Полный PASS | События | Router | Все времена preview, с | Median / max, с | Warm median, с |',
        '|---|---|---:|---:|---:|---|---|---|'];
    for (const row of rows) lines.push(`| ${row.profileId} | ${row.caseId} | ${row.automaticPasses}/${row.requestedRepeats} | ${row.eventPasses}/${row.requestedRepeats} | ${row.routerPasses}/${row.requestedRepeats} | ${row.previewTimesMs.map(seconds).join(', ')} | ${seconds(row.medianAllPreviewMs)} / ${seconds(row.maxAllPreviewMs)} | ${seconds(row.warmMedianPreviewMs)} (${row.warmRunCount} runs) |`);
    lines.push('', 'Время ошибочных результатов включено в столбцы «все времена»; оно не является временем получения правильного результата. Warm: у всех вызовов server load_duration < 1 с; это наблюдаемая категория, не принудительное измерение холодного запуска.', '',
        'На каждый run сохранены job/run.json, calls с исходными запросами и ответами, worker.log, traces, state-before/after, automatic-diff и review-packet. Метрики Ollama разделяют загрузку, prefill и генерацию; eval_count включает thinking, thinkingChars — символы.', '');
    for (const row of rows) lines.push(`- ${row.profileId} / ${row.caseId}: ${row.verdict}; расхождения: ${row.failedChecks.join(', ') || 'нет'}.`);
    fs.writeFileSync(path.join(batchDir, 'REPORT.md'), lines.join('\n') + '\n');
    return rows;
}

async function main(argv = process.argv.slice(2)) {
    const args = parseArgs(argv);
    const config = readJson(path.resolve(ROOT, args.config));
    if (config.schemaVersion !== 1) throw new Error('Unsupported matrix schema');
    if (!Number.isInteger(config.workerTimeoutMs) || config.workerTimeoutMs < 1000) throw new Error('Invalid worker timeout');
    const manifest = readJson(path.join(ROOT, 'docs/testing/model-evaluation/CASE_MANIFEST.json'));
    const profiles = config.profiles.filter(profile => !args.profiles || args.profiles.includes(profile.id)).map(validateProfile);
    const caseIds = args.caseIds || config.caseIds;
    const cases = caseIds.map(id => {
        const item = manifest.cases.find(item => item.caseId === id);
        if (!item) throw new Error(`Unknown case ${id}`);
        if (!item.expectedCutterDays) throw new Error(`Missing cutter oracle for ${id}`);
        return item;
    });
    if (!profiles.length || (args.profiles && args.profiles.some(id => !profiles.some(profile => profile.id === id)))) throw new Error('Unknown/empty profile selection');
    if (new Set(profiles.map(profile => profile.id)).size !== profiles.length || new Set(caseIds).size !== cases.length) throw new Error('Duplicate profile/case');
    const repeats = args.repeats || config.repeats;
    if (!Number.isInteger(repeats) || repeats < 1 || repeats > 20) throw new Error('Invalid repeats');
    const preflight = spawnSync(process.execPath, [path.join(__dirname, 'validate_model_evaluation.cjs')], { encoding: 'utf8', windowsHide: true });
    if (preflight.status !== 0) throw new Error(`Preflight failed: ${preflight.stdout}${preflight.stderr}`);
    if (args.dryRun) {
        console.log(JSON.stringify({ status: 'DRY_RUN', profiles: profiles.map(profile => profile.id), cases: caseIds, repeats, runs: profiles.length * cases.length * repeats, modelCalls: 0 }, null, 2));
        return;
    }
    const batchDir = path.join(ROOT, 'work/model-eval', new Date().toISOString().replace(/[:.]/g, '-') + '-' + cryptoSuffix());
    fs.mkdirSync(batchDir, { recursive: true });
    const batch = { schemaVersion: 1, status: 'RUNNING', startedAt: new Date().toISOString(), scope: config.scope,
        repeats, profiles, cases, manifest, matrixSha256: sha(fs.readFileSync(path.resolve(ROOT, args.config))),
        sourceHashes: fileSnapshot(), coldStartPolicy: 'observed-load-duration-no-forced-unload',
        comparisonPolicy: { ruleProjection: 'version, single-rule-count, exact mapping, exact ordered examples; runtime wrappers/IDs/raw/timestamps excluded',
            cutterPresentation: 'HTML br and newline equivalent; outer whitespace ignored; other text exact',
            eventProjection: 'preview metadata excluded; persisted data requires date and values only' } };
    writeJson(path.join(batchDir, 'batch.json'), batch);
    const reports = [];
    stopRequested = false;
    const stop = () => { stopRequested = true; activeChild?.kill(); };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    console.log(JSON.stringify({ type: 'batch-start', batchDir, runs: profiles.length * cases.length * repeats }));
    try {
        for (const profile of profiles) {
            const origin = localEndpoint(profile.endpoint).origin;
            const tagsResponse = await fetch(origin + '/api/tags', { signal: AbortSignal.timeout(10000) });
            if (!tagsResponse.ok) throw new Error('Cannot read installed model list');
            const tags = await tagsResponse.json();
            const tag = tags.models?.find(model => model.name === profile.model);
            if (!tag) throw new Error(`Model not installed: ${profile.model}. Evaluator never downloads weights.`);
            profile.resolvedModel = tag;
            const showResponse = await fetch(origin + '/api/show', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: profile.model }), signal: AbortSignal.timeout(10000) });
            if (!showResponse.ok) throw new Error(`Cannot inspect model: HTTP ${showResponse.status}`);
            const show = await showResponse.json();
            writeJson(path.join(batchDir, profile.id + '-model.json'), { tags, show, version: await (await fetch(origin + '/api/version')).json() });
            for (let repeat = 1; repeat <= repeats; repeat++) for (const item of cases) {
                if (stopRequested) throw new Error('Matrix cancelled');
                if (JSON.stringify(fileSnapshot()) !== JSON.stringify(batch.sourceHashes)) throw new Error('Project source or personal state changed during batch; stopping comparison');
                const runDir = path.join(batchDir, profile.id, item.caseId, String(repeat).padStart(2, '0'));
                fs.mkdirSync(runDir, { recursive: true });
                const job = { schemaVersion: 1, profile, item, repeat, runDir };
                const jobFile = path.join(runDir, 'job.json');
                writeJson(jobFile, job);
                writeJson(path.join(runDir, 'environment-before.json'), await environment(profile));
                const label = `${profile.id}/${item.caseId}/${repeat}`;
                console.log(JSON.stringify({ type: 'run-start', run: label }));
                const report = await runChild(jobFile, runDir, config.workerTimeoutMs, label);
                writeJson(path.join(runDir, 'environment-after.json'), await environment(profile));
                reports.push(report);
                console.log(JSON.stringify({ type: 'run-end', run: label, verdict: report.automaticVerdict, previewMs: report.previewMs,
                    groups: report.groups, failedChecks: report.checks?.filter(check => check.status !== 'PASS').map(check => check.name), error: report.error }));
                writeReport(batchDir, batch, reports);
                if (stopRequested) throw new Error('Matrix cancelled');
                if (JSON.stringify(fileSnapshot()) !== JSON.stringify(batch.sourceHashes)) throw new Error('Project source or personal state changed during batch');
            }
        }
        batch.status = 'COMPLETED';
    } catch (error) {
        batch.status = 'INTERRUPTED'; batch.error = error.message;
        throw error;
    } finally {
        process.removeListener('SIGINT', stop);
        process.removeListener('SIGTERM', stop);
        batch.completedAt = new Date().toISOString();
        writeJson(path.join(batchDir, 'batch.json'), batch);
        const rows = writeReport(batchDir, batch, reports);
        console.log(JSON.stringify({ type: 'batch-end', batchDir, status: batch.status, rows }));
        process.exitCode = completionExitCode(rows, reports);
    }
}

function cryptoSuffix() { return require('node:crypto').randomBytes(3).toString('hex'); }
if (require.main === module) main().catch(error => { console.error(error.stack); process.exitCode = 2; });
module.exports = { parseArgs, aggregate, completionExitCode, main };
