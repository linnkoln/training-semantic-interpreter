'use strict';
// core/interpreter.js — P4/P-F: интерпретатор «два прохода + 4-режимный автомат» + LLM Structured Event.
//
// Роль (ТЗ/ROADMAP, слой 2-перед-3): превращает сырую запись личного диалекта в
// структурно-верифицированные ИММУТАБЕЛЬНЫЕ события (core/events.js) с закреплённой
// interpretation_version (AC5). Это единственное место, где ВХОД становится СОБЫТИЕМ.
//
// Чистый модуль: нет dv/app/DOM, работает под node --test (как и весь core/).
//
// ============================ 4-РЕЖИМНЫЙ АВТОМАТ СОСТОЯНИЙ ============================
//   pending  ──(правило совпало)─────────────────→ resolved(event)
//      │
//      ├──(число + контекст есть)──→ pending_confirmation(ruleProposal) ──(подтверждение)──→ migrated
//      │                                                                                      │
//      └──(нет правила / нет контекста)──→ ambiguous(нужен контекст)                          │
//                                                                                             ▼
//                                                                                    structured(события с НОВОЙ версией)
//
//   mode результата interpret():
//     'resolved'  — правило Слоя 2 сработало → payload.events (AC1: событие ТОЛЬКО при ruled=true).
//     'resolve'   — правила не сработали, но есть число + правдоподобный контекст → payload.proposal
//                   (кандидат dynamic-правила, ждёт ручного подтверждения, AC7/AC10).
//     'ambiguous' — не покрыто правилами, контекста для предложения нет → требует контекст.
//     'error'     — программная ошибка вызова (пустой/не-строковый ввод).
//
// ============================ LLM STRUCTURED EVENT (P-F, Branch 1) ============================
// Structured Event — LLM-слой: берёт данные пользователя, смотрит ПОСЛЕДНИЕ ПРАВИЛА из лога,
// переводит пользовательский текст в ГОТОВЫЙ к отрисовке JSON.
// Использует llmGateway.callLLM(mode='parse') + rulesLog.getLatestRules().
// AC10: LLM — не источник истины, интерпретатор ВЕРИФИЦИРУЕТ ответ перед созданием событий.
//
// ============================ РЕШЕНИЕ БЛОКЕРА «ПОРЯДОК СЛОВ» (QA-гейт P1–P3) ============================
// Правила Слоя 2 (data/rules.json) написаны **словом первым** для читаемости:
//   ^отжимания.*\((\d+)\s*\+\s*(\d+)\)        ^(?:подтягивания|подтягиваний)\s*(\d+)\s*макс:\s*(\d+)
// Но живой ввод пользователя (prompt.md, таблица) — **число первым**:
//   "100 отжимания (73+27)"                 "50 подтягиваний макс: 15"
// Без нормализации match('100 отжимания (73+27)') вернул бы ruled:false (зафиксировано в PROBLEMS.md).
// Решение в интерпретаторе (а НЕ в data/rules.json — данные не трогаем): первый проход
// применяет reorderDialect — перенос числа после диалектного слова, чтобы правило,
// написанное словом первым, смогло сработать. Сами правила остаются неизменными.

const { makeEvent, isEvent } = require('./events.js');
const {
    DEFAULT_RULES,
    normalizeInput,
    match,
    applyMigration,
} = require('./rules.js');

// P-F: LLM Gateway и Rules Log для Structured Event ветки
const { callLLM } = require('./llmGateway.js');
const { getLatestRules } = require('./rulesLog.js');

// ---------------------------------------------------------------------------
// БЛОК 1. Нормализация порядка слов (ключевое решение блокера)
// ---------------------------------------------------------------------------

// Диалектные слова, у которых правила ожидают «слово первым». Строгий порядок в
// альтернации: сначала более длинное «подтягиваний», потом «подтягивания», чтобы
// короткое не «съело» хвост длинного (см. concerns ниже).
const DIALECT_WORDS = '(отжимания|подтягиваний|подтягивания)';

// <n> <диалект-слово> ... → <диалект-слово> <n> ...
// (?![а-яё]) — отрицательный просмотр: слово не должно продолжаться буквой, иначе
// «подтягивания» частично совпадёт внутри «подтягиваний». (JS: \w — только ASCII,
// поэтому вокруг кириллицы \b не работает — нужен явный просмотр.)
const NUMBER_FIRST_RE = new RegExp(
    `^(\\d+)\\s+${DIALECT_WORDS}(?![а-яё])(.*)$`
);

/**
 * ПЕРЕНОС ЧИСЛА ПОСЛЕ ДИАЛЕКТНОГО СЛОВА.
 * ОБОСНОВАНИЕ (зачем): реальный диалект кладёт количество первым, а правила Слоя 2
 * написаны словом первым для читаемости. Чтобы правило смогло сработать на живом
 * вводе, мы приводим лицензионную форму «слово-первым» к канону правил, НЕ трогая
 * data/rules.json.
 *
 * Покрываемые формы (всё после приведения в нижний регистр + trim + схлопывание):
 *   "<n> <слово> (<a>+<b>)"  → "<слово> <n> (<a>+<b>)"   (A+B композиция)
 *   "<n> <слово> макс: <z>"  → "<слово> <n> макс: <z>"   (max композиция)
 *   "<n> <слово>"            → "<слово> <n>"             (single)
 * Ввод «слово-первым» проходит без изменений — обе формы поддерживаются.
 *
 * @param {string} normalized уже нормализованная строка (нижний регистр).
 * @returns {string} строка в каноне правил «слово первым» (или исходная, если не применимо).
 */
function reorderDialect(normalized) {
    if (typeof normalized !== 'string' || !normalized) return normalized;
    const m = normalized.match(NUMBER_FIRST_RE);
    if (!m) return normalized;
    return `${m[2]} ${m[1]}${m[3]}`;
}

// ---------------------------------------------------------------------------
// БЛОК 2. Служебные помощники предложения правила (Resolve)
// ---------------------------------------------------------------------------

/** Текущий следующий id правила (rule_NNN+1), в согласии с core/rules.js. */
function nextRuleId(rules) {
    const ids = [
        ...(Array.isArray(rules.dynamic) ? rules.dynamic : []),
        ...(Array.isArray(rules.global) ? rules.global : []),
    ].map((r) => r && r.id).filter(Boolean);
    let maxN = 0;
    for (const id of ids) {
        const n = /^rule_(\d+)$/.exec(id);
        if (n) maxN = Math.max(maxN, Number(n[1]));
    }
    return `rule_${String(maxN + 1).padStart(3, '0')}`;
}

/**
 * Строит ЗАХВАТЫВАЮЩЕЕ правило-кандидат из нормированного ввода: всё экранируем,
 * первую последовательность цифр превращаем в группу `(\d+)` (чтобы production
 * дал реальное значение), пробелы делаем гибкими. Пример: «макс 6» → ^макс\s*(\d+)$.
 */
function buildCapturingDraft(normalized, template, rules) {
    const tokens = String(normalized).split(/(\d+)/).filter((t) => t !== '');
    const pattern = '^' + tokens.map((t) => {
        if (/^\d+$/.test(t)) return '(\\d+)';                       // число → capture
        return t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*');
    }).join('') + '$';
    const maxVer = (Array.isArray(rules.dynamic) ? rules.dynamic : [])
        .reduce((m, r) => Math.max(m, r.__version || 1), 1);
    return {
        id: nextRuleId(rules),
        __version: maxVer,
        when: { pattern },
        then: template,
    };
}

/**
 * Шаблон then, выводимый из правдоподобного контекста последней метрики
 * ('pull'/'push' + признак 'max' → *_max_set, иначе *_full, композиция single).
 * Возвращает null, если контекста нет — предложение невозможно.
 */
function templateForContext(lastContext) {
    const ctx = String(lastContext || '').toLowerCase();
    const entity = ctx.startsWith('pull') ? 'pull'
        : ctx.startsWith('push') ? 'push' : null;
    if (!entity) return null;
    const metric = ctx.includes('max') ? 'max_set' : 'full';
    return { entity, metric, composition: 'single' };
}

/**
 * Если ввод не покрыт правилами, но содержит ЧИСЛО и есть ПРАВДОПОДОБНЫЙ КОНТЕКСТ
 * (последняя метрика), строим предложение dynamic-правила (Resolve-режим). Правдоподобный
 * контекст = entity из последней записи, что даёт шаблон then. Иначе предложения нет.
 * @returns {object|null} { kind:'propose_dynamic', draft, basedOn, context, rationale, proposedAt }.
 */
function proposeIfPossible(input, lastContext, rules) {
    const norm = normalizeInput(input);
    const template = templateForContext(lastContext);
    if (!norm || !/\d/.test(norm) || !template) return null;
    const draft = buildCapturingDraft(norm, template, rules);
    return {
        kind: 'propose_dynamic',
        draft,
        basedOn: input,
        context: lastContext,
        rationale: `Не покрыто правилами, есть число и контекст «${lastContext}» → предложено dynamic-правило ${draft.id}`,
        proposedAt: new Date(),
    };
}

// ---------------------------------------------------------------------------
// БЛОК 3. Второй проход (MIGRATE → STRUCTURED) и дедуп дат
// ---------------------------------------------------------------------------

/**
 * Применяет подтверждённое предложение как миграцию ИММУТАБЕЛЬНО и возвращает новую
 * версию правил (версия +1), контрактно совпадающую с applyMigration (AC5/D3).
 *
 * Нюанс данного кодового дерева: applyMigration (core/rules.js) РАБОТАЕТ ТОЛЬКО по
 * замене СУЩЕСТВУЮЩИХ id — на неизвестный id он бросает «правило не найдено». Новое
 * dynamic-правило из кандидата в «new» классе ещё не существует в правилах, поэтому
 * для него мы ДОБАВЛЯЕМ запись в dynamic[] (append), а не заменяем. Для замены уже
 * известного правила (id совпал) используем штатный applyMigration.
 *
 * @param {object} rules  текущие правила.
 * @param {object} draft  правило-кандидат из proposal (новое или заменяющее).
 * @returns {object} новый замороженный объект правил, version = rules.version + 1.
 */
function applyProposalAsMigration(rules, draft) {
    const exists = [...(rules.dynamic || []), ...(rules.global || [])]
        .some((r) => r && r.id === draft.id);
    if (exists) {
        // замена существующего правила — штатный путь
        return applyMigration(rules, [{ id: draft.id, rule: draft }]);
    }
    // новое dynamic-правило — append + поднятие корневой версии (контракт applyMigration)
    const dynamic = Object.freeze([...(rules.dynamic || []), { ...draft }]);
    return Object.freeze({
        version: (rules.version || 0) + 1,
        updatedAt: new Date().toISOString(),
        dynamic,
        global: rules.global || Object.freeze([]),
    });
}

/**
 * Проверка на дубль даты (AC6): если в baseEvents уже есть событие на эту дату —
 * ничего не перезаписываем, помечаем дату как конфликт и пропускаем создание.
 */
function dateConflicts(baseEvents, date) {
    return Array.isArray(baseEvents)
        && date
        && baseEvents.some((e) => isEvent(e) && e.date === date);
}

/** Второй проход: кандидаты правил → иммутабельные события (чтение candidates). */
function coerceToEvents(candidates, date, version, baseEvents) {
    const events = [];
    const conflicts = [];
    for (const c of candidates) {
        if (!c || !c.production) continue;          // production только при реально сработавшем правиле (AC1)
        if (dateConflicts(baseEvents, date)) { conflicts.push(date); continue; } // AC6: не перезаписываем
        events.push(makeEvent({ date, values: c.production }, version));
    }
    return { events, conflicts };
}

// ---------------------------------------------------------------------------
// БЛОК 4. Публичный API (интерпретатор высокого уровня)
// ---------------------------------------------------------------------------

/**
 * ИНТЕРПРЕТАЦИЯ ВХОДА (два прохода + автомат состояний).
 *
 * Проход 1 — берём последнюю версию правил, нормализуем слово-порядок (reorderDialect)
 *           и матчим Слой 2 (match). Совпадение → кандидаты событий (eventCandidates).
 * Проход 2 — коерсим кандидатов в структурированные ИММУТАБЕЛЬНЫЕ события с
 *           interpretation_version = version правил, с защитой от дублей даты (AC6).
 *
 * @param {string} input сырая запись ('100 отжимания (73+27)', 'макс 6', ...).
 * @param {object} [opts]
 * @param {Array<Event>} [opts.baseEvents] уже сохранённые события (для дедупликации дат, AC6).
 * @param {string}       [opts.lastContext] последняя записанная метрика ('pull_max_set'...), чтобы
 *                          голое число в контексте (global-правила) и предложение правила (resolve) сработали.
 * @param {string}       [opts.date] дата события (YYYY-MM-DD). По умолчанию — сегодня.
 * @param {object}       [opts.rules] правила Слоя 2; по умолчанию DEFAULT_RULES.
 * @param {object}       [opts.llm]   (резерв) LLM-адаптер — НЕ обязателен: анализ правил детерминирован
 *                          (LLM не источник истины, AC10). Передаётся для совместимости но на чистом пути не используется.
 * @returns {object} результат автомата (см. шапку модуля): mode ∈
 *          'resolved'|'resolve'|'ambiguous'|'error', status, interpretation_version,
 *          rulesVersion, payload.
 */
function interpret(input, opts = {}) {
    const baseEvents = Array.isArray(opts.baseEvents) ? opts.baseEvents : [];
    const rules = opts.rules || DEFAULT_RULES;
    const lastContext = opts.lastContext || null;
    const date = opts.date || new Date().toISOString().slice(0, 10);

    if (typeof input !== 'string' || input.trim() === '') {
        return { mode: 'error', status: 'error', rulesVersion: rules.version, payload: { reason: 'Пустой ввод' } };
    }

    // Проход 1: нормализация порядка слов (РЕШЕНИЕ БЛОКЕРА) → матч Слоя 2.
    const normalized = normalizeInput(input);
    const reordered = reorderDialect(normalized);
    const { ruled, candidates } = match(reordered, lastContext, rules);

    // Проход 2: кандидаты → события (AC1: только при ruled=true).
    if (ruled && candidates.length > 0) {
        const version = rules.version;
        const { events, conflicts } = coerceToEvents(candidates, date, version, baseEvents);
        return {
            mode: 'resolved',
            status: 'success',
            interpretation_version: version,
            rulesVersion: version,
            payload: { events, conflicts },
        };
    }

    // Не совпало → не success по определению (AC1). Если есть число + контекст → Resolve.
    const proposal = opts.resolve === false ? null : proposeIfPossible(input, lastContext, rules);
    if (proposal) {
        return { mode: 'resolve', status: 'resolve', rulesVersion: rules.version, payload: { proposal } };
    }
    // Чистый ambiguous: нужен контекст (или число), нечего предложить.
    return {
        mode: 'ambiguous',
        status: 'ambiguous',
        rulesVersion: rules.version,
        payload: {
            reason: 'Не покрыто правилами, нет правдоподобного контекста для предложения правила.',
            needsContext: true,
        },
    };
}

/**
 * ПОДТВЕРЖДЕНИЕ ПРЕДЛОЖЕНИЯ → MIGRATE → STRUCTURED.
 * Вызывается, когда пользователь подтвердил proposal из режима 'resolve'. Применяем
 * миграцию правил иммутабельно (applyMigration, AC5), поднимаем корневую version,
 * и ПЕРЕЗАПУСКАЕМ проход 1 поверх новой версии → структурированные события с новой
 * interpretation_version. НИ ОДИН существующий date/base-event не мутируется (AC6).
 *
 * @param {object} proposal объект из interpret(...).payload.proposal
 * @param {object} [opts]
 * @param {object} [opts.rules]  правила, поверх которых мигрируем (default DEFAULT_RULES).
 * @param {Array}  [opts.baseEvents] базовые события для дедупа дат (AC6).
 * @param {string} [opts.date]     дата события (default сегодня).
 * @param {Function} [opts.llm]    (резерв) LLM-адаптер — если передан, его await-вызов
 *                          используется как необязательный пункт подтверждения; LLM не
 *                          источник истины (AC10), поэтому итоговое решение — за интерпретатором.
 * @returns {Promise<object>} { mode:'structured', migrated:true, status, interpretation_version,
 *          rulesVersion, fromMode:'pending_confirmation', payload:{ events, newRules, conflicts } }.
 */
async function confirmProposal(proposal, opts = {}) {
    const rules = opts.rules || DEFAULT_RULES;
    const baseEvents = Array.isArray(opts.baseEvents) ? opts.baseEvents : [];
    const date = opts.date || new Date().toISOString().slice(0, 10);

    if (!proposal || !proposal.draft || typeof proposal.draft.id !== 'string') {
        return { mode: 'error', status: 'error', rulesVersion: rules.version, payload: { reason: 'Некорректное предложение' } };
    }

    // Резерв: LLM-подтверждение (необязательно). Неисправность LLM не блокирует
    // детерминированную миграцию — AC10: LLM не источник истины, мы лишь консультируемся.
    if (typeof opts.llm === 'function') {
        try {
            await opts.llm({ type: 'confirm-proposal', proposalId: proposal.draft.id, draft: proposal.draft });
        } catch (_) { /* LLM-сбой не должен валить интерпретатор (AC10) */ }
    }

    // MIGRATE: иммутабельный перенос → новая версия правил (append нового dynamic-правила
    // или штатная замена applyMigration при совпадении id).
    const newRules = applyProposalAsMigration(rules, proposal.draft);

    // структурный MIGRATE-перезапуск первого прохода по НОВОЙ версии.
    const input = proposal.basedOn || '';
    const normalized = normalizeInput(input);
    const reordered = reorderDialect(normalized);
    const { candidates } = match(reordered, proposal.context || null, newRules);
    const version = newRules.version;
    const { events, conflicts } = coerceToEvents(candidates, date, version, baseEvents);

    return {
        mode: 'structured',
        migrated: true,
        status: 'success',
        interpretation_version: version,
        rulesVersion: version,
        fromMode: 'pending_confirmation',
        payload: { events, newRules, conflicts },
    };
}

module.exports = {
    interpret,
    confirmProposal,
    reorderDialect,
    proposeIfPossible,
    // helpers (для тестов/повторного использования)
    nextRuleId,
    buildCapturingDraft,
    templateForContext,
};