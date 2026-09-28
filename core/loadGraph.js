'use strict';
// Читает актуальный graph.json с диска (F-1: граф пересобирается на Save —
// бандл содержит старую копию, поэтому UI обязан перечитывать файл).
// RUNTIME OVERRIDE (баг 2026-08-31): в браузере fs-шим отдаёт вшитую на сборке копию,
// которая устаревает после vaultWriter.writeGraph. UI после записи вызывает setLatestGraph —
// рендер сразу видит свежий граф без пересборки bundle.
const fs = require('fs');
const path = require('path');
let _override = null;
module.exports = function loadGraphFile() {
    if (_override) return _override;
    try {
        const p = path.join(__dirname, '..', 'data', 'graph.json');
        return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (_) {
        return { relations: [], targets: [] };
    }
};
/** Перезаписывает рантайм-источник графа (после vaultWriter.writeGraph / Rule Evolution). */
module.exports.setLatestGraph = function setLatestGraph(graph) {
    if (graph && Array.isArray(graph.relations)) _override = graph;
};
/** Сброс рантайм-оверрайда (тесты). */
module.exports.clearLatestGraph = function clearLatestGraph() { _override = null; };
