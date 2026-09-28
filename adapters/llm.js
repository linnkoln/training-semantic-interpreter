'use strict';
// adapters/llm.js — типизированный адаптер к локальной Ollama (P1, AC9).
//
// Чистый модуль (нет dv/app/DOM): работает под node --test.
// Заменяет «жёстко зашитый» вызов из main.js (fetch http://localhost:11434/api/chat,
// model gemma4, stream:false, regex-вырезка [...]) на контрактный:
//   chat(promptText, mode) -> { status, payload, confidence }  (контракт D4)
//
// status ПРОИЗВОДИТСЯ из переданного mode:
//   mode 'parse'      -> status 'success'    (модель распознала запись)
//   mode 'ambiguous'  -> status 'ambiguous'  (модель не может однозначно решить)
//   mode 'resolve'    -> status 'resolve'    (модель предложила разрешение конфликта)
//   mode 'migrate'    -> status 'migrate'    (модель предложила перенос/миграцию)
//
// LLM — НЕ источник истины (AC10): payload здесь только кандидат; интерпретатор
// валидирует и конвертирует в финальные события. Модуль сам события не создаёт.

const { parseResponse } = require('../core/responseParser.js');

const DEFAULT_MODEL = 'gemma4';
const DEFAULT_URL = 'http://localhost:11434/api/chat';

// Транспортная устойчивость (2026-09-02): занятая/тормозящая Ollama больше не роняет
// вызов с первого сбоя. 2 повтора с короткой задержкой при сетевом сбое / HTTP 5xx /
// таймауте; таймаут запроса 120s (AbortSignal.timeout). 4xx НЕ ретраится (это не
// transient-сбой — например, битый запрос). retryDelays в options — для тестов.
const RETRY_DELAYS_MS = [500, 1500];
const FETCH_TIMEOUT_MS = 120000;

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// mode -> status (единственное место, где задаётся отображение; AC9)
// Рабочие modes: 'router' (классификация ветки), 'parse' (Branch 1 — перевод
// по правилам), 'minorRuleUpdate' (Branch 2: минорное дополнение правил —
// аппенд ключ → новый пример употребления в rulesLog.tmp.json) и
// 'ruleUpdate' (Branch 3: разрешение конфликта — новое правило, mode_RuleUpdate.md).
const MODE_TO_STATUS = Object.freeze({
    parse: 'success',
    minorRuleUpdate: 'success',
    ruleUpdate: 'success',
});

const VALID_MODES = new Set(Object.keys(MODE_TO_STATUS));

/**
 * Вызывает локальную Ollama и возвращает типизированный { status, payload, confidence }.
 *
 * @param {string} promptText готовый текст промпта
 * @param {'parse'|'ambiguous'|'resolve'|'migrate'} mode двигает -> status (AC9)
 * @param {{fetch?: Function, url?: string, model?: string}} [options]
 *   - fetch: injectable fetch-подобная функция для тестируемости (default globalThis.fetch)
 *   - url/model: переопределения точки и модели (для тестов и конфигурации)
 * @returns {Promise<{status:string, payload:*, confidence:number}>}
 *          На сетевую/HTTP/parse ошибку: { status:'error', payload:null, confidence:0 } — never throws.
 */
async function chat(promptText, mode, options = {}) {
    // Программистская ошибка (неверный mode) — бросаем ДО сети, это баг вызывающего,
    // а не нестабильная внешняя среда.
    if (!VALID_MODES.has(mode)) {
        throw new TypeError(
            `chat: неизвестный mode '${mode}'. Допустимые: ${[...VALID_MODES].join(', ')} (AC9)`
        );
    }
    if (typeof promptText !== 'string' || promptText.trim() === '') {
        throw new TypeError('chat: promptText обязан быть непустой строкой');
    }

    const model = (options && options.model) || DEFAULT_MODEL;
    const url = (options && options.url) || DEFAULT_URL;
    const fetchFn = (options && typeof options.fetch === 'function')
        ? options.fetch
        : (typeof globalThis.fetch === 'function' ? globalThis.fetch : null);

    if (!fetchFn) {
        return { status: 'error', payload: null, confidence: 0, error: 'fetch недоступен' };
    }

    const desiredStatus = MODE_TO_STATUS[mode];
    const body = {
        model,
        messages: [{ role: 'user', content: promptText }],
        stream: false,
    };
    // Ollama temperature is opt-in so existing modes retain their request shape.
    if (typeof options.temperature === 'number' && Number.isFinite(options.temperature)
        && options.temperature >= 0 && options.temperature <= 2) {
        body.options = { temperature: options.temperature };
    }

    // DEBUG-LOG: точный payload, отправляемый модели.
    console.log(`[LLM] transport POST ${url}`);
    console.log(`[LLM] transport body: ${JSON.stringify(body)}`);

    const retryDelays = (options && Array.isArray(options.retryDelays)) ? options.retryDelays : RETRY_DELAYS_MS;
    const maxAttempts = retryDelays.length + 1;
    const init = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function')
            ? AbortSignal.timeout(FETCH_TIMEOUT_MS)
            : undefined,
    };

    let lastCause = 'неизвестная ошибка';
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (attempt > 0) {
            await sleep(retryDelays[attempt - 1]);
            console.log(`[LLM] transport retry ${attempt}/${retryDelays.length} (после: ${lastCause})`);
        }
        try {
            const response = await fetchFn(url, init);
            if (!response || typeof response.ok !== 'boolean') {
                lastCause = 'нет корректного HTTP-ответа';
                continue; // transient — ретраим
            }
            if (!response.ok) {
                const cause = `HTTP ${response.status}`;
                if (response.status >= 500) {
                    lastCause = cause;
                    continue; // 5xx — transient (занятая Ollama), ретраим
                }
                // 4xx — НЕ ретраим (стабильный сбой запроса).
                return { status: 'error', payload: null, confidence: 0, error: cause };
            }
            const data = await response.json();
            const answer = data && data.message && typeof data.message.content === 'string'
                ? data.message.content
                : null;
            if (answer === null) {
                return { status: 'error', payload: null, confidence: 0, error: 'битый формат ответа (нет message.content)' };
            }
            // Сырой текст -> устойчивый парсер; status по умолчанию = статус от mode.
            return parseResponse(answer, { fallbackStatus: desiredStatus });
        } catch (e) {
            // Сеть упала / таймаут (AbortError/TimeoutError) — transient, ретраим.
            lastCause = (e && (e.name === 'TimeoutError' || e.name === 'AbortError'))
                ? `таймаут ${FETCH_TIMEOUT_MS}ms`
                : ((e && e.message) || String(e));
        }
    }
    // Все попытки исчерпаны — контрактный error с ПРИЧИНОЙ (для reason наверху). Never throws.
    return { status: 'error', payload: null, confidence: 0, error: lastCause };
}

module.exports = { chat, MODE_TO_STATUS, VALID_MODES, DEFAULT_MODEL, DEFAULT_URL };
