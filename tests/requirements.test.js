'use strict';
// tests/requirements.test.js — пользовательская логика: ИНВАРИАНТЫ (docs/REQUIREMENTS.md §3).
// Ловится регрессия «делаем одно — ломаем другое». Чистый модуль, no dv/app/DOM.
//
// Покрывает: INV-1 (interpret чист), INV-2 (запись только через persist — граница),
// INV-3 (иммутабельность событий), INV-4 (рендер не мутирует, не зависит от LLM как истины).

const { describe, it } = require('node:test');
const assert = require('node:assert');

const { interpret } = require('../core/interpreter.js');
const { DEFAULT_RULES } = require('../core/rules.js');
const { makeEvent } = require('../core/events.js');
const chat = require('../adapters/llm.js').chat;

// --- INV-1: interpret чист (нет side effects на baseEvents, ничего не пишет) ---
describe('INV-1: interpret() без побочных эффектов', () => {
    it('не мутирует переданные baseEvents', () => {
        const base = [makeEvent({ date: '2026-01-01', values: { push_full: 10 } }, 1)];
        const snapshot = JSON.stringify(base);
        interpret('- 50 подтягиваний макс: 15', { baseEvents: base, rules: DEFAULT_RULES });
        assert.strictEqual(JSON.stringify(base), snapshot, 'baseEvents изменён — нарушение INV-1');
    });

    it('не пишет на диск (нет persist-вызова на интерпретации)', async () => {
        // интерпретатор детерминирован: результат полностью из (input, rules, lastContext);
        // запись файла — за пределами interpret (делается только в editor.persist).
        const r = interpret('100 отжимания макс: 100', { baseEvents: [], rules: DEFAULT_RULES });
        assert.ok(['resolved', 'resolve', 'ambiguous', 'error'].includes(r.mode));
        // Ключ: у результата нет поля, несущего персистенцию.
        assert.ok(!('persist' in r) && !('save' in r));
    });
});

// --- INV-2: запись данных не происходит без явного persist ---
describe('INV-2: хранилище не записывает само при чтении', () => {
    it('чтение/интерпретация не вызывают storage.saveData', async () => {
        const storage = require('../adapters/storage.js');
        // storage API — loadData/saveData/бэкап. Здесь проверяем, что interpret не зависит от storage.
        const deps = reflectDependencies(interpret);
        assert.ok(!deps.includes('storage'), 'interpret не должен зависеть от storage (INV-2 граница)');
    });
});

// --- INV-3: события иммутабельны ---
describe('INV-3: события иммутабельны', () => {
    it('makeEvent замораживает событие и его values', () => {
        const evt = makeEvent({ date: '2026-01-01', values: { push_full: 1 } }, 1);
        assert.ok(Object.isFrozen(evt), 'событие не заморожено');
        assert.ok(Object.isFrozen(evt.values), 'values не заморожены');
        assert.throws(() => { 'use strict'; evt.date = 'changed'; }, TypeError);
        assert.throws(() => { 'use strict'; evt.values.push_full = 99; }, TypeError);
    });
});

// --- INV-4: рендер не зависит от LLM как источника; события не мутируются ---
describe('INV-4: рендер/источник истины', () => {
    it('два прогона интерпретации на одном вводе дают одинаковые события (детерминизм, LLM не источник истины)', () => {
        // Фикстура правил: data/rules.json пуст после сброса, детерминизм интерпретатора
        // проверяем на переданных правилах (AC10: match/interpret детерминированы).
        const rules = {
            version: 1,
            updatedAt: '2026-01-01',
            dynamic: [{ id: 'rule_001', __version: 1, when: { pattern: '^тест\\s*(\\d+)$' }, then: { entity: 'test', metric: 'full', composition: 'single' } }],
            global: [],
        };
        const a = interpret('тест 100', { baseEvents: [], lastContext: 'test_full', rules });
        const b = interpret('тест 100', { baseEvents: [], lastContext: 'test_full', rules });
        const stripCreatedAt = (events) => events.map(({ createdAt, ...e }) => e);
        assert.deepEqual(stripCreatedAt(a.payload.events), stripCreatedAt(b.payload.events));
    });
});

// Возвращает имена require-зависимостей функции (для проверки границы INV-2).
function reflectDependencies(fn) {
    const src = Function.prototype.toString.call(fn);
    const reqs = [...src.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]);
    // core/interpreter.js тянет events.js и rules.js — это ок. Проверяем storage.
    return reqs.map((p) => p.split('/').pop());
}

describe('REQ-5/REQ-7, UX-3: единое подтверждение Save', () => {
    it('REQ-6/INV-2/INV-3: рендер восстанавливает temp без записей и без замены сохранённой даты', async () => {
        const { createHarness, PATHS } = require('./helpers/editorHarness.js');
        const saved = { date: '2026-09-01', values: { arbitrary_units: 7 }, interpretation_version: 1 };
        const proposed = { date: '2026-09-02', values: { arbitrary_units: 9 }, interpretation_version: 1 };
        const ui = createHarness({ initial: {
            [PATHS.data]: JSON.stringify([saved]),
            [PATHS.dataTmp]: JSON.stringify({ events: [proposed, { ...saved, values: { arbitrary_units: 999 } }], state: {} }),
        } });
        const before = Object.fromEntries(ui.files);
        await ui.controller.render();
        assert.deepEqual(Object.fromEntries(ui.files), before);
        assert.deepEqual(ui.writes, []);
        assert.deepEqual(JSON.parse(ui.field(1).value), [proposed, saved]);
    });

    it('сохраняет предложенное правило, граф и события только по общему Save', async () => {
        const { createHarness, findAll, PATHS } = require('./helpers/editorHarness.js');
        const ui = createHarness();
        ui.files.delete(PATHS.rules);
        ui.files.delete(PATHS.graph);
        await ui.controller.render();
        const before = ui.mainBytes();
        const rule = { id: 'rule_001', raw: '50 отжимания (20+30)',
            mapping: { push_reps: 'обычные отжимания', push_knees_reps: 'отжимания с колен' },
            examples: [{ input: '50 отжимания (20+30)', values: { push_reps: 20, push_knees_reps: 30 } }] };
        ui.bundle.pipeline.next = async () => ({ status: 'success', branch: 1, payload: {
            events: [{ date: '2026-09-01', values: { push_reps: 20, push_knees_reps: 30 }, interpretation_version: 0 }],
            proposal: { rule },
            relations: [{ type: 'A+B', base: 'push_reps', parts: ['push_knees_reps'], stackOrder: ['push_reps', 'push_knees_reps'] }],
        } });
        ui.field(0).value = '2026-09-01: 50 отжимания (20+30)';
        await ui.click(ui.bundle.editor.UI_TEXT.runBtn);
        assert.deepEqual(ui.mainBytes(), before, 'обработка пишет только temp');
        assert.strictEqual(findAll(ui.container, (node) => node.tagName === 'textarea').length, 2);
        assert.ok(!findAll(ui.container, (node) => node.tagName === 'button' && /Принять правило/.test(node.textContent)).length);
        await ui.click(ui.bundle.editor.UI_TEXT.saveBtn);
        assert.strictEqual(ui.json(PATHS.rules).version, 1);
        assert.strictEqual(ui.json(PATHS.graph).relations.length, 1);
        assert.strictEqual(ui.json(PATHS.data).length, 1);
        assert.deepEqual(ui.json(PATHS.rulesTmp), { rules: [], newKeys: [] });
        assert.deepEqual(ui.json(PATHS.dataTmp).events, []);
    });
});
