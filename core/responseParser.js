'use strict';
// core/responseParser.js — устойчивый разбор сырого текста LLM в типизированный
// { status, payload, confidence } (контракт D4, AC10).
//
// Роль: LLM — не источник истины (AC10), его текст — только кандидат. Этот модуль
// превращает максимально «грязный» ответ модели (markdown-ограждения, обрамляющая
// проза, хвостовые запятые, оба вида литералов) во что-то, что интерпретатор сможет
// провалидировать. Модуль ЧИСТЫЙ: нет dv/app/DOM — работает под node --test.
//
// Инвариант: НИКОГДА не бросает исключений. На полную неудачу возвращает
// { status: 'error', payload: null, confidence: 0 }.

const VALID_STATUSES = new Set(['success', 'ambiguous', 'resolve', 'migrate', 'error']);

/**
 * Статус по умолчанию, когда в тексте нет явного поля status и вызывающий не задал
 * fallbackStatus. Успешно распарсенный полезный payload без статуса считаем 'success'.
 */
const DEFAULT_FALLBACK_STATUS = 'success';

/**
 * Справедливый confidence по статусу, если в тексте нет явного числа confidence.
 */
function fallbackConfidenceFor(status) {
    switch (status) {
        case 'success': return 1;
        case 'error': return 0;
        default: return 0;
    }
}

/**
 * Вырезает из текста содержимое первого fenced code block (```json ... ```
 * либо ```...```), если такой есть. Обрамляющая проза за пределами ограждения
 * отбрасывается — это самый частый «кейс грязи» (шаг 1 робаст-парсинга).
 */
function stripCodeFences(text) {
    const fenceRe = /```(?:json)?\s*\r?\n?([\s\S]*?)\r?\n?```/;
    const m = text.match(fenceRe);
    return m ? m[1] : text;
}

/**
 * Удаляет хвостовые запятые ("..., ]" / "..., }"), которые модель часто добавляет
 * перед закрывающей скобкой. JSON строго их запрещает, поэтому чистим до parse.
 */
function stripTrailingCommas(text) {
    return text.replace(/,\s*([}\]])/g, '$1');
}

/**
 * Пытается распарсить текст как JSON после вольных чисток. Возвращает true/значение
 * или false. Отдельно пробуем сырой текст и текст с убранными запятыми — вдруг
 * хвостовые запятые вностил только наш чистщик / наоборот.
 */
function tryParse(text) {
    const raw = text.trim();
    try {
        return { ok: true, value: JSON.parse(raw) };
    } catch (_) { /* проба ниже */ }
    const cleaned = stripTrailingCommas(raw);
    try {
        return { ok: true, value: JSON.parse(cleaned) };
    } catch (_) {
        return { ok: false, value: undefined };
    }
}

/**
 * Находит сбалансированный JSON-литерал в тексте, «вырванный» из обрамляющей прозы.
 * Классический случай: "Вот данные: [ {...} ] Спасибо". Ищем первый вхождение
 * '{' или '[' (контейнер), идём посимвольно, учитывая строки и экранирование,
 * и берём подстроку до парной закрывающей скобки того же типа.
 *
 * Если первый контейнер оказался не-JSON (нет парной скобки / не парсится) —
 * перебираем следующие вхождения, беря первую успешную попытку. Это устойчиво к
 * «{» в начале прозы.
 */
function extractBalancedOuter(text) {
    const starts = [];
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (c === '{' || c === '[') starts.push(i);
    }
    for (const start of starts) {
        const res = matchClosed(text, start);
        if (!res) continue;
        const candidate = tryParse(text.slice(start, res + 1));
        if (candidate.ok) return candidate;
    }
    return { ok: false, value: undefined };
}

/**
 * Находит индекс парной закрывающей скобки для позиции start ('{'->'}' , '['->']'),
 * учитывая строковые литералы и экранирование. Используем настоящий стек типов скобок:
 * каждая '{'/'[' увеличивает стек, каждая '}'/']' сверяется с вершиной и снимает её.
 * Когда стек опустошается — нашли парный закрывающий символ стартовой скобки.
 * Возвращает индекс закрывающей скобки или null, если баланс не сходится.
 */
function matchClosed(text, start) {
    const stack = [text[start]];
    let inString = false;
    for (let i = start + 1; i < text.length; i++) {
        const c = text[i];
        if (inString) {
            if (c === '\\') { i++; continue; }       // экранированная последовательность
            if (c === '"') inString = false;
            continue;
        }
        if (c === '"') { inString = true; continue; }
        if (c === '{' || c === '[') { stack.push(c); continue; }
        if (c === '}' || c === ']') {
            const last = stack.pop();
            const ok = (c === '}' && last === '{') || (c === ']' && last === '[');
            if (!ok) return null;                    // разбалансировка типов — кандидат невалиден
            if (stack.length === 0) return i;        // закрыли стартовую скобку
        }
    }
    return null;
}

/**
 * Нормализует полученное значение в { status, payload, confidence }.
 * @param {*} value распарсенное JSON-значение
 * @param {string} fallbackStatus используемый status, если в value нет валидного поля status
 * @returns {{status:string, payload:*, confidence:number}}
 */
function toResult(value, fallbackStatus) {
    // Массив: это сам payload (например, новые записи из prompt.md).
    if (Array.isArray(value)) {
        return { status: fallbackStatus, payload: value, confidence: fallbackConfidenceFor(fallbackStatus) };
    }
    // Объект: читаем явные status/payload/confidence, если есть; иначе весь объект — payload.
    if (value && typeof value === 'object') {
        let status = fallbackStatus;
        if (typeof value.status === 'string' && VALID_STATUSES.has(value.status)) {
            // Явный status в тексте модели имеет приоритет (AC10: модель честно сообщает
            // о неуверенности или необходимости resolver/migrate).
            status = value.status;
        }
        const hasPayload = Object.prototype.hasOwnProperty.call(value, 'payload') && value.payload !== undefined;
        const payload = hasPayload ? value.payload : value;
        let confidence = fallbackConfidenceFor(status);
        if (typeof value.confidence === 'number' && Number.isFinite(value.confidence)) {
            confidence = Math.min(1, Math.max(0, value.confidence)); // зажимаем в [0,1]
        }
        return { status, payload, confidence };
    }
    // Скаляр (строка/число) — это не контрактный payload; считаем непригодным.
    return { status: 'error', payload: null, confidence: 0 };
}

/**
 * Устойчивый парсер сырого текста LLM.
 * @param {string} rawText текст ответа модели
 * @param {{fallbackStatus?: string, fallbackConfidence?: number}} [options]
 * @returns {{status:string, payload:*, confidence:number}} типизированный результат; never throws
 */
function parseResponse(rawText, options = {}) {
    const fallbackStatus =
        options && VALID_STATUSES.has(options.fallbackStatus)
            ? options.fallbackStatus
            : DEFAULT_FALLBACK_STATUS;

    // 0. Пустой/не-строковый вход — ошибка. Никакого throw.
    if (typeof rawText !== 'string' || rawText.trim() === '') {
        return { status: 'error', payload: null, confidence: 0 };
    }

    // 1. Многие модели вкладывают JSON в markdown-ограждение ```json ... ```.
    const withoutFences = stripCodeFences(rawText);

    // 2. Быстрый путь: после снятия ограждения текст — уже валидный JSON.
    const direct = tryParse(withoutFences);
    if (direct.ok) return toResult(direct.value, fallbackStatus);

    // 3. Робастный путь: текст обрамлён прозой — вырезаем первый распарсившийся
    //    сбалансированный литерал (массив или объект).
    const balanced = extractBalancedOuter(withoutFences);
    if (balanced.ok) return toResult(balanced.value, fallbackStatus);

    // 4. Ничего не распарсилось — garbage. Не бросаем.
    return { status: 'error', payload: null, confidence: 0 };
}

module.exports = { parseResponse, VALID_STATUSES };