'use strict';
// core/contracts.js — JSDoc-контракты трёх слоёв модели (без реализации движков).
//
// Слои (AC3/AC4, D3): Semantic rules → Semantic graph.
// Здесь только схемы данных и пустые сигнатуры. Реализация движков — в
// rules.js, graph.js. Эти контракты — соглашение между
// пакетами, чтобы P3/P4 разрабатывались независимо.

/**
 * Слой 2 — Semantic rules (AC3, AC5, D3).
 * data/rules.json:
 * {
 *   version: number,          // версия правил в целом (AC5)
 *   updatedAt: string,        // дата версии
 *   dynamic: [ Rule ],        // класс Dynamic: диалект пользователя, меняются часто
 *   global:  [ Rule ]         // класс Global rulebook: системные, редкие
 * }
 * Rule:
 * {
 *   id: 'rule_001',           // идентификаторы rule_NNN (D3)
 *   __version: number,        // версия конкретного правила (для эволюции)
 *   when: { pattern, context? },  // 'pattern' — входной шаблон; 'context' — из последней метрики
 *   then: { entity, metric, composition? } // composition: 'A+B' | 'single' | 'max'
 *   deprecated?: boolean      // пометка на чистку (AC8)
 * }
 */

/**
 * Слой 3 — Semantic graph (AC4).
 * data/graph.json:
 * {
 *   relations: [
 *     { type: 'part_of'|'successor'|'independent', parent, child }
 *   ]
 * }
 * Renderer (chartModel) читает отношения и маппит: part_of→stacked,
 * successor→timeline, independent→multi-line (AC11). Никакого хардкода метрик в JS.
 */

// --- Пустые сигнатуры (заглушки) для контракта. Реализуются в пакетах P3/P4.
// Каждая бросает not implemented до реализации.

function match(/* input, lastContext, rules */) {
    throw new Error('not implemented: rules.js (P2)');
}
function childrenOf(/* entity, graph */) {
    throw new Error('not implemented: graph.js (P3)');
}

module.exports = { match, childrenOf };
