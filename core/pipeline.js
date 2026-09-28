'use strict';
// core/pipeline.js — P-P Orchestrator (новая архитектура 2026-09-04, канва).
//
// Трубопровод (канва: узел «Цикл обработки данных» id 2f9dc7e4b8cc77ba):
//   raw input → CUTTER (LLM: нарезка на дни, простая задача)
//     → ЦИКЛ по дням (в порядке следования в вводе):
//         каждый день отдельно → Router (LLM, 1 день на вход) → группа дня:
//           Группа 1 → Branch 1: structured.js — перевод в события по правилам.
//           Группа 2 → Branch 2: minorRuleUpdate — аппенд «ключ → пример» в
//                      rulesLog.tmp.json + оверлей в кэше → повторный structured.
//           Группа 3 → Branch 3: conflict.js — новое правило; oldChunks →
//                      structured, relations → graph.tmp.json.
//   Сквозная оценка возникает САМА из цикла: правила, созданные предыдущими
//   днями этого же прогона (Branch 2/3), живут в tmp-кэше (rulesLog.setCachedLog,
//   оверлей НЕ откатывается между днями — это temp-слой, на Save мержится в main),
//   поэтому следующий день видит их в {{RULES}}. rulesLog.json НЕ пишется —
//   только tmp-файлы и кэш (INV-2/3).
//
// Контракт: экспортирует объект pipeline c методами next(input, opts), confirm(proposal, opts),
// commitRules(result, opts). next() НЕ пишет на диск (только tmp-файлы/кэш); единственная
// запись main-файлов — confirm()/commitRules() (Rule Evolution, транзакционно на Save).
//
// Инварианты:
//   • Чистый CommonJS: нет dv/app/DOM, работает под node --test.
//   • LLM — НЕ источник истины (AC10): события льются из structured (верифицированы),
//     пример-паттерн — из conflict. P-P ничего не «додумывает».
//   • Инжектируемый LLM — через opts.llmOptions.fetch (unit-тесты без реальной сети).
//   • Ошибка восстанавливаемой ветки одного дня идёт в warnings; ошибка контракта
//     Cutter/Router прекращает прогон, чтобы не отдавать неполное превью.

const { confirmProposal, proposeRule, buildExample } = require('./conflict.js');
const { isEvent, makeEvent } = require('./events.js');
const { callLLM } = require('./llmGateway.js');
const { route } = require('./router.js');
const { cut } = require('./cutter.js');
const rulesLog = require('./rulesLog.js');
const structured = require('./structured.js');
const trace = require('./trace.js');
const tmpStore = require('../adapters/tmpStore.js');

// ---------------------------------------------------------------------------
// Стадии обработки пайплайна (для живого статуса LX-фидбека).
// ---------------------------------------------------------------------------
const STAGES = Object.freeze({
    CUTTER: 'cutter',
    ROUTER: 'router',
    MINOR: 'minor',
    STRUCTURED: 'structured',
    CONFLICT: 'conflict',
});

const STAGE_TEXT = Object.freeze({
    [STAGES.CUTTER]: 'Разбираем ввод на дни…',
    [STAGES.ROUTER]: 'Просматриваем данные и определяем тип обработки…',
    [STAGES.MINOR]: 'Уточняем формулировки правил…',
    [STAGES.STRUCTURED]: 'Переводим данные в события (существующие и новые сущности)…',
    [STAGES.CONFLICT]: 'Формируем новое правило отрисовки…',
});

/** Возвращает текстовую подпись стадии (или заданный запасной текст). */
function stageTextOf(key, fallback = 'Обработка…') {
    return STAGE_TEXT[key] || fallback;
}

// ---------------------------------------------------------------------------
// Вспомогательные помощники
// ---------------------------------------------------------------------------

/** Зажимает уверенность в [0,1]; нечисло → 0. */
function normalizeConfidence(v) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return 0;
    return Math.min(1, Math.max(0, v));
}

/** Accept only an explicit LLM source span that occurs verbatim in the input. */
function groundedSourceSpan(item, sourceText) {
    const span = item && typeof item.sourceSpan === 'string' ? item.sourceSpan : '';
    if (!span.trim() || typeof sourceText !== 'string' || !sourceText.includes(span)
        || span.trim() === sourceText.trim()) return null;
    return span;
}

function examplesFromGroundedKeys(keys, sourceText) {
    const byInput = new Map();
    for (const item of keys || []) {
        const input = groundedSourceSpan(item, sourceText);
        if (!input) continue;
        if (!byInput.has(input)) byInput.set(input, { input, values: {} });
        if (item.values && typeof item.values === 'object') Object.assign(byInput.get(input).values, item.values);
    }
    return [...byInput.values()];
}

/** Объединяет события одного дня из Branch 1/2 и примера Branch 3. */
function mergePreviewEvents(inputEvents) {
    const byDate = new Map();
    const conflicts = [];
    for (const evt of inputEvents || []) {
        if (!isEvent(evt)) continue;
        const current = byDate.get(evt.date);
        if (!current) {
            byDate.set(evt.date, { ...evt, values: { ...evt.values } });
            continue;
        }
        for (const [key, value] of Object.entries(evt.values || {})) {
            if (Object.prototype.hasOwnProperty.call(current.values, key)
                && !Object.is(current.values[key], value)) {
                conflicts.push({ date: evt.date, key, values: [current.values[key], value] });
                continue;
            }
            current.values[key] = value;
        }
    }
    return {
        events: [...byDate.values()].map((evt) => Object.freeze({
            ...evt,
            values: Object.freeze({ ...evt.values }),
        })),
        conflicts,
    };
}

/** Пример Branch 3 получает дату именно текущего дня, если Cutter её распознал. */
function dateForDay(dayDate, fallbackDate) {
    if (typeof dayDate !== 'string' || !/^\d{2}-\d{2}$/.test(dayDate)) return fallbackDate;
    const year = typeof fallbackDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(fallbackDate)
        ? fallbackDate.slice(0, 4)
        : String(new Date().getFullYear());
    return `${year}-${dayDate}`;
}

/** Вкладывает minor-примеры в предлагаемые правила перед явным Save. */
function mergeMinorExamplesIntoRules(rules, appends, events, relations = []) {
    const out = (rules || []).map((rule) => ({
        ...rule,
        mapping: { ...(rule.mapping || {}) },
        examples: (rule.examples || []).map((ex) => ({ ...ex, values: { ...(ex.values || {}) } })),
    }));
    for (const append of appends || []) {
        if (!append || typeof append.key !== 'string') continue;
        const target = out.find((rule) => Object.prototype.hasOwnProperty.call(rule.mapping, append.key));
        if (!target) continue;
        const text = String(append.exampleText || append.chunk || append.input || '');
        if (!text) continue;
        const related = new Set([append.key]);
        for (const rel of relations || []) {
            if (!rel || typeof rel !== 'object') continue;
            const keys = [rel.base, rel.sub, rel.parent, rel.child, ...(Array.isArray(rel.parts) ? rel.parts : []), ...(Array.isArray(rel.stackOrder) ? rel.stackOrder : [])]
                .filter((key) => typeof key === 'string');
            if (keys.includes(append.key)) keys.forEach((key) => related.add(key));
        }
        const candidates = (events || []).filter((evt) => evt && evt.values
            && Object.prototype.hasOwnProperty.call(evt.values, append.key)
            && (!append.date || evt.date === append.date || evt.date.endsWith(`-${append.date}`)));
        const confirmedValues = candidates.length === 1 ? candidates[0].values
            : (append.values && typeof append.values === 'object'
                && Object.prototype.hasOwnProperty.call(append.values, append.key) ? append.values : null);
        if (!confirmedValues) continue;
        const values = {};
        for (const key of related) {
            if (Object.prototype.hasOwnProperty.call(target.mapping, key)
                && Object.prototype.hasOwnProperty.call(confirmedValues, key)) values[key] = confirmedValues[key];
        }
        if (!Object.keys(values).length) continue;
        const existing = target.examples.find((ex) => ex.input === text);
        if (existing) Object.assign(existing.values, values);
        else target.examples.push({ input: text, values });
    }
    return out;
}

/** Restore a model-selected example to verbatim user text when its copy has a tiny typo. */
function snapMinorAppendToSource(append, source) {
    if (!append || typeof append !== 'object' || typeof source !== 'string') return null;
    const texts = [append.exampleText, append.chunk, append.input]
        .filter((value) => typeof value === 'string' && value.trim())
        .map((value) => value.trim());
    for (const value of texts) {
        if (source.includes(value)) return { ...append, chunk: value, exampleText: value };
    }
    const candidate = texts[0]?.replace(/^\*+|\*+$/g, '').trim();
    if (!candidate) return null;
    const spans = source.split(/<br\s*\/?>|\r\n?|\n/gi).map((part) => part.trim()).filter(Boolean);
    const maxEdits = 2;
    function distanceAtMost(a, b) {
        if (Math.abs(a.length - b.length) > maxEdits) return maxEdits + 1;
        let prev = Array.from({ length: b.length + 1 }, (_value, index) => index);
        for (let i = 1; i <= a.length; i++) {
            const row = [i];
            let rowMin = i;
            for (let j = 1; j <= b.length; j++) {
                row[j] = Math.min(row[j - 1] + 1, prev[j] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
                rowMin = Math.min(rowMin, row[j]);
            }
            if (rowMin > maxEdits) return maxEdits + 1;
            prev = row;
        }
        return prev[b.length];
    }
    const normalizedSource = source.replace(/<br\s*\/?>/gi, '\n').trim();
    const normalizedCandidate = candidate.replace(/<br\s*\/?>/gi, '\n');
    if (distanceAtMost(normalizedCandidate, normalizedSource) <= maxEdits) {
        return { ...append, chunk: source, exampleText: source };
    }
    let best = null;
    let bestDistance = maxEdits + 1;
    let ties = 0;
    for (const span of spans) {
        const distance = distanceAtMost(candidate, span);
        if (distance < bestDistance) {
            best = span;
            bestDistance = distance;
            ties = 1;
        } else if (distance === bestDistance) {
            ties++;
        }
    }
    return best && bestDistance <= maxEdits && ties === 1
        ? { ...append, chunk: best, exampleText: best }
        : null;
}

/** Merge a model-proposed extension into one existing versioned rule. */
function mergeRuleUpdate(existing, update) {
    const completeSnapshot = update && update.completeSnapshot === true;
    const stripInternalMarker = (rule) => {
        const { completeSnapshot: _completeSnapshot, ...persistable } = rule || {};
        return persistable;
    };
    if (completeSnapshot) {
        const incoming = stripInternalMarker(update);
        return {
            ...existing,
            ...incoming,
            id: existing.id,
            mapping: { ...(update.mapping || {}) },
            examples: (Array.isArray(update.examples) ? update.examples : []).map((example) => ({
                ...example,
                values: { ...(example.values || {}) },
            })),
        };
    }
    const examples = (existing.examples || []).map((example) => ({
        ...example,
        values: { ...(example.values || {}) },
    }));
    for (const example of update.examples || []) {
        const input = String(example.input || '');
        if (!input) continue;
        const current = examples.find((candidate) => candidate.input === input);
        if (!current) {
            examples.push({ ...example, values: { ...(example.values || {}) } });
            continue;
        }
        for (const [key, value] of Object.entries(example.values || {})) {
            if (Object.prototype.hasOwnProperty.call(current.values, key) && current.values[key] !== value) return null;
            current.values[key] = value;
        }
    }
    return {
        ...existing,
        ...stripInternalMarker(update),
        id: existing.id,
        mapping: { ...(existing.mapping || {}), ...(update.mapping || {}) },
        examples,
    };
}

/** Resolve session aliases and validate every rule change before Save starts writing. */
function prepareRuleChanges(rules, committedRules, proposalUpdateId) {
    const committed = [...(committedRules.dynamic || []), ...(committedRules.global || [])];
    const committedIds = new Set(committed.map((rule) => rule.id));
    const pendingIds = new Set((rules || []).map((rule) => rule && rule.id).filter(Boolean));
    const resolveId = (id) => {
        if (committedIds.has(id)) return id;
        let stable = id;
        while (typeof stable === 'string' && stable.startsWith('tmp_')) {
            stable = stable.slice(4);
            if (committedIds.has(stable)) return stable;
            if (pendingIds.has(stable)) return resolveId(stable);
        }
        return id;
    };
    const changes = new Map();
    for (const candidate of rules || []) {
        const id = resolveId(candidate.id);
        // A batch's last update target belongs only to that rule, never every
        // earlier proposal. Per-rule metadata also survives the temp adapter.
        const requested = candidate.updateRuleId || ((candidate.id === proposalUpdateId
            || rules.length === 1) ? proposalUpdateId : null);
        const targetId = requested ? resolveId(requested) : id;
        const prior = changes.get(targetId);
        const saved = committed.find((rule) => rule.id === targetId);
        const isUpdate = !!requested || id !== candidate.id
            || (candidate.completeSnapshot === true && !!saved);
        if (isUpdate && !prior && !saved) {
            throw new Error(`правило ${requested || candidate.id} для обновления не найдено`);
        }
        const { updateRuleId: _updateRuleId, ...incoming } = candidate;
        const base = prior ? prior.rule : (isUpdate ? saved : null);
        const rule = base ? mergeRuleUpdate(base, { ...incoming, id: targetId })
            : { ...incoming, id: targetId };
        if (!rule) throw new Error(`конфликт примеров при обновлении ${targetId}`);
        if (!base && saved) throw new Error(`правило с id '${targetId}' уже существует`);
        changes.set(targetId, { rule, changeType: prior ? prior.changeType : (isUpdate ? 'update' : 'add') });
    }
    return [...changes.values()];
}

/**
 * Забирает инжектируемый fetch из opts.llmOptions (единая точка проброса в
 * cutter/router/structured/conflict).
 * @returns {Function|undefined}
 */
function extractFetch(opts) {
    if (opts && opts.llmOptions && typeof opts.llmOptions === 'object' && typeof opts.llmOptions.fetch === 'function') {
        return opts.llmOptions.fetch;
    }
    return undefined;
}

/** Единая фабрика контрактного error-ответа пайплайна. */
function error(branch, message, confidence = 0) {
    return { status: 'error', branch, payload: null, confidence: normalizeConfidence(confidence), message };
}

/**
 * Актуальный срез правил {{RULES}}: formatRecentRules(Infinity) читает кэш, в котором
 * живёт оверлей temp-правил Branch 2/3 предыдущих дней этого же прогона.
 * Срез по ВСЕМ правилам (а не последние 2): Branch 3 мульти-группового дня добавляет
 * несколько tmp-правил — срез «последние 2» отдал бы LLM только часть, и следующий
 * день терял бы ранние правила (сквозная оценка канвы «Сквозная оценка»).
 * Срез «последние 2» остаётся про зафиксированные (main) правила МЕЖДУ прогонами.
 */
function currentRules() {
    try { return rulesLog.formatRecentRules(Infinity); } catch (_e) { return ''; }
}

// ---------------------------------------------------------------------------
// Публичный API: next(input, opts)
// ---------------------------------------------------------------------------

/**
 * Главный шаг пайплайна: Cutter (дни) → цикл { Router → Branch 1|2|3 } →
 * единый контракт конца пайплайна (AC-R1..R3, AC-R6).
 *
 * @param {string} input сырой ввод (таблица недели, многострочный блок, порции).
 * @param {object} [opts]
 * @param {string} [opts.context] контекст (последние записи) → {{CONTEXT}}.
 * @param {string} [opts.date] дата (YYYY-MM-DD) для интерпретации / пример-отрисовки.
 * @param {string} [opts.lastContext] последняя записанная метрика (для structured).
 * @param {string} [opts.table] таблица недели → {{TABLE}} router.
 * @param {object} [opts.llmOptions] пробрасывается в cutter/router/structured/conflict;
 *                                   { fetch } — инжектируемый LLM для unit-тестов.
 * @param {Function} [opts.onStage] колбэк стадии (LX-фидбек).
 * @param {object} [opts.tmpStore] Vault temp adapter; omitted in Node filesystem runs.
 * @returns {Promise<{status:'success'|'error', branch:1|2, payload|null, confidence, message?}>}
 *          Никогда не бросает.
 */
async function next(input, opts = {}) {
    const fetch = extractFetch(opts);
    const context = typeof opts.context === 'string' ? opts.context : '';
    const table = typeof opts.table === 'string' ? opts.table : '';
    const llmOptions = (opts.llmOptions && typeof opts.llmOptions === 'object') ? opts.llmOptions : {};
    const onStage = (typeof opts.onStage === 'function') ? opts.onStage : null;
    const sessionTmp = opts.tmpStore || {
        appendMinorMapping: tmpStore.appendMinorMappingFs,
        appendProposedRules: tmpStore.appendProposedRulesFs,
        appendGraphRelations: tmpStore.appendGraphTmpRelationsFs,
    };

    // Инструментальная трасса data-flow (только в файл data/test-artifacts/).
    const tr = trace.begin('interpret', { inputLen: typeof input === 'string' ? input.length : 0 });

    const warnings = [];
    const failedDays = [];
    const recordFailedDay = (day, dayIndex, reason) => {
        if (failedDays.some((item) => item.dayIndex === dayIndex)) return;
        const date = dateForDay(day && day.date, opts.date);
        failedDays.push({
            dayIndex,
            date: typeof date === 'string' && date ? date : null,
            reason: String(reason || 'Обработка дня не завершилась'),
        });
    };
    const initialRulesLogSnapshot = (() => {
        try { return JSON.parse(JSON.stringify(rulesLog.getRulesLog())); }
        catch (_e) { return null; }
    })();
    const restoreRulesCache = () => {
        if (!initialRulesLogSnapshot) return;
        try {
            if (Array.isArray(initialRulesLogSnapshot.entries)
                && typeof rulesLog.setCachedLog === 'function') {
                rulesLog.setCachedLog(initialRulesLogSnapshot);
            } else if (typeof rulesLog._resetCache === 'function') {
                // Legacy logs such as { rules: [] } are loaded directly from the
                // unchanged main file; setCachedLog intentionally accepts only
                // versioned logs with entries.
                rulesLog._resetCache();
            }
        } catch (_e) { /* best effort */ }
    };
    const fail = (branch, message, confidence = 0) => {
        restoreRulesCache();
        return error(branch, message, confidence);
    };

    // 1. Cutter (LLM): нарезка сырого ввода на дни (дни — в порядке следования).
    //    Сбой cutter не роняет прогон: весь ввод идёт одним днём (warning).
    let days = null;
    try {
        if (onStage) onStage(STAGES.CUTTER);
        const c = await cut(input, { ...llmOptions, fetch });
        if (c.status === 'success' && c.payload && Array.isArray(c.payload.days) && c.payload.days.length) {
            days = c.payload.days;
        }
    } catch (_e) { days = null; }
    if (!days) {
        warnings.push('Cutter: нарезка на дни не удалась — ввод обработан как один день');
        days = [{ raw: typeof input === 'string' ? input : String(input == null ? '' : input), date: null }];
    }
    trace.step(tr, 'cutter.days', days);

    // 2. Цикл по дням (канва: «Цикл обработки данных»): каждый день отдельно
    //    идёт в Router; правила предыдущих дней видны следующему через tmp-кэш.
    const payload = {
        groups: [],        // вердикты роутера по дням: { chunk: day.raw, group }
        minorChunks: [],   // куски группы 2 (Branch 2) — совместимость с UI/тестами
        // Полный ввод прогона — для commitRules (raw правила Branch 1).
        raw: typeof input === 'string' ? input : String(input == null ? '' : input),
    };
    const eventSets = [];
    const allRules = [];
    const allExampleEvents = [];
    const branch3ValidationEvents = [];
    const allAppends = [];
    const allRelations = [];
    let lastProposal = null;
    let conflictConfidence = 0;

    const runStructured = async (chunksArr, eventDate = opts.date, rulesOverride = null) => {
        if (!chunksArr || !chunksArr.length) return { failed: true };
        if (onStage) onStage(STAGES.STRUCTURED);
        const s = await structured(chunksArr.join('\n'), {
            context,
            date: eventDate,
            ...(rulesOverride ? { rules: rulesOverride } : {}),
            lastContext: opts.lastContext,
            llmOptions,
        });
        if (s.status !== 'success' || !s.payload || !Array.isArray(s.payload.events)) {
            return { failed: true, res: s };
        }
        const events = s.payload.events.filter(isEvent);
        if (events.length === 0) return { failed: true, res: s };
        return {
            events,
            newKeys: Array.isArray(s.payload.newKeys) ? s.payload.newKeys : [],
            confidence: normalizeConfidence(s.confidence),
        };
    };

    /**
     * Оверлей temp-правил в кэше (rulesLog.setCachedLog): main ∪ новые правила.
     * НИКОГДА не пишет rulesLog.json (INV-2/3) — только кэш; живёт до конца
     * прогона (на Save мержится в main через confirm/commitRules).
     */
    const applyOverlay = (extraRules, source) => {
        try {
            const log = rulesLog.getRulesLog();
            const latest = rulesLog.getLatestRules();
            const snapshot = latest ? JSON.parse(JSON.stringify(latest)) : { dynamic: [], global: [] };
            snapshot.version = log.version;
            const dynamic = [...(snapshot.dynamic || [])];
            for (const rule of extraRules || []) {
                if (!rule || typeof rule.id !== 'string') continue;
                const index = dynamic.findIndex((existing) => existing && existing.id === rule.id);
                if (index === -1) dynamic.push(rule);
                else dynamic[index] = { ...dynamic[index], ...rule };
            }
            snapshot.dynamic = dynamic;
            rulesLog.setCachedLog({
                ...log,
                version: log.version,
                entries: [
                    ...(log.entries || []),
                    {
                        version: log.version,
                        timestamp: new Date().toISOString(),
                        changeType: 'pipeline-overlay',
                        rulesSnapshot: snapshot,
                        meta: { proposedBy: 'pipeline', source },
                    },
                ],
            });
            return true;
        } catch (_e) { return false; }
    };

    for (let i = 0; i < days.length; i++) {
        const day = days[i];
        const dayNo = i + 1;

        // 2a. Router (LLM): ОДИН день на вход, {{RULES}} = актуальные правила
        //     (main ∪ tmp-кэш предыдущих дней). Ошибка Router-контракта прерывает
        //     прогон, иначе fallback-группа может скрыть новую метрику/правило.
        let groups = null;
        try {
            if (onStage) onStage(STAGES.ROUTER);
            const r = await route(day.raw, { ...opts, fetch, context, table, rules: currentRules() });
            if (r.status === 'error') {
                trace.step(tr, `day.${dayNo}.router.contract-error`, { message: r.message || 'invalid Router response' });
                trace.end(tr);
                return fail(1, `День ${dayNo}: ${r.message || 'Router не смог классифицировать исходный текст'}`, r.confidence);
            }
            if (r.status === 'success' && r.payload && Array.isArray(r.payload.groups) && r.payload.groups.length) {
                groups = r.payload.groups;
            }
        } catch (e) {
            const message = `День ${dayNo}: сбой Router (${(e && e.message) || String(e)})`;
            trace.step(tr, `day.${dayNo}.router.error`, { message });
            trace.end(tr);
            return fail(1, message, 0);
        }
        if (!groups) {
            const message = `День ${dayNo}: Router не вернул классификацию; обработка остановлена, чтобы не терять данные`;
            trace.step(tr, `day.${dayNo}.router.no-groups`, { message });
            trace.end(tr);
            return fail(1, message, 0);
        }
        trace.step(tr, `day.${dayNo}.router`, groups);
        const g = groups[0];
        payload.groups.push({ chunk: g.chunk, group: g.group, downgraded: undefined });

        // 2b. Ветка по группе дня (сквозная оценка — из цикла, не из инструкций LLM).
        try {
            if (g.group === 1) {
                const s = await runStructured([g.chunk], dateForDay(day.date, opts.date));
                trace.step(tr, `day.${dayNo}.branch1`, s);
                if (s.failed) {
                    recordFailedDay(day, dayNo, (s.res && (s.res.message || s.res.reason)) || 'перевод по существующим правилам не удался');
                    warnings.push(`День ${dayNo}: перевод по правилам не удался`);
                } else {
                    eventSets.push(s);
                    // Ключи Branch 1 → словарь прогона (живой прогон 2026-09-05):
                    // structured отдаёт payload.newKeys, но раньше они НЕ попадали
                    // в tmp-кэш — day.2 router видел rules:[] → группа 3 → Branch 3
                    // переоткрывал те же сущности с выдуманными ключами. Собираем
                    // сессийное правило напрямую (формат mergeRuleSnapshots) и
                    // кладём оверлеем в кэш — его увидит {{RULES}} следующего дня.
                    // НЕ путать с mergeRuleSnapshots (тот — для Branch 2-аппендов).
                    // Только кэш (rulesLog.setCachedLog), НЕ rulesLog.json (INV-2/3).
                    const nkList = (Array.isArray(s.newKeys) ? s.newKeys : [])
                        .filter((nk) => nk && typeof nk.key === 'string' && nk.key);
                    if (nkList.length) {
                        const b1Rule = {
                            id: `tmp_session_keys_b1_${dayNo}`,
                            semantics: `Ключи дня ${dayNo} (Branch 1, ещё не зафиксированы Save): ${nkList.map((nk) => nk.key).join(', ')}`,
                            // Формат {{RULES}} (§4): ключ → кусок текста (пример употребления).
                            mapping: nkList.reduce((acc, nk) => { acc[nk.key] = groundedSourceSpan(nk, day.raw) || nk.key; return acc; }, {}),
                            roles: nkList.reduce((acc, nk) => { acc[nk.key] = 'stack'; return acc; }, {}),
                            cues: [],
                            // Structured currently exposes no per-key source span. Never copy
                            // the whole day into every key's example; accept only an explicit
                            // LLM span, verified as a verbatim substring of that day.
                            examples: examplesFromGroundedKeys(nkList, day.raw),
                            __tmp: true,
                        };
                        if (!applyOverlay([b1Rule], 'b1-keys-overlay')) {
                            warnings.push(`День ${dayNo}: ключи Branch 1 не добавлены в словарь прогона`);
                        }
                    }
                }
            } else if (g.group === 2) {
                payload.minorChunks.push(g.chunk);
                if (onStage) onStage(STAGES.MINOR);
                const m = await callLLM('minorRuleUpdate', g.chunk, context, '', {
                    ...llmOptions,
                    rules: currentRules(),
                    fetch: fetch || llmOptions.fetch,
                });
                let appends = [];
                if (m.status === 'success' && m.payload && Array.isArray(m.payload.appends)) {
                    // Валидация key (фикс мусора в tmp): minor-аппенд ДОЛЖЕН уточнять
                    // ключ, уже существующий в маппинге актуальных правил. LLM иногда
                    // возвращает id правила (tmp_rule_004) вместо ключа маппинга —
                    // такой мусор раньше утекал в rulesLog.tmp.json и в {{RULES}}
                    // следующего дня («ключ tmp_rule_004: подтягивания»). Отбрасываем
                    // с warning, прогон не роняем.
                    const validKeys = new Set();
                    try {
                        const latest = rulesLog.getLatestRules();
                        for (const r of ((latest && latest.dynamic) || [])) {
                            if (r && r.mapping && typeof r.mapping === 'object') {
                                for (const k of Object.keys(r.mapping)) validKeys.add(k);
                            }
                        }
                    } catch (_e) { /* нет правил — фильтр пуст */ }
                    const isValidKey = (k) => validKeys.has(k);
                    const dropped = m.payload.appends
                        .filter((a) => a && typeof a.key === 'string' && a.key && !isValidKey(a.key))
                        .map((a) => a.key);
                    if (dropped.length) {
                        warnings.push(`День ${dayNo}: аппенды с неизвестными ключами отброшены (${dropped.join(', ')})`);
                    }
                    const grounded = m.payload.appends
                        .filter((a) => a && typeof a.key === 'string' && a.key && isValidKey(a.key))
                        .map((a) => snapMinorAppendToSource(a, g.chunk));
                    const ungrounded = grounded.filter((a) => !a).length;
                    if (ungrounded) {
                        warnings.push(`День ${dayNo}: ${ungrounded} minor-пример(ов) не совпали с исходным текстом и отброшены`);
                    }
                    appends = grounded.filter(Boolean)
                        .map((a) => ({ ...a, date: day.date || a.date || '' }));
                }
                if (!appends.length) {
                    warnings.push(`День ${dayNo}: минорное дополнение не удалось`);
                }
                // Сначала переводим день по уже подтверждённым ключам, затем
                // обогащаем minor-пример полученными значениями. Пустой пример
                // в {{RULES}} до Structured провоцировал Gemma выдумывать ключи.
                const s = await runStructured([g.chunk], dateForDay(day.date, opts.date));
                trace.step(tr, `day.${dayNo}.branch2`, s);
                if (s.failed) {
                    recordFailedDay(day, dayNo, (s.res && (s.res.message || s.res.reason)) || 'перевод по существующим правилам не удался');
                    warnings.push(`День ${dayNo}: повторный перевод по правилам не удался`);
                } else {
                    eventSets.push(s);
                    const enrichedRules = mergeMinorExamplesIntoRules(
                        (rulesLog.getLatestRules() && rulesLog.getLatestRules().dynamic) || [],
                        appends, s.events, allRelations,
                    );
                    // Пример сохраняет все значения события, включая нулевые,
                    // и связи соседних ключей (A+B/overlay), если они известны.
                    for (const append of appends) {
                        const rule = enrichedRules.find((candidate) =>
                            candidate.mapping && Object.prototype.hasOwnProperty.call(candidate.mapping, append.key));
                        const example = rule && (rule.examples || []).find((item) =>
                            item.input === String(append.exampleText || append.chunk || append.input || ''));
                        if (example) append.values = { ...example.values };
                    }
                    if (appends.length) {
                        // Только temp-файл и сессионный кэш; main меняется на Save.
                        try { await sessionTmp.appendMinorMapping(appends); } catch (e) {
                            warnings.push(`День ${dayNo}: аппенд не записан в tmp (${(e && e.message) || String(e)})`);
                        }
                        try {
                            // `enrichedRules` already contains each newly grounded example
                            // with event values. Rebuilding snapshots from appends alone can
                            // lose it when the target key already exists but the example is new.
                            applyOverlay(enrichedRules, 'minor-overlay');
                        } catch (_e) { /* кэш не критичен: structured уже прошёл */ }
                        allAppends.push(...appends);
                    }
                }
            } else {
                // Группа 3 → Branch 3 (conflict.js): придумывание нового правила.
                if (onStage) onStage(STAGES.CONFLICT);
                const branchRules = currentRules();
                // Keep the structured parser's pre-update rule snapshot separately.
                // `currentRules()` is prompt text for RuleUpdate; Structured needs
                // the object so it cannot fall back to the mutated in-run cache.
                const branchRuleSnapshot = rulesLog.getLatestRules();
                const c = await proposeRule(g.chunk, {
                    context, date: dateForDay(day.date, opts.date), rawInput: input,
                    llmOptions, rules: branchRules,
                });
                if (c.status !== 'success' || !c.payload || !c.payload.rule) {
                    trace.step(tr, `day.${dayNo}.branch3`, c);
                    recordFailedDay(day, dayNo, c.reason || c.message || 'предложение правила не удалось');
                    warnings.push(`День ${dayNo}: предложение правила не удалось`);
                } else {
                    const conflictRes = {
                        rule: c.payload.rule,
                        rules: (Array.isArray(c.payload.rules) && c.payload.rules.length)
                            ? c.payload.rules : [c.payload.rule],
                        exampleEvents: Array.isArray(c.payload.exampleEvents) ? c.payload.exampleEvents : [],
                        proposal: c.payload,
                        oldKeysEvents: Array.isArray(c.payload.oldKeysEvents) ? c.payload.oldKeysEvents : [],
                        oldChunks: Array.isArray(c.payload.oldChunks) ? c.payload.oldChunks : [],
                        newKeys: Array.isArray(c.payload.newKeys) ? c.payload.newKeys : [],
                        relations: Array.isArray(c.payload.relations) ? c.payload.relations : [],
                        confidence: normalizeConfidence(c.confidence),
                    };
                    // Examples and new-key chunks are citations of user input.
                    // Keep only exact citations; a missing/unsafe example must not
                    // discard otherwise valid keys and values from this day.
                    for (const item of conflictRes.newKeys) {
                        const span = typeof item.sourceSpan === 'string' ? item.sourceSpan : item.chunk;
                        const grounded = typeof span === 'string' && span.trim()
                            && g.chunk.includes(span)
                            && span.trim() !== g.chunk.trim();
                        if (grounded) item.chunk = span;
                        else {
                            delete item.chunk;
                            delete item.sourceSpan;
                        }
                    }
                    for (const rule of conflictRes.rules) {
                        rule.examples = (rule.examples || []).filter((example) => {
                            const span = example && example.input;
                            return typeof span === 'string' && span.trim()
                                && g.chunk.includes(span)
                                && span.trim() !== g.chunk.trim();
                        });
                    }
                    // Branch 3 returns both the previous-rule interpretation and the
                    // chunks to reparse with Structured. Keep both candidates so a
                    // disagreement becomes an explicit preview conflict instead of
                    // silently letting the second model call overwrite the first.
                    const oldVocabulary = new Set(structured.extractVocabulary(branchRuleSnapshot));
                    const oldValues = {};
                    for (const item of conflictRes.oldKeysEvents) {
                        if (!item || typeof item.key !== 'string' || !item.key
                            || !item.values || typeof item.values !== 'object') {
                            trace.end(tr);
                            return fail(3, 'Branch 3 вернул неполную интерпретацию старых данных; нужно проверить день', conflictRes.confidence);
                        }
                        const entries = Object.entries(item.values);
                        if (!entries.length || !entries.some(([key]) => key === item.key)) {
                            trace.end(tr);
                            return fail(3, `Branch 3 не подтвердил старый ключ ${item.key}; нужно проверить день`, conflictRes.confidence);
                        }
                        for (const [key, value] of entries) {
                            if (!oldVocabulary.has(key) || typeof value !== 'number' || !Number.isFinite(value)) {
                                trace.end(tr);
                                return fail(3, `Branch 3 вернул недопустимое старое значение ${key}; нужно проверить день`, conflictRes.confidence);
                            }
                            if (Object.prototype.hasOwnProperty.call(oldValues, key)
                                && !Object.is(oldValues[key], value)) {
                                trace.end(tr);
                                return fail(3, `Branch 3 противоречит сам себе по ключу ${key}; нужно проверить день`, conflictRes.confidence);
                            }
                            oldValues[key] = value;
                        }
                    }
                    if (Object.keys(oldValues).length) {
                        branch3ValidationEvents.push(makeEvent({
                            date: dateForDay(day.date, opts.date),
                            values: oldValues,
                        }, Number.isInteger(branchRuleSnapshot.version) ? branchRuleSnapshot.version : rulesLog.getVersion()));
                    }
                    trace.step(tr, `day.${dayNo}.branch3`, { rule: conflictRes.rule.id, keys: conflictRes.newKeys.map((nk) => nk.key) });
                    // Оверлей Branch 3: правило этого дня → кэш, его видит СЛЕДУЮЩИЙ день
                    // (сквозная оценка через tmp-кэш; rulesLog.json не пишется).
                    // Id в оверлее помечается tmp_ — на Save правило фиксируется под
                    // настоящим id (confirm/commitRules), кэш-копия не должна коллидировать.
                    if (conflictRes.rules.length) {
                        applyOverlay(conflictRes.rules.map((r) => ({
                            ...r,
                            id: `tmp_${r.id}`,
                            // Keep future days out of this run's evolving vocabulary.
                            // The saved proposal still retains rawInput verbatim.
                            raw: g.chunk,
                        })), 'conflict-overlay');
                    }
                    allRules.push(...conflictRes.rules.map((rule) => ({
                        ...rule,
                        ...(rule.id === conflictRes.proposal.updateRuleId
                            ? { updateRuleId: conflictRes.proposal.updateRuleId } : {}),
                    })));
                    allExampleEvents.push(...conflictRes.exampleEvents);
                    lastProposal = conflictRes.proposal;
                    conflictConfidence = Math.max(conflictConfidence, conflictRes.confidence);
                    // Branch 3 continuation: re-parse the COMPLETE day with the
                    // frozen pre-update vocabulary. RuleUpdate may omit familiar
                    // values while splitting old/new; full-day parsing recovers
                    // them. Both model views are validated together below.
                    if (conflictRes.oldChunks.length && conflictRes.newKeys.length) {
                        let c2Res = null;
                        try {
                            c2Res = await runStructured(
                                [g.chunk],
                                dateForDay(day.date, opts.date),
                                branchRuleSnapshot,
                            );
                        } catch (_e) { c2Res = { failed: true }; }
                        if (c2Res && c2Res.failed) {
                            warnings.push(`День ${dayNo} (Branch 3): перевод старых кусков по старым правилам не удался`);
                        } else if (c2Res) {
                            eventSets.push(c2Res);
                        }
                    }
                    // LLM-relations → temp-слой графа (graph.tmp.json, НЕ graph.json).
                    if (conflictRes.relations.length) {
                        allRelations.push(...conflictRes.relations);
                        // Graph temp is flushed only after the combined preview passes.
                    }
                }
            }
        } catch (e) {
            recordFailedDay(day, dayNo, (e && e.message) || String(e));
            warnings.push(`День ${dayNo}: сбой ветки (${(e && e.message) || String(e)})`);
        }
    }

    // 3. Сборка единого контракта. Неустранимые ошибки Router уже завершили цикл;
    //    recoverable errors в ветках дня остаются в warnings.
    let confidence = 0;
    if (eventSets.length) {
        payload.newKeys = eventSets.flatMap((r) => r.newKeys || []);
        confidence = Math.max(confidence, ...eventSets.map((r) => r.confidence));
    }
    const preview = mergePreviewEvents([
        ...eventSets.flatMap((r) => r.events || []),
        ...branch3ValidationEvents,
        ...allExampleEvents,
    ]);
    if (preview.conflicts.length) {
        const details = preview.conflicts.map((c) => `${c.date}/${c.key}`).join(', ');
        trace.step(tr, 'final.preview-conflict', { conflicts: preview.conflicts });
        trace.end(tr);
        return fail(1, `противоречивые значения в превью требуют уточнения: ${details}`, confidence);
    }
    if (preview.events.length) {
        const dayOrder = new Map();
        days.forEach((day, index) => {
            const date = dateForDay(day && day.date, opts.date);
            if (date && !dayOrder.has(date)) dayOrder.set(date, index);
        });
        payload.events = [...preview.events].sort((a, b) => {
            const aOrder = dayOrder.has(a.date) ? dayOrder.get(a.date) : Number.MAX_SAFE_INTEGER;
            const bOrder = dayOrder.has(b.date) ? dayOrder.get(b.date) : Number.MAX_SAFE_INTEGER;
            return aOrder - bOrder;
        });
    }
    if (allRules.length) {
        // Branch 3 (multi-group): rule = правила всех дней конфликта (rule — первое, совместимость).
        payload.rule = allRules[0];
        payload.rules = allRules;
        payload.exampleEvents = allExampleEvents;
        payload.proposal = {
            ...(lastProposal || {}),
            rule: allRules[0],
            rules: allRules,
            exampleEvents: allExampleEvents,
        };
        confidence = Math.max(confidence, conflictConfidence);
    }
    if (allAppends.length) payload.appends = allAppends;
    if (allRelations.length) payload.relations = allRelations;
    if (failedDays.length) payload.failedDays = failedDays;

    // Поле branch = доминирующая ветка (1, если есть дни групп 1/2, иначе 2 = conflict).
    const dominantBranch = payload.groups.some((x) => x.group === 1 || x.group === 2) ? 1 : 2;

    if (payload.events === undefined && payload.rule === undefined) {
        trace.step(tr, 'final.payload', { warnings });
        trace.end(tr);
        const result = fail(dominantBranch, warnings.join('; ') || 'ни один день не вернул результат', confidence);
        if (failedDays.length) result.failedDays = failedDays;
        return result;
    }
    // Commit session temp only after the final preview is known to be valid.
    // In-memory overlays above remain visible to later days in this same run.
    if (allRules.length) {
        try { await sessionTmp.appendProposedRules(allRules); }
        catch (e) {
            warnings.push(`Предложения Branch 3 не записаны в temp (${(e && e.message) || String(e)})`);
        }
    }
    if (allRelations.length) {
        try {
            const rr = require('./renderRules.js');
            const graphRels = rr.relationsFromLLM(allRelations);
            if (graphRels.length) {
                if (sessionTmp.appendGraphRelations) await sessionTmp.appendGraphRelations(graphRels);
                else await sessionTmp.writeGraphTmp(tmpStore.mergeGraphs(
                    await sessionTmp.readGraphTmp({ strict: true }), { relations: graphRels },
                ));
            }
        } catch (e) {
            warnings.push(`Связи Branch 3 не записаны в temp-граф (${(e && e.message) || String(e)})`);
        }
    }
    if (warnings.length) payload.warnings = warnings;

    trace.step(tr, 'final.payload', {
        status: 'success',
        branch: dominantBranch,
        days: days.length,
        events: Array.isArray(payload.events) ? payload.events.length : 0,
        newKeys: Array.isArray(payload.newKeys) ? payload.newKeys.length : 0,
        hasRule: payload.rule !== undefined,
        appends: Array.isArray(payload.appends) ? payload.appends.length : 0,
        warnings: warnings.length,
    });
    trace.end(tr);
    payload._traceId = tr.id;

    return {
        status: 'success',
        branch: dominantBranch,
        payload,
        confidence,
    };
}

/**
 * Подтверждает предложенное правило из branch 2 (Rule Evolution, AC-R4).
 * Зовёт conflict.confirmProposal → rulesLog.appendRule(rule,'add',meta), что поднимает
 * версию лога на 1 и дописывает правило в правила отрисовки.
 *
 * @param {object} proposal { rule: Rule, exampleEvents?: Event[], rationale? } (payload из branch 2).
 * @param {object} [opts] opts.meta — доп. метаданные записи лога.
 * @returns {Promise<{status:'success'|'error', branch:2, payload?:{entry, version}, confidence?, message?}>}
 *          Никогда не бросает: невалидное правило / программная ошибка → { status:'error' }.
 */
async function confirm(proposal, opts = {}) {
    try {
        const res = await confirmProposal(proposal, opts);
        // confirmProposal возвращает { status:'success', payload:{ entry, version } }.
        return {
            status: 'success',
            branch: 2,
            payload: res.payload,
            confidence: 1,
        };
    } catch (e) {
        return error(2, `confirm: правило не подтверждено (${(e && e.message) || String(e)})`);
    }
}

// ---------------------------------------------------------------------------
// Branch 3: LLM-relations → граф на Save
// ---------------------------------------------------------------------------

// fs-путь graph.json при Save (node-контекст). Для тестов — изолированный путь.
let _graphFsPath = require('path').resolve(__dirname, '..', 'data', 'graph.json');
/** Переключить fs-путь graph.json (для тестов). */
function _setGraphFsPath(p) { _graphFsPath = p; }
function _getGraphFsPath() { return _graphFsPath; }

/** Снимки файлов после Save → в трассу (fs может отсутствовать — no-op). */
function traceFileSnapshots(tr) {
    let fsMod = null;
    try { fsMod = require('fs'); } catch (_e) { return; }
    try {
        const rp = (typeof rulesLog._getLogPath === 'function') ? rulesLog._getLogPath() : null;
        if (rp) trace.fileSnapshot(tr, 'rulesLog.json после', rp, fsMod.readFileSync(rp, 'utf8'));
    } catch (_e) { /* fs-шим браузера / файл не читается */ }
    try {
        trace.fileSnapshot(tr, 'graph.json после', _graphFsPath, fsMod.readFileSync(_graphFsPath, 'utf8'));
    } catch (_e) { /* fs-шим браузера / файл не читается */ }
}

/** Мержит связи в граф без дублей (dedupe по JSON-сигнатуре, как в pipeline.js:502). */
function mergeRelationsIntoGraph(graph, extraRelations, extraTargets = []) {
    const base = graph || { relations: [], targets: [], trends: [] };
    const seen = new Set(base.relations.map((r) => JSON.stringify(r)));
    const out = {
        relations: [...base.relations],
        targets: [...(base.targets || [])],
        trends: [...new Set(base.trends || [])],
    };
    for (const rel of (extraRelations || [])) {
        if (!rel || typeof rel !== 'object') continue;
        const sig = JSON.stringify(rel);
        if (seen.has(sig)) continue;
        out.relations.push(rel);
        seen.add(sig);
    }
    const seenTargets = new Set(out.targets);
    for (const target of extraTargets || []) {
        if (typeof target !== 'string' || !target || seenTargets.has(target)) continue;
        out.targets.push(target);
        seenTargets.add(target);
    }
    return out;
}

/**
 * Save-этап связей Branch 3: main-граф ∪ LLM-связи из payload ∪ связи graph.tmp.json
 * → пишется в graph.json, temp-связи очищаются (temp ∪ main → main при «Сохранить»).
 * @param {object} result результат pipeline.next (payload.relations — LLM-формат).
 * @param {object|null} graph граф, уже построенный из ключей (branch 1); null →
 *        rebuildGraphFromRules([]) как база.
 * @returns {object|null} смерженный граф или null (писать было нечего/сбой fs — не бросает).
 */
function commitGraphRelations(result, graph, options = {}) {
    try {
        const rr = require('./renderRules.js');
        const payloadRels = rr.relationsFromLLM((result && result.payload && result.payload.relations) || []);
        // Browser Save supplies the live Vault snapshots. The bundled fs shim can
        // only see build-time copies, so reading graph.tmp.json through fs here
        // silently drops relations staged during the current Obsidian session.
        const hasVaultSnapshots = Object.prototype.hasOwnProperty.call(options, 'graphTmp')
            || Object.prototype.hasOwnProperty.call(options, 'mainGraph');
        const tmpGraph = Object.prototype.hasOwnProperty.call(options, 'graphTmp')
            ? (options.graphTmp || { relations: [] })
            : tmpStore.readGraphTmpFs();
        const payloadKeys = [
            ...((result && result.payload && result.payload.newKeys) || []),
            ...((result && result.payload && result.payload.proposal && result.payload.proposal.newKeys) || []),
        ]
            .map((item) => item && item.key).filter((key) => typeof key === 'string');
        const inferredTargets = rr.graphFromKeys(payloadKeys).targets;
        let savedGraph = Object.prototype.hasOwnProperty.call(options, 'mainGraph')
            ? options.mainGraph : null;
        if (!Object.prototype.hasOwnProperty.call(options, 'mainGraph')) {
            try {
                const fsMod = require('fs');
                const parsed = JSON.parse(fsMod.readFileSync(_graphFsPath, 'utf8'));
                if (parsed && Array.isArray(parsed.relations)) {
                    savedGraph = {
                        relations: parsed.relations,
                        targets: Array.isArray(parsed.targets) ? parsed.targets : [],
                        trends: Array.isArray(parsed.trends) ? parsed.trends : [],
                    };
                }
            } catch (_e) { /* no persisted graph yet: rebuild a baseline */ }
        }
        let base = graph || savedGraph || rr.rebuildGraphFromRules([]);
        if (savedGraph && graph && Object.prototype.hasOwnProperty.call(options, 'mainGraph')) {
            base = mergeRelationsIntoGraph(savedGraph, graph.relations, graph.targets);
            base.trends = [...new Set([...(savedGraph.trends || []), ...(graph.trends || [])])];
        }
        const merged = mergeRelationsIntoGraph(
            base,
            [...payloadRels, ...(tmpGraph.relations || [])],
            [...(tmpGraph.targets || []), ...((result && result.payload && result.payload.targets) || []), ...inferredTargets],
        );
        if (merged.relations.length === base.relations.length
            && merged.targets.length === base.targets.length
            && merged.trends.length === base.trends.length) {
            // Ничего нового, НО temp-связи (если были) уже в main — temp очищается (Save).
            if (!hasVaultSnapshots && (tmpGraph.relations || []).length) tmpStore.clearGraphTmpRelationsFs();
            return base;
        }
        if (!hasVaultSnapshots) {
            const fsMod = require('fs');
            fsMod.writeFileSync(_graphFsPath, JSON.stringify({ relations: merged.relations }, null, 2) + '\n', 'utf8');
            tmpStore.clearGraphTmpRelationsFs();
        }
        return merged;
    } catch (_e) {
        return graph; // fs может быть браузерным шимом — тогда UI пишет payload.graph сам
    }
}

/**
 * D10: фиксация правил/сущностей при «💾 Сохранить данные» (Rule Evolution, транзакционно на Save).
 *
 * Branch 1 (payload.newKeys непустые): собирает ОДНО правило вида
 *   { id: rule_NNN (следующий свободный), semantics: описание из входа,
 *     mapping: { key: entity_metric }, cues: [], examples: [{input, date, values}] }
 * и дописывает его в rulesLog через appendRule('add'). Повторный вызов с теми же ключами
 * НЕ дублирует правило: ключи, уже зафиксированные в вокабуляре, пропускаются (dedupe).
 *
 * Предложения правил: связывает временные id с исходными правилами, объединяет
 * изменения каждого правила и фиксирует add/update через confirmProposal.
 * Минорные аппенды обновляют примеры существующего правила на том же Save.
 *
 * @param {object} result результат последнего успешного pipeline.next (contract { status, branch, payload }).
 * @param {object} [opts] { meta } — доп. метаданные записи лога.
 * @returns {Promise<{status:'success'|'noop'|'error', branch:1|2|null, added:number, version?:number, message?}>}
 *          Никогда не бросает. added — сколько правил реально дописано.
 */
async function commitRules(result, opts = {}) {
    // Трасса Save-прогона (только в файл data/test-artifacts/).
    const tr = trace.begin('save');
    try {
        if (!result || result.status !== 'success' || !result.payload) {
            trace.end(tr);
            return { status: 'noop', branch: null, added: 0, version: rulesLog.getVersion() };
        }

        // Router sees provisional rules in the per-run cache. Save starts from
        // the committed log so overlays and tmp_* rules stay out of main.
        const currentLog = rulesLog.getRulesLog();
        const committedEntries = (currentLog.entries || []).filter((entry) =>
            entry.changeType !== 'pipeline-overlay' && entry.changeType !== 'tmp-merge');
        const committedLog = opts.committedLog || {
            ...currentLog,
            version: committedEntries.length ? committedEntries[committedEntries.length - 1].version : currentLog.version,
            entries: committedEntries,
        };
        if (!committedLog || !Array.isArray(committedLog.entries)) {
            trace.end(tr);
            return error(result.branch || null, 'не удалось прочитать сохранённый журнал правил', result.confidence);
        }
        rulesLog.setCachedLog(committedLog);

        // Branch 3 proposals can coexist with Branch 1/2 days in one table run.
        // Save every proposed rule regardless of the dominant branch label.
        let proposalAdded = 0;
        let proposalVersion;
        let proposalGraph = null;
        let proposalLog = null;
        if (result.payload.proposal) {
            const proposal = result.payload.proposal;
            // Branch 3 multi-group (2026-09-02): proposal.rules — правила ВСЕХ групп
            // (по одному на группу новых упражнений); fallback — одиночный rule.
            const rulesArr = (Array.isArray(proposal.rules) && proposal.rules.length)
                ? proposal.rules
                : [proposal.rule].filter(Boolean);
            const changes = prepareRuleChanges(rulesArr, rulesLog.getLatestRules(), proposal.updateRuleId);
            const enriched = mergeMinorExamplesIntoRules(
                changes.map((change) => change.rule),
                result.payload.appends || [],
                result.payload.events || [],
                [...((opts.committedGraph && opts.committedGraph.relations) || []),
                    ...(result.payload.relations || [])],
            );
            let lastVersion = rulesLog.getVersion();
            for (let index = 0; index < changes.length; index++) {
                const confirmInput = {
                    ...proposal,
                    changeType: changes[index].changeType,
                    rule: (() => {
                        const { completeSnapshot: _completeSnapshot, updateRuleId: _updateRuleId,
                            ...persistable } = enriched[index];
                        return persistable;
                    })(),
                };
                try {
                    const res = await confirmProposal(confirmInput, opts);
                    lastVersion = res.payload.version;
                    proposalLog = rulesLog.getRulesLog();
                } catch (persistErr) {
                    // Browser bundle's fs shim cannot persist. Compute the same append
                    // in memory; UI commits the resulting log in its Save transaction.
                    const rule = { ...confirmInput.rule };
                    if (!rule.id || String(rule.id).trim() === '') {
                        rule.id = rulesLog.nextRuleId(rulesLog.getLatestRules());
                    }
                    const legacyShape = rule.when && rule.when.pattern && rule.then && rule.then.entity && rule.then.metric;
                    const newShape = (typeof rule.raw === 'string' && rule.raw.trim())
                        || (rule.mapping && typeof rule.mapping === 'object' && Object.keys(rule.mapping).length > 0);
                    if (!legacyShape && !newShape) throw persistErr;
                    const sourceCitedProposal = Array.isArray(confirmInput.newKeys)
                        && Array.isArray(confirmInput.rules);
                    const generatedExample = sourceCitedProposal ? null
                        : buildExample(confirmInput.input, confirmInput.candidate || confirmInput, confirmInput);
                    const examples = (Array.isArray(rule.examples) && rule.examples.length)
                        ? rule.examples
                        : (generatedExample ? [generatedExample] : []);
                    if (examples.length) rule.examples = examples;
                    const meta = {
                        ...(opts.meta || {}), proposedBy: 'conflict', source: 'unknown-conflict',
                        ...(proposal.rationale ? { rationale: proposal.rationale } : {}),
                    };
                    const computed = rulesLog.computeRuleEntry(rule, confirmInput.changeType === 'update' ? 'update' : 'add', meta);
                    rulesLog.setCachedLog(computed.newLog);
                    proposalLog = computed.newLog;
                    lastVersion = computed.entry.version;
                }
                proposalAdded++;
            }
            // Связи Branch 3 (payload.relations + graph.tmp.json) → main-граф (graph.json),
            // temp-связи очищаются. Сбой fs не блокирует фиксацию правила.
            proposalGraph = commitGraphRelations(result, null, {
                ...(Object.prototype.hasOwnProperty.call(opts, 'graphTmp') ? { graphTmp: opts.graphTmp } : {}),
                ...(Object.prototype.hasOwnProperty.call(opts, 'committedGraph') ? { mainGraph: opts.committedGraph } : {}),
            });
            proposalVersion = lastVersion;
        }

        // A Branch 2-only run has no new-rule proposal. Its model-selected examples
        // still belong in the versioned main log on Save, rather than being cleared
        // as already-known keys. Existing snapshots remain immutable.
        if (Array.isArray(result.payload.appends) && result.payload.appends.length) {
            const beforeMinor = rulesLog.getLatestRules();
            const existingRules = [...(beforeMinor.dynamic || []), ...(beforeMinor.global || [])];
            const enriched = mergeMinorExamplesIntoRules(existingRules, result.payload.appends,
                result.payload.events || [], [
                    ...((opts.committedGraph && opts.committedGraph.relations) || []),
                    ...(result.payload.relations || []),
                ]);
            for (let index = 0; index < enriched.length; index++) {
                const rule = enriched[index];
                if (JSON.stringify(rule.examples) === JSON.stringify(existingRules[index].examples || [])) continue;
                const meta = { ...(opts.meta || {}), source: 'save-gate', proposedBy: 'minorRuleUpdate' };
                let entry;
                try { entry = rulesLog.appendRule(rule, 'update', meta); }
                catch (_) {
                    const computed = rulesLog.computeRuleEntry(rule, 'update', meta);
                    rulesLog.setCachedLog(computed.newLog);
                    entry = computed.entry;
                }
                proposalAdded++;
                proposalVersion = entry.version;
                proposalLog = rulesLog.getRulesLog();
            }
            if (proposalAdded && !proposalGraph) proposalGraph = commitGraphRelations(result, null, {
                ...(Object.prototype.hasOwnProperty.call(opts, 'graphTmp') ? { graphTmp: opts.graphTmp } : {}),
                ...(Object.prototype.hasOwnProperty.call(opts, 'committedGraph') ? { mainGraph: opts.committedGraph } : {}),
            });
        }

        if (proposalAdded > 0 && result.branch !== 1) {
            trace.step(tr, 'commitRules', { added: proposalAdded, version: proposalVersion });
            traceFileSnapshots(tr);
            trace.end(tr);
            return {
                status: 'success', branch: result.branch, added: proposalAdded,
                version: proposalVersion,
                payload: { log: proposalLog || rulesLog.getRulesLog(), graph: proposalGraph },
            };
        }

        // --- Branch 1: новые сущности/ключи → правило с examples ---------------
        if (result.branch === 1 && Array.isArray(result.payload.newKeys) && result.payload.newKeys.length) {
            const latest = rulesLog.getLatestRules();
            // Dedupe ТОЛЬКО по зафиксированным правилам: temp-оверлеи (__tmp —
            // сессийные ключи Branch 1/2/3 этого же прогона) НЕ считаются «уже
            // зафиксированными» — на Save они как раз пересобираются в настоящий
            // appendRule. Если включить их в вокабуляр, Save вернёт noop и ключи
            // прогона никогда не зафиксируются.
            const vocab = new Set(structured.extractVocabulary({
                ...latest,
                dynamic: (latest.dynamic || []).filter((r) => r && !r.__tmp),
            }));
            // Dedupe: пропускаем ключи, уже зафиксированные в вокабуляре (INV-5: правила
            // не редактируются кодом напрямую — только через appendRule; повторы скипаются).
            const fresh = result.payload.newKeys.filter(
                (nk) => nk && typeof nk.key === 'string' && nk.key && !vocab.has(nk.key)
            );
            if (fresh.length === 0) {
                if (proposalAdded > 0) {
                    trace.step(tr, 'commitRules', { added: proposalAdded, version: proposalVersion });
                    traceFileSnapshots(tr);
                    trace.end(tr);
                    return {
                        status: 'success', branch: result.branch, added: proposalAdded,
                        version: proposalVersion,
                        payload: { log: proposalLog || rulesLog.getRulesLog(), graph: proposalGraph },
                    };
        }
                trace.step(tr, 'commitRules', { added: 0, version: rulesLog.getVersion() });
                trace.end(tr);
                return { status: 'noop', branch: result.branch || null, added: 0, version: rulesLog.getVersion() };
            }
            const keys = fresh.map((nk) => nk.key);
            // Расхождение №4 (эталоны TC-001/TC-002): формат правила Branch 1 —
            // { id, raw, mapping, examples } — БЕЗ semantics, БЕЗ roles, БЕЗ cues,
            // примеры группируются по формулировке (input) БЕЗ даты.
            const first = fresh[0];
            const rule = {
                id: rulesLog.nextRuleId(latest),
                // raw — ПОЛНЫЙ ввод прогона (один раз), из payload.next().
                raw: (result.payload.raw != null && typeof result.payload.raw === 'string')
                    ? result.payload.raw
                    : (first.input != null ? String(first.input) : ''),
                // mapping: ключ → «кусочек смысла» от LLM (nk.meaning); смысл может
                // отсутствовать — тогда значение = сам ключ.
                mapping: fresh.reduce((acc, nk) => {
                    acc[nk.key] = (nk.meaning && typeof nk.meaning === 'string' && nk.meaning) ? nk.meaning : nk.key;
                    return acc;
                }, {}),
                // Save may persist only LLM-provided, verbatim-grounded exercise spans.
                // Unprovided or ungrounded spans are omitted; event keys/values remain.
                examples: examplesFromGroundedKeys(fresh, result.payload.raw),
            };
            const meta = { ...(opts.meta || {}), proposedBy: 'commitRules', source: 'save-gate' };
            // SAVE FIX (2026-08-31): в браузере rulesLog.appendRule не может писать rulesLog.json
            // через fs (fs-shim бросает). Сначала пробуем штатный append (node пишет fs-ом);
            // при сбое записи вычисляем новый лог + запись В ПАМЯТИ (computeRuleEntry, INV-2:
            // ни одной записи) и возвращаем { log, graph } — UI пишет их через vaultWriter.
            let entry = null;
            let logObj = null;
            let persisted = false;
            try {
                entry = rulesLog.appendRule(rule, 'add', meta);
                persisted = true;
            } catch (_persistErr) {
                const computed = rulesLog.computeRuleEntry(rule, 'add', meta);
                entry = computed.entry;
                try { logObj = JSON.parse(JSON.stringify(computed.newLog)); } catch (_) { logObj = null; }
            }
            // F-1/F-2: граф отрисовки строится из зафиксированных правил + НОВЫХ ключей
            // (контракт превью-графа 2026-08-31). В node — пишем fs-ом; в браузере fs-запись
            // невозможна — возвращаем готовый graph в payload: UI пишет через vaultWriter.
            let graph = null;
            try {
                const rr = require('./renderRules.js');
                // Фикс (2026-08-31): в браузере rebuildGraphFromRules читает ВШИТЫЙ в шим
                // rulesLog (устаревший, без ролей свежего правила) — тренды терялись.
                // Строим граф из актуального набора: ключи правила (с ролями) + текущий лог.
                graph = (() => {
                    try {
                        const keysSet = new Set(keys);
                        const trendSet = new Set(Object.entries(rule.roles || {})
                            .filter(([, v]) => v === 'overlay' || v === 'trend').map(([k]) => k));
                        const g = rr.graphFromKeys(keysSet, trendSet);
                        // мержим с существующим логом (предыдущие trends/relations не теряем)
                        const prev = rr.rebuildGraphFromRules([]);
                        return {
                            relations: [...prev.relations, ...g.relations].filter((r, i, arr) =>
                                arr.findIndex((x) => JSON.stringify(x) === JSON.stringify(r)) === i),
                            targets: [...(prev.targets || []), ...(g.targets || [])].filter((t, i, a) => a.indexOf(t) === i),
                            trends: [...new Set([...(prev.trends || []), ...(g.trends || [])])],
                        };
                    } catch (_e) {
                        return rr.rebuildGraphFromRules(keys);
                    }
                })();
                // Branch 3 relations: мержим LLM-связи (payload.relations) и связи
                // temp-графа (graph.tmp.json) в построенный граф (без дублей).
                graph = commitGraphRelations(result, graph, {
                    ...(Object.prototype.hasOwnProperty.call(opts, 'graphTmp') ? { graphTmp: opts.graphTmp } : {}),
                    ...(Object.prototype.hasOwnProperty.call(opts, 'committedGraph') ? { mainGraph: opts.committedGraph } : {}),
                });
                if (persisted) {
                    try {
                        const fsMod = require('fs');
                        fsMod.writeFileSync(_graphFsPath, JSON.stringify({ relations: graph.relations || [] }, null, 2) + '\n', 'utf8');
                    } catch (_) { /* fs может быть браузерным шимом — тогда UI пишет сам */ }
                }
            } catch (_) { /* граф не блокирует сохранение */ }
            if (!logObj) {
                try { logObj = JSON.parse(JSON.stringify(rulesLog.getRulesLog())); } catch (_) { logObj = null; }
            }
            trace.step(tr, 'commitRules', { added: 1, version: entry.version });
            traceFileSnapshots(tr);
            trace.end(tr);
            return {
                status: 'success', branch: result.branch, added: proposalAdded + 1,
                version: entry.version, payload: { log: logObj, graph },
            };
                    }
                    // Трасса: сюда доходим при noop (нечего фиксировать) / неизвестной ветке.
                    trace.step(tr, 'commitRules', { added: 0, version: rulesLog.getVersion(), noop: true });
                    traceFileSnapshots(tr);
                    trace.end(tr);
                    if (proposalAdded > 0) {
                        trace.step(tr, 'commitRules', { added: proposalAdded, version: proposalVersion });
                        traceFileSnapshots(tr);
                        trace.end(tr);
                        return {
                            status: 'success', branch: result.branch, added: proposalAdded,
                            version: proposalVersion,
                            payload: {
                                log: proposalLog || rulesLog.getRulesLog(),
                                graph: proposalGraph,
                            },
                        };
                    }
                    return { status: 'noop', branch: result.branch || null, added: 0, version: rulesLog.getVersion() };
                } catch (e) {
                    trace.end(tr);
                    return { status: 'error', branch: (result && result.branch) || null, added: 0, message: `commitRules: ${(e && e.message) || String(e)}` };
                }
}

module.exports = {
    next,
    confirm,
    commitRules,
    // helpers (для тестов/повторного использования)
    normalizeConfidence,
    groundedSourceSpan,
    examplesFromGroundedKeys,
    mergePreviewEvents,
    mergeMinorExamplesIntoRules,
    snapMinorAppendToSource,
    mergeRuleUpdate,
    // fs-пути/хуки для тестов (Branch 3 relations → граф)
    _setGraphFsPath,
    _getGraphFsPath,
    mergeRelationsIntoGraph,
    commitGraphRelations,
    // Живые стадии обработки (LX-фидбек, opts.onStage)
    STAGES,
    STAGE_TEXT,
    stageTextOf,
};
