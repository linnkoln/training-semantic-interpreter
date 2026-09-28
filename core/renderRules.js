'use strict';
// F-1: Динамический граф отрисовки. При Save правила (commitRules) строим граф из групп
// зафиксированных ключей: <группа>_<...> → part_of <группа>_total; метрики-способы
// («type1/type2/knees/austral...») — independent-линии; max-метрики — targets.
// Детерминированно из имён ключей (это структура, не парсинг входа).
const rulesLog = require('./rulesLog.js');

/** <группа>_<...>: группа = первый сегмент, метрика = остальное. null если ключ не парсится. */
function latinPart(key) {
    const parts = String(key).split('_').filter(Boolean);
    if (parts.length < 2) return null;
    return { group: parts[0], metric: parts.slice(1).join('_') };
}

/** Собирает ключи entity_metric из снапшота правил (mapping-ключи + then.entity_metric). */
function keysFromRules(snap) {
    const keys = new Set();
    for (const r of [...((snap && snap.dynamic) || []), ...((snap && snap.global) || [])]) {
        if (r && r.mapping && typeof r.mapping === 'object') {
            for (const k of Object.keys(r.mapping)) keys.add(k);
        }
        if (r && r.then && r.then.entity && r.then.metric) keys.add(`${r.then.entity}_${r.then.metric}`);
    }
    return keys;
}

/** Ключи с ролью 'overlay' (2026-09-01; бывший 'trend' — legacy-алиас): LLM помечает надстройку. */
function trendsFromRules(snap) {
    const trends = new Set();
    for (const r of [...((snap && snap.dynamic) || []), ...((snap && snap.global) || [])]) {
        if (r && r.roles && typeof r.roles === 'object') {
            for (const [k, role] of Object.entries(r.roles)) {
                if (role === 'overlay' || role === 'trend') trends.add(k);
            }
        }
    }
    return trends;
}

/** Детерминированный граф из набора ключей: ТОЛЬКО targets (max-метрики) + ЯВНЫЕ связи.
 *  (2026-09-03, расхождение №3): синтетические part_of → <группа>_total УБРАНЫ — граф
 *  отрисовки строится только из явных связей (LLM-relations Branch 3 + ручные).
 *  @param {Iterable<string>} keys ключи entity_metric.
 *  @param {Iterable<string>} [trends] ключи-надстройки (legacy roles).
 *  @param {Array} [explicitRelations] явные связи графа (формат A+B/overlay/part_of). */
function graphFromKeys(keys, trends, explicitRelations) {
    const trendSet = (trends instanceof Set) ? trends : new Set(trends || []);
    const graph = { relations: [], targets: [], trends: [...trendSet] };
    for (const k of keys) {
        if (/_max(_set)?$/.test(String(k))) graph.targets.push(k);
    }
    const seen = new Set();
    for (const rel of (explicitRelations || [])) {
        if (!rel || typeof rel !== 'object') continue;
        const sig = JSON.stringify(rel);
        if (seen.has(sig)) continue;
        graph.relations.push(rel);
        seen.add(sig);
    }
    return graph;
}

/**
 * LLM-relations (Branch 3) → графовый формат. Принимает НОВЫЙ формат напрямую
 * (2026-09-03, расхождение №3, эталон TC-001/TC-002):
 *   { type:'A+B', base, parts, stackOrder? }  — stackOrder: порядок полосок СНИЗУ ВВЕРХ
 *     (снизу сложное/base, сверху лёгкое/parts); если не задан — [base, ...parts].
 *   { type:'overlay', base, sub }             — sub рисуется поверх base.
 * ОБРАТНАЯ СОВМЕСТИМОСТЬ со старым {type:'A+B'|'subset', old, new}:
 *   A+B    → { type:'A+B', base: old, parts:[new], stackOrder:[old, new] }
 *   subset → { type:'overlay', base: old, sub: new }
 * note в граф не попадает. Дедуп по JSON-сигнатуре; мусор отбраковывается.
 */
function relationsFromLLM(relations) {
    const out = [];
    const seen = new Set();
    const s = (v) => (typeof v === 'string' ? v.trim() : '');
    const push = (mapped) => {
        const sig = JSON.stringify(mapped);
        if (seen.has(sig)) return;
        out.push(mapped);
        seen.add(sig);
    };
    for (const rel of (relations || [])) {
        if (!rel || typeof rel !== 'object') continue;
        if (rel.type === 'A+B') {
            const base = s(rel.base || rel.old);
            let parts = Array.isArray(rel.parts)
                ? rel.parts.map(s).filter(Boolean)
                : (s(rel.new) ? [s(rel.new)] : []);
            parts = [...new Set(parts)];
            if (!base || parts.length === 0) continue;
            let order = Array.isArray(rel.stackOrder)
                ? rel.stackOrder.map(s).filter((m) => [base, ...parts].includes(m))
                : [];
            for (const m of [base, ...parts]) {
                if (!order.includes(m)) order.push(m);
            }
            push({ type: 'A+B', base, parts, stackOrder: order });
        } else if (rel.type === 'overlay' || rel.type === 'subset') {
            const base = s(rel.base || rel.old);
            const sub = s(rel.sub || rel.new);
            if (!base || !sub) continue;
            push({ type: 'overlay', base, sub });
        }
    }
    return out;
}

/**
 * Строит граф отрисовки из зафиксированных ключей правил (без записи — возвращает объект).
 * @param {Iterable<string>} [extraKeys] дополнительные ключи (новые entity_metric последнего
 *        прогона пайплайна, ещё не зафиксированные в логе) — мержатся в набор (превью-граф).
 */
function rebuildGraphFromRules(extraKeys) {
    const snap = rulesLog.getLatestRules();
    const keys = keysFromRules(snap);
    for (const k of (extraKeys || [])) {
        if (typeof k === 'string' && k) keys.add(k);
    }
    // Явные связи НЕ выводятся из ключей (расхождение №3): берём сохранённые — graph.json
    // с диска (или рантайм-оверрайд loadGraph), чтобы ручные и LLM-связи переживали
    // пересборку графа на Save. Ключи дают только targets; связи — только явные.
    let explicit = [];
    try {
        explicit = ((require('./loadGraph.js'))() || {}).relations || [];
    } catch (_) { /* браузерный шим без графа — связей нет */ }
    return graphFromKeys(keys, trendsFromRules(snap), explicit);
}

/**
 * Превью-граф (2026-08-31): базовый граф с диска (data/graph.json) МЕРЖИТСЯ с отношениями,
 * выведенными из новых ключей последнего прогона (ещё не зафиксированных Save-ем).
 * Чистая функция: ничего не мутирует и не пишет (INV-2/INV-4). Дубликаты отношений убираются.
 * @param {object} baseGraph { relations[], targets[] } (например, из loadGraph()).
 * @param {Iterable<string>} keys новые ключи entity_metric.
 * @returns {object} новый граф { relations, targets }.
 */
function mergeGraph(baseGraph, keys) {
    const derived = graphFromKeys([...(keys || [])]);
    const out = {
        relations: [...((baseGraph && baseGraph.relations) || [])],
        targets: [...((baseGraph && baseGraph.targets) || [])],
        trends: [...((baseGraph && baseGraph.trends) || [])],
    };
    const seenRel = new Set(out.relations.map((r) => JSON.stringify(r)));
    for (const rel of derived.relations) {
        const sig = JSON.stringify(rel);
        if (!seenRel.has(sig)) { out.relations.push(rel); seenRel.add(sig); }
    }
    const seenT = new Set(out.targets);
    for (const t of derived.targets) {
        if (!seenT.has(t)) { out.targets.push(t); seenT.add(t); }
    }
    return out;
}

module.exports = { rebuildGraphFromRules, mergeGraph, graphFromKeys, relationsFromLLM, latinPart, keysFromRules, trendsFromRules };
