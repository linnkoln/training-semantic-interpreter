'use strict';
// ============================================================================
// tests/program-started-readable.test.js
// ЧИТАЕМЫЕ (человеческие) тесты стартового блока «Программа запущена».
//
// Источник поведения — docs/user/artifacts/architecture.canvas, узел
// «Программа запущена»:
//     - Отрисовывается график по существующим данным
//     - Показываются данные в JSON-формате (от последней к первой дате)
//     - Восстановить .tmp, показать уведомление и кнопку очистки
//   Вход: ничего (старт)  →  Выход: экран готов к работе
//
// Каждый тест записан в формате «ВХОД → ВЫХОД» простым языком:
// сначала что дано пользователю/системе, потом что должно получиться.
//
// Технические тесты тех же узлов — tests/save-preview.test.js и
// tests/tc001-wipe-state.test.js; ЭТОТ файл их не заменяет и не дублирует:
// он проверяет блок целиком, глазами пользователя.
//
// Запуск: node --test tests/program-started-readable.test.js
// ============================================================================

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const stagingMod = require(path.join(ROOT, 'adapters/staging.js'));
const tmpStoreMod = require(path.join(ROOT, 'adapters/tmpStore.js'));
const storageMod = require(path.join(ROOT, 'adapters/storage.js'));
const vaultWriterMod = require(path.join(ROOT, 'adapters/vaultWriter.js'));
const chartModel = require(path.join(ROOT, 'core/chartModel.js'));
const editorMod = require(path.join(ROOT, 'ui/editor.js'));

const STAGE_PATH = stagingMod.STAGE_PATH;                    // data/training/data.tmp.json
const DATA_PATH = storageMod.DATA_PATH;                      // data/training/data.json
const RULES_TMP_PATH = tmpStoreMod.RULESLOG_TMP_PATH;        // scripts/training/data/rulesLog.tmp.json
const GRAPH_TMP_PATH = tmpStoreMod.GRAPH_TMP_PATH;           // scripts/training/data/graph.tmp.json
const RULES_MAIN_PATH = 'scripts/training/data/rulesLog.json';
const GRAPH_MAIN_PATH = 'scripts/training/data/graph.json';

// ============================================================================
// Тестовое окружение: мини-DOM (как в tc001-wipe-state.test.js) + vault в памяти.
// ============================================================================

function makeNode(tag) {
    const node = {
        tag, children: [], style: {}, listeners: {}, parentNode: null,
        className: '', value: '', checked: false, disabled: false,
        setAttribute(n, v) { this['attr_' + n] = v; },
        appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
        remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((c) => c !== this); },
        addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); },
    };
    let _tc = '';
    Object.defineProperty(node, 'textContent', { get: () => _tc, set: (v) => { _tc = String(v); } });
    let _ih = '';
    Object.defineProperty(node, 'innerHTML', {
        get: () => _ih,
        set: (v) => { _ih = String(v); if (v === '') node.children = []; },
    });
    return node;
}

function makeDocument() {
    return {
        createElement: (tag) => makeNode(tag),
        createTextNode: (text) => ({ tag: '#text', text: String(text) }),
    };
}

/** Vault «в памяти»: файлы лежат в Map, путь → содержимое. */
function makeVault(initial) {
    const files = new Map();
    for (const [p, content] of Object.entries(initial || {})) files.set(p, { path: p, content });
    return {
        _files: files,
        getAbstractFileByPath(p) { return files.get(p) || null; },
        async read(f) { return f.content; },
        async create(p, content) { files.set(p, { path: p, content }); },
        async modify(f, content) { f.content = content; },
        async createFolder(p) { files.set(p, { path: p, content: '' }); },
        async delete(f) { files.delete(f.path); },
    };
}

function collect(root, pred, out = []) {
    if (pred(root)) out.push(root);
    for (const c of root.children || []) collect(c, pred, out);
    return out;
}

function findButtons(root) { return collect(root, (n) => n.tag === 'button'); }
function findTextareas(root) { return collect(root, (n) => n.tag === 'textarea'); }

/**
 * Собирает «бандл»-обманку: настоящие адаптеры хранилищ (vault в памяти),
 * настоящий chartModel; график «рисует» шпион, запоминающий группы.
 */
function makeBundle(vault, chartSpy) {
    return {
        staging: { makeStaging: () => stagingMod.makeStaging({ vault }) },
        tmpStore: { makeTmpStore: () => tmpStoreMod.makeTmpStore({ vault }) },
        storage: { makeStorage: () => {
            const storage = storageMod.makeStorage({ vault });
            return {
                ...storage,
                saveData: async (...args) => {
                    chartSpy.storageSaveCalls = (chartSpy.storageSaveCalls || 0) + 1;
                    try { return await storage.saveData(...args); }
                    catch (error) {
                        chartSpy.storageSaveErrors = chartSpy.storageSaveErrors || [];
                        chartSpy.storageSaveErrors.push(error.message);
                        throw error;
                    }
                },
            };
        } },
        vaultWriter: { makeVaultWriter: () => vaultWriterMod.makeVaultWriter({ vault }) },
        chartModel,
        chartview: { renderChartGrouped: (el, groups) => chartSpy.calls.push({ groups }) && [] },
        pipeline: {
            STAGE_TEXT: {
                cutter: 'Разбираем ввод на дни…',
                router: 'Просматриваем данные и определяем тип обработки…',
                structured: 'Переводим данные в события (существующие и новые сущности)…',
            },
            next: async (_input, options) => {
                chartSpy.pipelineCalls = (chartSpy.pipelineCalls || 0) + 1;
                chartSpy.lastInput = _input;
                if (chartSpy.deferPipeline) {
                    return new Promise((resolve) => {
                        chartSpy.resolvePipeline = resolve;
                        if (chartSpy.onPipelineStart) chartSpy.onPipelineStart(options);
                    });
                }
                return chartSpy.pipelineResult || { status: 'error' };
            },
            commitRules: async (result) => {
                chartSpy.commitCalls = (chartSpy.commitCalls || 0) + 1;
                chartSpy.lastCommitResult = result;
                return chartSpy.commitResult || { status: 'noop', added: 0 };
            },
        },
        loadGraph: () => ({
            relations: [{ type: 'part_of', parent: 'push_total', child: 'push_reps' }],
            targets: [],
            trends: [],
        }),
    };
}

/** Монтирует виджет (как main.js: mountEditor + render) и возвращает ручки к нему. */
async function mount(vault) {
    const document = makeDocument();
    const savedDoc = global.document;
    const savedWin = global.window;
    global.document = document;
    global.window = { confirm: () => true };
    const chartSpy = { calls: [] };
    const container = makeNode('div');
    const ctrl = editorMod.mountEditor({ container, app: { vault }, bundle: makeBundle(vault, chartSpy) });
    const state = await ctrl.render(); // ← это и есть «Программа запущена»
    return {
        ctrl,
        container,
        state,
        chartSpy,
        field1: () => findTextareas(container)[0],
        // Поле 2 — второй textarea на экране (первый — поле 1 для сырого ввода).
        field2: () => findTextareas(container)[1],
        runBtn: () => findButtons(container)[0],
        runMessage: () => {
            const button = findButtons(container)[0];
            return button.parentNode.children[button.parentNode.children.indexOf(button) + 1];
        },
        saveBtn: () => findButtons(container).find((button) => button.textContent === editorMod.UI_TEXT.saveBtn),
        saveMessage: () => {
            const button = findButtons(container).find((item) => item.textContent === editorMod.UI_TEXT.saveBtn);
            return button.parentNode.children[button.parentNode.children.indexOf(button) + 1];
        },
        cleanup() { global.document = savedDoc; global.window = savedWin; try { ctrl.destroy(); } catch (_) {} },
    };
}

function jsonFile(vault, p) { return JSON.parse(vault._files.get(p).content); }

test('Branch 2: Save подтверждает предложение вместе с данными', async () => {
    const initial = {
        [DATA_PATH]: JSON.stringify(COMMITTED),
        [RULES_MAIN_PATH]: JSON.stringify({ version: 1, entries: [] }),
        [GRAPH_MAIN_PATH]: JSON.stringify(GRAPH),
    };
    const vault = makeVault(initial);
    const ui = await mount(vault);
    try {
        const before = [DATA_PATH, RULES_MAIN_PATH, GRAPH_MAIN_PATH].map((file) => vault._files.get(file).content);
        ui.chartSpy.pipelineResult = {
            status: 'success', branch: 2,
            payload: {
                events: [{ date: '2026-09-03', values: { deadlift_kg: 50 }, interpretation_version: 1 }],
                rule: { id: 'candidate_rule', raw: 'становая тяга 50', mapping: { deadlift_kg: 'вес становой тяги' } },
                proposal: { rule: { id: 'candidate_rule', raw: 'становая тяга 50', mapping: { deadlift_kg: 'вес становой тяги' } } },
            },
        };
        ui.field1().value = 'становая тяга 50';
        await ui.runBtn().listeners.click[0]();
        assert.deepEqual([DATA_PATH, RULES_MAIN_PATH, GRAPH_MAIN_PATH].map((file) => vault._files.get(file).content), before,
            'pipeline оставляет main-файлы нетронутыми');

        assert.ok(!findButtons(ui.container).some((button) => /Принять правило/.test(button.textContent)),
            'отдельное одобрение не требуется');

        ui.chartSpy.commitResult = { status: 'noop', added: 0 };
        await ui.saveBtn().listeners.click[0]();
        assert.ok(ui.chartSpy.lastCommitResult.payload.proposal, 'Save передаёт предложенное правило в commitRules');
        assert.deepEqual(jsonFile(vault, DATA_PATH).map((event) => event.date), ['2026-09-03', '2026-09-02', '2026-08-31']);
    } finally { ui.cleanup(); }
});

test('Branch 2: единственный Save сохраняет и события, и предложение правила', async () => {
    const vault = makeVault({
        [DATA_PATH]: JSON.stringify(COMMITTED),
        [RULES_MAIN_PATH]: JSON.stringify({ version: 1, entries: [] }),
        [GRAPH_MAIN_PATH]: JSON.stringify(GRAPH),
    });
    const ui = await mount(vault);
    try {
        ui.chartSpy.pipelineResult = {
            status: 'success', branch: 2,
            payload: {
                events: [{ date: '2026-09-03', values: { deadlift_kg: 50 }, interpretation_version: 1 }],
                rule: { id: 'candidate_rule', raw: 'становая тяга 50', mapping: { deadlift_kg: 'вес становой тяги' } },
                proposal: { rule: { id: 'candidate_rule', raw: 'становая тяга 50', mapping: { deadlift_kg: 'вес становой тяги' } } },
            },
        };
        ui.field1().value = 'становая тяга 50';
        await ui.runBtn().listeners.click[0]();
        await ui.saveBtn().listeners.click[0]();
        assert.equal(Object.hasOwn(ui.chartSpy.lastCommitResult.payload, 'proposal'), true,
            'клик Save подтверждает правило без дополнительной кнопки');
        assert.deepEqual(jsonFile(vault, DATA_PATH).map((event) => event.date), ['2026-09-03', '2026-09-02', '2026-08-31'],
            'пользовательские данные сохраняются независимо от одобрения нового правила');
    } finally { ui.cleanup(); }
});

// ============================================================================
// Данные «как у пользователя»: две тренировки, отжимания. Новая дата — сверху.
// ============================================================================
const COMMITTED = [
    { date: '2026-09-02', values: { push_reps: 15 }, interpretation_version: 1 },
    { date: '2026-08-31', values: { push_reps: 10 }, interpretation_version: 1 },
];
const GRAPH = {
    relations: [{ type: 'part_of', parent: 'push_total', child: 'push_reps' }],
    targets: [],
    trends: [],
};

// ============================================================================
// Тест 1 — график рисуется по уже сохранённым данным
// ============================================================================

// ── ВХОД ────────────────────────────────────────────────────────────────────
// Пользователь открывает заметку, ничего не вводит. В хранилище уже лежат:
//   data.json  — две тренировки (2026-09-02 и 2026-08-31, отжимания);
//   graph.json — связь «push_reps входит в группу push_total».
// ── ВЫХОД ───────────────────────────────────────────────────────────────────
// Сразу после старта на экране график:
//   • построена группа «🏋️ Push» (по графу, а не по догадкам);
//   • в неё попали ОБЕ сохранённые тренировки с их значениями (10 и 15);
//   • сам data.json при этом не переписан (старт — только чтение, INV-2).
test('Старт: график отрисован по существующим data.json + graph.json', async () => {
    const vault = makeVault({
        [DATA_PATH]: JSON.stringify(COMMITTED, null, 2),
        // graph.json в тесте «живёт» отдельно: его отдаёт b.loadGraph (мимикрия под живой граф)
        'graph.json': JSON.stringify(GRAPH, null, 2),
    });
    const ui = await mount(vault);
    try {
        assert.equal(ui.chartSpy.calls.length, 1, 'график отрисован ровно один раз за старт');
        const groups = ui.chartSpy.calls[0].groups;
        const push = groups.find((g) => String(g.title).includes('Push'));
        assert.ok(push, 'есть группа отжиманий («🏋️ Push»), получены: ' + groups.map((g) => g.title).join(', '));
        const cfg = push.config;
        assert.deepEqual(cfg.labels, ['08-31', '09-02'], 'обе сохранённые даты на оси графика');
        const data = cfg.datasets.flatMap((d) => d.data);
        assert.ok(data.includes(15) && data.includes(10), 'сохранённые значения (10 и 15) на графике');
        // INV-2: старт не пишет файл данных
        assert.deepEqual(jsonFile(vault, DATA_PATH), COMMITTED, 'data.json не изменён при старте');
    } finally { ui.cleanup(); }
});

// ============================================================================
// Тест 2 — поле 2 показывает данные JSON от последней даты к первой
// ============================================================================

// ── ВХОД ────────────────────────────────────────────────────────────────────
// Тот же старт с сохранёнными данными (две даты: 2026-09-02 свежее, 2026-08-31 старше).
// ── ВЫХОД ───────────────────────────────────────────────────────────────────
// Поле 2 (JSON-окно) сразу при старте заполнено: события идут от ПОСЛЕДНЕЙ даты
// к первой (стек: свежая запись сверху), валидный JSON, все события на месте.
test('Старт: поле 2 показывает JSON от последней даты к первой', async () => {
    const vault = makeVault({
        [DATA_PATH]: JSON.stringify(COMMITTED, null, 2),
    });
    const ui = await mount(vault);
    try {
        const shown = JSON.parse(ui.field2().value); // валидный JSON, а не каша
        assert.ok(Array.isArray(shown) && shown.length === 2, 'в поле 2 оба события');
        assert.equal(shown[0].date, '2026-09-02', 'сверху — последняя (свежая) дата');
        assert.equal(shown[1].date, '2026-08-31', 'ниже — более ранняя дата');
        assert.deepEqual(shown[0].values, { push_reps: 15 }, 'значения события не искажены');
    } finally { ui.cleanup(); }
});

// ============================================================================
// Тест 3 — при старте восстановлены остатки прошлой сессии
// ============================================================================

// ── ВХОД ────────────────────────────────────────────────────────────────────
// Прошлая сессия не завершилась сохранением: data.tmp.json содержит
// черновик-превью (событие-призрак) и память UI (скрытая группа «push»).
// Пользователь заново открывает виджет (старт).
// ── ВЫХОД ───────────────────────────────────────────────────────────────────
// Черновик прошлой сессии сохранён: data.tmp.json — события восстановлены;
// память UI (hiddenGroups) при этом сохранена (это настройки, не данные);
// поле 2 и график показывают сохранённые данные вместе с черновиком;
// data.json не тронут (INV-2).
test('Старт: data.tmp.json восстановлен, data.json не тронут', async () => {
    const vault = makeVault({
        [DATA_PATH]: JSON.stringify(COMMITTED, null, 2),
        [STAGE_PATH]: JSON.stringify({
            events: [{ date: '2026-09-03', values: { press_new: 40 }, interpretation_version: 1 }],
            state: { hiddenGroups: ['push'] },
        }, null, 2),
    });
    const ui = await mount(vault);
    try {
        const staged = jsonFile(vault, STAGE_PATH);
        assert.equal(staged.events.length, 1, 'черновые события прошлой сессии сохранены');
        assert.deepEqual(staged.state.hiddenGroups, ['push'], 'память UI (настройки) переживает старт');
        const shown = JSON.parse(ui.field2().value);
        assert.deepEqual(shown.map((e) => e.date), ['2026-09-03', '2026-09-02', '2026-08-31'], 'показаны committed + temp');
        assert.deepEqual(jsonFile(vault, DATA_PATH), COMMITTED, 'data.json не изменён при старте (INV-2)');
    } finally { ui.cleanup(); }
});

test('Старт: все временные предложения восстановлены, committed данные и UI настройки сохранены', async () => {
    const vault = makeVault({
        [DATA_PATH]: JSON.stringify(COMMITTED, null, 2),
        [STAGE_PATH]: JSON.stringify({ events: [{ date: '2026-09-03', values: { press_new: 40 } }], state: { hiddenGroups: ['push'] } }, null, 2),
        [RULES_TMP_PATH]: JSON.stringify({ newKeys: [{ key: 'press_new', chunk: 'пресс 40' }] }, null, 2),
        [GRAPH_TMP_PATH]: JSON.stringify({ relations: [{ type: 'part_of', parent: 'press', child: 'press_new' }], targets: [], trends: [] }, null, 2),
    });
    const ui = await mount(vault);
    try {
        assert.equal(jsonFile(vault, RULES_TMP_PATH).newKeys.length, 1, 'временные правила сохранены');
        assert.equal(jsonFile(vault, GRAPH_TMP_PATH).relations.length, 1, 'временные связи сохранены');
        assert.equal(jsonFile(vault, STAGE_PATH).events.length, 1, 'события staging сохранены');
        assert.deepEqual(jsonFile(vault, STAGE_PATH).state.hiddenGroups, ['push'], 'настройки интерфейса сохранены');
        assert.deepEqual(jsonFile(vault, DATA_PATH), COMMITTED, 'основные данные не изменены');
    } finally { ui.cleanup(); }
});

test('Сбой очистки Vault блокирует обработку и Save, сохраняя committed данные', async () => {
    const vault = makeVault({
        [DATA_PATH]: JSON.stringify(COMMITTED, null, 2),
        [RULES_TMP_PATH]: JSON.stringify({ newKeys: [{ key: 'press_new', chunk: 'пресс 40' }] }, null, 2),
        [GRAPH_TMP_PATH]: JSON.stringify({ relations: [{ type: 'part_of', parent: 'press', child: 'press_new' }], targets: [], trends: [] }, null, 2),
    });
    const modify = vault.modify.bind(vault);
    vault.modify = async (file, content) => {
        if (file.path === RULES_TMP_PATH) throw new Error('simulated vault write failure');
        return modify(file, content);
    };
    const ui = await mount(vault);
    try {
        assert.equal(ui.state.tmpCleanupReady, true, 'старт только читает файлы и не требует очистки');
        ui.field1().value = 'любая запись';
        await ui.runBtn().listeners.click[0]();
        assert.equal(ui.state.tmpCleanupReady, false, 'ошибка очистки перед новым циклом отмечена');
        assert.equal(ui.chartSpy.pipelineCalls || 0, 0, 'pipeline не вызван после отказа очистки');
        await ui.saveBtn().listeners.click[0]();
        assert.deepEqual(jsonFile(vault, DATA_PATH), COMMITTED, 'Save не изменил committed данные');
        assert.deepEqual(jsonFile(vault, RULES_TMP_PATH).newKeys, [{ key: 'press_new', chunk: 'пресс 40' }], 'неочищенный temp остаётся без применения');
    } finally { ui.cleanup(); }
});

test('Save: частичный Vault отказ откатывает все main JSON, сохраняет temp и безопасно повторяется', async () => {
    const oldDataRaw = JSON.stringify(COMMITTED, null, 2);
    const oldRulesRaw = JSON.stringify({ version: 1, entries: [{ version: 1, rulesSnapshot: { dynamic: [], global: [] } }] }, null, 2);
    const oldGraphRaw = JSON.stringify(GRAPH, null, 2);
    const vault = makeVault({
        [DATA_PATH]: oldDataRaw,
        [RULES_MAIN_PATH]: oldRulesRaw,
        [GRAPH_MAIN_PATH]: oldGraphRaw,
        [RULES_TMP_PATH]: JSON.stringify({ rules: [], newKeys: [] }),
        [GRAPH_TMP_PATH]: JSON.stringify({ relations: [], targets: [], trends: [] }),
    });
    const modify = vault.modify.bind(vault);
    let failGraphOnce = true;
    vault._dataWrites = [];
    vault.modify = async (file, content) => {
        if (file.path === DATA_PATH) vault._dataWrites.push(content);
        const result = await modify(file, content);
        if (file.path === GRAPH_MAIN_PATH && failGraphOnce) {
            failGraphOnce = false;
            throw new Error('simulated partial graph write failure');
        }
        return result;
    };
    const ui = await mount(vault);
    try {
        ui.chartSpy.pipelineResult = {
            status: 'success', branch: 1,
            payload: {
                events: [{ date: '2026-09-03', values: { press_reps: 20 }, interpretation_version: 1 }],
                newKeys: [{ key: 'press_reps', chunk: 'отжимания', values: { press_reps: 20 } }],
            },
        };
        ui.chartSpy.commitResult = {
            status: 'success', added: 1,
            payload: {
                log: { version: 2, entries: [{ version: 2, rulesSnapshot: { dynamic: [], global: [] } }] },
                graph: { relations: [{ type: 'part_of', parent: 'press_total', child: 'press_reps' }], targets: [], trends: [] },
            },
        };
        ui.field1().value = '20 отжиманий';
        await ui.runBtn().listeners.click[0]();
        assert.ok(JSON.parse(ui.field2().value).some((event) => event.date === '2026-09-03'), 'результат pipeline появился в staged preview');
        const stagedRaw = vault._files.get(STAGE_PATH).content;
        const tempRulesRaw = vault._files.get(RULES_TMP_PATH).content;

        await ui.saveBtn().listeners.click[0]();
        assert.equal(ui.chartSpy.commitCalls, 1, 'Save control invoked commitRules once');
        assert.equal(vault._files.get(DATA_PATH).content, oldDataRaw, 'data.json восстановлен после отказа');
        assert.equal(vault._files.get(RULES_MAIN_PATH).content, oldRulesRaw, 'rulesLog.json восстановлен после отказа');
        assert.equal(vault._files.get(GRAPH_MAIN_PATH).content, oldGraphRaw, 'graph.json восстановлен побайтно после частичной записи');
        assert.equal(vault._files.get(STAGE_PATH).content, stagedRaw, 'staged-превью сохранено для повтора');
        assert.equal(vault._files.get(RULES_TMP_PATH).content, tempRulesRaw, 'временное предложение правила сохранено для повтора');
        assert.ok(JSON.parse(ui.field2().value).some((event) => event.date === '2026-09-03'), 'превью доступно для повторного Save');

        await ui.saveBtn().listeners.click[0]();
        assert.equal(ui.chartSpy.commitCalls, 2, 'повторный Save снова вычислил предложение');
        assert.equal(ui.chartSpy.storageSaveCalls, 2, `storage.saveData вызван; msg=${ui.saveMessage().textContent}`);
        assert.ok(JSON.parse(vault._dataWrites.at(-1)).some((event) => event.date === '2026-09-03'), 'в транзакцию повторного Save передано staged-событие');
        assert.deepEqual(jsonFile(vault, DATA_PATH).map((event) => event.date), ['2026-09-03', '2026-09-02', '2026-08-31'], 'повтор применил событие один раз');
        assert.equal(jsonFile(vault, RULES_MAIN_PATH).version, 2, 'правило записано при успешном повторе');
        assert.equal(jsonFile(vault, GRAPH_MAIN_PATH).relations.length, 1, 'связь записана ровно один раз');
        assert.deepEqual(jsonFile(vault, RULES_TMP_PATH), { rules: [], newKeys: [] }, 'temp правил очищен после успешного повтора');
        assert.deepEqual(jsonFile(vault, GRAPH_TMP_PATH), { relations: [] }, 'temp графа очищен после успешного повтора');
    } finally { ui.cleanup(); }
});

test('UI: статусы стадий видны по ходу pipeline, ошибка не создаёт preview', async () => {
    const vault = makeVault({ [DATA_PATH]: JSON.stringify(COMMITTED, null, 2) });
    const ui = await mount(vault);
    try {
        ui.field1().value = 'запись для проверки стадий';
        ui.chartSpy.deferPipeline = true;
        let resolveStarted;
        const started = new Promise((resolve) => { resolveStarted = resolve; });
        ui.chartSpy.onPipelineStart = resolveStarted;

        const runPromise = ui.runBtn().listeners.click[0]();
        const options = await started;
        const observedStages = [];
        const onStage = options.onStage;
        options.onStage = (stage) => { observedStages.push(stage); onStage(stage); };
        options.onStage('cutter');
        assert.equal(ui.runMessage().textContent, '⏳ Разбираем ввод на дни…', 'пользователь видит Cutter');
        options.onStage('router');
        assert.equal(ui.runMessage().textContent, '⏳ Просматриваем данные и определяем тип обработки…', 'пользователь видит Router');
        options.onStage('structured');
        assert.equal(ui.runMessage().textContent, '⏳ Переводим данные в события (существующие и новые сущности)…', 'пользователь видит Structured');

        ui.chartSpy.resolvePipeline({ status: 'error', message: 'simulated structured failure' });
        await runPromise;
        assert.deepEqual(observedStages, ['cutter', 'router', 'structured'], 'стадии пришли в ожидаемом порядке');
        assert.match(ui.runMessage().textContent, /Ошибка: simulated structured failure/, 'pipeline-ошибка показана явно');
        assert.deepEqual(JSON.parse(ui.field2().value), COMMITTED, 'ошибка не добавила события в preview');
        assert.deepEqual(jsonFile(vault, STAGE_PATH).events, [], 'ошибка не записала staged-события');
    } finally {
        if (ui.chartSpy.resolvePipeline) ui.chartSpy.resolvePipeline({ status: 'error', message: 'test cleanup' });
        ui.cleanup();
    }
});

test('UI: поле 1 передаётся дословно, main не меняется до запуска, двойной клик не дублирует pipeline', async () => {
    const initial = {
        [DATA_PATH]: JSON.stringify(COMMITTED, null, 2),
        [RULES_MAIN_PATH]: JSON.stringify({ version: 1, entries: [] }),
        [GRAPH_MAIN_PATH]: JSON.stringify(GRAPH, null, 2),
    };
    const vault = makeVault(initial);
    const ui = await mount(vault);
    try {
        const rawInput = '  \t*09-03* 20 отжимания\r\nКомментарий: оставить дословно  \n';
        const mainBefore = [DATA_PATH, RULES_MAIN_PATH, GRAPH_MAIN_PATH].map((file) => vault._files.get(file).content);
        ui.field1().value = ' \t\r\n ';
        await ui.runBtn().listeners.click[0]();
        assert.equal(ui.chartSpy.pipelineCalls || 0, 0, 'пустой/whitespace-only ввод не вызывает pipeline');
        assert.deepEqual([DATA_PATH, RULES_MAIN_PATH, GRAPH_MAIN_PATH].map((file) => vault._files.get(file).content), mainBefore, 'пустой ввод не меняет main-файлы');

        ui.field1().value = rawInput;
        assert.equal(ui.field1().value, rawInput, 'UI не переписывает введённый текст');
        assert.equal(ui.chartSpy.pipelineCalls || 0, 0, 'ввод сам по себе не запускает pipeline');
        assert.deepEqual([DATA_PATH, RULES_MAIN_PATH, GRAPH_MAIN_PATH].map((file) => vault._files.get(file).content), mainBefore, 'до кнопки main-файлы не меняются');

        ui.chartSpy.deferPipeline = true;
        let resolveStarted;
        const started = new Promise((resolve) => { resolveStarted = resolve; });
        ui.chartSpy.onPipelineStart = resolveStarted;
        const firstRun = ui.runBtn().listeners.click[0]();
        const secondRun = ui.runBtn().listeners.click[0]();
        await started;
        assert.equal(ui.chartSpy.pipelineCalls, 1, 'пока первый запуск обрабатывается, второй клик игнорируется');
        assert.equal(ui.chartSpy.lastInput, rawInput, 'pipeline получает исходный текст, включая пробелы и переносы');
        assert.deepEqual([DATA_PATH, RULES_MAIN_PATH, GRAPH_MAIN_PATH].map((file) => vault._files.get(file).content), mainBefore, 'до Save все main-файлы прежние');

        ui.chartSpy.resolvePipeline({ status: 'error', message: 'expected test result' });
        await Promise.all([firstRun, secondRun]);
        assert.equal(ui.chartSpy.pipelineCalls, 1, 'за оба клика выполнен ровно один pipeline');
        assert.deepEqual([DATA_PATH, RULES_MAIN_PATH, GRAPH_MAIN_PATH].map((file) => vault._files.get(file).content), mainBefore, 'после неуспешного preview main-файлы прежние');
    } finally {
        if (ui.chartSpy.resolvePipeline) ui.chartSpy.resolvePipeline({ status: 'error', message: 'test cleanup' });
        ui.cleanup();
    }
});

test('UI: повторный запуск с ошибкой сбрасывает прошлый результат, правило и preview-ключи', async () => {
    const rulesRaw = JSON.stringify({ version: 1, entries: [{ version: 1, rulesSnapshot: { dynamic: [], global: [] } }] });
    const graphRaw = JSON.stringify(GRAPH, null, 2);
    const vault = makeVault({
        [DATA_PATH]: JSON.stringify(COMMITTED, null, 2),
        [RULES_MAIN_PATH]: rulesRaw,
        [GRAPH_MAIN_PATH]: graphRaw,
    });
    const ui = await mount(vault);
    try {
        const baseChart = ui.chartSpy.calls[ui.chartSpy.calls.length - 1].groups;
        ui.field1().value = 'новое упражнение 20';
        ui.chartSpy.pipelineResult = {
            status: 'success', branch: 1,
            payload: {
                events: [{ date: '2026-09-03', values: { pull_reps: 20 }, interpretation_version: 1 }],
                newKeys: [{ key: 'pull_reps', chunk: 'подтягивания', values: { pull_reps: 20 } }],
            },
        };
        await ui.runBtn().listeners.click[0]();
        assert.ok(JSON.parse(ui.field2().value).some((event) => event.date === '2026-09-03'), 'успешная первая попытка показана в preview');
        assert.ok(jsonFile(vault, RULES_TMP_PATH).newKeys.some((item) => item.key === 'pull_reps'), 'предложение первой попытки лежит во временном слое');

        ui.field1().value = 'повторная попытка';
        ui.chartSpy.pipelineResult = { status: 'error', message: 'second run failed' };
        await ui.runBtn().listeners.click[0]();
        assert.deepEqual(JSON.parse(ui.field2().value), COMMITTED, 'старое staged-событие снято с preview');
        assert.deepEqual(ui.chartSpy.calls[ui.chartSpy.calls.length - 1].groups, baseChart, 'preview chart вернулся к main-графу и committed данным');
        assert.deepEqual(jsonFile(vault, RULES_TMP_PATH), { rules: [], newKeys: [] }, 'временное правило прошлой попытки удалено');
        assert.deepEqual(jsonFile(vault, GRAPH_TMP_PATH), { relations: [] }, 'временные связи прошлой попытки удалены');

        await ui.saveBtn().listeners.click[0]();
        assert.equal(ui.chartSpy.commitCalls || 0, 0, 'Save после ошибки не фиксирует lastResult прошлой попытки');
        assert.deepEqual(jsonFile(vault, DATA_PATH), COMMITTED, 'Save после ошибки не добавил отброшенное событие');
        assert.equal(vault._files.get(RULES_MAIN_PATH).content, rulesRaw, 'Save после ошибки не обновил правила');
        assert.equal(vault._files.get(GRAPH_MAIN_PATH).content, graphRaw, 'Save после ошибки не обновил граф');
    } finally { ui.cleanup(); }
});

// ============================================================================
// Тест 4 — все .tmp-файлы очищаются перед новым циклом работы
// ============================================================================

// ── ВХОД ────────────────────────────────────────────────────────────────────
// Прошлый прогон пользователя не удовлетворил: во временных файлах остались
// его следы — rulesLog.tmp.json (ключи прошлой сессии), graph.tmp.json
// (связи прошлой сессии), data.tmp.json (черновик). Поле 1 ПУСТО,
// пользователь нажимает «Обработать данные» — цикл запускается заново.
// ── ВЫХОД ───────────────────────────────────────────────────────────────────
// Все три .tmp-файла очищены ДО начала обработки (чистый временный слой):
//   rulesLog.tmp.json → newKeys: []; graph.tmp.json → без связей;
//   data.tmp.json → события пусты. Пользователю показано предупреждение
//   «Вставьте данные!» (пустой ввод не «обрабатывается» молча).
test('Новый цикл: все .tmp-файлы прошлой сессии очищены', async () => {
    const vault = makeVault({
        [DATA_PATH]: JSON.stringify(COMMITTED, null, 2),
        [STAGE_PATH]: JSON.stringify({
            events: [{ date: '2026-09-03', values: { press_new: 40 }, interpretation_version: 1 }],
            state: {},
        }, null, 2),
        [RULES_TMP_PATH]: JSON.stringify({ newKeys: [{ key: 'press_new', chunk: 'пресс 40' }] }, null, 2),
        [GRAPH_TMP_PATH]: JSON.stringify({ relations: [{ type: 'part_of', parent: 'press', child: 'press_new' }], targets: [], trends: [] }, null, 2),
    });
    const ui = await mount(vault);
    try {
        const btn = ui.runBtn();
        assert.ok(btn, 'кнопка «Обработать данные» найдена');
        await btn.listeners.click[0]();
        const rulesTmp = jsonFile(vault, RULES_TMP_PATH);
        const graphTmp = jsonFile(vault, GRAPH_TMP_PATH);
        const staged = jsonFile(vault, STAGE_PATH);
        assert.deepEqual(rulesTmp.newKeys, [], 'rulesLog.tmp.json очищен');
        assert.deepEqual(graphTmp.relations, [], 'graph.tmp.json очищен');
        assert.deepEqual(staged.events, [], 'data.tmp.json очищен');
        assert.deepEqual(jsonFile(vault, DATA_PATH), COMMITTED, 'data.json по-прежнему не тронут (INV-2)');
    } finally { ui.cleanup(); }
});
