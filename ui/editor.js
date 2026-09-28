'use strict';
// ui/editor.js — P-F: Dataview/Obsidian-виджет «редактор + график» c ТРАНЗАКЦИОННЫМ
// двухпольным UX (DISCREPANCIES_PLAN §4.2, AC-R9).
//
// ВАЖНО: файл НЕ делает require (стратегия бандла — микро-shim; app/bundle передаются
// аргументом). Поэтому он встраивается в bundle.js без require-графа и одинаково
// работает и в бандле, и (при желании) отдельно. Только фабрика mountEditor(opts):
// все зависимые модули приходят через opts.bundle (window.TrainingCore).
//
// LLM-движок — core/pipeline.js (P-P): raw input → Router → Branch 1 | Branch 2/3.
//   b.pipeline.next(input, opts) → { status, branch, payload, confidence, message? }
//   b.pipeline.commitRules(result) подготавливает правила для общего Save, не пишет из браузера.
//
// ТРАНЗАКЦИОННАЯ СЕМАНТИКА (staged/committed, AC-R9):
//   committed — сохранённые события (data.json), эталон.
//   staged    — предлагаемый/PREVIEW-набор событий из pipeline (Branch 1: события;
//               Branch 2: пример-отрисовка). Пишется только в data.tmp.json.
// Поле 2 (JSON) и график рисуются по committed ∪ staged (черновик). Файл data.json
// НЕ трогается, пока пользователь явно не нажмёт «💾 Сохранить данные» — только
// тогда staged → committed через storage.saveData (с dedupeByDate, AC6).
// Ререндер восстанавливает staged; новый прогон и явная очистка сбрасывают его.
//
// Движок распознавания/перевода — LLM-пайплайн (вместо детерминированного регекса).
// НИ ОДНО событие не мутируется (INV-4/AC10): всегда создаются новые массивы и копии.
// Хранится сильное: иммутабельность, версионирование правил, chartModel из графа,
// контрактный LLM-ответ { status, branch, payload, confidence }.

const UI_TEXT = {
    title: '📝 Редактор данных тренировок + график',
    field1Header: '── Поле 1 · сырой ввод (без побочных эффектов) ──────────────',
    tableLabel: 'Вставьте таблицу (текст), по строке на запись:',
    tablePlaceholder: 'Скопируйте сюда строки записей…\nНапример: 100 отжимания (73+27)',
    runBtn: '🧠 Обработать через LLM-пайплайн',
    field2Header: '── Поле 2 · данные (черновик: committed ∪ staged) ─────────',
    jsonLabel: '⚙️ JSON данных (committed ∪ staged) — черновик, файл НЕ пишется до «Сохранить»:',
    jsonPlaceholder: 'Штатно поле заполняется из пайплайна. Руками можно править как fallback.\nВведи корректный JSON-массив объектов с полями date и values…',
    saveBtn: '💾 Сохранить данные',
    wipeBtn: '🗑️ Очистить память (полный сброс)',
    clearTmpBtn: '🧽 Очистить временные файлы',
    tempNotice: '⚠️ График отрисован с временными файлами. Сохраните данные, чтобы сохранить также временные правила и граф.',
    saved: '✅ Данные сохранены!',
    noData: '📊 Нет данных для отображения графика.',
    loading: '⏳ Загрузка…',
};

function el(tag, attrs, parent) {
    const node = document.createElement(tag);
    if (attrs && attrs.className) node.className = attrs.className;
    if (attrs && attrs.style) node.setAttribute('style', attrs.style);
    if (attrs && attrs.text !== undefined) node.textContent = attrs.text;
    if (attrs && attrs.placeholder !== undefined) node.setAttribute('placeholder', attrs.placeholder);
    if (attrs && attrs.rows !== undefined) node.setAttribute('rows', String(attrs.rows));
    if (parent) parent.appendChild(node);
    return node;
}

/**
 * «Последняя метрика» из событий для контекста правила/structured (resolve-режим).
 * Приоритет: push → pull → произвольная; учитываем признак max.
 */
function lastContextOf(events) {
    const last = events && events[events.length - 1];
    if (!last || !last.values) return null;
    const keys = Object.keys(last.values).filter((k) => Number.isFinite(last.values[k]));
    if (!keys.length) return null;
    const push = keys.find((k) => k.indexOf('push') === 0);
    const pull = keys.find((k) => k.indexOf('pull') === 0);
    const base = push || pull || keys[keys.length - 1];
    const family = base.split('_')[0];
    const max = keys.find((k) => k.includes('max'));
    return (max && max.startsWith(family)) ? max : base;
}

/**
 * Диагностика частичного прогона (TC001, partial-cycle): человекочитаемая строка
 * по payload.failedDays / response.failedDays [{dayIndex, date, reason}].
 * Только текст через textContent — никакого raw HTML.
 */
function failedDaysText(failedDays) {
    return (failedDays || []).map((d) => 'день ' + d.dayIndex
        + (d.date ? ' (' + d.date + ')' : '')
        + (d.reason ? ': ' + d.reason : '')).join('; ');
}

/**
 * Локальный fallback «фактического вайпа» лога правил — ТОЧНО та же форма, что
 * core/rulesLog.buildWipeLog (нужен, только если bundle собран без этой функции).
 * Журнал ЛИТЕРАЛЬНО ПУСТ: { version: 0, updatedAt, entries: [] } — ни истории правил,
 * ни записи о самом сбросе. Версия 0 = «как будто в системе не было ничего записано»
 * (цитата заказчика 2026-09-01, docs/user/quotes.md; та же форма, что в
 * tools/reset-all-data.js по указанию пользователя 2026-08-30) — исключение из INV-5
 * только для пользовательского сброса, следующий append даст version 1.
 * entries: [] безопасен: getLatestRules() на пустом списке откатывается на
 * DEFAULT_RULES (core/rules.js), а тот сам пуст — правила не «воскресают».
 */
function localWipeLog(prevLog) { // prevLog игнорируется намеренно (сигнатура вызовов)
    void prevLog;
    return {
        version: 0,
        updatedAt: new Date().toISOString(),
        entries: [],
    };
}

/**
 * Монтирует виджет в container.
 * @param {{container: HTMLElement, app: object, bundle: object}} opts
 *   bundle = window.TrainingCore { storage, chartModel, chartview, resources, editor, pipeline? }
 * @returns {{ render: ()=>Promise<void>, refresh: ()=>Promise<void>, destroy: ()=>void }}
 */
function mountEditor(opts) {
    const container = opts.container;
    const app = opts.app;
    const b = opts.bundle;
    const storage = b.storage.makeStorage(app);
    // F-2: vault-писатель правил/графа (bundle не может fs-ом писать файлы проекта)
    const vaultWriter = (b && b.vaultWriter && typeof b.vaultWriter.makeVaultWriter === 'function')
        ? b.vaultWriter.makeVaultWriter(app) : null;
    // F-3: staging-файл (data/training/data.tmp.json) — превью живёт в vault, не в памяти:
    // восстанавливается при ререндере, чистится перед новым прогоном и после Save.
    const staging = (b && b.staging && typeof b.staging.makeStaging === 'function')
        ? b.staging.makeStaging(app) : null;
    // TEMP-СЛОЙ (модель пользователя 2026-09-01): у каждого основного JSON — свой tmp.
    // rulesLog.tmp.json (ключи сессии), graph.tmp.json (граф сессии), ui-state.json (память UI).
    const tmpStore = (b && b.tmpStore && typeof b.tmpStore.makeTmpStore === 'function')
        ? b.tmpStore.makeTmpStore(app) : null;
    const CM = b.chartModel;
    const CV = b.chartview;
    // Граф отрисовки: ЖИВОЙ файл data/graph.json (F-1) — пересобирается на Save,
    // бандл содержит вшитую копию на момент сборки, поэтому читаем с диска каждый рендер.
    const loadGraphFile = (b.loadGraph && typeof b.loadGraph === 'function') ? b.loadGraph : (() => ({ relations: [] }));
    function currentGraph() {
        try { return loadGraphFile() || { relations: [], targets: [] }; }
        catch (_) { return { relations: [], targets: [] }; }
    }

    // ---- транзакционное состояние (staged/committed, AC-R9) -----------------
    let committed = [];          // сохранённые события (data.json), эталон.
    let stagedEvents = [];       // предлагаемый/PREVIEW-набор из data.tmp.json.
    let lastResult = null;       // последний успешный результат pipeline.next (D10: фиксация правил на Save).
    // ПРЕВЬЮ-ГРАФ (2026-08-31): новые ключи entity_metric последнего успешного прогона,
    // ещё НЕ зафиксированные Save-ем. График рендерится по ДИСК-графу ⊕ эти ключи —
    // «📊 Нет данных» для новых сущностей до Save больше не появляется.
    let previewKeys = [];
    let previewTrends = [];
    // Скрытые группы на графике (2026-08-31, запрос пользователя): Set имён групп ('push').
    // Память состояния — в staging-файле (поле hiddenGroups); данные — только UI-фильтр рендера.
    let hiddenGroups = new Set();
    const RR = (b && b.renderRules && typeof b.renderRules.mergeGraph === 'function') ? b.renderRules : null;
    // TEMP-СЛОЙ: temp-граф сессии (кэш; источник — graph.tmp.json через vault, переживает reload)
    let tmpGraphCache = { relations: [], targets: [], trends: [] };
    function previewGraph() {
        // TEMP-СЛОЙ: сбор на лету = main-граф ∪ graph.tmp.json
        let base = currentGraph();
        try {
            if (b.tmpStore && typeof b.tmpStore.mergeGraphs === 'function') {
                base = b.tmpStore.mergeGraphs(base, tmpGraphCache);
            }
        } catch (_) {}
        if (!RR || !previewKeys.length) return base;
        try {
            const graph = RR.mergeGraph(base, previewKeys);
            return { ...graph, trends: [...new Set([...(graph.trends || []), ...previewTrends])] };
        } catch (_) { return base; }
    }

    // ---- DOM ---------------------------------------------------------------
    const root = el('div', {
        style: 'padding:12px; border:1px solid var(--border-color); border-radius:8px; font-family:var(--font-interface);',
    });
    container.appendChild(root);

    const state = {
        chartRefs: [],
        busy: false,
        tmpCleanupReady: true,
        hasTemp: false,
    };

    // Obsidian executes a fresh bundle on every render. Share only activity,
    // never data: the finished operation reloads the new view from Vault.
    const host = typeof window === 'undefined' ? globalThis : window;
    const sessions = host.__trainingEditorSessions || (host.__trainingEditorSessions = new WeakMap());
    let session = sessions.get(app.vault);
    if (!session) {
        session = { busy: false, message: '', views: new Map() };
        sessions.set(app.vault, session);
    }

    function setMsg(node, text, color) {
        node.textContent = text;
        node.style.color = color || 'var(--text-muted)';
    }

    // Поле 1 — сырой ввод (raw input, БЕЗ побочных эффектов) + LLM-пайплайн.
    el('h4', { text: UI_TEXT.title }, root);
    el('div', { text: UI_TEXT.field1Header, style: 'color:var(--text-muted); font-size:12px; letter-spacing:0.4px; margin:8px 0 4px;' }, root);
    el('label', { text: UI_TEXT.tableLabel }, root);
    const tableInput = el('textarea', {
        style: 'width:100%; min-height:120px; margin-top:4px; font-family:var(--font-monospace);',
        placeholder: UI_TEXT.tablePlaceholder,
        rows: 5,
    }, root);

    const runBtn = el('button', {
        text: UI_TEXT.runBtn,
        style: 'margin-top:8px; padding:8px 16px; background:var(--interactive-accent); color:#fff; border:none; border-radius:6px; cursor:pointer;',
    }, root);
    const runMsg = el('div', { style: 'margin-top:8px; white-space:pre-line; color:var(--text-muted);' }, root);

    // Поле 2 — данные (committed ∪ staged JSON), ЧЕРНОВИК.
    el('div', { text: UI_TEXT.field2Header, style: 'color:var(--text-muted); font-size:12px; letter-spacing:0.4px; margin:16px 0 4px;' }, root);
    el('label', { text: UI_TEXT.jsonLabel, style: 'display:block; margin-top:8px;' }, root);
    const textarea = el('textarea', {
        style: 'width:100%; min-height:160px; font-family:var(--font-monospace); margin-top:4px; overflow-y:auto;',
        placeholder: UI_TEXT.jsonPlaceholder,
        rows: 6,
    }, root);
    const tempNotice = el('div', {
        className: 'training-temp-notice',
        style: 'margin-top:8px; padding:8px 12px; color:var(--text-warning, #b7791f); background:rgba(217,119,6,0.1); border-left:3px solid var(--text-warning, #b7791f); border-radius:4px;',
    }, root);
    const saveBtn = el('button', {
        text: UI_TEXT.saveBtn,
        style: 'margin-top:8px; padding:8px 16px; cursor:pointer;',
    }, root);
    const saveMsg = el('div', { style: 'margin-top:8px; color:var(--text-muted);' }, root);
    const cleanupActions = el('div', { style: 'display:flex; flex-wrap:wrap; gap:8px; margin-top:8px;' }, root);
    const wipeBtn = el('button', {
        text: UI_TEXT.wipeBtn,
        style: 'padding:8px 16px; cursor:pointer; color:var(--text-error, #dc2626); background:rgba(220,38,38,0.12); border:1px solid var(--text-error, #dc2626); border-radius:6px;',
    }, cleanupActions);
    const clearTmpBtn = el('button', {
        text: UI_TEXT.clearTmpBtn,
        style: 'padding:8px 16px; cursor:pointer; color:var(--text-warning, #b7791f); background:rgba(217,119,6,0.12); border:1px solid var(--text-warning, #b7791f); border-radius:6px;',
    }, cleanupActions);
    clearTmpBtn.hidden = true;
    clearTmpBtn.style.display = 'none';
    const wipeMsg = el('div', { style: 'margin-top:8px; color:var(--text-muted);' }, root);
    const tempMsg = el('div', { style: 'margin-top:8px; color:var(--text-muted);' }, root);

    // Блок 2.5 — чекбоксы видимости групп графика (память — staging-файл).
    const groupTogglesEl = el('div', { style: 'margin-top:10px; width:100%;' }, root);
    // Блок 3 — график (рисуется по committed ∪ staged).
    const chartEl = el('div', { style: 'margin-top:16px; width:100%;' }, root);
    el('div', { text: UI_TEXT.loading, style: 'color:var(--text-muted);' }, chartEl);

    function updateTempNotice() {
        tempNotice.textContent = state.hasTemp
            ? (state.tmpCleanupReady ? UI_TEXT.tempNotice : '⚠️ Временные файлы требуют проверки. Сохранение заблокировано.')
            : '';
        tempNotice.hidden = !state.hasTemp;
        tempNotice.style.display = state.hasTemp ? '' : 'none';
        clearTmpBtn.hidden = !state.hasTemp;
        clearTmpBtn.style.display = state.hasTemp ? '' : 'none';
    }

    function updateActivity() {
        state.busy = session.busy;
        runBtn.disabled = saveBtn.disabled = wipeBtn.disabled = clearTmpBtn.disabled = session.busy;
        if (session.busy && session.message) setMsg(runMsg, session.message);
    }

    function notifyActivity() {
        for (const [node, view] of session.views) {
            if (node.isConnected === false) session.views.delete(node);
            else view.update();
        }
    }

    function startOperation(message) {
        session.busy = true;
        session.message = message;
        notifyActivity();
    }

    async function finishOperation() {
        const message = /^⏳|^🧹 Очистка/.test(runMsg.textContent) ? '' : runMsg.textContent;
        const color = runMsg.style.color;
        notifyActivity();
        // A view mounted while LLM/Save was running must see the final files,
        // even if the originating DOM has already been removed by Obsidian.
        await Promise.allSettled([...session.views.entries()]
            .filter(([node]) => node !== root)
            .map(async ([, view]) => {
                await view.reload();
                view.status(message, color);
            }));
        session.busy = false;
        session.message = '';
        notifyActivity();
        setMsg(runMsg, message, color);
    }

    session.views.set(root, { update: updateActivity, reload: loadStoredPreview,
        status: (message, color) => setMsg(runMsg, message, color) });
    notifyActivity();

    // ---- логика -------------------------------------------------------------
    function sortedAsc(arr) {
        return [...arr].sort((a, b) => String(a.date).localeCompare(String(b.date)));
    }

    /** Нормализация события (чистка null/undefined значений, prev behavior main.js). НЕ мутирует вход. */
    function normalizeEvent(rec) {
        return {
            date: rec.date,
            values: Object.keys(rec.values || {}).reduce((acc, k) => {
                if (rec.values[k] !== null && rec.values[k] !== undefined) acc[k] = rec.values[k];
                return acc;
            }, {}),
            ...(rec.interpretation_version !== undefined ? { interpretation_version: rec.interpretation_version } : {}),
            ...(rec.createdAt !== undefined ? { createdAt: rec.createdAt } : {}),
        };
    }

    /** Уникальные по дате (AC6: не перезаписывать существующие даты). НЕ мутирует вход.
         *  ПОРЯДОК сохраняется как в текущем массиве (стек: последнее добавленное первым)
         *  — чтобы JSON оставался в порядке добавления, а не пересортировывался по дате. */
        function uniqueByDate(arr) {
            const seen = new Set();
            const out = [];
            for (const e of (arr || [])) {
                if (seen.has(e.date)) continue;
                seen.add(e.date);
                out.push(e);
            }
            return out;
        }

    /**
         * Отображаемый набор: committed ∪ staged, от последней даты к первой. staged не
         * перезаписывает существующие даты committed (AC6). По нему поле 2 и график.
         */
        function currentEvents() {
            const merged = [];
            const seen = new Set();
            // Committed dates always win, including restored legacy temp files.
            for (const e of committed) {
                if (seen.has(e.date)) continue;
                seen.add(e.date);
                merged.push(e);
            }
            for (const e of stagedEvents) {
                if (seen.has(e.date)) continue; // AC6
                seen.add(e.date);
                merged.push(e);
            }
            return sortedAsc(merged).reverse();
        }

    /** Компактный контекст последних записей для LLM-пайплайна ({{CONTEXT}}). */
    function buildContext(events) {
        const last = (events || []).slice(-5);
        return last.map((e) => `${e.date}: ${JSON.stringify(e.values)}`).join('\n');
    }

    function refreshChart() {
        updateTempNotice();
        // Раздельная раскладка по упражнениям (part_of-группам) из ЖИВОГО графа (F-1), AC11.
        // График по committed ∪ staged (preview). События не мутируются (INV-4).
        const allGroups = CM.toChartConfigs(currentEvents(), previewGraph());
        const groups = hiddenGroups.size
            ? allGroups.filter((g) => {
                  const m = /^🏋️ ([A-Za-zА-Яа-яЁё]+)/.exec(g.title || '');
                  return !m || !hiddenGroups.has(m[1].toLowerCase());
              })
            : allGroups;
        renderGroupToggles(allGroups);
        state.chartRefs = CV.renderChartGrouped(chartEl, groups);
    }

    /** Чекбоксы видимости групп (перерисовываются при каждом refreshChart). */
    function renderGroupToggles(allGroups) {
        if (!groupTogglesEl) return;
        groupTogglesEl.innerHTML = '';
        if (!allGroups.length) return;
        for (const g of allGroups) {
            const m = /^🏋️ ([A-Za-zА-Яа-яЁё]+)/.exec(g.title || '');
            if (!m) continue;
            const name = m[1];
            const low = name.toLowerCase();
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = !hiddenGroups.has(low);
            cb.style.verticalAlign = 'middle';
            cb.addEventListener('change', () => {
                if (cb.checked) hiddenGroups.delete(low); else hiddenGroups.add(low);
                persistGroupState();
                refreshChart();
            });
            const lb = document.createElement('label');
            lb.style.cssText = 'margin-right:14px; font-size:12px; cursor:pointer; color:var(--text-normal);';
            lb.appendChild(cb);
            lb.appendChild(document.createTextNode(' ' + name));
            groupTogglesEl.appendChild(lb);
        }
    }

    /** Память состояния скрытых групп — в staging-файле (не данные, не правила). */
    function persistGroupState() {
        if (!staging || typeof staging.writeState !== 'function') return;
        try { staging.writeState({ hiddenGroups: [...hiddenGroups] }); } catch (_) {}
    }
    async function restoreGroupState() {
        if (!staging || typeof staging.readState !== 'function') return;
        try {
            const st = await staging.readState();
            if (st && Array.isArray(st.hiddenGroups)) hiddenGroups = new Set(st.hiddenGroups.map(String));
        } catch (_) {}
    }

    function refreshEditor() {
            // Canvas: от последней даты к первой, включая восстановленный temp.
            textarea.value = JSON.stringify(currentEvents(), null, 2);
        refreshChart();
    }

    async function readTempPreview() {
        const events = staging && typeof staging.read === 'function' ? await staging.read({ strict: true }) : stagedEvents;
        const rules = tmpStore ? await tmpStore.readRulesTmp({ strict: true }) : { rules: [], newKeys: [] };
        const graph = tmpStore ? await tmpStore.readGraphTmp({ strict: true }) : { relations: [] };
        const savedDates = new Set(committed.map((event) => event.date));
        stagedEvents = events.filter((event) => !savedDates.has(event.date));
        tmpGraphCache = graph;
        previewKeys = [...new Set([
            ...rules.newKeys.map((item) => item.key),
            ...rules.rules.flatMap((rule) => Object.keys(rule.mapping || {})),
            ...events.flatMap((event) => Object.keys(event.values || {})),
        ])];
        previewTrends = [...new Set([
            ...rules.newKeys.filter((item) => item.role === 'overlay' || item.role === 'trend').map((item) => item.key),
            ...rules.rules.flatMap((rule) => Object.entries(rule.roles || {})
                .filter(([, role]) => role === 'overlay' || role === 'trend').map(([key]) => key)),
        ])];
        state.hasTemp = !!(events.length || rules.rules.length || rules.newKeys.length || graph.relations.length);
        state.tmpCleanupReady = true;
    }

    async function loadStoredPreview() {
        if (vaultWriter) {
            const log = await vaultWriter.readRulesLog();
            if (log && b.rulesLog && b.rulesLog.setCachedLog) b.rulesLog.setCachedLog(log);
            const graph = await vaultWriter.readGraph();
            if (graph && b.loadGraph && b.loadGraph.setLatestGraph) b.loadGraph.setLatestGraph(graph);
        }
        committed = await storage.loadData();
        lastResult = null;
        try {
            await readTempPreview();
            setMsg(tempMsg, '');
        } catch (error) {
            state.tmpCleanupReady = false;
            state.hasTemp = true;
            setMsg(tempMsg, '❌ Не удалось восстановить временные файлы: ' + error.message, 'red');
        }
        hiddenGroups = new Set();
        await restoreGroupState();
        refreshEditor();
        updateActivity();
        return state;
    }

    async function clearTempFiles() {
        if (staging) await staging.clear();
        if (tmpStore) {
            await tmpStore.clearRulesTmp();
            await tmpStore.clearGraphTmp();
        }
        stagedEvents = [];
        lastResult = null;
        previewKeys = [];
        previewTrends = [];
        tmpGraphCache = { relations: [] };
        state.hasTemp = false;
        state.tmpCleanupReady = true;
        refreshEditor();
    }

    async function handleClearTemp() {
        if (session.busy) return;
        startOperation('🧹 Очистка временных файлов…');
        try {
            await clearTempFiles();
            setMsg(tempMsg, '🧹 Временные данные, граф и правила очищены.', 'green');
            setMsg(runMsg, '');
        } catch (error) {
            await loadStoredPreview();
            state.tmpCleanupReady = false;
            updateTempNotice();
            setMsg(tempMsg, '❌ Ошибка очистки временных файлов: ' + error.message, 'red');
        } finally {
            await finishOperation();
        }
    }

    /**
         * Стаджит результат pipeline (branch 1/2) в stagedEvents с защитой committed дат (AC6).
         * Используется и построчно (handleInterpret), и для блока-таблицы недели (D9).
         */
        function commitStagedResult(res) {
            if (!res || res.status !== 'success' || !res.payload) return 0;
            const events = Array.isArray(res.payload.events) && res.payload.events.length
                ? res.payload.events
                : (Array.isArray(res.payload.exampleEvents) ? res.payload.exampleEvents : []);
            // AC6: не перезаписывать существующие даты ни в committed, ни в уже застейдженных.
            // Set строится локально (committedDates не существует в этом скоупе — его было ссылаться нельзя).
            const usedDates = new Set(
                committed.map((e) => e.date).concat(stagedEvents.map((e) => e.date))
            );
            let added = 0;
            for (const evt of events) {
                if (usedDates.has(evt.date)) continue; // AC6
                usedDates.add(evt.date);
                stagedEvents.unshift(evt);
                added++;
            }
            return added;
        }

    async function handleInterpret() {
            if (session.busy) return;
            startOperation('⏳ Обработка через LLM-пайплайн…');
            try {
            setMsg(runMsg, '⏳ Обработка через LLM-пайплайн…');
            // F-3: staging-файл — чистим ПЕРЕД каждым прогоном (прошлое превью не смешивается
            // с новым: «данные из превью читались вместо реального json» — не повторится).
            // Канва «Очистка .tmp» (узел b9739c0e46fc855a): повторное «Обработать» —
            // цикл заново, temp-слой прошлого (неудовлетворённого) прогона очищается
            // ДО Router: словарь LLM = только main, tmp-ключи прошлой сессии не подмешиваются.
                try {
                    await clearTempFiles();
                } catch (eT) {
                    await loadStoredPreview();
                    state.tmpCleanupReady = false;
                    updateTempNotice();
                    setMsg(runMsg, '❌ Не удалось очистить временные предложения: ' + ((eT && eT.message) || eT), 'red');
                    return;
                }

            if (!b.pipeline || typeof b.pipeline.next !== 'function') {
                setMsg(runMsg, '❌ LLM-пайплайн (pipeline.next) недоступен в бандле. Пересоберите bundle с core/pipeline.js (P-P).', 'red');
                return;
            }

            // Живой статус этапов: показываем, КАКУЮ стадию обработки сейчас выполняет пайплайн
            // (просмотр данных / перевод в события / формирование правила) вместо смутного «обрабатывается».
            const stageText = (b.pipeline && b.pipeline.STAGE_TEXT) || {};
            const onStage = (key) => {
                session.message = '⏳ ' + (stageText[key] || 'Обработка…');
                notifyActivity();
            };

            const rawInput = String(tableInput.value || '');
            if (!rawInput.trim()) {
                setMsg(runMsg, '⚠️ Вставьте данные!', 'red');
                return;
            }

            // TEMP-СЛОЙ: словарь для LLM = main ∪ rulesLog.tmp.json (сбор на лету).
            if (tmpStore && b.rulesLog && typeof b.rulesLog.setCachedLog === 'function') {
                try {
                    const mainLog = await (vaultWriter && vaultWriter.readRulesLog ? vaultWriter.readRulesLog() : null);
                    if (mainLog) b.rulesLog.setCachedLog(mainLog);
                    const tmp = await tmpStore.readRulesTmp();
                    if (b.tmpStore && typeof b.tmpStore.mergeRuleSnapshots === 'function' && tmp.newKeys.length) {
                        const merged = b.tmpStore.mergeRuleSnapshots(b.rulesLog.getLatestRules(), tmp.newKeys);
                        b.rulesLog.setCachedLog({ version: mainLog ? mainLog.version : 0, updatedAt: new Date().toISOString(), entries: [{ version: mainLog ? mainLog.version : 0, timestamp: new Date().toISOString(), rulesSnapshot: merged, changeType: 'tmp-merge', meta: {} }] });
                    }
                } catch (eT) { console.debug('[training-diag] tmp merge failed:', eT && eT.message); }
            }
            // НИКАКОГО детерминированного парсинга в начале (запрет заказчика).
            // Весь ввод (таблица недели |*08-24*<br>...|, многострочный блок с *MM-DD*, малые порции)
            // отдаётся ЛЛМ КАК ЕСТЬ одним вызовом pipeline.next. LLM сама разбирает даты и упражнения
            // (REQ-1/D9); детерминизм — только структурный валидатор контракта в structured.js.
                        // Источник истины для контекста/базы — ТОЛЬКО файл (committed на диске),
                        // перечитываемый КАЖДЫЙ прогон (цитата пользователя 2026-08-30: «данные из
                        // превью читались вместо данных из реального json, который… должен был быть
                        // пуст»). Память виджета и staged НЕ являются источником: если пользователь
                        // стёр данные в поле 2 и сохранил (или файл пуст) — контекст реально пуст.
                        const fileEvents = await storage.loadData();
                        committed = Array.isArray(fileEvents) ? fileEvents : [];
                        const source = committed;
                        const context = buildContext(source);
                        const lastMetric = lastContextOf(source);
                        const res = await b.pipeline.next(rawInput, {
                            context,
                            lastContext: lastMetric,
                            baseEvents: source,
                            onStage,
                            tmpStore,
                        });
            const stagedAdded = commitStagedResult(res);
            // F-3: превью persists в staging-файл (переживает ререндер заметки)
            if (staging) await staging.write(stagedEvents);
            await refreshEditor();
                        if (res.status === 'error') {
                            setMsg(runMsg, 'Ошибка: ' + ((res && res.message) || 'не удалось обработать'), 'red');
                        } else {
                            // D10: запоминаем последний успешный прогон — правила/сущности
                            // из него фиксируются при «💾 Сохранить данные» (commitRules).
                            lastResult = res;
                            // ПРЕВЬЮ-ГРАФ: новые ключи прогона сразу попадают в график (без Save).
                            previewKeys = (res.payload && Array.isArray(res.payload.newKeys))
                                ? res.payload.newKeys.map((nk) => (nk && nk.key) || '').filter(Boolean)
                                : [];
                            // Branch 3 proposals must be staged through Vault in the
                            // browser: the pipeline's Node FS shim cannot persist here.
                            // Keep any rules/newKeys already staged by earlier steps.
                            if (tmpStore && res.payload) {
                                const proposedRules = (Array.isArray(res.payload.rules) && res.payload.rules.length)
                                    ? res.payload.rules
                                    : (res.payload.proposal && Array.isArray(res.payload.proposal.rules)
                                        ? res.payload.proposal.rules
                                        : (res.payload.proposal && res.payload.proposal.rule
                                            ? [res.payload.proposal.rule]
                                            : []));
                                if (proposedRules.length && typeof tmpStore.appendProposedRules === 'function') {
                                    try { await tmpStore.appendProposedRules(proposedRules); }
                                    catch (eT) { throw new Error('Не удалось записать временные правила: ' + eT.message); }
                                }
                            }
                            if (tmpStore && res.payload && Array.isArray(res.payload.appends)
                                && res.payload.appends.length) {
                                await tmpStore.appendMinorMapping(res.payload.appends);
                            }
                            // TEMP-СЛОЙ: ключи прогона → rulesLog.tmp.json (переживают reload;
                            // Save приплюсует их в main и очистит tmp).
                            if (tmpStore && res.payload && Array.isArray(res.payload.newKeys) && res.payload.newKeys.length) {
                                try {
                                    await tmpStore.appendRulesTmp(res.payload.newKeys);
                                } catch (eT) { throw new Error('Не удалось записать временные ключи: ' + eT.message); }
                            }
                            // TEMP-СЛОЙ (канва STAGED): график = main ∪ graph.tmp.json — сразу после
                            // «Обработать», а не после перемонтирования виджета. Связи Branch 3
                            // (payload.relations) дописываем в graph.tmp.json и здесь (в node это
                            // уже сделал pipeline fs-ом — mergeGraphs дедуплирует, идемпотентно);
                            // затем поднимаем свежий tmp-граф в кэш превью.
                            if (tmpStore) {
                                try {
                                    if (Array.isArray(res.payload.relations) && res.payload.relations.length
                                        && RR && typeof RR.relationsFromLLM === 'function'
                                        && b.tmpStore && typeof b.tmpStore.mergeGraphs === 'function') {
                                        const graphRels = RR.relationsFromLLM(res.payload.relations);
                                        if (graphRels.length) {
                                            const curTmp = await tmpStore.readGraphTmp();
                                            await tmpStore.writeGraphTmp(b.tmpStore.mergeGraphs(curTmp, { relations: graphRels }));
                                        }
                                    }
                                    tmpGraphCache = await tmpStore.readGraphTmp();
                                } catch (eT) { throw new Error('Не удалось записать временный граф: ' + eT.message); }
                            }
                            // Render only after the staged graph cache is fresh. Otherwise
                            // this preview uses the previous graph and no later refresh
                            // applies the newly staged relations to the chart.
                            await readTempPreview();
                            refreshEditor();
                            // Частичный цикл (TC001): статус не только зелёный «N событий» —
                            // при failedDays явно сообщаем о частичном результате с датами.
                            const runFailed = (res.payload && Array.isArray(res.payload.failedDays)) ? res.payload.failedDays : [];
                            if (runFailed.length) {
                                setMsg(runMsg,
                                    '⚠️ Частичный результат: '
                                    + stagedAdded + (stagedAdded === 1 ? ' событие' : ' событий')
                                    + ' добавлено в превью; не удалось обработать: ' + failedDaysText(runFailed),
                                    'var(--text-warning)');
                            } else if (stagedAdded > 0) {
                                setMsg(runMsg, stagedAdded + (stagedAdded === 1 ? ' событие' : ' событий') + ' добавлено в превью', 'green');
                            } else {
                                setMsg(runMsg, 'Ничего не добавлено: такие даты уже сохранены или результат пуст');
                            }
                        }
                        const resultPayload = res.payload || {};
                        const failures = resultPayload.failedDays || res.failedDays || [];
                        const messages = [];
                        if (failures.length) messages.push('Не удалось обработать: ' + failedDaysText(failures));
                        for (const warning of resultPayload.warnings || []) messages.push('⚠️ ' + String(warning));
                        if (res.status !== 'error' && resultPayload.proposal) {
                            messages.push('Предложенные правила будут сохранены вместе с данными по кнопке «Сохранить данные».');
                        }
                        if (messages.length) setMsg(runMsg, runMsg.textContent + '\n' + messages.join('\n'),
                            failures.length || (resultPayload.warnings || []).length ? 'var(--text-warning)' : runMsg.style.color);
                        return;
        } catch (e) {
            try { await readTempPreview(); } catch (_) {}
            state.tmpCleanupReady = false;
            refreshEditor();
            setMsg(runMsg, '❌ Ошибка пайплайна: ' + ((e && e.message) || e), 'red');
            return;
        } finally {
            await finishOperation();
        }
    }

async function handleSave() {
        if (session.busy) return;
        startOperation('⏳ Сохранение данных…');
        let originalRulesLog = null;
        try {
            if (!state.tmpCleanupReady) {
                setMsg(saveMsg, '❌ Сохранение заблокировано: временные данные не готовы. Повторите обработку или перезапустите виджет.', 'red');
                return;
            }
            const parsed = JSON.parse(textarea.value);
            if (!Array.isArray(parsed)) throw new Error('Данные должны быть массивом');
            const normalized = parsed.map(normalizeEvent);
            const cleaned = uniqueByDate(normalized); // AC6 + сортировка

            // D10/F-2: вычисляем предложения правил/графа и передаём все main-файлы
            // одному storage-транзакционному Save. При отказе любого Vault-write все
            // ранее изменённые main JSON восстанавливаются, а temp остаётся для повтора.
            let saveNotice = '';
            const additionalWrites = [];
            let committedGraph = null;
            let committedRulesLog = null;
            // Read live Vault graph state for this Save. In the browser, pipeline fs
            // reads may see only bundle-time snapshots; Vault is the source of truth.
            const mainGraphForSave = vaultWriter ? await vaultWriter.readGraph({ strict: true }) : null;
            const graphTmpForSave = tmpStore ? await tmpStore.readGraphTmp({ strict: true }) : null;
            // TEMP-СЛОЙ: Save = tmp → main. Собираем ВСЕ новые ключи сессии из rulesLog.tmp.json
            // (не только последний прогон — правит «ранние прогоны терялись») и отдаём commitRules.
            let saveResult = lastResult;
            if (tmpStore) {
                const tmp = await tmpStore.readRulesTmp({ strict: true });
                const base = (saveResult && saveResult.payload) || { events: stagedEvents };
                const lastKeys = new Set((base.newKeys || []).map((nk) => nk.key));
                const minorAppends = (tmp.newKeys || []).filter((nk) => nk.source === 'minorRuleUpdate');
                const extra = (tmp.newKeys || []).filter((nk) => nk.source !== 'minorRuleUpdate' && !lastKeys.has(nk.key));
                // Full rules carry semantics/examples; preserve the pipeline's update metadata.
                const proposal = base.proposal || (tmp.rules.length ? {
                    rule: tmp.rules[0], rules: tmp.rules,
                } : null);
                if (extra.length || minorAppends.length || proposal) {
                    saveResult = {
                        ...(saveResult || { status: 'success', branch: 1 }),
                        payload: { ...base, newKeys: [...(base.newKeys || []), ...extra],
                            appends: [...(base.appends || []), ...minorAppends],
                            ...(proposal ? { proposal } : {}) },
                    };
                }
            }
            if (saveResult) {
                if (!b.pipeline || typeof b.pipeline.commitRules !== 'function') {
                    throw new Error('Невозможно сохранить: pipeline.commitRules недоступен');
                }
                originalRulesLog = (b.rulesLog && typeof b.rulesLog.getRulesLog === 'function')
                    ? JSON.parse(JSON.stringify(b.rulesLog.getRulesLog())) : null;
                committedRulesLog = vaultWriter && await vaultWriter.readRulesLog();
                if (!committedRulesLog) throw new Error('Не удалось прочитать сохранённый журнал правил через Vault');
                const cr = await b.pipeline.commitRules(saveResult, {
                    committedLog: committedRulesLog,
                    committedGraph: mainGraphForSave,
                    graphTmp: graphTmpForSave,
                });
                if (!cr || cr.status === 'error') {
                    throw new Error('Правила не подготовлены к сохранению: ' + ((cr && cr.message) || 'ошибка commitRules'));
                }
                if (cr.status === 'success') {
                    if (cr.added > 0) {
                        if (!vaultWriter || !cr.payload) throw new Error('Невозможно сохранить правила/граф через Vault');
                        if (cr.payload.log) additionalWrites.push({ path: vaultWriter.FILES.rulesLog, data: cr.payload.log });
                        if (!cr.payload.log) throw new Error('commitRules не вернул журнал правил для сохранения');
                        saveNotice = ' (правила сохранены вместе с данными)';
                    }
                }
                // Some implementations return a graph with noop (e.g. a prepared
                // graph without a new rule). Preserve it independently of status/add count.
                if (cr.payload && cr.payload.graph) committedGraph = cr.payload.graph;
            }

            // graph.tmp.json is an independent Save payload: merge it even when
            // this run added no rule (or there is no tmp adapter in this bundle).
            let graphForSave = committedGraph || mainGraphForSave || { relations: [], targets: [], trends: [] };
            if (graphTmpForSave) {
                const mergeGraphs = b.tmpStore && typeof b.tmpStore.mergeGraphs === 'function'
                    ? b.tmpStore.mergeGraphs : ((main, temp) => {
                        const relations = [...(main.relations || [])];
                        const seen = new Set(relations.map((relation) => JSON.stringify(relation)));
                        for (const relation of temp.relations || []) {
                            const signature = JSON.stringify(relation);
                            if (!seen.has(signature)) { relations.push(relation); seen.add(signature); }
                        }
                        return { relations };
                    });
                graphForSave = mergeGraphs(graphForSave, graphTmpForSave);
            }
            // The persisted graph contract is intentionally only { relations }.
            // targets/trends are derived at render time and must not leak into JSON.
            const persistedGraph = { relations: Array.isArray(graphForSave.relations) ? graphForSave.relations : [] };
            const mainPersistedGraph = { relations: Array.isArray(mainGraphForSave && mainGraphForSave.relations)
                ? mainGraphForSave.relations : [] };
            const hasTempRelations = !!(graphTmpForSave && Array.isArray(graphTmpForSave.relations)
                && graphTmpForSave.relations.length);
            const graphChanged = JSON.stringify(persistedGraph) !== JSON.stringify(mainPersistedGraph);
            if (vaultWriter && (committedGraph || hasTempRelations || graphChanged) && graphChanged) {
                committedGraph = persistedGraph;
                const existingGraphWrite = additionalWrites.find((item) => item.path === vaultWriter.FILES.graph);
                if (existingGraphWrite) existingGraphWrite.data = persistedGraph;
                else additionalWrites.push({ path: vaultWriter.FILES.graph, data: persistedGraph });
            }

            try {
                await storage.saveData(cleaned, { additionalWrites });
            } catch (e) {
                if (originalRulesLog && b.rulesLog && typeof b.rulesLog.setCachedLog === 'function') {
                    b.rulesLog.setCachedLog(originalRulesLog);
                }
                throw e;
            }
            if (b.rulesLog && typeof b.rulesLog.setCachedLog === 'function') {
                const writtenRules = additionalWrites.find((item) => item.path === vaultWriter.FILES.rulesLog);
                if (writtenRules) b.rulesLog.setCachedLog(writtenRules.data);
                else if (committedRulesLog) b.rulesLog.setCachedLog(committedRulesLog);
            }
            if (committedGraph && b.loadGraph && typeof b.loadGraph.setLatestGraph === 'function') {
                try { b.loadGraph.setLatestGraph(committedGraph); } catch (_) {}
            }

            committed = cleaned;
            stagedEvents = [];
            lastResult = null; // прогон зафиксирован — сбрасываем
            previewKeys = []; // граф теперь берётся с диска (vaultWriter обновил graph.json)
            previewTrends = [];
            // Temp удаляем ТОЛЬКО после успешной транзакции main-файлов.
            try {
                await clearTempFiles();
            } catch (error) {
                try { await readTempPreview(); } catch (_) {}
                state.tmpCleanupReady = false;
                saveNotice += ' ⚠️ Main сохранён, но temp не очищен: ' + error.message;
            }
            await refreshEditor();
            const savedPaths = [storage.DATA_PATH, ...additionalWrites.map((item) => item.path)].filter(Boolean);
            setMsg(saveMsg, '💾 Сохранено: ' + savedPaths.join(', ') + saveNotice, saveNotice.includes('⚠️') ? 'var(--text-warning)' : 'green');
        } catch (e) {
            if (originalRulesLog && b.rulesLog && typeof b.rulesLog.setCachedLog === 'function') {
                b.rulesLog.setCachedLog(originalRulesLog);
            }
            setMsg(saveMsg, '❌ Ошибка: ' + ((e && e.message) || e), 'red');
        } finally {
            await finishOperation();
        }
    }

    /**
     * Полный сброс памяти: ФАКТИЧЕСКИЙ вайп — rulesLog.json ПЕРЕЗАПИСЫВАЕТСЯ ЛИТЕРАЛЬНО
     * ПУСТЫМ ({ version: 0, updatedAt, entries: [] } — ни истории правил, ни записи о сбросе),
     * граф → пустой, committed-данные → [] (бэкап автоматом), staged → [].
     * Обоснование — цитата заказчика (docs/user/quotes.md, 2026-09-01; документация уровня 1):
     * «полный сброс будет сбрасывать правила, графы, словари и данные, то есть переводить
     * состояние системы в состояние, как будто в системе не было ничего записано».
     * Раньше здесь дописывалась revert-запись (append-only), затем — одна запись changeType
     * 'wipe': и то и другое оставляло в файле след сброса, т.е. сброс не был фактическим
     * (дефект, зафиксирован 2026-09-01; заказчик: «есть запись в рулс логе о сбросе —
     * её не должно там быть»).
     * UI-состояние (скрытые группы) ТОЖЕ сбрасывается (иначе после wipe на графике остаются
     * зомби-тоглы). Всё через vault API — как Save.
     */
    async function handleWipe() {
        if (session.busy) return;
        if (!window.confirm('Очистить ВСЮ память: словарь правил, граф отрисовки и сохранённые данные? Действие необратимо (останется только резервная копия данных).')) return;
        startOperation('🧹 Очистка памяти…');
        try {
            wipeBtn.disabled = true;
            setMsg(wipeMsg, '🧹 Очистка…', 'var(--text-muted)');
            // 1. rulesLog: ПЕРЕЗАПИСЬ в ЛИТЕРАЛЬНО ПУСТОЙ журнал вместо прежней истории:
            //    { version: 0, updatedAt, entries: [] } — «как будто в системе не было ничего
            //    записано» (запрос заказчика 2026-09-01; запись о самом сбросе в журнале
            //    оставлять нельзя). version: 0 — исключение из INV-5 только для пользовательского
            //    сброса, следующий Save даст version 1 (0+1) в новом чистом отсчёте.
            //    entries: [] безопасен: getLatestRules() на пустом списке откатывается на
            //    DEFAULT_RULES (core/rules.js), а тот сам пуст — правила не «воскресают».
            let freshLog = null;
            let curLog = null;
            try { curLog = JSON.parse(JSON.stringify(b.rulesLog.getRulesLog())); } catch (_) { curLog = null; }
            if (b.rulesLog && typeof b.rulesLog.buildWipeLog === 'function') {
                freshLog = b.rulesLog.buildWipeLog(curLog);
            } else if (b.rulesLog && typeof b.rulesLog.getRulesLog === 'function') {
                // Fallback: bundle без buildWipeLog — та же форма лога локально (НЕ revert-append).
                freshLog = localWipeLog(curLog);
            }
            // 2. data.json → [] (storage.saveData делает timestamped-бэкап автоматически)
            await storage.saveData([]);
            // 3. граф → пустой + rulesLog (вайп) через vaultWriter. В node-режиме (тесты)
            //    vaultWriter нет — файлы там пишет вызывающий через rulesLog._setLogPath.
            const emptyGraph = { relations: [], targets: [], trends: [] };
            if (vaultWriter) {
                if (freshLog) await vaultWriter.writeRulesLog(freshLog);
                await vaultWriter.writeGraph(emptyGraph);
            }
            // 3b. РАНТАЙМ-КЭШ ПРАВИЛ — обязательная синхронизация с только что записанным логом
            //     (и в браузере, и в node). Без этого кэш остаётся до-сбросным: formatRecentRules
            //     (Infinity) отдаёт старые правила, а pipeline.commitRules берёт базу из кэша и
            //     перезаписывает файл до-сбросным состоянием. _resetCache() здесь НЕЛЬЗЯ: в браузере
            //     fs.readFileSync идёт через шим бандла и вернёт ВШИТУЮ на сборке копию лога.
            if (freshLog && b.rulesLog && typeof b.rulesLog.setCachedLog === 'function') {
                b.rulesLog.setCachedLog(freshLog);
            }
            // 4. runtime-кэши: сброс графа
            if (b.loadGraph && typeof b.loadGraph.setLatestGraph === 'function') {
                try { b.loadGraph.setLatestGraph(emptyGraph); } catch (_) {}
            }
            // 5. состояние виджета
            committed = [];
            stagedEvents = [];
            lastResult = null;
            previewKeys = [];
            previewTrends = [];
            // 5c. TEMP-СЛОЙ: тот же явный reset всех трёх файлов.
            await clearTempFiles();
            // 6. staged-файл: события стереть, скрытые группы сбросить (расхождение №6):
            //    staging.clear() сохраняет state — иначе после wipe остаются зомби-тоглы.
            //    Поэтому после clear() перезаписываем state пустым hiddenGroups
            //    (clear() для обычного Save-пути НЕ меняем — он state сохраняет намеренно).
            if (staging) {
                if (typeof staging.writeState === 'function') {
                    await staging.writeState({ hiddenGroups: [] });
                }
            }
            // 7. runtime: сброс скрытых групп — чекбоксы перерисуются в refreshEditor() ниже.
            try { hiddenGroups.clear(); } catch (_) {}
            state.hasTemp = false;
            await refreshEditor();
            setMsg(wipeMsg, '🧹 Память очищена: словарь, граф и данные сброшены. Резервная копия данных — в data/training/backups/', 'green');
        } catch (e) {
            try { await loadStoredPreview(); } catch (_) {}
            setMsg(wipeMsg, '❌ Ошибка очистки: ' + ((e && e.message) || e), 'red');
        } finally {
            await finishOperation();
        }
    }

    wipeBtn.addEventListener('click', handleWipe);
    runBtn.addEventListener('click', handleInterpret);
    saveBtn.addEventListener('click', handleSave);
    clearTmpBtn.addEventListener('click', handleClearTemp);

    // ---- публичный контроллер -------------------------------------------------
    return {
        render: loadStoredPreview,
        refresh: async () => session.busy ? refreshEditor() : loadStoredPreview(),
        destroy: () => {
            session.views.delete(root);
            root.remove();
        },
    };
}

module.exports = { mountEditor, lastContextOf, UI_TEXT, failedDaysText };
