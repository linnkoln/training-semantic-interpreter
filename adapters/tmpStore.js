'use strict';
// adapters/tmpStore.js — TEMP-слой по модели пользователя (2026-09-01):
//
//   «Обработать» → новое сессии пишется в ВРЕМЕННЫЕ версии файлов;
//   отрисовка и LLM-контекст всегда = основной файл + временный (собирается на лету);
//   «Сохранить» → temp приплюсовывается к main, temp очищается;
//   «Очистить память» → main и temp — в пустое состояние.
//
// У КАЖДОГО основного JSON — СВОЙ temp-файл (никаких сборных tmp):
//   data.json        ↔ data/training/data.tmp.json   (temp-слой событий: adapters/staging.js)
//   rulesLog.json    ↔ scripts/training/data/rulesLog.tmp.json (этот адаптер)
//   graph.json       ↔ scripts/training/data/graph.tmp.json    (этот адаптер)
//
// UI-состояние (не данные, напр. скрытые группы графика) — отдельно, ui-state.json
// в data/training/. Temp-файлы переживают перезагрузку страницы (живут в vault).
// INV-2 не нарушается: Save/wipe — явные действия пользователя.

const fs = require('fs');
const path = require('path');

const RULESLOG_TMP_PATH = 'scripts/training/data/rulesLog.tmp.json';
const GRAPH_TMP_PATH = 'scripts/training/data/graph.tmp.json';
const UI_STATE_PATH = 'data/training/ui-state.json';

// fs-путь rulesLog.tmp.json для node-контекста (pipeline без app.vault).
// Относительный RULESLOG_TMP_PATH живёт от КОРНЯ хранилища; здесь репозиторий
// сам является хранилищем: adapters/../data = scripts/training/data.
let _rulesTmpFsPath = path.resolve(__dirname, '..', 'data', 'rulesLog.tmp.json');
/** Переключить fs-путь rulesLog.tmp.json (для тестов). */
function _setRulesTmpPath(p) { _rulesTmpFsPath = p; }
function _getRulesTmpPath() { return _rulesTmpFsPath; }

// fs-путь graph.tmp.json для node-контекста (pipeline Branch 3 relations, без app.vault).
let _graphTmpFsPath = path.resolve(__dirname, '..', 'data', 'graph.tmp.json');
/** Переключить fs-путь graph.tmp.json (для тестов). */
function _setGraphTmpPath(p) { _graphTmpFsPath = p; }
function _getGraphTmpPath() { return _graphTmpFsPath; }

/** Чтение graph.tmp.json из fs (node-контекст). Нет файла → пустой список relations. */
function readGraphTmpFs(tmpPath = _graphTmpFsPath) {
    try {
        const g = JSON.parse(fs.readFileSync(tmpPath, 'utf8'));
        return { relations: (g && Array.isArray(g.relations)) ? g.relations : [] };
    } catch (_) { return { relations: [] }; }
}

/**
 * Branch 3 (node-контекст, fs): дописать LLM-связи (уже в графовом формате
 * {type,parent,child}) в graph.tmp.json. НИКОГДА не пишет graph.json (INV-2/3):
 * только temp-слой. Дедуп по JSON-сигнатуре; сериализуется только relations.
 * @param {Array<{type,parent,child}>} relations
 * @param {string} [tmpPath]
 * @returns {{ relations: Array }} текущие связи tmp-графа.
 */
function appendGraphTmpRelationsFs(relations, tmpPath = _graphTmpFsPath) {
    const cur = readGraphTmpFs(tmpPath);
    const seen = new Set(cur.relations.map((r) => JSON.stringify(r)));
    const out = [...cur.relations];
    for (const rel of (relations || [])) {
        if (!rel || typeof rel !== 'object') continue;
        const sig = JSON.stringify(rel);
        if (seen.has(sig)) continue;
        out.push(rel);
        seen.add(sig);
    }
    fs.mkdirSync(path.dirname(tmpPath), { recursive: true });
    fs.writeFileSync(tmpPath, JSON.stringify({ relations: out }, null, 2) + '\n', 'utf8');
    return { relations: out };
}

/** Очистить связи temp-графа (на Save после мержа в main). */
function clearGraphTmpRelationsFs(tmpPath = _graphTmpFsPath) {
    const cur = readGraphTmpFs(tmpPath);
    fs.mkdirSync(path.dirname(tmpPath), { recursive: true });
    fs.writeFileSync(tmpPath, JSON.stringify({ relations: [] }, null, 2) + '\n', 'utf8');
    return { relations: [] };
}

/** Нормализует один аппенд Branch 2 в запись newKeys. null — мусор. */
function normalizeMinorAppend(a) {
    if (!a || typeof a.key !== 'string' || !a.key.trim()) return null;
    const chunk = (typeof a.chunk === 'string') ? a.chunk : '';
    const exampleText = (typeof a.exampleText === 'string' && a.exampleText) ? a.exampleText : chunk;
    return {
        key: a.key,
        role: (a.role === 'overlay' || a.role === 'trend') ? 'overlay' : 'stack',
        exampleText,
        input: chunk,
        values: (a.values && typeof a.values === 'object' && !Array.isArray(a.values)) ? { ...a.values } : {},
        date: (typeof a.date === 'string') ? a.date : '',
        source: 'minorRuleUpdate',
    };
}

/** Чистое слияние аппендов в массив newKeys (дедуп по key+exampleText). */
function mergeMinorAppends(curNewKeys, appends) {
    const cur = (curNewKeys || []).filter((nk) => nk && typeof nk.key === 'string' && nk.key);
    const out = cur.map((item) => ({ ...item, values: { ...(item.values || {}) } }));
    for (const a of (appends || [])) {
        const nk = normalizeMinorAppend(a);
        if (!nk) continue;
        const sig = `${nk.key}\u0000${nk.exampleText || ''}`;
        const existing = out.find((item) => `${item.key}\u0000${item.exampleText || ''}` === sig);
        if (existing) {
            existing.values = { ...(existing.values || {}), ...nk.values };
            continue;
        }
        out.push(nk);
    }
    return out;
}

/** Keep only RuleUpdate records that have a stable id and a mapping object. */
function normalizeProposedRule(rule) {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)
        || typeof rule.id !== 'string' || !rule.id.trim()
        || !rule.mapping || typeof rule.mapping !== 'object' || Array.isArray(rule.mapping)) return null;
    return {
        ...rule,
        mapping: { ...rule.mapping },
        examples: Array.isArray(rule.examples)
            ? rule.examples.filter((example) => example && typeof example.input === 'string')
                .map((example) => ({ ...example, values: { ...(example.values || {}) } }))
            : [],
    };
}

/** Merge proposals by rule id, preserving existing mapping/value decisions. */
function mergeProposedRules(currentRules, proposals) {
    const out = (Array.isArray(currentRules) ? currentRules : [])
        .map(normalizeProposedRule).filter(Boolean);
    for (const candidate of (proposals || []).map(normalizeProposedRule).filter(Boolean)) {
        const existingIndex = out.findIndex((rule) => rule.id === candidate.id);
        if (existingIndex === -1) {
            out.push(candidate);
            continue;
        }
        if (candidate.completeSnapshot === true) {
            // A complete RuleUpdate snapshot is authoritative for this rule's
            // current mapping/examples, so keys retired by the model disappear.
            out[existingIndex] = candidate;
            continue;
        }
        const existing = out[existingIndex];
        for (const [key, meaning] of Object.entries(candidate.mapping)) {
            if (!Object.prototype.hasOwnProperty.call(existing.mapping, key)) existing.mapping[key] = meaning;
        }
        for (const example of candidate.examples) {
            const prior = existing.examples.find((item) => item.input === example.input);
            if (!prior) existing.examples.push(example);
            else {
                for (const [key, value] of Object.entries(example.values || {})) {
                    if (!Object.prototype.hasOwnProperty.call(prior.values, key)) prior.values[key] = value;
                }
            }
        }
    }
    return out;
}

function readRulesTmpObject(tmpPath = _rulesTmpFsPath) {
    try {
        const obj = JSON.parse(fs.readFileSync(tmpPath, 'utf8'));
        if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj;
    } catch (_) { /* missing or malformed temp file */ }
    return {};
}

/**
 * Branch 2 (node-контекст, fs): дописать минорные аппенды (ключ → новый пример
 * употребления) в rulesLog.tmp.json. НИКОГДА не пишет rulesLog.json (INV-2/3):
 * только temp-слой. Не бросает на чтении; создание директории рекурсивно.
 * @param {Array<{key, chunk?, exampleText?, role?, date?}>} appends
 * @param {string} [tmpPath]
 * @returns {{ newKeys: Array }} текущее содержимое tmp-словаря.
 */
function appendMinorMappingFs(appends, tmpPath = _rulesTmpFsPath) {
    const cur = readRulesTmpObject(tmpPath);
    const out = mergeMinorAppends(Array.isArray(cur.newKeys) ? cur.newKeys : [], appends);
    fs.mkdirSync(path.dirname(tmpPath), { recursive: true });
    fs.writeFileSync(tmpPath, JSON.stringify({ rules: mergeProposedRules(cur.rules, []), newKeys: out }, null, 2) + '\n', 'utf8');
    return { newKeys: out };
}

/** Branch 3 (node/fs): stage complete model-proposed rules without touching rulesLog.json. */
function appendProposedRulesFs(rules, tmpPath = _rulesTmpFsPath) {
    const cur = readRulesTmpObject(tmpPath);
    const out = mergeProposedRules(cur.rules, rules);
    fs.mkdirSync(path.dirname(tmpPath), { recursive: true });
    fs.writeFileSync(tmpPath, JSON.stringify({ rules: out, newKeys: Array.isArray(cur.newKeys) ? cur.newKeys : [] }, null, 2) + '\n', 'utf8');
    return { rules: out, newKeys: Array.isArray(cur.newKeys) ? cur.newKeys : [] };
}

/** Чтение rulesLog.tmp.json из fs (node-контекст). */
function readRulesTmpFs(tmpPath = _rulesTmpFsPath) {
    const obj = readRulesTmpObject(tmpPath);
    return {
        rules: mergeProposedRules(obj.rules, []),
        newKeys: Array.isArray(obj.newKeys)
            ? obj.newKeys.filter((nk) => nk && typeof nk.key === 'string' && nk.key)
            : [],
    };
}

/** Пустой temp-слой правил. newKeys — нечто среднее: ключи, придуманные LLM за сессию. */
function emptyRulesTmp() {
    return { rules: [], newKeys: [] };
}

function makeTmpStore(app) {
    if (!app || !app.vault) throw new TypeError('makeTmpStore: требуется app.vault');

    async function readJson(path) {
        const f = app.vault.getAbstractFileByPath(path);
        if (!f) return null;
        try {
            const text = await app.vault.read(f);
            return text.trim() ? JSON.parse(text) : null;
        } catch (_) { return null; }
    }

    async function writeJson(path, obj) {
        const json = JSON.stringify(obj, null, 2) + '\n';
        const f = app.vault.getAbstractFileByPath(path);
        if (f) await app.vault.modify(f, json);
        else await app.vault.create(path, json);
    }

    // ---- rulesLog.tmp.json ----------------------------------------------------
    async function readRulesTmp(options = {}) {
        let obj;
        if (options.strict) {
            const file = app.vault.getAbstractFileByPath(RULESLOG_TMP_PATH);
            if (!file) return emptyRulesTmp();
            const text = await app.vault.read(file);
            if (!text.trim()) return emptyRulesTmp();
            obj = JSON.parse(text);
            if (!obj || typeof obj !== 'object' || Array.isArray(obj)
                || (obj.rules !== undefined && !Array.isArray(obj.rules))
                || (obj.newKeys !== undefined && !Array.isArray(obj.newKeys))) {
                throw new Error(`Некорректная структура ${RULESLOG_TMP_PATH}: ожидались rules и newKeys`);
            }
        } else obj = await readJson(RULESLOG_TMP_PATH);
        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return emptyRulesTmp();
        return {
            rules: mergeProposedRules(obj.rules, []),
            newKeys: Array.isArray(obj.newKeys)
                ? obj.newKeys.filter((nk) => nk && typeof nk.key === 'string' && nk.key)
                : [],
        };
    }

    /**
     * Дописать ключи прогона в temp-словарь. Дедуп по key.
     * @param {Array<{key:string, role?:'overlay'|'stack'|string, input?:string, date?:string, values?:object}>} newKeys
     */
    async function appendRulesTmp(newKeys) {
        const cur = await readRulesTmp();
        const seen = new Set(cur.newKeys.map((nk) => nk.key));
        const out = [...cur.newKeys];
        for (const nk of (newKeys || [])) {
            if (nk && typeof nk.key === 'string' && nk.key && !seen.has(nk.key)) {
                out.push(nk);
                seen.add(nk.key);
            }
        }
        await writeJson(RULESLOG_TMP_PATH, { rules: cur.rules, newKeys: out });
        return { newKeys: out };
    }

    /** Append complete Branch 3 proposals to rulesLog.tmp.json with id dedupe. */
    async function appendProposedRules(rules) {
        const cur = await readRulesTmp();
        const out = mergeProposedRules(cur.rules, rules);
        await writeJson(RULESLOG_TMP_PATH, { rules: out, newKeys: cur.newKeys });
        return { rules: out, newKeys: cur.newKeys };
    }

    async function clearRulesTmp() {
        await writeJson(RULESLOG_TMP_PATH, emptyRulesTmp());
    }

    /**
     * Branch 2 (vault-контекст): дописать минорные аппенды (ключ → новый пример
     * употребления) в rulesLog.tmp.json. НИКОГДА не rulesLog.json (INV-2/3).
     * @param {Array<{key, chunk?, exampleText?, role?, date?}>} appends
     */
    async function appendMinorMapping(appends) {
        const cur = await readRulesTmp();
        const out = mergeMinorAppends(cur.newKeys, appends);
        await writeJson(RULESLOG_TMP_PATH, { rules: cur.rules, newKeys: out });
        return { newKeys: out };
    }

    // ---- graph.tmp.json ---------------------------------------------------------
    /** @returns {Promise<{relations:[]}>} */
    async function readGraphTmp(options = {}) {
        let g;
        if (options.strict) {
            const file = app.vault.getAbstractFileByPath(GRAPH_TMP_PATH);
            if (!file) return { relations: [] };
            let text;
            try { text = await app.vault.read(file); }
            catch (error) { throw new Error(`Не удалось прочитать ${GRAPH_TMP_PATH}: ${(error && error.message) || error}`); }
            if (!text.trim()) return { relations: [] };
            try { g = JSON.parse(text); }
            catch (error) { throw new Error(`Некорректный JSON в ${GRAPH_TMP_PATH}: ${(error && error.message) || error}`); }
            if (!g || typeof g !== 'object' || Array.isArray(g) || !Array.isArray(g.relations)) {
                throw new Error(`Некорректная структура ${GRAPH_TMP_PATH}: ожидался объект с массивом relations`);
            }
        } else {
            g = await readJson(GRAPH_TMP_PATH);
        }
        return { relations: (g && Array.isArray(g.relations)) ? g.relations : [] };
    }

    async function writeGraphTmp(graph) {
        await writeJson(GRAPH_TMP_PATH, { relations: (graph && graph.relations) || [] });
    }

    async function clearGraphTmp() {
        await writeJson(GRAPH_TMP_PATH, { relations: [] });
    }

    // ---- ui-state.json (НЕ данные: только память виджета) ---------------------
    async function readUiState() {
        const obj = await readJson(UI_STATE_PATH);
        return (obj && typeof obj === 'object' && !Array.isArray(obj)) ? obj : {};
    }

    async function writeUiState(patch) {
        const base = await readUiState();
        await writeJson(UI_STATE_PATH, { ...base, ...patch });
    }

    return {
        readRulesTmp, appendRulesTmp, appendProposedRules, appendMinorMapping, clearRulesTmp,
        readGraphTmp, writeGraphTmp, clearGraphTmp,
        readUiState, writeUiState,
        PATHS: { RULESLOG_TMP_PATH, GRAPH_TMP_PATH, UI_STATE_PATH },
    };
}

/**
 * СЛИЯНИЕ НА ЛЕТУ (чистые функции, ничего не пишут):
 * словарь правил main ∪ temp-ключи → срез правил для LLM {{RULES}} и дедупа.
 * Temp-ключи превращаются в «сессийные» правила вида rule_tmp_NNN (id tmp-*, чтобы
 * на Save их пересобрать из temp в настоящий appendRule без дублей).
 */
function mergeRuleSnapshots(mainSnapshot, tmpNewKeys) {
    const dynamic = ((mainSnapshot && mainSnapshot.dynamic) || []).map((rule) => ({
        ...rule,
        mapping: { ...(rule.mapping || {}) },
        examples: (rule.examples || []).map((example) => ({ ...example, values: { ...(example.values || {}) } })),
    }));
    const keys = new Set();
    for (const r of dynamic) {
        if (r && r.mapping && typeof r.mapping === 'object') {
            for (const k of Object.keys(r.mapping)) keys.add(k);
        }
    }
    const fresh = [];
    for (const nk of (tmpNewKeys || [])) {
        if (!nk || !nk.key) continue;
        if (keys.has(nk.key)) {
            if (nk.source !== 'minorRuleUpdate' && typeof nk.exampleText !== 'string') continue;
            const target = dynamic.find((rule) => rule.mapping && Object.prototype.hasOwnProperty.call(rule.mapping, nk.key));
            const input = (typeof nk.exampleText === 'string' && nk.exampleText)
                || (typeof nk.input === 'string' && nk.input)
                || (typeof nk.chunk === 'string' && nk.chunk);
            if (target && input) {
                const example = target.examples.find((item) => item.input === input);
                if (example) Object.assign(example.values, nk.values || {});
                else target.examples.push({ input, values: { ...(nk.values || {}) } });
            }
            continue;
        }
        fresh.push(nk);
        keys.add(nk.key);
    }
    if (fresh.length) {
        dynamic.push({
            id: 'tmp_session_keys',
            semantics: `Ключи текущей сессии (ещё не зафиксированы Save): ${fresh.map((nk) => nk.key).join(', ')}`,
            // Формат {{RULES}} (§4): маппинг = ключ → кусок текста (разночтение),
            // а не ключ → ключ. Для минорных аппендов это exampleText (новый пример
            // употребления); для прочих newKeys fallback — сам ключ.
            mapping: fresh.reduce((acc, nk) => {
                acc[nk.key] = (typeof nk.exampleText === 'string' && nk.exampleText) ? nk.exampleText : nk.key;
                return acc;
            }, {}),
            roles: fresh.reduce((acc, nk) => { acc[nk.key] = (nk.role === 'overlay' || nk.role === 'trend') ? 'overlay' : 'stack'; return acc; }, {}),
            cues: [],
            examples: [],
            __tmp: true,
        });
    }
    return {
        version: ((mainSnapshot && mainSnapshot.version) || 0) + 0.5,
        updatedAt: (mainSnapshot && mainSnapshot.updatedAt) || null,
        dynamic,
        global: [...((mainSnapshot && mainSnapshot.global) || [])],
    };
}

/** Слияние графов main ∪ temp (на лету, чистая функция). */
function mergeGraphs(mainGraph, tmpGraph) {
    const seenRel = new Set(((mainGraph && mainGraph.relations) || []).map((r) => JSON.stringify(r)));
    const seenT = new Set([...((mainGraph && mainGraph.targets) || []), ...((mainGraph && mainGraph.trends) || [])]);
    const relations = [...((mainGraph && mainGraph.relations) || [])];
    for (const rel of ((tmpGraph && tmpGraph.relations) || [])) {
        const sig = JSON.stringify(rel);
        if (!seenRel.has(sig)) { relations.push(rel); seenRel.add(sig); }
    }
    const targets = [...((mainGraph && mainGraph.targets) || [])];
    for (const t of ((tmpGraph && tmpGraph.targets) || [])) {
        if (!seenT.has(t)) { targets.push(t); seenT.add(t); }
    }
    const trends = [...new Set([...((mainGraph && mainGraph.trends) || []), ...((tmpGraph && tmpGraph.trends) || [])])];
    return { relations, targets, trends };
}

module.exports = {
    makeTmpStore,
    mergeRuleSnapshots,
    mergeGraphs,
    // Branch 2 (minorRuleUpdate): аппенд «ключ → новый пример употребления» в temp-слой
    appendMinorMappingFs,
    appendProposedRulesFs,
    readRulesTmpFs,
    mergeMinorAppends,
    _setRulesTmpPath, // только для тестов
    _getRulesTmpPath, // только для тестов
    // Branch 3 (ruleUpdate): LLM-связи в temp-слой графа
    readGraphTmpFs,
    appendGraphTmpRelationsFs,
    clearGraphTmpRelationsFs,
    _setGraphTmpPath, // только для тестов
    _getGraphTmpPath, // только для тестов
    emptyRulesTmp,
    RULESLOG_TMP_PATH,
    GRAPH_TMP_PATH,
    UI_STATE_PATH,
};
