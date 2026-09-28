'use strict';
// core/rulesLog.js — Версионированный лог правил рендеринга (P-D).
// Читается Structured Event, дописывается Rule Evolution.
// Монотонные версии, иммутабельные записи.

const fs = require('fs');
const path = require('path');

const DEFAULT_LOG_PATH = path.resolve(__dirname, '../data/rulesLog.json');
const RULES_PATH = path.resolve(__dirname, 'rules.js');

// Позволяет тестам подменять путь к логу
let _logPath = DEFAULT_LOG_PATH;
function _setLogPath(p) { _logPath = p; }
function _getLogPath() { return _logPath; }

/** Загружает лог с диска (кэширует после первого чтения). Всегда возвращает замороженный объект. */
let _cachedLog = null;
function loadLog() {
    if (_cachedLog) return _cachedLog;
    let raw;
    try { raw = fs.readFileSync(_getLogPath(), 'utf8'); }
    catch (error) {
        // A new installation has no personal journal until its first Save.
        // Reading that empty state must not create or write the journal.
        if (error.code !== 'ENOENT') throw error;
        _cachedLog = deepFreeze({ version: 0, updatedAt: null, entries: [] });
        return _cachedLog;
    }
    const parsed = JSON.parse(raw);
    _cachedLog = deepFreeze(parsed);
    return _cachedLog;
}

/** Сохраняет лог на диск и инвалидирует кэш. */
function persistLog(log) {
    // Иммутабельность: deep-freeze перед записью
    const frozen = deepFreeze(log);
    fs.writeFileSync(_getLogPath(), JSON.stringify(frozen, null, 2), 'utf8');
    _cachedLog = frozen;
    return frozen;
}

/** Рекурсивная глубокая заморозка. */
function deepFreeze(obj) {
    if (obj === null || typeof obj !== 'object') return obj;
    Object.freeze(obj);
    for (const key of Object.keys(obj)) {
        if (obj[key] && typeof obj[key] === 'object') {
            deepFreeze(obj[key]);
        }
    }
    return obj;
}

/**
 * Возвращает полный лог правил (иммутабельный снапшот).
 * @returns {Object} { version, entries: Array<{ version, timestamp, rulesSnapshot, changeType, meta }> }
 */
function getRulesLog() {
    return loadLog();
}

/**
 * Возвращает текущую версию лога (последняя запись).
 * @returns {number}
 */
function getVersion() {
    const log = loadLog();
    return log.version;
}

/**
 * Возвращает последнее снапшот правил (rulesSnapshot из последней записи).
 * Используется Structured Event для получения актуальных правил.
 * @returns {Object} { version, dynamic[], global[] }
 */
function getLatestRules() {
    const log = loadLog();
    if (!log.entries || log.entries.length === 0) {
        // Fallback на DEFAULT_RULES из core/rules.js
        return require('./rules.js').DEFAULT_RULES;
    }
    const latest = log.entries[log.entries.length - 1];
    return latest.rulesSnapshot;
}

/**
 * Дописывает новое правило/изменение в лог (Rule Evolution).
 * Создаёт новую версию лога с монотонно возрастающим номером.
 * @param {Object} rule - Новое правило или изменение { id, when, then, __version?, deprecated? }
 * @param {string} changeType - Тип изменения: 'add' | 'update' | 'deprecate' | 'migrate'
 * @param {Object} [meta] - Дополнительные метаданные (rationale, proposedBy, etc.)
 * @returns {Object} Новая запись лога { version, timestamp, rulesSnapshot, changeType, meta }
 */
function computeRuleEntry(rule, changeType, meta = {}) {
    if (!['add', 'update', 'deprecate', 'migrate'].includes(changeType)) {
        throw new TypeError(`appendRule: неизвестный changeType '${changeType}'`);
    }

    const log = loadLog();
    const currentRules = getLatestRules();
    const newVersion = log.version + 1;

    // Применяем изменение к копии текущих правил (иммутабельно)
    const { dynamic = [], global = [] } = currentRules;
    let newDynamic = [...dynamic];
    let newGlobal = [...global];

    if (changeType === 'add') {
        if (!rule || !rule.id) {
            throw new TypeError('appendRule: правило должно иметь id');
        }
        const allRules = [...newDynamic, ...newGlobal];
        const existingIndex = allRules.findIndex(r => r.id === rule.id);
        if (existingIndex >= 0) {
            throw new Error(`appendRule: правило с id '${rule.id}' уже существует`);
        }
        const newRule = {
            ...rule,
            __version: rule.__version || 1,
        };
        // По умолчанию добавляем в dynamic (пользовательский слой)
        newDynamic = [...newDynamic, newRule];
    } else if (changeType === 'update') {
        if (!rule || !rule.id) {
            throw new TypeError('appendRule: правило должно иметь id');
        }
        const allRules = [...newDynamic, ...newGlobal];
        const existingIndex = allRules.findIndex(r => r.id === rule.id);
        if (existingIndex < 0) {
            throw new Error(`appendRule: правило '${rule.id}' не найдено для обновления`);
        }
        const isDynamic = existingIndex < newDynamic.length;
        const idx = isDynamic ? existingIndex : existingIndex - newDynamic.length;
        const targetArr = isDynamic ? newDynamic : newGlobal;
        const oldRule = targetArr[idx];
        const updatedArr = targetArr.map((r, i) =>
            i === idx ? { ...r, ...rule, __version: (oldRule.__version || 1) + 1 } : r
        );
        if (isDynamic) newDynamic = updatedArr;
        else newGlobal = updatedArr;
    } else if (changeType === 'deprecate') {
        if (!rule || !rule.id) {
            throw new TypeError('appendRule: правило должно иметь id');
        }
        const allRules = [...newDynamic, ...newGlobal];
        const existingIndex = allRules.findIndex(r => r.id === rule.id);
        if (existingIndex < 0) {
            throw new Error(`appendRule: правило '${rule.id}' не найдено для депрекации`);
        }
        const isDynamic = existingIndex < newDynamic.length;
        const idx = isDynamic ? existingIndex : existingIndex - newDynamic.length;
        const targetArr = isDynamic ? newDynamic : newGlobal;
        const updatedArr = targetArr.map((r, i) =>
            i === idx ? { ...r, deprecated: true, __version: (r.__version || 1) + 1 } : r
        );
        if (isDynamic) newDynamic = updatedArr;
        else newGlobal = updatedArr;
    } else if (changeType === 'migrate') {
        // Полная миграция правил (как applyMigration в rules.js)
        // rule здесь — это массив изменений { id, rule }
        if (!Array.isArray(rule)) {
            throw new TypeError('appendRule: migrate ожидает массив изменений');
        }
        const rulesObj = { dynamic: newDynamic, global: newGlobal };
        // Используем applyMigration из core/rules.js
        const { applyMigration } = require('./rules.js');
        const migrated = applyMigration(rulesObj, rule);
        newDynamic = migrated.dynamic;
        newGlobal = migrated.global;
    }

    const rulesSnapshot = {
        version: newVersion,
        updatedAt: new Date().toISOString(),
        dynamic: newDynamic,
        global: newGlobal,
    };

    const entry = {
        version: newVersion,
        timestamp: new Date().toISOString(),
        rulesSnapshot,
        changeType,
        meta,
    };

    const newLog = {
        version: newVersion,
        updatedAt: entry.timestamp,
        entries: [...log.entries, entry],
    };

    return { entry, newLog };
}

/**
 * Дописывает новое правило/изменение в лог (Rule Evolution) с записью на диск.
 * Чистое вычисление — computeRuleEntry; здесь только persist (node-режим).
 * В браузере (fs-shim) используйте computeRuleEntry + vaultWriter (INV-2).
 * @returns {Object} Новая запись лога { version, timestamp, rulesSnapshot, changeType, meta }
 */
function appendRule(rule, changeType, meta = {}) {
    const { entry, newLog } = computeRuleEntry(rule, changeType, meta);
    persistLog(newLog);
    return entry;
}

/**
 * Детерминированный следующий свободный id правила (rule_NNN+1, D10):
 * только по текущим правилам лога, без опоры на слова LLM.
 * @param {object} [rules] срез правил (default: getLatestRules()).
 * @returns {string} 'rule_NNN'
 */
function nextRuleId(rules) {
    const latest = rules || getLatestRules();
    const ids = [
        ...(Array.isArray(latest.dynamic) ? latest.dynamic : []),
        ...(Array.isArray(latest.global) ? latest.global : []),
    ].map((r) => r && r.id).filter(Boolean);
    let maxN = 0;
    for (const id of ids) {
        // tmp_rule_NNN (оверлей pipeline) резервирует тот же номер — иначе
        // commitRules после Branch 3 выдаёт занятый id (см. conflict.js nextRuleId).
        const m = /^(?:tmp_)?rule_(\d+)$/.exec(String(id));
        if (m) maxN = Math.max(maxN, Number(m[1]));
    }
    return `rule_${String(maxN + 1).padStart(3, '0')}`;
}

// К1 (2026-08-31): браузерный вход — заполнить кэш логом, прочитанным через vault API.
// В браузере fs.readFileSync получает ВШИТУЮ в bundle копию (снимок момента сборки),
// поэтому UI при старте читает файл через vault и поднимает его сюда.
// Только чтение: диск не пишется (INV-2), объект иммутабелен (deep-freeze, INV-3/5).
function setCachedLog(log) {
    if (log && typeof log === 'object' && Array.isArray(log.entries)) {
        _cachedLog = deepFreeze(JSON.parse(JSON.stringify(log)));
    }
}
/**
 * Сбрасывает кэш (для тестов/перезагрузки).
 */
function _resetCache() {
    _cachedLog = null;
}


/**
 * Машиночитаемый срез последних N правил (для передачи LLM-роутеру/minor, 2026-08-30).
 * НОВЫЙ ФОРМАТ (расхождение №4, эталон TC-001/TC-002):
 *   raw      — полный ввод прогона, дословно;
 *   mapping  — ключ → кусочек смысла;
 *   examples — образцы «формулировка → json» БЕЗ дат (D13).
 * Легаси-правила (semantics/when/then/cues/roles) валидны: рендерим их в новом
 * формате (mapping из then, examples без date). Возвращает СТРОГУЮ JSON-строку —
 * её подставляют в {{RULES}} промпта роутера.
 * @param {number} [n=2] сколько последних правил из dynamic (затем global) брать.
 *        НЕконечное n (Infinity) или n<=0 — ВСЕ правила (сквозная оценка внутри
 *        прогона: {{RULES}} роутера/minor должен видеть все tmp-правила, созданные
 *        предыдущими днями этого же прогона, а не только последние 2).
 * @returns {string}
 */
function formatRecentRules(n = 2) {
    const latest = getLatestRules();
    const pool = [...(latest.dynamic || []), ...(latest.global || [])]
        .filter((r) => r && typeof r === 'object');
    const count = (Number.isFinite(n) && n > 0) ? n : pool.length;
    const picked = pool.slice(-count);
    const out = picked.map((r) => {
        const then = (r.then && typeof r.then === 'object') ? r.then : {};
        const obj = {
            id: r.id || '',
            raw: (typeof r.raw === 'string' && r.raw)
                || (r.when && typeof r.when.pattern === 'string' ? 'вход по шаблону: ' + r.when.pattern : ''),
            mapping: (r.mapping && typeof r.mapping === 'object')
                ? r.mapping
                : { entity: then.entity || '', metric: then.metric || '', composition: then.composition || '' },
            examples: Array.isArray(r.examples)
                ? r.examples.map((e) => ({ input: e && e.input != null ? String(e.input) : '', values: (e && e.values) || {} }))
                : [],
        };
        if (r.deprecated) obj.deprecated = true;
        return obj;
    });
    return JSON.stringify({ rules: out }, null, 2);
}

/**
 * Строит лог ФАКТИЧЕСКОГО полного сброса (кнопка «🧹 Очистить память»): журнал
 * ЛИТЕРАЛЬНО ПУСТ — ни истории правил, ни следа самого сброса. Обоснование — цитата
 * заказчика (docs/user/quotes.md, 2026-09-01; документация уровня 1): «полный сброс
 * будет сбрасывать правила, графы, словари и данные, то есть переводить состояние
 * системы в состояние, как будто в системе не было ничего записано». Прежние варианты
 * (append-only revert-запись и запись changeType 'wipe') оставляли в файле след сброса —
 * сброс не был фактическим: заказчик отдельно указал, что записи о сбросе в журнале
 * быть не должно («есть запись в рулс логе о сбросе — её не должно там быть»).
 *
 * ЧИСТАЯ функция: диск/кэш НЕ трогает. Персист — на вызывающем (vaultWriter в браузере,
 * persistLog в node), синхронизация рантайм-кэша — setCachedLog у вызывающего.
 *
 * Обоснования формы { version: 0, updatedAt, entries: [] }:
 *  (а) version 0 + пустые entries = «ничего не записано» (цитата выше). Ту же форму пишет
 *      tools/reset-all-data.js (сделан по прямому указанию пользователя 2026-08-30): сброс
 *      возвращает систему в начальное состояние, а не продолжает нумерацию. Это ЯВНОЕ
 *      исключение из INV-5 (монотонные версии) ТОЛЬКО для пользовательского сброса: журнал
 *      правил при сбросе не «откатывается», а стирается — следующая же append-запись даст
 *      version 1 (0 + 1) в новом, чистом отсчёте.
 *  (б) пустой entries БЕЗОПАСЕН: getLatestRules() (см. выше, строки 70-78) при пустом списке
 *      откатывается на DEFAULT_RULES из core/rules.js:17, а тот САМ пустой
 *      ({ version: 0, updatedAt: null, dynamic: [], global: [] }) — правила не «воскресают»
 *      из обнулённого файла. Единственный неохраняемый индекс log.entries[len-1] стоит
 *      внутри этой же проверки и до пустого массива не доходит.
 *
 * Инварианты:
 *  - changeType 'wipe' больше НЕ пишется нигде: белый список computeRuleEntry
 *    ('add'/'update'/'deprecate'/'migrate') НЕ расширяем — журнал Rule Evolution
 *    остаётся append-only для правил.
 * @param {Object} [prevLog] предыдущий лог (getRulesLog() / vault-файл); ИГНОРИРУЕТСЯ
 *        НАМЕРЕННО — параметр оставлен только для стабильности сигнатуры вызовов
 *        (handleWipe передаёт curLog); версия сброса всегда 0.
 * @returns {Object} новый лог { version: 0, updatedAt, entries: [] }.
 */
function buildWipeLog(prevLog) { // eslint-disable-line no-unused-vars -- prevLog игнорируется намеренно
    void prevLog;
    return {
        version: 0,
        updatedAt: new Date().toISOString(),
        entries: [],
    };
}

module.exports = {
    getRulesLog,
    buildWipeLog, // фактический полный сброс: журнал ЛИТЕРАЛЬНО пуст ({ version: 0, updatedAt, entries: [] })
    computeRuleEntry,
    appendRule,
    getLatestRules,
    formatRecentRules,
    getVersion,
    nextRuleId,
    setCachedLog, // К1: браузерный вход через vault API (только чтение)
    _resetCache, // только для тестов
    _setLogPath, // только для тестов
    _getLogPath, // только для тестов
};
