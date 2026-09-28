'use strict';
// core/router.js — P-A Router / классификация ОДНОГО дня в 3 группы (канва 2026-09-04).
// Чистый CommonJS: нет dv/app/DOM. Работает под node --test.
//
// С 2026-09-04 нарезку ввода на дни делает CUTTER (core/cutter.js). Router получает
// УЖЕ ОДИН день (кусок) и решает одно: сравнивает кусок дня с последними правилами
// ({{RULES}}) и относит его к группе:
//   Группа 1 — полное попадание в пример правила (та же формулировка) → Branch 1.
//   Группа 2 — та же семантика, другая формулировка → Branch 2 (минорное дополнение).
//   Группа 3 — новой сути в правилах нет → Branch 3 (conflict).
// Правила предыдущих дней этого же прогона попадают в {{RULES}} через tmp-кэш
// (пайплайн держит оверлей в rulesLog.setCachedLog) — сквозная оценка возникает
// из цикла, без инструкций LLM.
//
// LLM классифицирует, но НЕ является источником истины (AC10): router валидирует
// группы детерминированно (кусок — непустая строка; группа ∈ {1,2,3}), и если
// LLM не дал валидного ответа — возвращается ошибка, чтобы pipeline не терял
// новые правила на fallback-группе. Придумывание новых правил кодом НЕ делается.
// Router НИЧЕГО не пишет на диск, события и правила не мутирует.
//
// Шаблон prompts/mode_router.md читается напрямую через fs (VALID_MODES не
// содержит 'router'), подставляется substitute(), вызывается chat(promptText, 'parse', opts).

const { substitute, validateResponse } = require('./llmGateway.js');
const { chat } = require('../adapters/llm.js');

const path = require('path');

const PROMPTS_DIR = path.join(__dirname, '..', 'prompts');

// Кэш содержимого шаблона router (читаем напрямую — VALID_MODES не содержит 'router').
const _routerTemplates = new Map();

/** Читает вариант шаблона Router (с кэшем). */
function loadRouterTemplate(session = false) {
    const filename = session ? 'mode_routerSession.md' : 'mode_router.md';
    if (!_routerTemplates.has(filename)) {
        _routerTemplates.set(filename, require('fs').readFileSync(path.join(PROMPTS_DIR, filename), 'utf8'));
    }
    return _routerTemplates.get(filename);
}

/** Сбрасывает кэш шаблона (для тестов). */
function _resetTemplateCache() {
    _routerTemplates.clear();
}

/** Временное правило текущего прогона требует проверки свежих примеров. */
function hasProvisionalRules(rules) {
    if (typeof rules !== 'string') return false;
    try {
        const parsed = JSON.parse(rules);
        return Array.isArray(parsed?.rules) && parsed.rules.some(rule =>
            typeof rule?.id === 'string' && rule.id.startsWith('tmp_'));
    } catch (_e) { return false; }
}

/** Нормализует номер группы: 1/2/'1'/'2'/'3' → число; прочее → null. */
function normGroup(v) {
    const n = typeof v === 'number' ? v : (typeof v === 'string' ? Number(v) : NaN);
    return (n === 1 || n === 2 || n === 3) ? n : null;
}

/** Совпадение куска допускает только эквивалентную запись HTML-переноса строки. */
function normalizeChunkBreaks(value) {
    return String(value).replace(/<br\s*\/?>/gi, '\n').replace(/\r\n?/g, '\n');
}

/** Project stored rules to the exercise-specific evidence Router needs. */
function routerRules(rules) {
    if (typeof rules !== 'string') return { rules: [] };
    try {
        const parsed = JSON.parse(rules);
        if (!Array.isArray(parsed?.rules)) return { rules: [] };
        const projected = {};
        const keys = [...new Set(parsed.rules.flatMap(rule =>
            Object.keys(rule?.mapping && typeof rule.mapping === 'object' ? rule.mapping : {})))];
        for (const key of keys) {
            projected[key] = [];
            for (const rule of [...parsed.rules].reverse()) {
                const examples = Array.isArray(rule?.examples) ? rule.examples : [];
                for (const example of [...examples].reverse()) {
                    if (!example || !example.values || !Object.prototype.hasOwnProperty.call(example.values, key)) continue;
                    // New examples use grounded source spans; older examples already store the exercise fragment in input.
                    const fragment = typeof example.sourceSpan === 'string' ? example.sourceSpan : example.input;
                    if (typeof fragment !== 'string' || !fragment.trim()) continue;
                    if (!projected[key].includes(fragment)) projected[key].push(fragment);
                }
            }
        }
        return { rules: projected };
    } catch (_e) {
        return { rules: [] };
    }
}

/**
 * Structurally validates model verdicts without changing the classification.
 * Accepts object entries or bare numeric group entries, and attaches the source day
 * when the model omitted it. LLM rule IDs are intentionally ignored.
 * @param {*} payload
 * @returns {Array|null} массив валидных кусков или null, если валидных нет.
 */
function llmGroups(payload, sourceChunk = null) {
    if (!payload || !Array.isArray(payload.groups)) return null;
    const out = [];
    for (const g of payload.groups) {
        if (normGroup(g) !== null) {
            out.push({ chunk: typeof sourceChunk === 'string' ? sourceChunk : '', group: normGroup(g) });
            continue;
        }
        if (!g || typeof g !== 'object') continue;
        const chunk = typeof g.chunk === 'string'
            ? g.chunk.trim()
            : (g.chunk === undefined && typeof sourceChunk === 'string' ? sourceChunk : '');
        const group = normGroup(g.group);
        if (!chunk || group === null) continue;
        const item = { chunk, group };
        // Rule identity is owned by the wrapper; never trust an LLM-supplied ID.
        if (typeof g.reasoning === 'string' && g.reasoning) item.reasoning = g.reasoning;
        if (typeof g.confidence === 'number' && Number.isFinite(g.confidence)) {
            item.confidence = Math.min(1, Math.max(0, g.confidence));
        }
        out.push(item);
    }
    return out.length ? out : null;
}

/**
 * P-A Router: classifies one complete day into one of three groups.
 *
 * @param {string} input пользовательский ввод (любой недетерминированный формат).
 * @param {{fetch?: Function, url?: string, model?: string, context?: string, rules?: string}} [opts]
 *        - fetch: инжектируемый fetch (тесты); url/model переопределения chat();
 *        - rules: stored examples are projected to key → exercise fragments for the prompt.
 * @returns {Promise<{status:'success'|'error',
 *                    payload:{groups:{chunk,group,reasoning?,confidence?}[], confidence}|null,
 *                    confidence:number}>}
 *          Никогда не бросает. Сбой LLM/шаблона/контракта → явная ошибка без групп.
 */
async function route(input, opts = {}) {
    try {
        if (typeof input !== 'string' || input.trim() === '') {
            return { status: 'error', payload: null, confidence: 0 };
        }

        const template = loadRouterTemplate(hasProvisionalRules(opts.rules));
        const promptText = substitute(template, {
            rules: JSON.stringify(routerRules(opts.rules)),
            input,
        });

        // mode 'parse' -> желаемый status 'success'. Router — чисто классифицирующий шаг.
        const response = await chat(promptText, 'parse', {
            ...opts,
            temperature: opts.temperature === undefined ? 0 : opts.temperature,
        });
        // Gemma occasionally serializes a single object property as the literal dotted key.
        // Unwrap only that structural spelling; preserve its original group verdict.
        const structurallyNormalized = response?.payload && typeof response.payload === 'object'
            && Array.isArray(response.payload['payload.groups'])
            ? { ...response, payload: { ...response.payload, groups: response.payload['payload.groups'] } }
            : response;
        const validated = validateResponse(structurallyNormalized);

        // Ответ без ровно одной валидной группы для исходного дня — ошибка контракта.
        // Fallback 1/3 может молча потерять новую метрику, поэтому не классифицируем.
        const groups = (validated.status === 'success')
            ? llmGroups(validated.payload, input)
            : null;
        // Router receives one day. Permit only equivalent HTML/newline serialization,
        // then restore the exact source chunk before passing it downstream.
        const exactDay = groups && groups.length === 1
            && normalizeChunkBreaks(groups[0].chunk) === normalizeChunkBreaks(input);
        if (validated.status !== 'success' || !groups || !exactDay) {
            return {
                status: 'error',
                payload: null,
                confidence: validated.confidence,
                message: validated.status !== 'success'
                    ? `Router не дал валидного ответа (${validated.message || validated.status}); классификация остановлена, повторите обработку.`
                    : (!groups
                        ? 'Router не вернул ровно одну валидную группу для исходного дня; классификация остановлена, повторите обработку.'
                        : 'Router вернул chunk, который не совпадает с исходным днём; классификация остановлена, повторите обработку или уточните ввод.'),
            };
        }
        const modelGroup = groups[0].group;
        const emptyRulebook = Object.keys(routerRules(opts.rules).rules).length === 0;
        if (emptyRulebook && modelGroup !== 3) {
            return {
                status: 'error', payload: null, confidence: validated.confidence,
                message: 'Router выбрал группу 1/2 при пустом словаре правил; требуется явный ответ группы 3. Повторите обработку.',
            };
        }
        const decision = { ...groups[0] };
        const groups_ = [{ ...decision, chunk: input }];

        return {
            status: 'success',
            payload: {
                groups: groups_,
                confidence: validated.confidence,
                fallback: false,
            },
            confidence: validated.confidence,
        };
    } catch (e) {
        // Сеть, HTTP, битый шаблон: никогда не бросаем и не маскируем ошибку группой.
        return {
            status: 'error',
            payload: null,
            confidence: 0,
            message: `Router завершился ошибкой: ${(e && e.message) || String(e)}`,
        };
    }
}

module.exports = {
    route,
    llmGroups,
    normGroup,
    loadRouterTemplate,
    PROMPTS_DIR,
    _resetTemplateCache,
    routerRules,
};
