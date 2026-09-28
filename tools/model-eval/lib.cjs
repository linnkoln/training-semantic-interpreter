'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { parseResponse } = require('../../core/responseParser.js');
const ROOT = path.resolve(__dirname, '../..');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
const clone = value => JSON.parse(JSON.stringify(value));

function localEndpoint(value) {
    const url = new URL(value);
    if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
        || url.username || url.password || url.search || url.hash || url.pathname !== '/api/chat') {
        throw new Error('Evaluator requires a local Ollama /api/chat endpoint without credentials');
    }
    return url;
}

function validateProfile(profile) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(profile.id)) throw new Error('Invalid profile id');
    localEndpoint(profile.endpoint);
    if (typeof profile.model !== 'string' || !profile.model.trim()) throw new Error('Missing model');
    if (typeof profile.think !== 'boolean') throw new Error('Explicit think is required');
    for (const key of ['num_ctx', 'num_predict']) {
        if (!Number.isInteger(profile.options?.[key]) || profile.options[key] <= 0) throw new Error(`Invalid ${key}`);
    }
    if (!Number.isFinite(profile.options.temperature) || profile.options.temperature < 0) throw new Error('Invalid temperature');
    if (!Number.isInteger(profile.timeoutMs) || profile.timeoutMs < 1000) throw new Error('Invalid timeout');
    return profile;
}

function runtimeRules(reference) {
    if (!Array.isArray(reference.rules)) throw new Error('Expected canonical fixture rules array');
    const entries = reference.rules.map((rule, index) => ({
        version: rule.version,
        timestamp: rule.updatedAt || rule.createdAt,
        rulesSnapshot: { version: rule.version, updatedAt: rule.updatedAt,
            dynamic: [{ id: 'rule_001', raw: rule.raw || '', mapping: clone(rule.mapping),
                examples: clone(rule.examples), __version: rule.version }], global: [] },
        changeType: index ? 'update' : 'add', meta: { source: 'model-evaluation-reference-fixture' },
    }));
    return { version: entries.at(-1)?.version || 0, updatedAt: entries.at(-1)?.timestamp || null, entries };
}

// Declared comparison projection: canonical oracles omit runtime log wrappers,
// IDs/raw descriptions/timestamps. Mapping text, examples and their order stay exact.
function ruleProjection(log) {
    if (Array.isArray(log.rules)) return log.rules.map(({ version, mapping, examples }) => ({ version, mapping, examples }));
    if (!Array.isArray(log.entries)) throw new Error('Invalid runtime log');
    return log.entries.map(entry => {
        const rules = [...(entry.rulesSnapshot?.dynamic || []), ...(entry.rulesSnapshot?.global || [])];
        return { version: entry.version, ruleCount: rules.length,
            ...(rules.length === 1 ? { mapping: rules[0].mapping, examples: rules[0].examples } : { rules }) };
    });
}

function diff(expected, actual, pointer = '', result = []) {
    if (Object.is(expected, actual)) return result;
    const object = value => value !== null && typeof value === 'object';
    if (!object(expected) || !object(actual) || Array.isArray(expected) !== Array.isArray(actual)) {
        result.push({ path: pointer || '/', expected, actual, kind: 'value' });
        return result;
    }
    for (const key of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
        const at = pointer + '/' + key.replace(/~/g, '~0').replace(/\//g, '~1');
        if (!Object.hasOwn(actual, key)) result.push({ path: at, expected: expected[key], kind: 'missing' });
        else if (!Object.hasOwn(expected, key)) result.push({ path: at, actual: actual[key], kind: 'unexpected' });
        else diff(expected[key], actual[key], at, result);
    }
    return result;
}

const same = (expected, actual) => diff(expected, actual).length === 0;
const normalizeDay = raw => typeof raw === 'string' ? raw.replace(/<br\s*\/?>/gi, '\n').trim() : raw;

function compareRun({ item, result, calls, before, afterPreview, saved, expected }) {
    const checks = [];
    const add = (name, wanted, actual, scope = 'core') => {
        const differences = diff(wanted, actual);
        checks.push({ name, scope, status: differences.length ? 'FAIL' : 'PASS', differences });
    };
    add('status', 'success', result.status);
    add('complete', [], [...(result.payload?.warnings || []), ...(result.payload?.failedDays || []), ...(result.failedDays || [])]);
    const cutter = calls.find(call => call.stageId === 'cutter');
    add('cutter.dates', item.processingDates.map(date => date.slice(5)), cutter?.parsed?.payload?.days?.map(day => day.date));
    add('cutter.source-preserved', item.expectedCutterDays.map(day => normalizeDay(day.raw)),
        cutter?.parsed?.payload?.days?.map(day => normalizeDay(day.raw)));
    add('router.groups', item.expectedRouterGroups, (result.payload?.groups || []).map(group => group.group));
    add('events', [...expected.data.slice(0, 3)].reverse(),
        (result.payload?.events || []).map(({ date, values }) => ({ date, values })));
    add('transport', [], calls.filter(call => call.error || call.httpStatus !== 200 || !call.done || call.finishReason === 'length')
        .map(call => ({ callIndex: call.callIndex, error: call.error, httpStatus: call.httpStatus, finishReason: call.finishReason })));
    add('main-unchanged-before-save', before, afterPreview, 'isolation');
    if (saved.status !== 'SAVED') {
        checks.push({ name: 'persisted-oracle', scope: 'save', status: saved.status === 'ERROR' ? 'FAIL' : 'NOT_RUN', differences: [{ path: '/', reason: saved.reason }] });
    } else {
        add('saved.events', expected.data, saved.data, 'save');
        const wanted = ruleProjection(expected.rules).map(rule => ({ ...rule, ruleCount: 1 }));
        add('saved.rules.versions-mapping-examples', wanted, ruleProjection(saved.rules), 'save');
        add('saved.graph', expected.graph, saved.graph, 'save');
        const seedRules = JSON.parse(before['rulesLog.json']);
        add('saved.old-rule-entries-immutable', seedRules.entries, saved.rules.entries.slice(0, seedRules.entries.length), 'isolation');
        const seedData = JSON.parse(before['data.json']);
        add('saved.old-events-immutable', seedData, saved.data.filter(event => seedData.some(old => old.date === event.date)), 'isolation');
        add('saved.version-monotonic', true, saved.rules.entries.every((entry, index, list) => entry.version === index + 1)
            && saved.rules.version === saved.rules.entries.length, 'save');
    }
    return {
        scope: 'core-preview-and-isolated-serialization', checks,
        automaticVerdict: checks.some(check => check.status === 'FAIL') ? 'FAIL'
            : checks.some(check => check.status === 'NOT_RUN') ? 'NOT_RUN' : 'PASS',
        isolationVerdict: checks.filter(check => check.scope === 'isolation').every(check => check.status === 'PASS') ? 'PASS' : 'FAIL',
        semanticVerdict: 'NOT_REVIEWED', liveAcceptance: 'NOT_RUN',
    };
}

function metrics(data, wallMs) {
    const milliseconds = key => Number.isFinite(data?.[key]) ? data[key] / 1e6 : null;
    return { wallMs, totalMs: milliseconds('total_duration'), loadMs: milliseconds('load_duration'),
        prefillMs: milliseconds('prompt_eval_duration'), decodeMs: milliseconds('eval_duration'),
        inputTokens: data?.prompt_eval_count ?? null, generatedTokensIncludingThinking: data?.eval_count ?? null,
        tokensPerSecond: data?.eval_duration > 0 ? data.eval_count / (data.eval_duration / 1e9) : null,
        thinkingChars: typeof data?.message?.thinking === 'string' ? data.message.thinking.length : null,
        answerChars: typeof data?.message?.content === 'string' ? data.message.content.length : null };
}

function makeTransport({ profile, directory, stage, snapshot, progress = () => {}, fetchImpl = globalThis.fetch }) {
    validateProfile(profile);
    const calls = [];
    fs.mkdirSync(directory, { recursive: true });
    const transport = async (url, init = {}) => {
        localEndpoint(String(url));
        const sourceRequest = JSON.parse(init.body);
        const callIndex = calls.length + 1;
        const stageId = stage();
        const request = { ...sourceRequest, model: profile.model, think: profile.think,
            options: { ...sourceRequest.options, ...profile.options }, keep_alive: profile.keepAlive || '10m', stream: false };
        const file = path.join(directory, `call-${String(callIndex).padStart(3, '0')}.json`);
        const artifact = { callIndex, stageId, startedAt: new Date().toISOString(), endpoint: profile.endpoint,
            promptSha256: sha(JSON.stringify(request.messages)), sourceRequest, request,
            contextBefore: snapshot(), contextProvenance: 'observed-core-state-not-independent-stage-oracle' };
        calls.push(artifact);
        writeJson(file, artifact); // survives a timeout/interruption
        progress({ type: 'call-start', callIndex, stageId });
        const start = performance.now();
        try {
            const response = await fetchImpl(profile.endpoint, { ...init, body: JSON.stringify(request),
                signal: AbortSignal.timeout(profile.timeoutMs), redirect: 'error' });
            const text = await response.text();
            artifact.httpStatus = response.status;
            artifact.rawResponseText = text;
            let data;
            try { data = JSON.parse(text); } catch (_) { data = null; }
            artifact.response = data;
            artifact.done = data?.done === true;
            artifact.finishReason = data?.done_reason ?? null;
            artifact.metrics = metrics(data, performance.now() - start);
            artifact.parsed = parseResponse(data?.message?.content, { fallbackStatus: 'success' });
            try { JSON.parse(data?.message?.content); artifact.rawJsonPass = true; } catch (_) { artifact.rawJsonPass = false; }
            // Return the server response unchanged to the project's parser.
            return new Response(text, { status: response.status, headers: { 'Content-Type': 'application/json' } });
        } catch (error) {
            artifact.error = { name: error.name, message: error.message };
            artifact.metrics = metrics(null, performance.now() - start);
            throw error;
        } finally {
            artifact.completedAt = new Date().toISOString();
            writeJson(file, artifact);
            progress({ type: 'call-end', callIndex, stageId, wallMs: artifact.metrics?.wallMs, error: artifact.error });
        }
    };
    return { fetch: transport, calls };
}

module.exports = { ROOT, sha, clone, readJson, writeJson, localEndpoint, validateProfile,
    runtimeRules, ruleProjection, diff, same, normalizeDay, compareRun, metrics, makeTransport };
