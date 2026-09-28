'use strict';
// Vault-писатель для правил и графа (F-2): браузерный bundle не может писать через fs —
// пишет через Obsidian vault API. Файлы проекта в vault: scripts/training/data/*.json.
const path = require('path');

const BASE = 'scripts/training/data';
const FILES = {
    rulesLog: `${BASE}/rulesLog.json`,
    graph: `${BASE}/graph.json`,
    rules: `${BASE}/rules.json`,
};

function makeVaultWriter(app) {
    if (!app || !app.vault) throw new TypeError('makeVaultWriter: требуется app.vault');
    async function writeJson(relPath, obj) {
        const json = JSON.stringify(obj, null, 2) + '\n';
        const file = app.vault.getAbstractFileByPath(relPath);
        if (file) await app.vault.modify(file, json);
        else await app.vault.create(relPath, json);
    }
    async function readJson(relPath) {
        const file = app.vault.getAbstractFileByPath(relPath);
        if (!file) return null;
        try { return JSON.parse(await app.vault.read(file)); } catch (_) { return null; }
    }
    return {
        async writeRulesLog(log) { await writeJson(FILES.rulesLog, log); },
        async writeGraph(graph) { await writeJson(FILES.graph, graph); },
        async writeRules(rules) { await writeJson(FILES.rules, rules); },
        // К1 (2026-08-31): чтение актуального состояния через vault API — fs-шим бандла
        // вшивает копию на момент СБОРКИ и устаревает после Save вне сборки (reload
        // откатывал систему к вшитому снапшоту). Чтение INV-2 не нарушает.
        async readRulesLog() {
            if (!app.vault.getAbstractFileByPath(FILES.rulesLog)) {
                return { version: 0, updatedAt: null, entries: [] };
            }
            return readJson(FILES.rulesLog);
        },
        async readGraph(options = {}) {
            if (!options.strict) return readJson(FILES.graph);
            const file = app.vault.getAbstractFileByPath(FILES.graph);
            if (!file) return null;
            let text;
            try { text = await app.vault.read(file); }
            catch (error) { throw new Error(`Не удалось прочитать ${FILES.graph}: ${(error && error.message) || error}`); }
            let graph;
            try { graph = JSON.parse(text); }
            catch (error) { throw new Error(`Некорректный JSON в ${FILES.graph}: ${(error && error.message) || error}`); }
            if (!graph || typeof graph !== 'object' || Array.isArray(graph)
                || !Array.isArray(graph.relations)) {
                throw new Error(`Некорректная структура ${FILES.graph}: ожидался объект с массивом relations`);
            }
            return graph;
        },
        FILES,
    };
}

module.exports = { makeVaultWriter, FILES };
