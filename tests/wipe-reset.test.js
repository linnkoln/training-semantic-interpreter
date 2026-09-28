'use strict';
// tests/wipe-reset.test.js — «ФАКТИЧЕСКИЙ вайп» (запрос заказчика, docs/user/quotes.md 2026-09-01,
// документация уровня 1: «полный сброс будет сбрасывать правила, графы, словари и данные, то есть
// переводить состояние системы в состояние, как будто в системе не было ничего записано»).
//
// Кнопка «🧹 Очистить память (полный сброс)» ПЕРЕЗАПИСЫВАЕТ data/rulesLog.json ЛИТЕРАЛЬНО ПУСТЫМ:
//   { version: 0, updatedAt: <ISO>, entries: [] }
// Ни истории правил, ни записи о самом сбросе (changeType 'wipe') в журнале быть не должно —
// заказчик: «есть запись в рулс логе о сбросе — её не должно там быть». Та же форма, что в
// tools/reset-all-data.js (прямое указание пользователя 2026-08-30). version: 0 — явное исключение
// из INV-5 (монотонные версии) ТОЛЬКО для пользовательского сброса: следующий Save даёт version 1.
// Пустой entries безопасен: getLatestRules() откатывается на DEFAULT_RULES (core/rules.js), а тот
// сам пуст — правила не «воскресают» из обнулённого файла. handleWipe обязан синхронизировать
// рантайм-кэш rulesLog (setCachedLog) — иначе формат {{RULES}} и база Save продолжают жить
// до-сбросным состоянием.
//
// ИЗОЛЯЦИЯ (обязательно): тест НИКОГДА не пишет в data/*.json — путь лога переводится во
// временный каталог вне репозитория (os.tmpdir() + mkdtemp) и восстанавливается в finally.
//
// Запуск: node --test tests/wipe-reset.test.js

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const rulesLog = require(path.join(ROOT, 'core/rulesLog.js'));
const vaultWriterMod = require(path.join(ROOT, 'adapters/vaultWriter.js'));
const stagingMod = require(path.join(ROOT, 'adapters/staging.js'));
const tmpStoreMod = require(path.join(ROOT, 'adapters/tmpStore.js'));
const storageMod = require(path.join(ROOT, 'adapters/storage.js'));
const chartModel = require(path.join(ROOT, 'core/chartModel.js'));
const editorMod = require(path.join(ROOT, 'ui/editor.js'));

const UI_TEXT = editorMod.UI_TEXT;
const RULESLOG_VAULT_PATH = vaultWriterMod.FILES.rulesLog;

// ---- фикстура: лог с одним правилом rule_001 ---------------------------------
const SEED_RULE = {
    id: 'rule_001',
    raw: 'жим 100',
    mapping: { press_kg: 'жим, вес' },
    examples: [{ input: 'жим 100', values: { press_kg: 100 } }],
    __version: 1,
};

function seedLog() {
    return {
        version: 1,
        updatedAt: '2026-09-01T00:00:00.000Z',
        entries: [{
            version: 1,
            timestamp: '2026-09-01T00:00:00.000Z',
            changeType: 'add',
            rulesSnapshot: {
                version: 1,
                updatedAt: '2026-09-01T00:00:00.000Z',
                dynamic: [SEED_RULE],
                global: [],
            },
            meta: { proposedBy: 'seed' },
        }],
    };
}

/**
 * Изоляция: лог правил — во временном каталоге ВНЕ репозитория (data/*.json не трогаем).
 * Возвращает ручку с dispose(), который возвращает прежний путь, сбрасывает кэш и удаляет каталог.
 */
function isolateLog() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wipe-reset-'));
    const logPath = path.join(dir, 'rulesLog.json');
    fs.writeFileSync(logPath, JSON.stringify(seedLog(), null, 2), 'utf8');
    // страховка: путь действительно вне data/ репозитория
    assert.ok(!logPath.startsWith(path.join(ROOT, 'data') + path.sep),
        'temp-лог не должен жить в data/ репозитория (vault пользователя)');
    const origPath = rulesLog._getLogPath();
    rulesLog._resetCache();
    rulesLog._setLogPath(logPath);
    return {
        dir,
        logPath,
        origPath,
        dispose() {
            rulesLog._setLogPath(origPath);
            rulesLog._resetCache();
            try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
        },
    };
}

function readJsonFile(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }

/** «Пустой срез правил»: formatRecentRules сериализует pretty-print (null, 2), поэтому
 *  сравниваем без незначащих пробелов — по смыслу это ровно {"rules":[]}. */
function compactJson(s) { return String(s).replace(/\s+/g, ''); }
function isEmptyRulesSlice(s) { return compactJson(s) === '{"rules":[]}'; }

/** Единственная легальная форма лога сброса: { version: 0, updatedAt: <ISO>, entries: [] }. */
function assertLiterallyEmptyLog(log, label) {
    assert.deepEqual(Object.keys(log).sort(), ['entries', 'updatedAt', 'version'],
        `${label}: ровно три поля version/updatedAt/entries`);
    assert.equal(log.version, 0, `${label}: version 0 («ничего не записано») `);
    assert.deepEqual(log.entries, [], `${label}: entries ЛИТЕРАЛЬНО пуст`);
    assert.equal(typeof log.updatedAt, 'string', `${label}: updatedAt обязателен`);
    assert.ok(!Number.isNaN(Date.parse(log.updatedAt)), `${label}: updatedAt — валидный ISO`);
    // следа сброса в журнале нет ни в каком виде
    assert.ok(!JSON.stringify(log).includes('wipe'), `${label}: записи о сбросе ('wipe') нет`);
}

// ============================================================
// (a) buildWipeLog — форма лога сброса (чистая функция)
// ============================================================

test('buildWipeLog: ЛИТЕРАЛЬНО пустой журнал { version: 0, updatedAt, entries: [] } без записи wipe', () => {
    const prev = seedLog();
    const log = rulesLog.buildWipeLog(prev);

    assertLiterallyEmptyLog(log, 'buildWipeLog');
    assert.equal(log.entries.length, 0, 'в журнале НЕТ ни одной записи');
    // история правил НЕ сохраняется и следа сброса нет: ни правила, ни его ключей
    assert.ok(!JSON.stringify(log).includes('rule_001'), 'прежние правила не должны попасть в wipe-лог');
    assert.ok(!JSON.stringify(log).includes('press_kg'), 'ключи прежних правил не должны попасть в wipe-лог');
    assert.ok(!JSON.stringify(log).includes('user-request'), 'запись о самом сбросе (meta) не пишется');
    // чистая функция: вход не мутирован
    assert.equal(prev.entries.length, 1);
    assert.equal(prev.version, 1);
    assert.deepEqual(prev.entries[0].rulesSnapshot.dynamic, [SEED_RULE]);
});

test('buildWipeLog: prevLog ИГНОРИРУЕТСЯ — version всегда 0, entries всегда [] (prev = 5/7/null/битый)', () => {
    for (const prev of [null, undefined, {}, { version: 0 }, { version: 5, entries: [] }, seedLog(),
        { version: 7, updatedAt: 'x', entries: [{ version: 7 }] }]) {
        const log = rulesLog.buildWipeLog(prev);
        assertLiterallyEmptyLog(log, `buildWipeLog(prev=${JSON.stringify(prev)})`);
        assert.equal(log.entries.length, 0,
            `entries===0 для prev=${JSON.stringify(prev)} (форма сброса не зависит от prev)`);
    }
});

test("'wipe' не пишется НИГДЕ: computeRuleEntry по-прежнему не знает такого changeType", () => {
    assert.throws(() => rulesLog.computeRuleEntry({ id: 'x' }, 'wipe'), /неизвестный changeType/);
    // белый список правил (add/update/deprecate/migrate) не расширен
    assert.throws(() => rulesLog.appendRule({ id: 'x' }, 'wipe'), /неизвестный changeType/);
});

// ============================================================
// (b)(c) после вайпа: пустой формат правил, база Save без воскрешения, чистая нумерация
// ============================================================

test('после вайпа: formatRecentRules = {"rules":[]}, Save-база пуста, нумерация начинается заново (rule_001, version 1)', () => {
    const iso = isolateLog();
    try {
        // как UI после render(): кэш поднят логом из vault-файла
        rulesLog.setCachedLog(seedLog());
        assert.match(rulesLog.formatRecentRules(Infinity), /rule_001/, 'санити: до вайпа правило видно');

        const wipe = rulesLog.buildWipeLog(rulesLog.getRulesLog());
        fs.writeFileSync(iso.logPath, JSON.stringify(wipe, null, 2), 'utf8'); // vaultWriter.writeRulesLog
        rulesLog.setCachedLog(wipe);                                          // handleWipe, шаг 3b

        // (b) правила после вайпа не видны ни движку, ни роутеру
        assert.ok(isEmptyRulesSlice(rulesLog.formatRecentRules(Infinity)), '{{RULES}} после вайпа пуст');
        assert.deepEqual(JSON.parse(rulesLog.formatRecentRules(Infinity)), { rules: [] });
        assert.equal(rulesLog.getLatestRules().dynamic.length, 0);
        assert.equal(rulesLog.getLatestRules().global.length, 0);
        assert.equal(rulesLog.getVersion(), 0, 'версия лога после сброса — 0');

        // (c) Save-база после вайпа: записей нет, прежних id нет
        const log = rulesLog.getRulesLog();
        assert.equal(log.entries.length, 0, 'в журнале нет ни одной записи');
        assertLiterallyEmptyLog(log, 'рантайм-лог после вайпа');
        assert.ok(!JSON.stringify(log).includes('rule_001'), 'прежний id отсутствует');
        assert.ok(!JSON.stringify(log).includes('press_kg'), 'прежние ключи отсутствуют');

        // файл на диске = кэш (иначе следующий Save перезапишет до-сбросным состоянием)
        const onDisk = readJsonFile(iso.logPath);
        assertLiterallyEmptyLog(onDisk, 'файл на диске после вайпа');
        assert.equal(onDisk.version, wipe.version);
        assert.equal(onDisk.entries.length, 0);

        // следующий шаг — ЧИСТАЯ нумерация: ни одного прежнего номера не осталось
        assert.equal(rulesLog.nextRuleId(rulesLog.getLatestRules()), 'rule_001',
            'после сброса первый id — rule_001 (счёт идёт с нуля)');

        // первое же добавленное правило поднимает версию в 1 (0 + 1) и не воскрешает прежние
        const entry = rulesLog.appendRule({ id: 'rule_001', raw: 'новое правило' }, 'add', {});
        assert.equal(entry.version, 1, 'первая append-запись даёт version 1');
        assert.equal(rulesLog.getVersion(), 1, 'getVersion() === 1 после appendRule');
        const after = rulesLog.getRulesLog();
        assert.equal(after.entries.length, 1, 'истории прежних версий нет: одна запись');
        assert.equal(after.entries[0].rulesSnapshot.dynamic.length, 1);
        assert.ok(!JSON.stringify(after).includes('press_kg'), 'старое правило не воскресло');
    } finally {
        iso.dispose();
    }
});

test('регресс-мотивация: без setCachedLog кэш остаётся до-сбросным (правила живут после вайпа файла)', () => {
    const iso = isolateLog();
    try {
        rulesLog.setCachedLog(seedLog());
        const wipe = rulesLog.buildWipeLog(rulesLog.getRulesLog());
        fs.writeFileSync(iso.logPath, JSON.stringify(wipe, null, 2), 'utf8');
        // файл перезаписан, но кэш НЕ обновлён (прежнее поведение handleWipe):
        assert.match(rulesLog.formatRecentRules(Infinity), /rule_001/,
            'именно этот дефект закрывает setCachedLog(freshLog) в handleWipe');
        // и _resetCache() тоже не выход: читаем НЕ файл, а то, что лежит в пути лога (в браузере — шим бандла)
        rulesLog._resetCache();
        assert.equal(rulesLog.getLatestRules().dynamic.length, 0, 'в node _resetCache читает temp-файл (в браузере — вшитую копию)');
    } finally {
        iso.dispose();
    }
});

// ============================================================
// (d) UI-уровень: клик по кнопке полного сброса
// ============================================================

// ---- минимальный DOM-шим (как в tests/tc001-wipe-state.test.js) --------------
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

function findButton(root, label) {
    if (root.textContent === label) return root;
    for (const c of root.children || []) {
        const hit = findButton(c, label);
        if (hit) return hit;
    }
    return null;
}

/** Vault «в памяти»: файлы в Map (как в tests/program-started-readable.test.js). */
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

/**
 * «Бандл»: НАСТОЯЩИЕ адаптеры (vault в памяти) + НАСТОЯЩИЙ core/rulesLog.js
 * (как в проде: handleWipe вызывает b.rulesLog.buildWipeLog/setCachedLog).
 */
function makeBundle(vault, spy) {
    const loadGraph = () => ({ relations: [], targets: [], trends: [] });
    loadGraph.setLatestGraph = (g) => { spy.latestGraph = g; };
    return {
        staging: { makeStaging: () => stagingMod.makeStaging({ vault }) },
        tmpStore: { makeTmpStore: () => tmpStoreMod.makeTmpStore({ vault }) },
        storage: { makeStorage: () => storageMod.makeStorage({ vault }) },
        vaultWriter: { makeVaultWriter: () => vaultWriterMod.makeVaultWriter({ vault }) },
        chartModel,
        chartview: { renderChartGrouped: () => [] },
        loadGraph,
        rulesLog,      // настоящий модуль: buildWipeLog + setCachedLog + getRulesLog
        renderRules: {},
    };
}

async function mount(vault) {
    const document = makeDocument();
    const savedDoc = global.document;
    const savedWin = global.window;
    global.document = document;
    global.window = { confirm: () => true };
    const spy = {};
    const container = makeNode('div');
    const ctrl = editorMod.mountEditor({ container, app: { vault }, bundle: makeBundle(vault, spy) });
    await ctrl.render();
    return {
        ctrl,
        container,
        spy,
        wipe: async () => {
            const btn = findButton(container, UI_TEXT.wipeBtn);
            assert.ok(btn, 'wipe-кнопка не найдена в DOM');
            await btn.listeners.click[0]();
        },
        cleanup() { global.document = savedDoc; global.window = savedWin; try { ctrl.destroy(); } catch (_) {} },
    };
}

test('UI: клик «полный сброс» пишет ЛИТЕРАЛЬНО пустой rulesLog.json и чистит рантайм-кэш', async () => {
    const iso = isolateLog();
    const vault = makeVault({
        [RULESLOG_VAULT_PATH]: JSON.stringify(seedLog(), null, 2),
        [vaultWriterMod.FILES.graph]: JSON.stringify({
            relations: [{ type: 'part_of', parent: 'press_total', child: 'press_kg' }],
            targets: [], trends: [],
        }),
    });
    const ui = await mount(vault);
    try {
        // санити: рендер поднял лог из vault в рантайм-кэш — правило видно движку
        assert.match(rulesLog.formatRecentRules(Infinity), /rule_001/);

        await ui.wipe();

        // vault-файл rulesLog.json ПЕРЕЗАПИСАН с нуля — ровно { version: 0, entries: [] }
        const content = vault._files.get(RULESLOG_VAULT_PATH).content;
        const written = JSON.parse(content);
        assertLiterallyEmptyLog(written, 'vault-файл rulesLog.json после клика');
        assert.deepEqual(written.entries, [], 'история правил удалена: entries пуст');
        assert.equal(written.version, 0, 'версия сброшена в 0 — «ничего не записано»');
        assert.ok(!content.includes('wipe'), 'записи о самом сбросе в файле нет');
        assert.ok(!content.includes('rule_001'), 'прежнее правило удалено из файла');
        assert.ok(!content.includes('press_kg'));

        // рантайм-кэш пуст: движок больше не видит правил
        assert.ok(isEmptyRulesSlice(rulesLog.formatRecentRules(Infinity)), '{{RULES}} после вайпа пуст');
        assert.deepEqual(JSON.parse(rulesLog.formatRecentRules(Infinity)), { rules: [] });
        assert.equal(rulesLog.getRulesLog().entries.length, 0, 'кэш синхронизирован с пустым логом');
        assert.equal(rulesLog.getVersion(), 0);
        assert.equal(rulesLog.getLatestRules().dynamic.length, 0);
        assert.equal(rulesLog.getLatestRules().global.length, 0);
        assert.equal(rulesLog.nextRuleId(rulesLog.getLatestRules()), 'rule_001', 'нумерация начинается заново');

        // граф обнулён и в файле, и в рантайме
        assert.deepEqual(JSON.parse(vault._files.get(vaultWriterMod.FILES.graph).content),
            { relations: [], targets: [], trends: [] });
        assert.deepEqual(ui.spy.latestGraph, { relations: [], targets: [], trends: [] });
    } finally {
        ui.cleanup();
        iso.dispose();
    }
});