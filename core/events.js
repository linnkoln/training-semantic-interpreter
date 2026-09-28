'use strict';
// core/events.js — иммутабельное событие + снапшот интерпретации
//
// Модель события (D2): { date, values, interpretation_version, createdAt }.
// Каждое событие хранит снапшот интерпретации (interpretation_version), который
// указывает, какая версия правил его породила. Это делает старые данные
// самодостаточными: их семантика не зависит от текущего состояния правил.
// // Основной инвариант: события иммутабельны (read-only). Интерпретатор и ни
// один LLM-путь не могут мутировать существующее событие — только создавать новое.

/**
 * Создаёт замороженное (immutable) событие.
 * @param {{date: string, values: Object<string, number>}} input
 * @param {number} interpretationVersion версия правил, породившая событие (AC5)
 * @returns {Readonly<{date:string, values:Readonly<Object>, interpretation_version:number, createdAt:Date}>}
 */
function makeEvent(input, interpretationVersion) {
    if (!input || typeof input.date !== 'string') {
        throw new TypeError('makeEvent: требуется { date: string, values: {...} }');
    }
    if (!Number.isInteger(interpretationVersion)) {
        throw new TypeError('makeEvent: событие без interpretation_version невозможно (D2)');
    }
    const evt = Object.freeze({
        date: input.date,
        values: Object.freeze({ ...(input.values || {}) }),
        interpretation_version: interpretationVersion,
        createdAt: new Date(), // снапшот времени создания; не путать с датой события
    });
    return evt;
}

/**
 * Проверяет, что объект — корректное событие (полная форма, AC6).
 */
function isEvent(x) {
    return !!x && typeof x === 'object'
        && typeof x.date === 'string'
        && x.values && typeof x.values === 'object'
        && Number.isInteger(x.interpretation_version)
        && x.createdAt !== undefined;
}

/**
 * Возвращает интерпретационную версию события (или null).
 */
function getVersion(x) {
    return x && Number.isInteger(x.interpretation_version) ? x.interpretation_version : null;
}

module.exports = { makeEvent, isEvent, getVersion };