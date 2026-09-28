'use strict';
// core/rules.js — Слой 2 (AC3/AC5/AC7/AC8): семантические правила.
// Чистый модуль (нет dv/app/DOM), работает под node --test.
//
// Два класса правил (D3/DECISIONS):
//   dynamic[] — диалект пользователя, меняется часто (AC7: LLM/UI *предлагает*, не применяет сам);
//   global[]  — системный rulebook, редок.
// Приоритет: dynamic побеждает global (динамика точнее знает личный диалект).
//
// Каждое правило: { id: rule_NNN, __version, when:{pattern, context?}, then:{entity,metric,composition?},
//                    deprecated? (AC8) }.
// pattern — строка-регекс поверх нормализованного (нижний регистр, trim) входа.
// тогда production считаем только когда правило реально сработало (AC1: событие
// возможно только при ruled=true).

// data/rules.json архивирован в archive/ (2026-09-01): правила живут в data/rulesLog.json.
const DEFAULT_RULES = { version: 0, updatedAt: null, dynamic: [], global: [] };

// метрика-«спутник» для entity при композиции A+B / max. A+B: отжимания→knee,
// подтягивания→assisted. max: добавляем *_max_set.
const SECONDARY_METRIC = { push: 'knee', pull: 'assisted' };

/** Нормализация входного текста: нижний регистр + trim + схлопывание пробелов. */
function normalizeInput(input) {
    if (typeof input !== 'string') return '';
    return input.toLowerCase().trim().replace(/\s+/g, ' ');
}

/** context записи: правило с when.context требует, чтобы последняя метрика
 *  начиналась с этого префикса ('pull_max' матчит 'pull_max' и 'pull_max_set').
 *  Это даёт «голое число в контексте последней метрики max_pullup → max_set». */
function contextMatches(rule, lastContext) {
    if (!rule.when.context) return true;             // правило без контекста — всегда применимо
    return typeof lastContext === 'string'
        && lastContext.toLowerCase().startsWith(rule.when.context.toLowerCase());
}

/**
 * Считает «производство» правила из captures регекса.
 * Композиции (D3/contracts):
 *   single — одно число → { primaryMetric: n };            (только *_full)
 *   A+B    — (n+m) → primary = n, secondary = m;            (full + knee/assisted)
 *   max    — "X макс: Z" → primary = X, secondary = Z;      (full + *_max_set)
 * Возвращает объект вида { push_full: n, push_knee: m }.
 */
function computeProduction(rule, captures) {
    const then = rule.then;
    const nums = captures.map((x) => {
        const v = Number(x);
        return Number.isFinite(v) ? v : null;
    });
    const primary = then.metric;
    const key = `${then.entity}_${primary}`;
    if (then.composition === 'A+B') {
        const secondary = SECONDARY_METRIC[then.entity] || 'secondary';
        return { [key]: nums[0], [`${then.entity}_${secondary}`]: nums[1] };
    }
    if (then.composition === 'max') {
        return { [key]: nums[0], [`${then.entity}_max_set`]: nums[1] };
    }
    // single (или без композиции = одно значение)
    return { [key]: nums[0] };
}

/**
 * Совпадение по правилу: возвращает null, если не совпало / deprecated /
 * контекст не подходит. Иначе — кандидат { rule, pattern, production, kind }.
 */
function testRule(rule, normalized, lastContext) {
    if (rule.deprecated) return null;                 // AC8: deprecated исключаются из match
    if (!rule.when || !rule.when.pattern) return null;
    const re = new RegExp(rule.when.pattern, 'i');    // 'i' — хотя уже lowercased, страховка
    const m = normalized.match(re);
    if (!m) return null;
    const captures = m.slice(1);
    if (captures.length > 0 && captures.some((c) => c == null || c === '')) return null;
    if (!contextMatches(rule, lastContext)) return null; // контекст не подходит — не кандидат
    return {
        rule,
        pattern: rule.when.pattern,
        production: captures.length > 0 ? computeProduction(rule, captures) : null,
    };
}

/**
 * Сопоставляет вход с правилами.
 * @param {string} input           сырой текст записи ('отжимания 100 (50+50)').
 * @param {string|null} lastContext последняя записанная метрика ('pull_max_set'...), может быть null/''.
 * @param {object} rules           объект правил { version, dynamic[], global[] }.
 * @returns {{ruled: boolean, candidates: Array}}
 *   ruled=true, только если сработало правило (AC1); candidates — в порядке приоритета.
 */
function match(input, lastContext, rules) {
    const normalized = normalizeInput(input);
    if (!normalized || !rules) return { ruled: false, candidates: [] };
    const dyn = Array.isArray(rules.dynamic) ? rules.dynamic : [];
    const glob = Array.isArray(rules.global) ? rules.global : [];
    // Сначала dynamic; если хоть один dynamic сработал — global не рассматриваем (приоритет dynamic).
    const dynCands = dyn.map((r) => testRule(r, normalized, lastContext)).filter(Boolean);
    if (dynCands.length > 0) return { ruled: true, candidates: dynCands };
    const globCands = glob.map((r) => testRule(r, normalized, lastContext)).filter(Boolean);
    return { ruled: globCands.length > 0, candidates: globCands };
}

/**
 * Предложение новой dynamic-правила (AC7). НЕ применяет и не мутирует правила —
 * возвращает объект-предложение, которое должно пройти ручное подтверждение
 * (интерпретатор — единственный источник истины, AC10).
 * @param {string}   input       текст, который пока не покрыт правилами (обычно после ruled:false).
 * @param {object}   template    шаблон then: { entity, metric, composition? }.
 * @param {object}   baseRules   текущие правила (для следующего rule id / __version).
 * @returns {object} proposal    { kind:'propose_dynamic', draft:{Rule}, rationale, proposedAt }.
 */
function proposeDynamicRule(input, template, baseRules) {
    const rules = baseRules || DEFAULT_RULES;
    const dyn = Array.isArray(rules.dynamic) ? rules.dynamic : [];
    const glob = Array.isArray(rules.global) ? rules.global : [];
    const ids = [...dyn, ...glob].map((r) => r.id).filter(Boolean);
    const maxN = ids.reduce((mx, id) => {
        const n = /^rule_(\d+)$/.exec(id);
        return n ? Math.max(mx, Number(n[1])) : mx;
    }, 0);
    const norm = normalizeInput(input);
    // Черновой pattern: экранируем весь текст, чтобы предложение было безопасным регексом.
    const pattern = norm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const draft = {
        id: `rule_${String(maxN + 1).padStart(3, '0')}`,
        __version: Math.max(...dyn.map((r) => r.__version || 1), 1),
        when: { pattern },
        then: template || {},
    };
    return {
        kind: 'propose_dynamic',
        draft,
        rationale: `Не покрыто правилами: '${input}' → предложено новое dynamic-правило ${draft.id}`,
        proposedAt: new Date(),
    };
}

/**
 * Применяет миграцию к правилам иммутабельно (AC5/D3): возвращает НОВЫЙ объект
 * правил с поднятым корневым version и заменёнными правилами из batch.
 * Исходный объект не мутируется и остаётся валидным.
 * @param {object} rules  текущие правила.
 * @param {Array<{id: string, rule: object}>} batch  набор замен { id → новое определение }.
 * @returns {object} новый объект правил (заморожен), version = rules.version + 1.
 */
function applyMigration(rules, batch) {
    if (!rules || !Array.isArray(batch)) throw new TypeError('applyMigration: нужны rules и batch[]');
    const replace = (arr, id, rule) => arr.map((r) => (r.id === id ? rule : r));
    let dynamic = (rules.dynamic || []).map((r) => ({ ...r, aliases: r.aliases ? [...r.aliases] : r.aliases }));
    let global = (rules.global || []).map((r) => ({ ...r }));
    // applyMigration возвращает цельные замены; заменённое правило получает __version+1,
    // если batch не указывает свою.
    for (const item of batch) {
        const foundDyn = dynamic.find((r) => r.id === item.id);
        const foundGlob = global.find((r) => r.id === item.id);
        if (!foundDyn && !foundGlob) {
            throw new Error(`applyMigration: правило '${item.id}' не найдено`);
        }
        const merged = {
            ...item.rule,
            id: item.id,
            __version: (item.rule.__version ?? 0) < 1
                ? (foundDyn ? foundDyn.__version : foundGlob.__version) + 1
                : item.rule.__version,
        };
        if (foundDyn) dynamic = replace(dynamic, item.id, merged);
        else global = replace(global, item.id, merged);
    }
    const next = Object.freeze({
        version: (rules.version || 0) + 1,
        updatedAt: new Date().toISOString(),
        dynamic: Object.freeze(dynamic),
        global: Object.freeze(global),
    });
    return next;
}

module.exports = {
    DEFAULT_RULES,
    normalizeInput,
    match,
    proposeDynamicRule,
    applyMigration,
};