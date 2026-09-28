'use strict';
// core/llmGateway.js — шлюз вызова LLM с подстановкой шаблонов (P-E).
// Чистый CommonJS: нет dv/app/DOM. Работает под node --test.
// Подменяет {{TABLE}}, {{CONTEXT}}, {{INPUT}}, {{RULES}} в prompts/mode_*.md
// и вызывает adapters/llm.js chat() с валидацией ответа {status, payload, confidence}.

const fs = require('fs');
const path = require('path');
const { chat, VALID_MODES } = require('../adapters/llm.js');

const PROMPTS_DIR = path.join(__dirname, '..', 'prompts');

/** Кэш загруженных шаблонов. */
const templateCache = new Map();

/**
 * Загружает шаблон промпта для режима.
 * @param {'parse'} mode
 * @returns {string} содержимое .md файла
 * @throws {Error} если файл не найден или mode невалиден
 */
function loadTemplate(mode) {
    if (!VALID_MODES.has(mode)) {
        throw new TypeError(`llmGateway: неизвестный mode '${mode}'. Допустимые: ${[...VALID_MODES].join(', ')}`);
    }
    if (templateCache.has(mode)) return templateCache.get(mode);

    const filePath = path.join(PROMPTS_DIR, `mode_${mode}.md`);
    let content;
    try {
        content = fs.readFileSync(filePath, 'utf8');
    } catch (e) {
        throw new Error(`llmGateway: не удалось прочитать шаблон ${filePath}: ${e.message}`);
    }
    templateCache.set(mode, content);
    return content;
}

/**
 * Подставляет плейсхолдеры в шаблоне.
 * @param {string} template
 * @param {{table?: string, context?: string, input?: string}} vars
 * @returns {string}
 */
function substitute(template, vars = {}) {
    const table = vars.table ?? '';
    const context = vars.context ?? '';
    const input = vars.input ?? '';
    const rules = vars.rules ?? '';

    return template
        .replace(/\{\{TABLE\}\}/g, table)
        .replace(/\{\{CONTEXT\}\}/g, context)
        .replace(/\{\{INPUT\}\}/g, input)
        .replace(/\{\{RULES\}\}/g, rules);
}

/**
 * Валидирует, что ответ соответствует контракту {status, payload, confidence}.
 * @param {*} response
 * @returns {{status:string, payload:*, confidence:number}} нормализованный ответ
 * @throws {TypeError} если структура нарушена
 */
function validateResponse(response) {
    if (!response || typeof response !== 'object') {
        throw new TypeError('llmGateway: ответ LLM не является объектом');
    }
    if (typeof response.status !== 'string' || response.status.trim() === '') {
        throw new TypeError('llmGateway: отсутствует или некорректное поле status');
    }
    if (!Object.prototype.hasOwnProperty.call(response, 'payload')) {
        throw new TypeError('llmGateway: отсутствует поле payload');
    }
    if (typeof response.confidence !== 'number' || !Number.isFinite(response.confidence)) {
        throw new TypeError('llmGateway: отсутствует или некорректное поле confidence (ожидается число)');
    }
    // Зажимаем confidence в [0, 1] на случай выхода за границы
    const confidence = Math.min(1, Math.max(0, response.confidence));
    return { status: response.status, payload: response.payload, confidence };
}

/**
 * Основная точка входа: подставляет шаблон, вызывает LLM, валидирует ответ.
 *
 * @param {'parse'} mode — режим (шаблон mode_parse.md, статус success)
 * @param {string} [input=''] — пользовательский ввод (подставляется в {{INPUT}})
 * @param {string} [context=''] — контекст (последние записи, подставляется в {{CONTEXT}})
 * @param {string} [table=''] — пользовательская таблица недели ({{TABLE}})
 * @param {Object} [options.rules] — машиночитаемый срез правил ({{RULES}}, D14)
 * @param {{fetch?: Function, url?: string, model?: string}} [options] — пробрасывается в adapters/llm.js chat()
 * @returns {Promise<{status:string, payload:*, confidence:number}>} контрактный ответ
 */
async function callLLM(mode, input = '', context = '', table = '', options = {}) {
    const template = loadTemplate(mode);
    const rules = (options && typeof options === 'object' && options.rules != null) ? String(options.rules) : '';
    const promptText = substitute(template, { table, context, input, rules });

    // DEBUG-LOG: что именно уходит в LLM (шаблон + подстановки).
    console.log(`[LLM] === CALL mode='${mode}' ===================================`);
    console.log('[LLM] --- SLOTS ---');
    console.log(`[LLM] INPUT:   ${JSON.stringify(input)}`);
    console.log(`[LLM] CONTEXT: ${JSON.stringify(context)}`);
    console.log(`[LLM] TABLE:   ${JSON.stringify(table)}`);
    console.log(`[LLM] RULES:   ${JSON.stringify(rules)}`);
    console.log('[LLM] --- FINAL PROMPT (sent to model) ---');
    console.log(promptText);
    console.log(`[LLM] === END CALL mode='${mode}' ================================`);

    const response = await chat(promptText, mode, options);

    // chat() уже возвращает {status, payload, confidence} через responseParser,
    // но валидируем структуру повторно на шлюзе для защиты контракта (AC9/AC10).
    return validateResponse(response);
}

module.exports = { callLLM, loadTemplate, substitute, validateResponse, PROMPTS_DIR };