'use strict';
// core/conflict.js — P-C (Branch 2): Unknown/Conflict + Rule Proposal / Rule Evolution.
//
// Роль (ТЗ/ROADMAP, AC-R3/AC-R4): когда ввод не покрыт правилами Слоя 2 (незнакомое
// упражнение — пресс/присяд/велосипед и т.п.), этот модуль через LLM-наблюдателя
// РАСПОЗНАЁТ новую «метрику» и ПРЕДЛАГАЕТ новое правило отрисовки + пример-отрисовку
// (иммутабельные events). Подтверждение правила (Rule Evolution) записывается в лог
// правил через rulesLog.appendRule(rule, 'add', meta) — монотонная версия + иммутабельность.
//
// КЛЮЧЕВОЕ (AC10): LLM — НЕ источник истины. LLM только ПРЕДЛАГАЕТ семантику
// (entity/metric/composition) и «пример» для отрисовки. Окончательное добавление
// правила в лог происходит ТОЛЬКО при подтверждении (confirmProposal → appendRule).
// Сам модуль НЕ пишет в лог при генерации — только возвращает proposal.
//
// Чистый CommonJS: нет dv/app/DOM, работает под node --test.
// Импорты используют относительные пути внутри репозитория.

const { loadTemplate, substitute, validateResponse } =
    require('./llmGateway.js');
const { chat } = require('../adapters/llm.js');
const { appendRule, getLatestRules, formatRecentRules } =
    require('./rulesLog.js');
const { makeEvent } = require('./events.js');
const { DEFAULT_RULES, normalizeInput, match } =
    require('./rules.js');

// mode для транспорта — 'ruleUpdate' (Branch 3: промпт mode_RuleUpdate.md;
// read-only adapters, VALID_MODES жёсткий). Валидация остаётся детерминированной.
const TRANSPORT_MODE = 'ruleUpdate';

// Детерминированный нейминг-контроль ключей (цитата 2026-08-31 «Правила нейминга
// ключей»): только латиница в нижнем регистре, формат <группа>_<метрика> —
// минимум два сегмента через '_'. Никакой кириллицы/транслита — LLM о нейминге
// просит промпт, а здесь только СТРУКТУРНАЯ проверка.
const KEY_RE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/;

function isRecord(value) {
    return value && typeof value === 'object' && !Array.isArray(value);
}

/** Structural consistency only: recognition and meanings remain LLM-owned. */
function snapshotConsistencyIssue(payload, input) {
    const rule = payload && payload.rule;
    if (!payload || !rule || typeof payload.updateRuleId !== 'string' || !payload.updateRuleId.trim()) return null;
    if (!isRecord(rule.mapping) || !Array.isArray(rule.examples)) return 'missing_snapshot';

    const expectedKeys = new Set();
    for (const item of [...(Array.isArray(payload.oldKeysEvents) ? payload.oldKeysEvents : []),
        ...(Array.isArray(payload.newKeys) ? payload.newKeys : [])]) {
        if (!item || typeof item !== 'object') continue;
        if (typeof item.key === 'string' && KEY_RE.test(item.key)) expectedKeys.add(item.key);
        if (isRecord(item.values)) {
            for (const key of Object.keys(item.values)) {
                if (!KEY_RE.test(key)) return 'invalid_recognized_key';
                expectedKeys.add(key);
            }
            if (typeof item.key === 'string' && !Object.prototype.hasOwnProperty.call(item.values, item.key)) {
                return 'missing_recognized_value';
            }
        }
    }
    const mappingKeys = Object.keys(rule.mapping);
    if (!expectedKeys.size || mappingKeys.length !== expectedKeys.size
        || mappingKeys.some((key) => !expectedKeys.has(key))) return 'key_set_mismatch';
    for (const [key, meaning] of Object.entries(rule.mapping)) {
        if (!KEY_RE.test(key) || typeof meaning !== 'string' || !meaning.trim()) return 'invalid_mapping';
    }

    const recognizedValues = new Map();
    for (const item of [...(Array.isArray(payload.oldKeysEvents) ? payload.oldKeysEvents : []),
        ...(Array.isArray(payload.newKeys) ? payload.newKeys : [])]) {
        if (!item || !isRecord(item.values)) continue;
        for (const [key, value] of Object.entries(item.values)) {
            if (!expectedKeys.has(key) || !Number.isFinite(value)) return 'invalid_recognized_value';
            if (!recognizedValues.has(key)) recognizedValues.set(key, new Set());
            recognizedValues.get(key).add(value);
        }
    }
    const exampleValues = new Map();
    for (const example of rule.examples) {
        if (!example || typeof example.input !== 'string' || !example.input.trim()
            || example.input.trim() === String(input).trim() || !String(input).includes(example.input)
            || !isRecord(example.values) || !Object.keys(example.values).length) return 'invalid_example';
        for (const [key, value] of Object.entries(example.values)) {
            if (!expectedKeys.has(key) || !Number.isFinite(value)) return 'invalid_example_value';
            if (!recognizedValues.has(key) || !recognizedValues.get(key).has(value)) return 'unrecognized_value';
            if (!exampleValues.has(key)) exampleValues.set(key, new Set());
            exampleValues.get(key).add(value);
        }
    }
    for (const key of expectedKeys) {
        if (!recognizedValues.has(key)) return 'missing_recognized_value';
        if (!exampleValues.has(key)) return 'missing_key_example';
        for (const value of recognizedValues.get(key)) {
            if (!exampleValues.get(key).has(value)) return 'missing_value_example';
        }
    }
    return null;
}

function buildSnapshotRetryPrompt(input, payload) {
    const rawInput = String(input);
    const readableInput = rawInput.replace(/<br\s*\/?>/gi, '\n');
    const facts = {
        oldKeysEvents: (payload.oldKeysEvents || []).map((item) => item && ({
            key: item.key, chunk: item.chunk, values: item.values,
        })).filter(Boolean),
        newKeys: (payload.newKeys || []).map((item) => item && ({
            key: item.key, meaning: item.meaning,
            chunk: item.sourceSpan || item.chunk, values: item.values,
        })).filter(Boolean),
    };
    const oldKeys = new Set(facts.oldKeysEvents.flatMap((item) => [
        ...(typeof item.key === 'string' ? [item.key] : []),
        ...Object.keys(item.values || {}),
    ]));
    // Only existing keys get wording hints. New keys must be described from
    // their current source evidence rather than echoing a possibly loose draft.
    const previousMapping = isRecord(payload.rule?.mapping) ? payload.rule.mapping : {};
    const meaningHints = Object.fromEntries(Object.entries(previousMapping)
        .filter(([key, meaning]) => oldKeys.has(key)
            && typeof meaning === 'string' && meaning.trim())
        .map(([key, meaning]) => [key, meaning.trim()]));
    return [
        'Return only one JSON object with exactly two fields: "mapping" (object) and "examples" (array).',
        'Build the current active rule snapshot from this input only. Include every recognized key in mapping with a concise Russian exercise/metric meaning. Do not include historical examples, retired keys, dates, or extra fields.',
        'Each examples item MUST be an object with exactly "input" (an exact exercise fragment from the input) and "values" (an object of recognized key-number pairs). Never return examples as strings.',
        'Use the readable view only to see exercise boundaries: one exercise record (one line) per example. Do not combine separate lines. The source chunks are evidence hints, not a list of examples: do not make one example per key or fact. Combine old and new values only when they belong to the same exercise line.',
        'Each example input must be one contiguous exact substring of the original raw input. Do not copy the date marker, HTML tags, or list bullet into example input. Examples must cover every recognized key-number pair below.',
        'Use the supplied numbers exactly. Do not add or infer values. Treat previous meanings below as optional wording hints for existing keys: keep a short meaning when it still describes the exercise in this input, but remove variant qualifiers absent now. Do not add the word "повторения" unless needed to distinguish the metric. For a maximum-set metric, write a concise lower-case meaning in the form "максимальный подход <название упражнения в родительном падеже>" (for example: "максимальный подход отжиманий").',
        `Original raw input (authoritative source for exact substring checks):\n${rawInput}`,
        `Readable view (only <br> replaced with newlines for exercise boundaries):\n${readableInput}`,
        `Recognized values:\n${JSON.stringify(facts)}`,
        `Optional previous meanings for existing keys only:\n${JSON.stringify(meaningHints)}`,
        'Required shape: {"mapping":{"key":"краткий смысл"},"examples":[{"input":"точный фрагмент","values":{"key":123}}]}. The examples array contains objects only, never strings.',
    ].join('\n\n');
}

/** Сегодня (YYYY-MM-DD), по умолчанию для пример-отрисовки. */
function today() {
    return new Date().toISOString().slice(0, 10);
}

/**
 * Детерминированный следующий id правила (rule_NNN+1), в согласии с core/interpreter.js.
 * Это «инвариант» предложения: не зависит от слов LLM — только от текущих правил.
 */
function nextRuleId(rules) {
    const ids = [
        ...(Array.isArray(rules.dynamic) ? rules.dynamic : []),
        ...(Array.isArray(rules.global) ? rules.global : []),
    ].map((r) => r && r.id).filter(Boolean);
    let maxN = 0;
    for (const id of ids) {
        // tmp_rule_NNN (оверлей pipeline) резервирует тот же номер: без учёта tmp-
        // префикса следующий Branch 3 день снова выдаёт rule_001 → два правила с
        // одинаковым id (дубли tmp_rule_001 в трассе).
        const m = /^(?:tmp_)?rule_(\d+)$/.exec(id);
        if (m) maxN = Math.max(maxN, Number(m[1]));
    }
    return `rule_${String(maxN + 1).padStart(3, '0')}`;
}

/**
 * Строит безопасный capturing-pattern из входа (детерминированно, НЕ зависит от слов LLM):
 * всё экранируется (regex-спецсимволы), цифровые последовательности → группа (\d+),
 * пробелы → гибкие \s*. Пример: «пресс 30» → ^пресс\s*(\d+)$.
 */
function buildPattern(input) {
    const tokens = String(input).toLowerCase().split(/(\d+)/).filter((t) => t !== '');
    return '^' + tokens.map((t) => {
        if (/^\d+$/.test(t)) return '(\\d+)';                       // число → capture
        return t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*');
    }).join('') + '$';
}

/**
 * Выводит entity из ключей values кандидата. Все ключи должны иметь ОДИН префикс
 * entity (press_full, press_knee → 'press'). Если сущности разнобой — null (не можем
 * предложить одно правило).
 */
function deriveEntity(keys) {
    const entities = new Set(
        keys.map((k) => String(k).split('_')[0] || '').filter(Boolean)
    );
    if (entities.size !== 1) return null;
    return [...entities][0];
}

/**
 * Выводит { metric, composition } из ключей values кандидата (детерминированно). */
function deriveThen(entity, keys) {
    const baseKeys = keys.filter((k) => !/_max_set$/.test(k));
    const hasMax = keys.some((k) => /_max_set$/.test(k));
    if (hasMax && baseKeys.length >= 1) {
        return { metric: baseKeys[0].split('_').slice(1).join('_'), composition: 'max' };
    }
    if (keys.length >= 2) {
        return { metric: keys[0].split('_').slice(1).join('_'), composition: 'A+B' };
    }
    return { metric: keys[0].split('_').slice(1).join('_') || 'full', composition: 'single' };
}

/**
 * Собирает пример «как семантика перевелась в json» (D13): из исходного ввода и
 * распознанного кандидата. Это то, что LLM увидит в {{RULES}} при следующем прогоне,
 * чтобы соотнести похожий вход. Может вернуть null, если нет ни ввода, ни даты.
 * @param {string} input сырой ввод пользователя.
 * @param {object} candidate распознанный кандидат { date?, values }.
 * @param {object} [opts] { date? } — дата из контекста, если в кандидате нет.
 * @returns {{input, date, values}|null}
 */
function buildExample(input, candidate, opts = {}) {
    if (typeof input !== 'string' || !input.trim()) return null;
    if (!candidate || !candidate.values || typeof candidate.values !== 'object') return null;
    const date = (candidate.date && String(candidate.date).trim()) || (opts.date && String(opts.date).trim()) || '';
    return { input, date, values: candidate.values };
}

/**
 * Пример-ОТРИСОВКА предложенного правила на входе: иммутабельные события через makeEvent.
 * Реально «прогоняем» правило по входу через match (правило сработало → production),
 * version — предлагаемая версия правил (текущая + 1 по умолчанию).
 */
function renderExample(rule, input, opts = {}) {
    const baseRules = opts.rules || DEFAULT_RULES;
    const version = Number.isInteger(opts.interpretationVersion)
        ? opts.interpretationVersion
        : (baseRules.version + 1);
    const matchRules = { version, dynamic: [rule], global: [] };
    const { candidates } = match(normalizeInput(input), opts.context || null, matchRules);
    const events = [];
    for (const c of candidates) {
        if (c && c.production) {
            events.push(makeEvent(
                { date: opts.date || today(), values: c.production },
                version
            ));
        }
    }
    return events;
}

/** Build preview rows from values already proposed by the LLM. */
function previewEventsFromNewKeys(newKeys, opts = {}) {
    const byDate = new Map();
    const version = Number.isInteger(opts.interpretationVersion)
        ? opts.interpretationVersion
        : (((opts.rules && opts.rules.version) || DEFAULT_RULES.version) + 1);
    for (const item of newKeys || []) {
        if (!item || typeof item !== 'object' || !item.values || typeof item.values !== 'object') continue;
        const date = (typeof item.date === 'string' && item.date.trim())
            || (typeof opts.date === 'string' && opts.date.trim())
            || today();
        if (!byDate.has(date)) byDate.set(date, {});
        const values = byDate.get(date);
        for (const [key, value] of Object.entries(item.values)) {
            if (!Number.isFinite(value)) continue;
            if (Object.prototype.hasOwnProperty.call(values, key) && values[key] !== value) return null;
            values[key] = value;
        }
    }
    return [...byDate.entries()]
        .filter(([, values]) => Object.keys(values).length)
        .map(([date, values]) => makeEvent({ date, values }, version));
}

/**
 * Собирает текст для слота RULES (инструкция наблюдателю) из исходного входа.
 * Само проецирование в шаблон делает callLLM через substitute (loadTemplate + substitute).
 */
function buildTableText(input, opts = {}) {
    const lines = [
        'НОВЫЕ ДАННЫЕ (новые упражнения, НЕ покрытые текущими правилами отрисовки).',
        'Распознай их и верни массив кандидатов {date, values} строго по «Формату ответа».',
        'Ключи values — "<entity>_<metric>", например press_full; для A+B добавь второй ключ,',
        'для max — ключ *_max_set. Дата известна из контекста.',
        '',
        String(input),
    ];
    return lines.join('\n');
}

/**
 * Строит предложение из ответа НОВОГО контракта mode_RuleUpdate.md:
 * payload { rule: {semantics, keys:[{key, role}], composition}, oldKeysEvents: [...],
 * newKeys: [...], relations: [...] }.
 *
 * НОВЫЙ ФОРМАТ (расхождение №4, эталон TC-001/TC-002): правило = { id, raw, mapping,
 * examples[{input, values}] } — без semantics/when/then/roles/__version. raw — полный
 * ввод прогона дословно; mapping — ключ → кусочек смысла; examples — без дат.
 * Валидны также ЛЕГАси-правила с when/then (обратная совместимость).
 * Ключи всех групп одного Branch 3 ввода входят в одну запись правила.
 * Возвращает null, если валидных ключей нет.
 */
function buildProposalFromRuleUpdate(response, input, opts = {}) {
    const payload = response && response.payload;
    const r = payload && payload.rule;
    if (!r || typeof r !== 'object') return null;
    const rawKeys = Array.isArray(r.keys) ? r.keys : [];
    const newKeysAll = (Array.isArray(payload.newKeys) ? payload.newKeys : [])
        .filter((e) => e && typeof e === 'object' && typeof e.key === 'string' && KEY_RE.test(e.key));
    // Структурный нейминг-контроль: кириллица/транслит/без 'группа_метрика' — отбраковка.
    const keyByName = new Map(rawKeys
        .map((k) => (typeof k === 'string' ? { key: k } : k))
        .filter((k) => k && typeof k.key === 'string' && KEY_RE.test(k.key))
        .map((k) => [k.key, k]));
    // `newKeys` is the authoritative list of measurements introduced by this
    // proposal. Some model responses omit/partially fill rule.keys; retain their
    // validated new-key definitions instead of dropping an otherwise usable day.
    for (const nk of newKeysAll) {
        if (!keyByName.has(nk.key)) keyByName.set(nk.key, { key: nk.key, meaning: nk.meaning });
    }
    const keys = [...keyByName.values()];
    if (keys.length === 0) return null;

    const keyNames = keys.map((k) => k.key);
    // Branch 3 (канва 2026-09-02): может быть НЕСКОЛЬКО новых упражнений за раз →
    // несколько групп ключей (по первой сегмент-группе: pushups_reps → 'pushups').
    // Раньше здесь стоял deriveEntity(keyNames) с требованием ровно одной группы —
    // из-за этого multi-group ввод (напр. отжимания + жим от груди) давал null.
    // Entity-группы нужны для примеров отрисовки; правило одно на ввод.
    const groups = new Map(); // prefix -> { keys: [{key, role}], newKeys: [...] }
    for (const k of keys) {
        const prefix = String(k.key).split('_')[0] || '';
        if (!groups.has(prefix)) groups.set(prefix, { keys: [], newKeys: [] });
        groups.get(prefix).keys.push(k);
    }
    for (const nk of newKeysAll) {
        const prefix = String(nk.key).split('_')[0] || '';
        if (!groups.has(prefix)) continue; // newKey без валидного ключа в rule.keys — пропускаем
        groups.get(prefix).newKeys.push(nk);
    }
    const sourceSpanOf = (nk) => {
        const span = typeof nk?.sourceSpan === 'string' ? nk.sourceSpan : nk?.chunk;
        if (typeof span !== 'string' || !span.trim() || !String(input).includes(span)) return null;
        // The whole day cannot serve as a per-exercise example. This also means
        // a one-exercise day that equals the whole input may have no example.
        if (span.trim() === String(input).trim()) return null;
        return span;
    };

    const baseRules = opts.rules || (() => {
        try { return getLatestRules(); } catch (_) { return DEFAULT_RULES; }
    })();
    const requestedUpdateId = typeof payload.updateRuleId === 'string' && payload.updateRuleId.trim()
        ? payload.updateRuleId.trim()
        : null;
    const knownRuleIds = new Set([
        ...(Array.isArray(baseRules.dynamic) ? baseRules.dynamic : []),
        ...(Array.isArray(baseRules.global) ? baseRules.global : []),
    ].map((item) => item && item.id).filter(Boolean));
    if (requestedUpdateId && !knownRuleIds.has(requestedUpdateId)) return null;

    const rules = [];
    const modelPreviewEvents = previewEventsFromNewKeys(newKeysAll, { ...opts, rules: baseRules });
    if (newKeysAll.length && modelPreviewEvents === null) return null;
    const exampleEvents = modelPreviewEvents || [];
    // Пул правил для генерации id: каждая следующая группа должна получить
    // СВОБОДНЫЙ rule_NNN (предыдущие группы расширяют пул в памяти).
    let rulePool = baseRules;
    // НОВЫЙ ФОРМАТ ПРАВИЛА (расхождение №4, эталон TC-001/TC-002):
    // правило = { id, raw, mapping, examples } — БЕЗ semantics/when/then/roles/__version.
    // raw — ПОЛНЫЙ ввод прогона, один раз, дословно. mapping — ключ → кусочек смысла
    // (от LLM: payload.rule.keys[].meaning; fallback = сам ключ). examples — по
    // формулировке-куску, БЕЗ дат. Отрисовку (exampleEvents) делаем по ВРЕМЕННОЙ
    // when/then-форме, которая в правило НЕ попадает.
    // g передаётся явно: замыкание над `g` из цикла ниже невозможно (хелпер объявлен ДО цикла).
    const meaningOf = (key, g) => {
        const k = keys.find((x) => x.key === key);
        if (k && typeof k.meaning === 'string' && k.meaning.trim()) return k.meaning.trim();
        const nk = (g && Array.isArray(g.newKeys) ? g.newKeys : []).find((x) => x && x.key === key && typeof x.meaning === 'string' && x.meaning.trim());
        return nk ? nk.meaning.trim() : key; // fallback: сам ключ
    };
    for (const [entity, g] of groups) {
        const gKeyNames = g.keys.map((k) => k.key);
        const derived = deriveThen(entity, gKeyNames);
        const composition = (typeof r.composition === 'string' && r.composition.trim())
            ? r.composition.trim()
            : derived.composition;
        // При нескольких кусках: pattern по первому куску newKeys ГРУППЫ (не весь ввод) —
        // только для пример-отрисовки (временная when/then-форма).
        const firstChunk = g.newKeys.map(sourceSpanOf).find(Boolean);
        const patternInput = firstChunk || '';
        const rule = {
            // opts.id (явный id) — только для ПЕРВОГО правила; остальным — свободные id из пула.
            id: rules.length === 0 && requestedUpdateId
                ? requestedUpdateId
                : (rules.length === 0 && opts.id && String(opts.id).trim())
                    ? String(opts.id).trim()
                    : nextRuleId(rulePool),
            // raw — весь ввод прогона, ОДИН раз, дословно (эталон TC-001).
            raw: typeof opts.rawInput === 'string' ? opts.rawInput : String(input),
            // mapping: ключ → кусочек смысла (из LLM; fallback = сам ключ).
            mapping: gKeyNames.reduce((acc, k) => { acc[k] = meaningOf(k, g); return acc; }, {}),
            // D13: примеры «как семантика перевелась в json» — по формулировке-куску,
            // БЕЗ дат (эталон TC-001: примеры без даты).
            examples: (() => {
                const byChunk = new Map();
                for (const nk of g.newKeys) {
                    if (!nk || typeof nk !== 'object') continue;
                    const chunk = sourceSpanOf(nk);
                    if (!chunk) continue;
                    const values = (nk.values && typeof nk.values === 'object') ? nk.values : {};
                    if (!byChunk.has(chunk)) byChunk.set(chunk, { input: chunk, values: {} });
                    Object.assign(byChunk.get(chunk).values, values);
                }
                return [...byChunk.values()];
            })(),
        };
        rules.push(rule);
        // Пример-отрисовка — через временную when/then-форму (в правило не попадает).
        const transient = {
            id: rule.id,
            when: { pattern: buildPattern(patternInput) },
            then: { entity, metric: derived.metric, composition },
        };
        if (!newKeysAll.length) exampleEvents.push(...renderExample(transient, patternInput, opts));
        rulePool = { ...rulePool, dynamic: [...(rulePool.dynamic || []), rule] };
    }
    if (rules.length === 0) return null;
    // Дедупликация id внутри группы (защита от дублей rule_NNN — в трассе были два
    // tmp_rule_001): дубли ломают оверлей (tmp_<id>) и appendRule на Save. Если дубль
    // всё же появился — выдаём свободный id из пула (пул расширяется на каждую выдачу).
    const seenIds = new Set();
    for (const r of rules) {
        while (seenIds.has(r.id)) {
            const fresh = nextRuleId(rulePool);
            rulePool = { ...rulePool, dynamic: [...(rulePool.dynamic || []), { id: fresh }] };
            r.id = fresh;
        }
        seenIds.add(r.id);
    }
    // TC-001 uses one Rule Evolution record for the complete input batch. Keep
    // entity groups for rendering, but combine their mappings/examples into the
    // single versioned rule that will be staged and saved.
    if (rules.length > 1) {
        const combinedMapping = {};
        const examplesByInput = new Map();
        for (const part of rules) {
            Object.assign(combinedMapping, part.mapping || {});
            for (const ex of part.examples || []) {
                if (!examplesByInput.has(ex.input)) examplesByInput.set(ex.input, { input: ex.input, values: {} });
                Object.assign(examplesByInput.get(ex.input).values, ex.values || {});
            }
        }
        rules.splice(0, rules.length, {
            id: rules[0].id,
            raw: typeof opts.rawInput === 'string' ? opts.rawInput : String(input),
            mapping: combinedMapping,
            examples: [...examplesByInput.values()],
        });
    }
    const rule = rules[0];

    // Some updates replace the active vocabulary wholesale (for example when
    // an exercise drops an old variant and adds a max metric). In that case the
    // model may return a complete rule snapshot alongside the incremental
    // oldKeysEvents/newKeys split. Accept that snapshot only when both mapping
    // and examples are present and structurally valid. The marker is internal:
    // Save can replace the prior mapping/examples without guessing which keys
    // the user intended to retire. Recognition and meanings remain model-owned.
    const hasSnapshotMapping = Object.prototype.hasOwnProperty.call(r, 'mapping');
    const hasSnapshotExamples = Object.prototype.hasOwnProperty.call(r, 'examples');
    if (hasSnapshotMapping || hasSnapshotExamples) {
        const isRecord = (value) => value && typeof value === 'object' && !Array.isArray(value);
        if (!hasSnapshotMapping || !hasSnapshotExamples || !isRecord(r.mapping) || !Array.isArray(r.examples)) return null;
        const snapshotMapping = {};
        for (const [key, meaning] of Object.entries(r.mapping)) {
            if (!KEY_RE.test(key) || typeof meaning !== 'string' || !meaning.trim()) return null;
            snapshotMapping[key] = meaning.trim();
        }
        if (!Object.keys(snapshotMapping).length) return null;
        const snapshotExamples = [];
        for (const example of r.examples) {
            const invalidSourceExample = !example || typeof example !== 'object'
                || typeof example.input !== 'string' || !example.input.trim()
                || !String(input).includes(example.input)
                || example.input.trim() === String(input).trim()
                || !isRecord(example.values) || !Object.keys(example.values).length;
            // A malformed citation on a new rule must not discard otherwise valid
            // values for the whole day. Updates remain strict because their examples
            // form part of a replacement snapshot and get the consistency retry.
            if (invalidSourceExample) {
                if (requestedUpdateId) return null;
                continue;
            }
            const values = {};
            let invalidValue = false;
            for (const [key, value] of Object.entries(example.values)) {
                if (!Object.prototype.hasOwnProperty.call(snapshotMapping, key)
                    || typeof value !== 'number' || !Number.isFinite(value)) {
                    invalidValue = true;
                    break;
                }
                values[key] = value;
            }
            if (invalidValue) {
                if (requestedUpdateId) return null;
                continue;
            }
            const rawInput = String(input);
            const withoutListMarker = example.input.startsWith('- ')
                ? example.input.slice(2) : example.input;
            const markerIndex = example.input.startsWith('- ')
                ? rawInput.indexOf(example.input) : -1;
            const linePrefix = markerIndex >= 0 ? rawInput.slice(0, markerIndex) : '';
            const atLineStart = markerIndex === 0
                || /(?:<br\s*\/?\s*>|\r?\n)\s*$/.test(linePrefix);
            const exampleInput = atLineStart && rawInput.includes(withoutListMarker)
                ? withoutListMarker : example.input;
            snapshotExamples.push({ input: exampleInput, values });
        }
        rule.mapping = snapshotMapping;
        rule.examples = snapshotExamples;
        rule.completeSnapshot = true;
    }

    // Разделение данных: старые куски (для повторного перевода через structured)
    // и новые ключи — отдаём пайплайну как есть (дослОВНО).
    const oldKeysEvents = (Array.isArray(payload.oldKeysEvents) ? payload.oldKeysEvents : [])
        .filter((e) => e && typeof e === 'object' && typeof e.key === 'string' && e.key
            && typeof e.chunk === 'string' && e.chunk.trim());
    const oldChunks = [...new Set(oldKeysEvents.map((e) => e.chunk.trim()))];
    const relations = Array.isArray(payload.relations) ? payload.relations : [];

    // Контракт (2026-09-02): rules — ВСЕ группы (основной путь для confirm/commitRules);
    // rule — главное правило первой группы (обратная совместимость с UI/тестами).
    return {
        rules, rule, exampleEvents, oldKeysEvents, oldChunks, newKeys: newKeysAll, relations,
        updateRuleId: requestedUpdateId,
    };
}

/**
 * Нормализует ответ LLM (payload — массив кандидатов {date, values}) в контрактную
 * форму правила { id?, when:{pattern}, then:{entity, metric, composition}, __version? }
 * + пример-отрисовку. Возвращает null, если правило не удалось построить.
 *
 * Инвариант AC10: семантику тогда (entity/metric/composition) даёт LLM-наблюдатель,
 * а ВЕСЬ контрактный остаток (id, when.pattern, __version, exampleEvents) — детерминированно
 * строит МОДУЛЬ. Поэтому два разных LLM-ответа с той же семантикой дают согласованный результат.
 */
function buildProposal(response, input, opts = {}) {
    const payload = response && response.payload;
    // Новый контракт mode_RuleUpdate.md (payload.rule + oldKeysEvents/newKeys).
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
        return buildProposalFromRuleUpdate(response, input, opts);
    }
    // Легаси-контракт (payload — массив кандидатов {date, values}) — совместимость
    // со старыми прогонами/тестами.
    if (!Array.isArray(payload) || payload.length === 0) return null;

    // Берём первый кандидат с распознанными values (новая метрика).
    const candidate = payload.find((c) => c && c.values
        && typeof c.values === 'object' && Object.keys(c.values).length > 0);
    if (!candidate) return null;

    const keys = Object.keys(candidate.values);
    const entity = deriveEntity(keys);
    if (!entity) return null;
    const { metric, composition } = deriveThen(entity, keys);

    // Фикс (2026-09-01): id кандидата должен быть свободным ОТНОСИТЕЛЬНО ТЕКУЩЕГО ЛОГА
    // (раньше брался от DEFAULT_RULES → 'rule_001' при занятом rule_001 → appendRule падал
    // «правило с id 'rule_001' уже существует» после первых же зафиксированных правил).
    const baseRules = opts.rules || (() => {
        try { return getLatestRules(); } catch (_) { return DEFAULT_RULES; }
    })();
    const rule = {
        id: (opts.id && String(opts.id).trim()) || nextRuleId(baseRules),
        __version: 1,
        when: { pattern: buildPattern(input) },
        then: { entity, metric, composition },
        // D13: пример «как семантика перевелась в json» (сырой ввод, дата, результат).
        // LLM увидит его в {{RULES}} и сможет соотнести похожий вход при следующем прогоне.
        examples: [buildExample(input, candidate, opts)].filter(Boolean),
    };
    const exampleEvents = renderExample(rule, input, opts);
    return { rule, exampleEvents };
}

/**
 * ПРЕДЛОЖЕНИЕ ПРАВИЛА для Unknown/Conflict (AC-R3, Branch 2).
 *
 * 1. Генерирует промпт через llmGateway (loadTemplate + substitute + callLLM; mode='parse'
 *    как транспорт — read-only adapters).
 * 2. Валидирует ответ через validateResponse.
 * 3. Строит предложенное правило (LLM даёт semantic-кандидата, модуль нормализует).
 * 4. Строит пример-отрисовку (иммутабельные events через makeEvent).
 *
 * Модуль НЕ пишет в лог — только возвращает proposal. Подтверждение — confirmProposal.
 *
 * @param {string} input новая/непокрытая запись ('пресс 30 присяд 50', ...).
 * @param {object} [opts]
 * @param {object} [opts.llmOptions] пробрасывается в callLLM (напр. {fetch, model, url}).
 * @param {string} [opts.context] контекст (последние записи) — слот {{CONTEXT}}.
 * @param {string} [opts.date] дата пример-отрисовки (default сегодня).
 * @param {object} [opts.rules] текущие правила (default DEFAULT_RULES).
 * @param {number} [opts.interpretationVersion] версия правил для пример-отрисовки.
 * @returns {Promise<{status:'success'|'error', payload:{rule, exampleEvents:Event[]}|null, confidence, reason?}>}
 */
async function proposeRule(input, opts = {}) {
    if (typeof input !== 'string' || input.trim() === '') {
        return { status: 'error', payload: null, confidence: 0, reason: 'Пустой ввод' };
    }

    const table = buildTableText(input, opts);
    const context = opts.context || '';
    // {{RULES}} — срез последних правил отрисовки (для разделения данных на
    // «старые ключи» / «новые ключи»): opts.rules (готовый текст) или logs-срез.
    let rulesText = (typeof opts.rules === 'string') ? opts.rules : '';
    if (!rulesText) {
        try { rulesText = formatRecentRules(2); } catch (_e) { rulesText = ''; }
    }
    const llmOptions = { ...((opts && opts.llmOptions) || {}), rules: rulesText };

    // 1. Транспорт: loadTemplate('RuleUpdate') + substitute + chat (adapters/llm.js).
    //    chat() вызывается НАПРЯМУЮ (не через callLLM), чтобы транспортный error дошёл
    //    сюда вместе с причиной (поле error) — validateResponse на шлюзе его отбрасывал.
    let response;
    try {
        const template = loadTemplate(TRANSPORT_MODE);
        const promptText = substitute(template, { table, context, input, rules: rulesText });
        response = await chat(promptText, TRANSPORT_MODE, llmOptions);
    } catch (e) {
        // Причина пробрасывается наверх (diagnostика транспорта): chat() кладёт
        // поле error (текст сетевого сбоя/HTTP-статуса) — включаем в reason.
        const cause = (e && (e.error || e.message)) || String(e);
        return { status: 'error', payload: null, confidence: 0, reason: `LLM-вызов упал: ${cause}` };
    }
    // Транспортный сбой (chat() never throws — возвращает контрактный error c полем error).
    if (response && response.status === 'error') {
        return {
            status: 'error', payload: null, confidence: 0,
            reason: `LLM-вызов упал: ${response.error || 'нет ответа транспорта'}`,
        };
    }

    // 2. Валидация контракта ответа.
    try {
        response = validateResponse(response);
    } catch (_e) {
        return { status: 'error', payload: null, confidence: 0, reason: 'Невалидный ответ LLM' };
    }
    if (response.status !== 'success') {
        return {
            status: 'error',
            payload: null,
            confidence: response.confidence,
            reason: `LLM вернул status '${response.status}'`,
        };
    }

    // An existing-rule update may need a compact second pass when its proposed
    // full snapshot contradicts the first pass's recognized facts. The retry
    // sees no historical examples, and can only restate this candidate snapshot.
    if (response.payload && typeof response.payload === 'object'
        && typeof response.payload.updateRuleId === 'string'
        && response.payload.updateRuleId.trim()) {
        const issue = snapshotConsistencyIssue(response.payload, input);
        if (issue) {
            let retry;
            try {
                retry = await chat(buildSnapshotRetryPrompt(input, response.payload), TRANSPORT_MODE, llmOptions);
            } catch (e) {
                const cause = (e && (e.error || e.message)) || String(e);
                return { status: 'error', payload: null, confidence: response.confidence,
                    reason: `Снимок правила не согласован (${issue}); повторный LLM-вызов упал: ${cause}` };
            }
            if (!retry || retry.status !== 'success' || !isRecord(retry.payload)) {
                return { status: 'error', payload: null, confidence: response.confidence,
                    reason: `Снимок правила не согласован (${issue}); повторная генерация не удалась` };
            }
            const retryRule = retry.payload.rule || retry.payload;
            const repairedPayload = {
                ...response.payload,
                rule: { ...response.payload.rule, mapping: retryRule.mapping, examples: retryRule.examples },
            };
            const retryIssue = snapshotConsistencyIssue(repairedPayload, input);
            if (retryIssue) {
                return { status: 'error', payload: null, confidence: response.confidence,
                    reason: `Снимок правила не согласован после повтора (${retryIssue})` };
            }
            response = { ...response, payload: repairedPayload };
        }
    }

    // 3-4. Нормализация в правило + пример-отрисовка.
    // opts.rules-СТРОКА ({{RULES}}) — только для промпта; детерминированные
    // buildProposal/renderExample ждут объект правил (version/dynamic).
    const built = buildProposal(response, input, {
        ...opts,
        rules: (opts.rules && typeof opts.rules === 'object') ? opts.rules : undefined,
    });
    if (!built) {
        return {
            status: 'error',
            payload: null,
            confidence: response.confidence,
            reason: 'Не удалось построить правило из ответа LLM',
        };
    }

    return {
        status: 'success',
        payload: {
            // Branch 3 multi-group (2026-09-02): правила ВСЕХ групп + главное (rules[0])
            // для обратной совместимости downstream (UI/confirm/commitRules).
            rules: built.rules || [built.rule],
            rule: built.rule,
            exampleEvents: built.exampleEvents,
            // Разделение данных (Branch 3): старые куски — кандидаты на перевод по
            // старым правилам (structured), новые ключи — для нового правила.
            oldKeysEvents: built.oldKeysEvents || [],
            oldChunks: built.oldChunks || [],
            newKeys: built.newKeys || [],
            relations: built.relations || [],
            updateRuleId: built.updateRuleId || null,
        },
        confidence: response.confidence,
    };
}

/**
 * ПОДТВЕРЖДЕНИЕ / EВОЛЮЦИЯ ПРАВИЛА (AC-R4, Rule Evolution).
 * Принимает proposal и записывает правило в лог отрисовки через rulesLog.appendRule
 * (rule, 'add', meta) — это проверяет иммутабельность и монотонность версий.
 * Модуль генерирует id, если предложенное правило его не имеет.
 *
 * @param {object} proposal { rule: Rule, exampleEvents?, rationale? }.
 * @param {object} [opts.meta] доп. метаданные для entry.
 * @returns {Promise<{status:'success', payload:{entry, version}}>}
 * @throws {TypeError} если правило невалидно (нет when/then) — программистская ошибка.
 */
async function confirmProposal(proposal, opts = {}) {
    if (!proposal || !proposal.rule || typeof proposal.rule !== 'object') {
        throw new TypeError('conflict: confirmProposal требует proposal.rule');
    }
    const rule = { ...proposal.rule };
    // НОВЫЙ ФОРМАТ: правило { id, raw, mapping, examples } БЕЗ when/then — валидно.
    // ЛЕГАси: when.pattern + then{entity, metric}. Должно быть хотя бы одно из двух.
    const legacyShape = rule.when && rule.when.pattern && rule.then && rule.then.entity && rule.then.metric;
    const newShape = (typeof rule.raw === 'string' && rule.raw.trim())
        || (rule.mapping && typeof rule.mapping === 'object' && Object.keys(rule.mapping).length > 0);
    if (!legacyShape && !newShape) {
        throw new TypeError('conflict: правило должно иметь when.pattern+then{entity, metric} ИЛИ raw/mapping (новый формат)');
    }
    // appendRule требует уникальный id + changeType 'add'; если id пуст — генерируем (уникальный).
    if (!rule.id || String(rule.id).trim() === '') {
        rule.id = nextRuleId(getLatestRules());
    }

    // Legacy proposals may construct an example from their single input/candidate.
    // RuleUpdate proposals carry per-key source citations; an empty examples list
    // there means no safe citation was supplied, so never replace it with the full day.
    const sourceCitedProposal = Array.isArray(proposal.newKeys) && Array.isArray(proposal.rules);
    const ex = (Array.isArray(rule.examples) && rule.examples.length)
        ? rule.examples
        : (sourceCitedProposal ? []
            : (buildExample(proposal.input, proposal.candidate || proposal, proposal)
                ? [buildExample(proposal.input, proposal.candidate || proposal, proposal)] : []));
    if (ex.length) rule.examples = ex;

    const meta = {
        ...(opts.meta || {}),
        proposedBy: 'conflict',
        source: 'unknown-conflict',
    };
    if (proposal.rationale) meta.rationale = proposal.rationale;

    const changeType = proposal.changeType === 'update' ? 'update' : 'add';
    const entry = appendRule(rule, changeType, meta);
    return { status: 'success', payload: { entry, version: entry.version } };
}

module.exports = {
    proposeRule,
    confirmProposal,
    // helpers (для тестов/повторного использования)
    nextRuleId,
    buildPattern,
    buildProposal,
    buildProposalFromRuleUpdate,
    deriveEntity,
    deriveThen,
    buildExample,
    renderExample,
    KEY_RE,
};
