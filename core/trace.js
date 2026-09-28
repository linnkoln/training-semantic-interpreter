'use strict';
// core/trace.js — инструментальная трасса data-flow (JSON-файл прогона).
//
// Роль: фиксирует поэтапный ход прогона pipeline (next/commitRules) в JSON-файл
// в data/test-artifacts/ — для отладки data-flow (какие куски куда ушли, что
// вернул LLM, какие файлы затронуты). Трасса ЖИВЁТ ТОЛЬКО В ФАЙЛЕ (INV: не
// засорять контракт payload — наружу возвращается только _traceId для
// сопоставления с файлом).
//
// API (все функции безопасны: в браузерном бандле fs-возможностей нет —
// молча no-op; сбой записи — console.warn, НИКОГДА не бросает):
//   begin(kind, meta)        → объект трассы { id, kind, startedAt, steps, files }
//   step(traceObj, step, data) → добавить запись { step, at, data }
//   fileSnapshot(tr, label, path, content) → снимок файла (размер + summary ≤2000)
//   end(traceObj)            → пишет JSON в data/test-artifacts/trace-<ts>-<kind>.json
//
// Ретеншн: файлов трасс в test-artifacts больше 50 — самые старые удаляются
// при новой записи (мусор не копим).
//
// Инварианты:
//   • Чистый CommonJS, node --test-совместимо.
//   • Браузерный бандл: require('fs') может отдать shim — проверяем наличие
//     fs-возможностей (mkdirSync/writeFileSync/readdirSync/unlinkSync) и
//     оборачиваем все записи в try/catch: нет fs → тихий no-op.

const path = require('path');

// ---------------------------------------------------------------------------
// fs-возможности (браузерная безопасность)
// ---------------------------------------------------------------------------

let _fs = null;
let _fsOk = false;
try {
    const fsMod = require('fs');
    // Shim может экспортировать часть функций — требуем полный набор записи.
    if (fsMod && typeof fsMod.writeFileSync === 'function'
        && typeof fsMod.mkdirSync === 'function'
        && typeof fsMod.readdirSync === 'function'
        && typeof fsMod.unlinkSync === 'function'
        && typeof fsMod.readFileSync === 'function') {
        _fs = fsMod;
        _fsOk = true;
    }
} catch (_e) { /* браузер без fs — no-op */ }

let _traceDir = path.resolve(__dirname, '..', 'data', 'test-artifacts');
/** Переключить каталог трасс (для тестов). */
function _setTraceDir(p) { _traceDir = p; }
function _getTraceDir() { return _traceDir; }
/** Тестовый хук: принудительно включить/выключить fs-возможности. */
function _setFsAvailable(v) { _fsOk = !!v; }

// ---------------------------------------------------------------------------
// Адаптерный бэкенд (браузерный бандл в Obsidian: Node fs недоступен).
//
// UI (ui/editor.js, mountEditor) при доступности app.vault кладёт адаптер в
// window.TrainingCore.TRACE_FS с методами:
//   writeFile(path, content)  mkdir(path)  readDir(path) -> string[]
//   statMtimeMs(path) -> number  unlink(path)
// Все методы асинхронны → end() буферизует трассу и ФЛАШИТ fire-and-forget
// (контракт end() прежний: синхронно возвращает id; сбой — console.warn).
// ---------------------------------------------------------------------------

/** Каталог трасс ВНУТРИ vault (путь относительно корня vault, не диска). */
const ADAPTER_DIR_DEFAULT = 'data/test-artifacts';
let _adapterDir = ADAPTER_DIR_DEFAULT;
function _setAdapterDir(p) { _adapterDir = String(p || ADAPTER_DIR_DEFAULT); }

/** Тестовый хук: принудительно установить/сбросить адаптер записи. */
let _adapterOverride = null;
function _setTraceAdapter(a) { _adapterOverride = a || null; }

/** Ищет адаптер в window.TrainingCore.TRACE_FS (кладётся ui/editor.js). */
function detectAdapter() {
    if (_adapterOverride) return _adapterOverride;
    try {
        if (typeof window !== 'undefined' && window.TrainingCore && window.TrainingCore.TRACE_FS) {
            const a = window.TrainingCore.TRACE_FS;
            if (a && typeof a.writeFile === 'function' && typeof a.readDir === 'function') return a;
        }
    } catch (_e) { /* не браузер — без адаптера */ }
    return null;
}

/** Асинхронный флеш трассы через адаптер. Fire-and-forget, не бросает. */
function flushTraceAsync(adapter, dir, file, json) {
    const norm = (p) => String(p).replace(/\\/g, '/');
    Promise.resolve()
        .then(() => (typeof adapter.mkdir === 'function' ? adapter.mkdir(norm(dir)) : null))
        .then(() => adapter.writeFile(norm(file), json))
        .then(() => pruneOldTracesAsync(adapter, norm(dir)))
        .catch((e) => console.warn(`trace.end: не удалось записать трассу (${(e && e.message) || String(e)})`));
}

/** Асинхронный ретеншн поверх адаптера: >50 файлов трасс — старые удаляются. Не бросает. */
function pruneOldTracesAsync(adapter, dir) {
    return Promise.resolve()
        .then(() => adapter.readDir(dir))
        .then((entries) => {
            const names = (entries || []).filter((f) => /^trace-.*\.json$/.test(f));
            return Promise.all(names.map((f) => Promise.resolve()
                .then(() => (typeof adapter.statMtimeMs === 'function' ? adapter.statMtimeMs(`${dir}/${f}`) : 0))
                .then((mt) => ({ f, mt: Number.isFinite(mt) ? mt : 0 }))
                .catch(() => ({ f, mt: 0 }))));
        })
        .then((withMt) => {
            withMt.sort((a, b) => a.mt - b.mt);
            const excess = withMt.length - MAX_TRACE_FILES;
            const doomed = withMt.slice(0, Math.max(0, excess));
            return Promise.all(doomed.map((x) => Promise.resolve()
                .then(() => adapter.unlink(`${dir}/${x.f}`))
                .catch(() => { /* не критично */ })));
        })
        .catch(() => { /* каталог мог не существовать — не критично */ });
}

// ---------------------------------------------------------------------------
// Сборка трассы
// ---------------------------------------------------------------------------

/** Идентификатор трассы: 'trace-<timestamp>' (ms с эпохи). */
function makeTraceId(ts) { return `trace-${ts}`; }

/** Имя файла трассы: trace-<timestamp>-<kind>.json (без опасных символов). */
function makeTraceFilename(id, kind) {
    const safeKind = String(kind || 'unknown').replace(/[^a-zA-Z0-9_-]+/g, '-');
    return `${id}-${safeKind}.json`;
}

/**
 * Начинает трассу прогона.
 * @param {'interpret'|'save'|'wipe'} kind
 * @param {object} [meta] произвольные метаданные прогона (длина входа и т.п.)
 * @returns {{ id: string, kind: string, startedAt: string, steps: object[], files: object[] } | null}
 *          null, если fs-возможностей нет (браузер) — все остальные вызовы тоже no-op.
 */
function begin(kind, meta) {
    const ts = Date.now();
    const tr = {
        id: makeTraceId(ts),
        kind: kind || 'unknown',
        startedAt: new Date(ts).toISOString(),
        steps: [],
        files: [],
    };
    if (meta && typeof meta === 'object') tr.meta = meta;
    return tr;
}

/** Добавляет шаг. data — любой JSON-сериализуемый кусок (куски, ветки, LLM-вывод). */
function step(traceObj, stepName, data) {
    if (!traceObj || !Array.isArray(traceObj.steps)) return;
    let safeData = data;
    try {
        // Страховка от циклических ссылок: гоняем через stringify заранее.
        safeData = JSON.parse(JSON.stringify(data === undefined ? null : data));
    } catch (_e) { safeData = { unserializable: true }; }
    traceObj.steps.push({ step: stepName, at: new Date().toISOString(), data: safeData });
}

/**
 * Снимок файла: короткая сводка (размер в символах + JSON.stringify, обрезанный
 * до 2000 символов). content — уже прочитанное вызывающим содержимое (строка
 * или объект); null — файла не было/чтение не удалось.
 */
function fileSnapshot(traceObj, label, filePath, content) {
    if (!traceObj || !Array.isArray(traceObj.files)) return;
    let summary = null;
    let size = 0;
    try {
        if (content !== null && content !== undefined) {
            const str = typeof content === 'string' ? content : JSON.stringify(content);
            size = str ? str.length : 0;
            summary = str.slice(0, 2000);
        }
    } catch (_e) { summary = null; size = 0; }
    traceObj.files.push({ label, path: filePath, size, summary });
}

// ---------------------------------------------------------------------------
// Ретеншн: держим в test-artifacts не больше 50 файлов трасс
// ---------------------------------------------------------------------------

const MAX_TRACE_FILES = 50;

/** Удаляет самые старые файлы трасс, если их больше MAX_TRACE_FILES. Не бросает. */
function pruneOldTraces(dir) {
    try {
        const entries = _fs.readdirSync(dir)
            .filter((f) => /^trace-.*\.json$/.test(f))
            .map((f) => {
                let mt = 0;
                try { mt = _fs.statSync(path.join(dir, f)).mtimeMs; } catch (_e) { mt = 0; }
                return { f, mt };
            })
            .sort((a, b) => a.mt - b.mt);
        const excess = entries.length - MAX_TRACE_FILES;
        for (let i = 0; i < excess; i++) {
            try { _fs.unlinkSync(path.join(dir, entries[i].f)); } catch (_e) { /* не критично */ }
        }
    } catch (_e) { /* каталог мог не существовать — не критично */ }
}

/**
 * Завершает трассу: пишет JSON в data/test-artifacts/trace-<ts>-<kind>.json.
 * Ретеншн: старше 50 файлов — самые старые удаляются.
 * Ошибка записи — console.warn, НИКОГДА не бросает.
 * @returns {string|null} id трассы (или null при no-op).
 */
function end(traceObj) {
    // Путь 1: node fs (тесты/CLI) — синхронная запись как раньше.
    if (traceObj && _fsOk) {
        try {
            _fs.mkdirSync(_traceDir, { recursive: true });
            traceObj.endedAt = new Date().toISOString();
            const file = path.join(_traceDir, makeTraceFilename(traceObj.id, traceObj.kind));
            _fs.writeFileSync(file, JSON.stringify(traceObj, null, 2) + '\n', 'utf8');
            pruneOldTraces(_traceDir);
            return traceObj.id;
        } catch (e) {
            console.warn(`trace.end: не удалось записать трассу (${(e && e.message) || String(e)})`);
            return traceObj.id;
        }
    }
    // Путь 2 (браузер): vault-адаптер window.TrainingCore.TRACE_FS — асинхронный
    // fire-and-forget флеш (end() прежний контракт: синхронно возвращает id).
    const adapter = detectAdapter();
    if (traceObj && adapter) {
        traceObj.endedAt = new Date().toISOString();
        const json = JSON.stringify(traceObj, null, 2) + '\n';
        const file = `${_adapterDir}/${makeTraceFilename(traceObj.id, traceObj.kind)}`;
        flushTraceAsync(adapter, _adapterDir, file, json);
        return traceObj.id;
    }
    return (traceObj && traceObj.id) || null;
}

module.exports = {
    begin,
    step,
    fileSnapshot,
    end,
    // Тестовые хуки (не для продакшена).
    _setTraceDir,
    _getTraceDir,
    _setFsAvailable,
    _setTraceAdapter,
    _setAdapterDir,
};