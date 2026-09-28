'use strict';
// core/cutter.js — Cutter: LLM-нарезка сырого ввода на дни (канва 2026-09-04,
// узел «Router — решение о ветке» id 8c49ad6f02c200d4 = cutter).
//
// Cutter — ПРОСТАЯ LLM-задача: разбить сырой ввод (таблица недели, строки,
// текст — любой формат) на дни, выбросив мусор ВНЕ записей (линии `| --- |`,
// шапки, пустые ячейки). Содержимое дня переносится ДОСЛОВНО. Сквозная оценка
// групп — НЕ его работа: каждый день дальше идёт в Router отдельно (цикл
// пайплайна), а правила предыдущих дней появляются сами — через tmp-кэш.
//
// Cutter НЕ интерпретирует данные (AC10) и НИЧЕГО не пишет на диск.
// Никогда не бросает: сбой LLM/шаблона → { status:'error', payload:{ days:[] } }.
//
// Шаблон prompts/mode_cutter.md читается напрямую через fs (VALID_MODES в
// adapters/llm.js не содержит 'cutter'), подставляется substitute(), вызывается
// chat(promptText, 'parse', opts) — по образцу core/router.js.

const { substitute, validateResponse } = require('./llmGateway.js');
const { chat } = require('../adapters/llm.js');

const path = require('path');

const PROMPTS_DIR = path.join(__dirname, '..', 'prompts');

// Кэш содержимого шаблона cutter (читаем напрямую — VALID_MODES не содержит 'cutter').
let _cutterTemplate = null;

/** Читает prompts/mode_cutter.md (с кэшем). Бросает, если файл недоступен. */
function loadCutterTemplate() {
    if (_cutterTemplate === null) {
        _cutterTemplate = require('fs').readFileSync(path.join(PROMPTS_DIR, 'mode_cutter.md'), 'utf8');
    }
    return _cutterTemplate;
}

/** Сбрасывает кэш шаблона (для тестов). */
function _resetTemplateCache() {
    _cutterTemplate = null;
}

/** Нормализует дату дня: 'MM-DD' строка или null. */
function normDate(v) {
    if (typeof v === 'string' && /^\d{2}-\d{2}$/.test(v.trim())) return v.trim();
    return null;
}

/**
 * Детерминированная валидация дней LLM (AC10 guardrail).
 * Из payload достаёт массив дней {raw, date}: raw — непустая строка (дословно,
 * без trim — вербатим), date — 'MM-DD' или null. Невалидные дни отбрасываются.
 * @param {*} payload
 * @returns {Array|null} массив валидных дней или null, если валидных нет.
 */
function llmDays(payload) {
    if (!payload || !Array.isArray(payload.days)) return null;
    const out = [];
    for (const d of payload.days) {
        if (!d || typeof d !== 'object') continue;
        const raw = typeof d.raw === 'string' ? d.raw : '';
        if (raw.trim() === '') continue;
        out.push({ raw, date: normDate(d.date) });
    }
    return out.length ? out : null;
}

/**
 * Cutter: нарезает сырой ввод на дни (канва 2026-09-04).
 *
 * @param {string} input весь сырой ввод пользователя (любой формат).
 * @param {{fetch?: Function, url?: string, model?: string}} [opts]
 *        - fetch: инжектируемый fetch (тесты); url/model — переопределения chat().
 * @returns {Promise<{status:'success'|'error',
 *                    payload:{days:{raw:string,date:string|null}[], confidence?:number}|null,
 *                    confidence:number}>}
 *          Никогда не бросает. Сбой → { status:'error', payload:{ days:[] } }.
 */
async function cut(input, opts = {}) {
    try {
        if (typeof input !== 'string' || input.trim() === '') {
            return { status: 'error', payload: { days: [] }, confidence: 0 };
        }

        const template = loadCutterTemplate();
        const promptText = substitute(template, { input });

        // mode 'parse' -> желаемый status 'success'. Cutter — чисто структурный шаг.
        const response = await chat(promptText, 'parse', opts);
        const validated = validateResponse(response);

        const days = (validated.status === 'success')
            ? llmDays(validated.payload)
            : null;
        if (!days) {
            // Сбой (ambiguous/garbage/невалидные дни) → контрактный error, никогда не бросаем.
            return { status: 'error', payload: { days: [] }, confidence: 0 };
        }

        return {
            status: 'success',
            payload: { days, confidence: validated.confidence },
            confidence: validated.confidence,
        };
    } catch (_e) {
        // Сеть, HTTP, битый шаблон, некорректный контракт — никогда не бросаем.
        return { status: 'error', payload: { days: [] }, confidence: 0 };
    }
}

module.exports = {
    cut,
    llmDays,
    normDate,
    loadCutterTemplate,
    PROMPTS_DIR,
    _resetTemplateCache,
};
