'use strict';
// tests/trace.test.js — инструментальная трасса data-flow (core/trace.js + зацепки pipeline).
//
// (а) begin/step/fileSnapshot/end → файл создан, валидный JSON, содержит шаги.
// (б) pipeline.next() (mock-fetch, изолированный tmp-каталог через хук _setTraceDir) →
//     файл трассы создан и содержит шаг 'router.groups'.
// (в) ретеншн: 51 файл в test-artifacts → после новой записи остаётся 50.
//
// Все трассы пишутся в изолированный tmp-каталок (mkdtemp) — data/test-artifacts
// из реального репозитория не трогаем.

const test = require('node:test');
const { beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const trace = require('../core/trace.js');
const pipeline = require('../core/pipeline.js');
const rulesLog = require('../core/rulesLog.js');
const tmpStore = require('../adapters/tmpStore.js');

beforeEach((t) => {
    const originalPath = tmpStore._getRulesTmpPath();
    const prefix = 'training-trace-rules-tmp-';
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    const resolvedDir = path.resolve(tempDir);
    if (!resolvedDir.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`)
        || !path.basename(resolvedDir).startsWith(prefix)) {
        throw new Error(`Unsafe isolated rules temp path: ${resolvedDir}`);
    }
    const tempPath = path.join(resolvedDir, 'rulesLog.tmp.json');
    tmpStore._setRulesTmpPath(tempPath);
    t.after(() => {
        tmpStore._setRulesTmpPath(originalPath);
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
        fs.rmdirSync(resolvedDir);
    });
});

const DATE = '2026-08-29';

/** Уникальный tmp-каталог + переключение trace._setTraceDir. Возвращает restore(). */
function isolateTraceDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `trace-test-${crypto.randomBytes(4).toString('hex')}-`));
    const prev = trace._getTraceDir();
    trace._setTraceDir(dir);
    return { dir, restore: () => trace._setTraceDir(prev) };
}

// ============================================================
// Fake-fetch (как в pipeline.test.js): Router / parse по тексту промпта
// ============================================================

function makeFetch({ cutter, router, parse }) {
    return async (url, init = {}) => {
        const body = JSON.parse(init.body || '{}');
        const prompt = (body.messages && body.messages[0] && body.messages[0].content) || '';
        const isCutter = /нарезщик/i.test(prompt);
        const isRouter = !isCutter && /(?:Роутер|Router)/i.test(prompt);
        const answer = isCutter ? cutter : (isRouter ? router : parse);
        return { ok: true, status: 200, json: async () => ({ message: { content: answer } }) };
    };
}

/** Ответ Cutter: один день (кусок = весь ввод). */
function cutterAnswer(raw) {
    return JSON.stringify({
        status: 'success',
        payload: { days: [{ raw, date: null }], confidence: 0.9 },
        confidence: 0.9,
    });
}

function routerAnswer(group, chunk, confidence = 0.9) {
    return JSON.stringify({
        status: 'success',
        payload: { groups: [{ chunk, group, reasoning: 'тест', confidence }], confidence },
        confidence,
    });
}

function parseAnswer(candidates, confidence = 0.95) {
    return JSON.stringify({ status: 'success', payload: candidates, confidence });
}

// ============================================================
// (а) begin/step/fileSnapshot/end
// ============================================================

test('trace: begin/step/fileSnapshot/end создаёт валидный JSON-файл с шагами', () => {
    const { dir, restore } = isolateTraceDir();
    try {
        const tr = trace.begin('interpret', { inputLen: 7 });
        assert.match(tr.id, /^trace-\d+$/);
        assert.equal(tr.kind, 'interpret');
        assert.equal(tr.steps.length, 0);

        trace.step(tr, 'router.groups', [{ chunk: 'пресс 40', group: 1 }]);
        trace.step(tr, 'dispatch', { chunks12: ['пресс 40'], minorChunks: [], chunks3: [] });
        trace.fileSnapshot(tr, 'rulesLog.json после', path.join(dir, 'rulesLog.json'),
            JSON.stringify({ version: 1, entries: [] }).repeat(200)); // >2000 символов

        const id = trace.end(tr);
        assert.equal(id, tr.id);

        const files = fs.readdirSync(dir).filter((f) => f.startsWith('trace-') && f.endsWith('.json'));
        assert.equal(files.length, 1);
        assert.ok(files[0].includes('-interpret.json'), `имя файла: ${files[0]}`);

        const parsed = JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'));
        assert.equal(parsed.id, tr.id);
        assert.ok(parsed.startedAt);
        assert.ok(Array.isArray(parsed.steps) && parsed.steps.length === 2);
        assert.equal(parsed.steps[0].step, 'router.groups');
        assert.equal(parsed.steps[0].data[0].chunk, 'пресс 40');
        assert.equal(parsed.steps[1].step, 'dispatch');
        assert.ok(Array.isArray(parsed.files) && parsed.files.length === 1);
        // Summary обрезан до 2000 символов, размер указан.
        assert.ok(parsed.files[0].summary.length <= 2000);
        assert.ok(parsed.files[0].size > 2000);
    } finally {
        restore();
    }
});

test('trace: end при недоступном fs не бросает (браузерный no-op)', () => {
    const tr = trace.begin('wipe');
    trace.step(tr, 'x', { ok: true });
    // _setFsAvailable(false) имитирует браузерный fs-шим.
    trace._setFsAvailable(false);
    try {
        const id = trace.end(tr); // не бросает
        assert.match(id, /^trace-\d+$/);
    } finally {
        trace._setFsAvailable(true);
    }
});

test('trace: fileSnapshot с null-контентом и не-JSON данными не бросает', () => {
    const { dir, restore } = isolateTraceDir();
    try {
        const tr = trace.begin('save');
        trace.fileSnapshot(tr, 'нет файла', path.join(dir, 'absent.json'), null);
        trace.step(tr, 'cycle', { a: 1, self: null });
        trace.end(tr);
        const files = fs.readdirSync(dir).filter((f) => /^trace-.*\.json$/.test(f));
        assert.equal(files.length, 1);
        const parsed = JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'));
        assert.equal(parsed.files[0].summary, null);
    } finally {
        restore();
    }
});

// ============================================================
// (б) pipeline.next() пишет трассу с шагом router.groups
// ============================================================

test('pipeline.next(): трасса interpret создана, содержит cutter.days и day.1.router, payload._traceId совпадает', async () => {
    const { dir, restore } = isolateTraceDir();
    const previousLog = rulesLog.getRulesLog();
    try {
        rulesLog.setCachedLog({ version: 1, entries: [{
            version: 1,
            rulesSnapshot: { version: 1, dynamic: [{
                id: 'trace_push_rule', raw: '100 отжимания (73+27)',
                mapping: { push_full: 'отжимания', push_knee: 'отжимания с колен' },
                examples: [{ input: '100 отжимания (73+27)', values: { push_full: 73, push_knee: 27 } }],
            }], global: [] },
        }] });
        const fetch = makeFetch({
            cutter: cutterAnswer('100 отжимания (73+27)'),
            router: routerAnswer(1, '100 отжимания (73+27)', 0.95),
            parse: parseAnswer([{ date: DATE, values: { push_full: 73, push_knee: 27 } }]),
        });
        const res = await pipeline.next('100 отжимания (73+27)', {
            date: DATE,
            llmOptions: { fetch },
        });
        assert.equal(res.status, 'success');

        const files = fs.readdirSync(dir).filter((f) => f.includes('-interpret.json'));
        assert.equal(files.length, 1, 'ровно один файл трассы interpret');
        const parsed = JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'));
        const stepNames = parsed.steps.map((s) => s.step);
        assert.ok(stepNames.includes('cutter.days'), `шаги: ${stepNames.join(', ')}`);
        assert.ok(stepNames.includes('day.1.router'));
        assert.ok(stepNames.includes('day.1.branch1'));
        assert.ok(stepNames.includes('final.payload'));
        // _traceId в payload сопоставляется с файлом (файл содержит id).
        assert.equal(res.payload._traceId, parsed.id);
    } finally {
        rulesLog.setCachedLog(previousLog);
        restore();
    }
});

test('pipeline.next(): сбой Router-LLM → трасса закрыта, прогон завершается ошибкой', async () => {
    const { dir, restore } = isolateTraceDir();
    try {
        const fetch = async () => { throw new Error('сеть недоступна'); };
        const res = await pipeline.next('пресс 40', { date: DATE, llmOptions: { fetch } });
        assert.equal(res.status, 'error');
        assert.equal(res.payload, null);
        const files = fs.readdirSync(dir).filter((f) => f.includes('-interpret.json'));
        assert.equal(files.length, 1, 'трасса записана даже при сбое');
        const parsed = JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'));
        // Трасса всегда закрыта (endedAt) — никаких «висящих» прогонов.
        assert.ok(parsed.endedAt);
    } finally {
        restore();
    }
});

// ============================================================
// (в) ретеншн: 51 файл → остаётся 50
// ============================================================

test('retention: при новой записи остаётся не больше 50 файлов трасс', () => {
    const { dir, restore } = isolateTraceDir();
    try {
        // 51 файл трассы; самый первый — искусственно древний.
        for (let i = 0; i < 51; i++) {
            const f = path.join(dir, `trace-${1000 + i}-interpret.json`);
            fs.writeFileSync(f, JSON.stringify({ id: `trace-${1000 + i}`, kind: 'interpret', steps: [] }));
            fs.utimesSync(f, new Date(1000 + i), new Date(1000 + i));
        }
        const tr = trace.begin('interpret');
        trace.step(tr, 'x', { n: 1 });
        trace.end(tr);

        const files = fs.readdirSync(dir).filter((f) => /^trace-.*\.json$/.test(f));
        assert.equal(files.length, 50, `файлов: ${files.length}`);
        // Удалены САМЫЕ СТАРЫЕ: trace-1000 удалён, trace-1050 (новый) жив.
        assert.ok(!files.includes('trace-1000-interpret.json'), 'самый старый удалён');
        assert.ok(files.some((f) => f === `${tr.id}-interpret.json`), 'новая трасса записана');
    } finally {
        restore();
    }
});
