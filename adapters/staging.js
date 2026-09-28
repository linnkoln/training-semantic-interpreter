'use strict';
// F-3: staging-хранилище — JSON-файл во временной папке vault, живёт МЕЖДУ прогонами,
// восстанавливается при рендере; очищается перед новым прогоном и после Save.
// Это решает проблему «2-й прогон видит дубли»: staged живёт не в памяти виджета,
// а в файле, который чистится детерминированно.
const path = require('path');

const STAGE_PATH = 'data/training/data.tmp.json';

function makeStaging(app) {
    if (!app || !app.vault) throw new TypeError('makeStaging: требуется app.vault');
    async function read(options = {}) {
        const f = app.vault.getAbstractFileByPath(STAGE_PATH);
        if (!f) return [];
        try {
            const text = await app.vault.read(f);
            if (!text.trim()) return [];
            const stored = JSON.parse(text);
            if (Array.isArray(stored)) return stored; // legacy bare-array format
            if (stored && typeof stored === 'object' && Array.isArray(stored.events)) return stored.events;
            throw new Error('ожидался массив событий или объект с events');
        } catch (error) {
            if (options.strict) throw new Error(`Не удалось прочитать ${STAGE_PATH}: ${error.message}`);
            return [];
        }
    }
    async function write(events) {
        // Формат файла: { events, state } — события и UI-состояние в одном JSON (F-3+state).
        let state = {};
        const f0 = app.vault.getAbstractFileByPath(STAGE_PATH);
        if (f0) {
            try {
                const cur = JSON.parse(await app.vault.read(f0));
                if (cur && typeof cur === 'object' && !Array.isArray(cur) && cur.state) state = cur.state;
            } catch (_) {}
        }
        const json = JSON.stringify({ events: events || [], state }, null, 2);
        const f = app.vault.getAbstractFileByPath(STAGE_PATH);
        if (f) await app.vault.modify(f, json);
        else await app.vault.create(STAGE_PATH, json);
    }
    async function clear() {
        // Стираем ТОЛЬКО события; UI-состояние (state) сохраняется — память виджета.
        await write([]);
    }
    // ---- state (UI-настройки виджета, 2026-08-31): отдельное поле в том же файле.
    // НЕ события, НЕ правила — только память UI (напр. скрытые группы графика).
    async function readState() {
        const f = app.vault.getAbstractFileByPath(STAGE_PATH);
        if (!f) return null;
        try {
            const obj = JSON.parse(await app.vault.read(f));
            return (obj && typeof obj === 'object' && !Array.isArray(obj)) ? obj.state || null : null;
        } catch (_) { return null; }
    }
    async function writeState(patch) {
        let base = {};
        const f = app.vault.getAbstractFileByPath(STAGE_PATH);
        if (f) {
            try {
                const cur = JSON.parse(await app.vault.read(f));
                if (cur && typeof cur === 'object' && !Array.isArray(cur)) base = cur;
                else if (Array.isArray(cur)) base = { events: cur }; // legacy bare-array формат
            } catch (_) {}
        }
        const events = Array.isArray(base.events) ? base.events : [];
        const json = JSON.stringify({ events, state: { ...(base.state || {}), ...patch } }, null, 2);
        if (f) await app.vault.modify(f, json);
        else await app.vault.create(STAGE_PATH, json);
    }
    return { read, write, clear, readState, writeState, PATH: STAGE_PATH };
}

module.exports = { makeStaging, STAGE_PATH };
