'use strict';
// core/graph.js — слой 3: Semantic graph (AC4). Чистый модуль БЕЗ dv/app/DOM.
//
// Читает data/graph.json ({ relations: [ {type, parent, child} ] }).
// Никакой эвристики имён: маппинг "какая метрика с какой связана" живёт
// в данных графа, а не в коде (AC11). Возвращает массивы/null.

/**
 * Все рёбра заданного типа. Пустой массив, если граф пуст/битый.
 * @returns {{type:string, parent:string, child:string}[]}
 */
function relationsOfType(graph, type) {
    if (!graph || !Array.isArray(graph.relations)) return [];
    return graph.relations.filter(r => r && r.type === type);
}

/**
 * Прямые дети сущности (по отношениям part_of).
 * @returns {string[]}
 */
function childrenOf(entity, graph) {
    return relationsOfType(graph, 'part_of')
        .filter(r => r.parent === entity)
        .map(r => r.child);
}

/**
 * Тип отношения между двумя сущностями (двусторонний поиск).
 * @returns {string|null} 'part_of' | 'successor' | 'independent' | null
 */
function relationBetween(a, b, graph) {
    if (!a || !b || !graph || !Array.isArray(graph.relations)) return null;
    const found = graph.relations.find(r =>
        (r.parent === a && r.child === b) ||
        (r.parent === b && r.child === a));
    return found ? found.type : null;
}

/** Целевые (накладывающиеся) метрики из graph.targets. Пусто, если поле нет. */
function targetNodes(graph) {
    if (!graph || !Array.isArray(graph.targets)) return [];
    return graph.targets;
}

module.exports = { childrenOf, relationBetween, relationsOfType, targetNodes };