'use strict';
// core/keyNaming.js — структурный валидатор контракта именования ключей entity_metric
// (запрос заказчика 2026-08-31, D16): ТОЛЬКО латиница, нижний регистр snake_case,
// минимум 2 сегмента (первый — группа упражнения, второй+ — конкретный тип/метрика),
// семантически читаемые названия. Это валидация СТРУКТУРЫ ВЫВОДА LLM (детерминированный
// слой контракта, D9), НЕ парсинг входа: в коде нет ни одного доменного имени упражнения.
//
// Валидатор возвращает { ok, reason? } — нарушение = статус 'ambiguous' у structured
// (результат LLM НЕ принимается молча, контракт {status, payload, confidence}).

// Сегмент: латинская строчная буква с начала, дальше строчные буквы/цифры.
const SEGMENT_RE = /^[a-z][a-z0-9]*$/;
// Весь ключ: латиница в нижнем регистре + цифры + подчёркивания (кириллица/транслит-мусор
// с не-ASCII или заглавными отсекается уже здесь).
const KEY_RE = /^[a-z0-9_]+$/;
// Обезличенные метки-заглушки (Type A / way2 / var1 / part3) запрещены контрактом:
// их невозможно прочитать на графике. Это структурный запрет ФОРМЫ, не списка упражнений.
const ANON_RE = /^(type|way|var|part|variant|option|kind)[0-9]*$/;
// Частые артефакты русской транслитерации. Эвристика ФОРМЫ: только однозначно русские
// цепочки. НЕ включены (К3, 2026-08-31): ch/ts/kh (chest, squats, khaki), а также sch/yo —
// легитимные английские слова (school, yoga) давали ложный ambiguous → лишние прогоны.
// Остались: zh («otzhimaniya»), shch, ya («prisyad», «podtyagivaniya»), yu.
const TRANSLIT_RE = /(zh|shch|ya|yu)/;

/**
 * Валидирует ключ entity_metric по контракту именования.
 * @param {string} key кандидат-ключ (вывод LLM).
 * @returns {{ok: boolean, reason?: string}}
 */
function validateKeyName(key) {
    if (typeof key !== 'string' || key.length === 0) {
        return { ok: false, reason: 'ключ должен быть непустой строкой' };
    }
    if (!KEY_RE.test(key)) {
        return { ok: false, reason: 'только латиница в нижнем регистре, цифры и подчёркивания (кириллица/транслит/заглавные запрещены)' };
    }
    if (/^_|_$|__/.test(key)) {
        return { ok: false, reason: 'подчёркивания только между сегментами (без ведущих/хвостовых/двойных)' };
    }
    const parts = key.split('_');
    if (parts.length < 2) {
        return { ok: false, reason: 'минимум 2 сегмента: <группа>_<тип/метрика>' };
    }
    for (const p of parts) {
        if (!SEGMENT_RE.test(p)) {
            return { ok: false, reason: `сегмент '${p}' должен начинаться с латинской буквы (строчные буквы/цифры)` };
        }
        if (ANON_RE.test(p)) {
            return { ok: false, reason: `безликая метка '${p}' запрещена — имя должно быть семантически понятным` };
        }
        if (TRANSLIT_RE.test(p)) {
            return { ok: false, reason: `сегмент '${p}' выглядит транслитом — используйте короткое английское слово по смыслу` };
        }
    }
    return { ok: true };
}

/** Проверяет все ключи объекта values; возвращает список нарушений ['key — reason']. */
function namingViolations(values) {
    const out = [];
    for (const k of Object.keys(values || {})) {
        const v = validateKeyName(k);
        if (!v.ok) out.push(`${k} — ${v.reason}`);
    }
    return out;
}

module.exports = { validateKeyName, namingViolations };
