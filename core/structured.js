'use strict';
// core/structured.js — P-B/D9: Structured Event (LLM) + последние правила лога → JSON событий (Branch 1).
//
// РОЛЬ (D9, по заказчику): LLM — когнитивный движок принятия решения. Он на основе
// недетерминированных данных выбирает, какие детерминированные правила применить,
// и переводит недетерминированное в ДЕТЕРМИНИРОВАННЫЕ события (JSON, готовое к отрисовке).
//
// Детерминированный слой (этот модуль) — НЕ фильтр по формату, а:
//   (а) ВАЛИДАТОР СТРУКТУРЫ КОНТРАКТА — дата валидна (YYYY-MM-DD), values — объект
//       с числовыми значениями, ключи в формате "entity_metric";
//   (б) КОНТЕЙНЕР — оформляет события (immunтабельные через makeEvent) с
//       interpretation_version = версия правил из лога, готовые для рендера.
//
// КРИТИЧНО (устранение ловушки): модуль НЕ зовёт interpret()/match() как фильтр,
// НЕ отбрасывает валидный LLM-результат по формату входа (D9, AGENTS.md ПАМЯТКА).
// События строятся ИЗ ТОГО, ЧТО РАСПОЗНАЛА LLM (это когнитивный источник распознавания),
// но проходят структурную валидацию контракта и оформляются детерминированно.
//
// Идея иерархии правил (D10): LLM получает срез последних правил (из rulesLog), решает
// в порядке свежести; здесь события построены так, что могут использовать/ссылаться на
// зафиксированный в правилах вокабуляр. Новые сущности фиксируются на Save (Rule Evolution).

const { getLatestRules, getVersion } = require('./rulesLog.js');
const { callLLM } = require('./llmGateway.js');
const { makeEvent, isEvent } = require('./events.js');
const { validateKeyName } = require('./keyNaming.js');

// ---------------------------------------------------------------------------
// Вспомогательные помощники
// ---------------------------------------------------------------------------

/** Зажимает уверенность в [0, 1]; нечисло → 0. */
function normalizeConfidence(v) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return 0;
    return Math.min(1, Math.max(0, v));
}

/** Строковое представление `then` правила для таблицы правил. */
function renderThen(then) {
    if (!then || typeof then !== 'object') return '';
    const base = `${then.entity || '?'}_${then.metric || '?'}`;
    return then.composition ? `${base} (composition=${then.composition})` : base;
}

/**
 * Собирает зафиксированный вокабуляр `entity_metric` из правил лога (D11):
 * дедуплицированный, отсортированный список ключей `${entity}_${metric}` НЕ-deprecated правил.
 * Это то, что LLM обязана ПЕРЕИСПОЛЬЗОВАТЬ, а не пере-изобретать между прогонами.
 * Read-only для правил (INV-5): ничего не мутирует, только читает then.
 * @param {object} rules { version, dynamic[], global[] }
 * @returns {string[]} уникальные, отсортированные ключи entity_metric (или []).
 */
function extractVocabulary(rules) {
    if (!rules || typeof rules !== 'object') return [];
    const keys = new Set();
    const all = []
        .concat(Array.isArray(rules.dynamic) ? rules.dynamic : [])
        .concat(Array.isArray(rules.global) ? rules.global : []);
    for (const r of all) {
        if (!r || r.deprecated) continue;
        if (r.then && typeof r.then.entity === 'string' && typeof r.then.metric === 'string'
            && r.then.entity && r.then.metric) {
            keys.add(`${r.then.entity}_${r.then.metric}`);
        }
        // D10: правила, зафиксированные через commitRules (auto-save), несут вокабуляр
        // в mapping (ключи entity_metric), а не в then — учитываем их тоже.
        if (r.mapping && typeof r.mapping === 'object') {
            for (const k of Object.keys(r.mapping)) {
                if (typeof k === 'string' && k && k.includes('_')) keys.add(k);
            }
        }
    }
    return Array.from(keys).sort();
}

/**
 * Собирает текст для слота {{RULES}}: СРЕЗ последних правил + ЯВНЫЙ АКТУАЛЬНЫЙ ВОКАБУЛЯР
 * entity_metric (D11). LLM получает это «на вход», чтобы выбирать правила в порядке свежести и
 * ПЕРЕИСПОЛЬЗОВАТЬ уже созданные entity_metric (консистентность, D10), а не изобретать заново.
 * @param {object} rules { version, dynamic[], global[] }
 * @param {number} [maxRules] сколько последних правил включить (срез истории). default: все.
 * @returns {string} многострочный текст (или пустая строка).
 */
function buildRulesTable(rules, maxRules) {
    if (!rules || typeof rules !== 'object') return '';
    const lines = [];
    lines.push(`Актуальный вокабуляр сущностей (правила версии из лога: ${rules.version ?? '?'}):`);
    const vocab = extractVocabulary(rules);
    if (vocab.length > 0) {
        lines.push('Зафиксированные ключи entity_metric (переиспользуй их при распознавании):');
        lines.push(`  ${vocab.join(', ')}`);
    } else {
        lines.push('  (зафиксированных ключей нет — можно создавать новые)');
    }
    const sections = [
        ['dynamic (пользовательский диалект, самые свежие)', rules.dynamic],
        ['global (системный rulebook)', rules.global],
    ];
    for (const [title, arr] of sections) {
        lines.push(`[${title}]`);
        if (!Array.isArray(arr) || arr.length === 0) {
            lines.push('  (нет)');
            continue;
        }
        const list = (typeof maxRules === 'number' && maxRules > 0) ? arr.slice(-maxRules) : arr;
        for (const r of list) {
            if (!r || typeof r !== 'object') continue;
            const hasPattern = !!(r.when && typeof r.when.pattern === 'string');
            const hasMappingSemantics = (r.mapping && typeof r.mapping === 'object' && Object.keys(r.mapping).length > 0)
                || (typeof r.semantics === 'string' && r.semantics);
            const note = r.deprecated ? ' [deprecated]' : '';
            if (!hasPattern && hasMappingSemantics) {
                // Правило БЕЗ when.pattern, но с mapping/semantics (напр. tmp_session_keys):
                // печатаем по mapping/semantics — полная информация для LLM. Формат (§4):
                // raw/семантика ОДИН раз на правило + только разночтения по маппингу
                // (ключ → кусок текста), без дублей базового примера.
                const sem = (typeof r.semantics === 'string' && r.semantics) ? r.semantics : '(без semantics)';
                lines.push(`  - ${r.id}: "${sem}" -> ${renderThen(r.then)}${note}`);
                if (r.mapping && typeof r.mapping === 'object') {
                    for (const [k, chunk] of Object.entries(r.mapping)) {
                        lines.push(`      ключ ${k}: "${String(chunk)}"`);
                    }
                }
                if (Array.isArray(r.examples) && r.examples.length) {
                    for (const ex of r.examples.slice(-2)) {
                        const date = (ex && ex.date) ? ` (${ex.date})` : '';
                        const input0 = (ex && ex.input != null) ? String(ex.input) : '';
                        const values0 = (ex && ex.values) ? JSON.stringify(ex.values) : '';
                        if (input0 || values0) lines.push(`      пример${date}: "${input0}" -> ${values0}`);
                    }
                }
                continue;
            }
            const pattern = hasPattern ? r.when.pattern : '';
            lines.push(`  - ${r.id}: "${pattern}" -> ${renderThen(r.then)}${note}`);
            // D13: пример «как семантика перевелась в json» — LLM видит эталон входа,
            // чтобы надёжно соотнести похожий вход при следующем прогоне.
            if (Array.isArray(r.examples) && r.examples.length) {
                for (const ex of r.examples.slice(-2)) {
                    const date = (ex && ex.date) ? ` (${ex.date})` : '';
                    const input0 = (ex && ex.input != null) ? String(ex.input) : '';
                    const values0 = (ex && ex.values) ? JSON.stringify(ex.values) : '';
                    if (input0 || values0) lines.push(`      пример${date}: "${input0}" -> ${values0}`);
                }
            }
        }
    }
    return lines.join('\n');
}

/** Проверяет строку — валидная дата YYYY-MM-DD. */
function isValidDate(d) {
    if (typeof d !== 'string') return false;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
    const t = new Date(d + 'T00:00:00Z');
    return !Number.isNaN(t.getTime());
}

/** Проверяет "entity_metric" ключ: непустой, без посторонних. */
function isValidEntityMetricKey(k) {
    if (typeof k !== 'string') return false;
    const parts = k.split('_');
    if (parts.length < 2) return false;
    return parts.every((p) => /^[a-zA-Z0-9\u0400-\u04FF]+$/.test(p) && p.length > 0);
}

/**
 * Валидирует КАНДИДАТА события по структуре контракта (D9):
 * values — объект, все значения числовые и конечные, ключи entity_metric.
 * Возвращает нормализованного кандидата { date, values } или null (не проходит валидацию структуры).
 * НЕ оценивает по формату ввода (regex) — только по структуре контракта (D9).
 * ДАТА НЕ приходит от LLM: она определяется структурой ввода (таблица недели / opts.date).
 * Здесь дата кандидата — только как резерв, если контекст дату не дал.
 */
function validateCandidate(candidate) {
    if (!candidate || typeof candidate !== 'object') return null;
    if (!candidate.values || typeof candidate.values !== 'object' || Array.isArray(candidate.values)) {
        return null;
    }
    const values = {};
    for (const [k, v] of Object.entries(candidate.values)) {
        if (!isValidEntityMetricKey(k)) return null;
        if (typeof v !== 'number' || !Number.isFinite(v)) return null;
        values[k] = v;
    }
    if (Object.keys(values).length === 0) return null;
    // дата ОПЦИОНАЛЬНА: если LLM распознал валидную дату (из таблицы недели) — несём её как резерв;
    // иначе null (тогда structured подставит opts.date/контекст). Храним только валидную.
    const date = (typeof candidate.date === 'string' && isValidDate(candidate.date)) ? candidate.date : null;
    return { date, values };
}

/**
 * ПРИМИТИВ: приводит произвольный ответ LLM к массиву кандидатов {date, values}.
 * LLM может вернуть: массив кандидатов, объект {events:[...]}, вложенный объект {date,values}
 * (отсутствие трафарета по формату ввода — LLM свободна). Разворачиваем в единый список.
 */
function coerceCandidates(rawPayload) {
    if (!rawPayload) return [];
    const out = [];
    // массив кандидатов
    if (Array.isArray(rawPayload)) {
        for (const c of rawPayload) out.push(c);
        return out;
    }
    if (typeof rawPayload !== 'object') return [];
    // объект { events: [...] }
    if (Array.isArray(rawPayload.events)) {
        for (const c of rawPayload.events) out.push(c);
        return out;
    }
    // одиночный объект кандидата {date, values} (сам payload — один кандидат)
    if (typeof rawPayload.date === 'string' || (rawPayload.values && typeof rawPayload.values === 'object')) {
        out.push(rawPayload);
    }
    return out;
}

// ---------------------------------------------------------------------------
// Публичный API: structured(input, opts)
// ---------------------------------------------------------------------------

/**
 * Structured Event (Branch 1): LLM-кандидаты + СТРУКТУРНАЯ валидация контракта → события.
 *
 * @param {string} input сырая запись пользователя ('- 100 отжимания (макс за раз: 100)', ...).
 * @param {object} [opts]
 * @param {string} [opts.context] контекст (последние записи) → {{CONTEXT}}.
 * @param {string} [opts.date] дата события (YYYY-MM-DD). По умолчанию — сегодня.
 * @param {string} [opts.lastContext] (резерв; не фильтрует).
 * @param {object} [opts.llmOptions] пробрасывается в llmGateway.callLLM → adapters/llm.js chat().
 *                   { fetch } — инжектируемый fetch для unit-тестов без реальной сети.
 * @param {number} [opts.maxRules] срез последних правил в {{RULES}} (default: все).
 * @returns {Promise<{status:'success'|'error', payload:{events:Event[]}, confidence:number}>}
 *          События полные (isEvent), иммутабельны, interpretation_version = версия правил из лога.
 */
async function structured(input, opts = {}) {
    const context = opts.context || '';
    const fallbackDate = opts.date || new Date().toISOString().slice(0, 10);
    const llmOptions = (opts.llmOptions && typeof opts.llmOptions === 'object') ? opts.llmOptions : {};

    // 1-2. Последние правила из лога → текст правил + вокабуляр для {{RULES}} + версия.
    const latestRules = opts.rules && typeof opts.rules === 'object' ? opts.rules : getLatestRules();
    const table = buildRulesTable(latestRules, opts.maxRules);
    const cachedVersion = getVersion();
    const rulesVersion = Number.isInteger(opts.rules && opts.rules.version)
        ? opts.rules.version
        : (Number.isInteger(cachedVersion) ? cachedVersion : (latestRules.version || 0));

    // 3. LLM (mode='parse' как транспорт) → кандидаты событий.
    let llmResult;
    try {
        llmResult = await callLLM('parse', input, context, '', { ...llmOptions, rules: table });
    } catch (e) {
        llmResult = { status: 'error', payload: null, confidence: 0 };
    }
    if (!llmResult || typeof llmResult !== 'object' || llmResult.status !== 'success') {
        return { status: 'error', payload: { events: [] }, confidence: 0 };
    }

    // 4-5. Разворачиваем ответ LLM в список кандидатов (по одному на упражнение) +
    //    СТРУКТУРНАЯ валидация контракта (D9) + СЛИЯНИЕ в одно событие на дату.
    //    payload: { events, newKeys } — newKeys = новые entity_metric (D10, для commitRules).
    //    ДАТА: приоритет — распознанная LLM (из таблицы недели, по ячейкам); иначе
    //    opts.date/контекст; последний резерв — fallback-date. (D9)
    const rawCandidates = coerceCandidates(llmResult.payload);
    const byDate = new Map(); // date -> values (объединение)
    for (const c of rawCandidates) {
        const valid = validateCandidate(c);
        if (!valid) continue;
        // дата события: распознанная LLM (если есть и валидна) > opts.date/контекст > fallback.
        const date = (valid.date && isValidDate(valid.date) ? valid.date : null)
            || (isValidDate(opts.date) && String(opts.date))
            || fallbackDate;
        const existing = byDate.get(date) || {};
        byDate.set(date, { ...existing, ...valid.values });
    }

    // 5a. Контракт именования НОВЫХ ключей (запрос заказчика 2026-08-31): только латиница,
    //     snake_case, >=2 сегментов (группа_тип), семантические имена. Структурная валидация
    //     ВЫВОДА LLM (не парсинг входа). Ключи из вокабуляра не пере-проверяем (уже в логе).
    //     ОТКАЗОУСТОЙЧИВОСТЬ (2026-09-03): нарушение нейминга бракует ТОЛЬКО пару
    //     (ключ → значение), а не весь прогон (REQ-1: LLM не идеальна; детерминизм —
    //     верификатор, не guillotine). Забракованные ключи не теряются молча: они
    //     возвращаются в payload.namingIssues = [{key, reason}] + кратко в message.
    //     Статус 'ambiguous' — ТОЛЬКО если после отбраковки не осталось ни одного события.
    //     (Блок выполняется ДО построения событий 5b: отбраковка меняет byDate.)
    const vocabSet = new Set(extractVocabulary(latestRules));
    const namingIssues = [];
    for (const [dateKey, values] of byDate.entries()) {
        for (const key of Object.keys(values)) {
            if (vocabSet.has(key)) continue;
            const v = validateKeyName(key);
            if (!v.ok) {
                namingIssues.push({ key, reason: v.reason });
                delete values[key]; // бракуем пару ключ→значение, остальное живёт
            }
        }
        if (Object.keys(values).length === 0) byDate.delete(dateKey);
    }

    // 5b. Кандидаты → иммутабельные события (одно на дату, values слиты, AC6 — не перезаписываем существующее вне).
    const events = [];
    for (const [date, values] of byDate.entries()) {
        events.push(makeEvent({ date, values }, rulesVersion));
    }

    // 5c. D10: новые ключи entity_metric, отсутствующие в вокабуляре правил лога.
    //     Только СТРУКТУРНОЕ сравнение ключей результата с вокабуляром (это не парсинг входа —
    //     вход не разбирается детерминированно). Из newKeys на Save собирается правило
    //     с examples {input, date, values} (pipeline.commitRules, D10).
    //     (vocabSet вычислен в блоке 5a выше — там же отбраковка нейминга.)
    const seenKeys = new Set();
    const newKeys = [];
    const sourceSpansByDateKey = new Map();
    for (const candidate of rawCandidates) {
        const valid = validateCandidate(candidate);
        if (!valid || !candidate.sourceByKey || typeof candidate.sourceByKey !== 'object' || Array.isArray(candidate.sourceByKey)) continue;
        const date = (valid.date && isValidDate(valid.date) ? valid.date : null)
            || (isValidDate(opts.date) && String(opts.date))
            || fallbackDate;
        for (const key of Object.keys(valid.values)) {
            const span = candidate.sourceByKey[key];
            if (typeof span !== 'string' || !span.trim() || !input.includes(span)) continue;
            sourceSpansByDateKey.set(`${date}\u0000${key}`, span);
        }
    }
    // Роли ключей (2026-09-01, пересмотрено 2026-09-03 — расхождение №3): role-информация
    // LLM переводится в ГРАФОВЫЙ формат отношений и уходит в payload.relations
    // (A+B/overlay), а НЕ вливается в newKeys (раньше role оседала в правиле через
    // commitRules → roles — теперь роли отрисовки живут только в графе).
    // overlay-надстройка → { type:'overlay', base, sub }: база — stack-ключ той же
    // группы (первый сегмент ключа), если она однозначна; иначе связь не изобретается.
    // A+B-связи из ролей не выводятся — их LLM отдаёт явно через relations (Branch 3).
    const rolesFromLlm = {};
    for (const c of rawCandidates) {
        if (c && c.roles && typeof c.roles === 'object') {
            for (const [k, r] of Object.entries(c.roles)) {
                if (r === 'overlay' || r === 'trend' || r === 'stack') rolesFromLlm[k] = (r === 'trend') ? 'overlay' : r;
            }
        }
    }
    const roleRelations = [];
    {
        const overlayKeys = Object.keys(rolesFromLlm).filter((k) => rolesFromLlm[k] === 'overlay');
        const stackKeys = Object.keys(rolesFromLlm).filter((k) => rolesFromLlm[k] === 'stack');
        for (const sub of overlayKeys) {
            const grp = String(sub).split('_')[0];
            const bases = stackKeys.filter((k) => String(k).split('_')[0] === grp);
            if (bases.length !== 1) continue; // нет однозначной базы — связь не выдумываем
            roleRelations.push({ type: 'overlay', base: bases[0], sub });
        }
    }
    for (const [date, values] of byDate.entries()) {
        for (const [key, value] of Object.entries(values)) {
            if (vocabSet.has(key) || seenKeys.has(key)) continue;
            seenKeys.add(key);
            // роль в newKeys больше не несём (расхождение №3): она живёт в payload.relations
            const item = { key, input, date, values: { [key]: value } };
            const sourceSpan = sourceSpansByDateKey.get(`${date}\u0000${key}`);
            if (sourceSpan) item.sourceSpan = sourceSpan;
            newKeys.push(item);
        }
    }

    // 6. Если ничего не прошло структурную валидацию — контрактный error (LLM не дал структуры).
    //    Исключение: если события исчезли ИЗ-ЗА отбраковки нейминга — это 'ambiguous'
    //    (весь прогон состоял из плохих ключей), с перечнем причин.
    if (events.length === 0) {
        if (namingIssues.length > 0) {
            return {
                status: 'ambiguous',
                payload: { events: [], newKeys: [], namingIssues },
                confidence: normalizeConfidence(llmResult.confidence),
                message: `Все ключи нарушают контракт именования (латиница, <группа>_<тип>, семантические): ${namingIssues.map((n) => `${n.key} — ${n.reason}`).join('; ')}`,
            };
        }
        return { status: 'error', payload: { events: [], newKeys: [] }, confidence: 0 };
    }

    return {
        status: 'success',
        payload: {
            events,
            newKeys,
            // Роли отрисовки → графовый формат (расхождение №3): overlay/A+B-связи
            // из ответа LLM уходят в relations (для commitGraphRelations / превью-графа).
            relations: roleRelations,
            // Отбракованные по неймингу ключи не теряются молча (отказоустойчивый режим).
            ...(namingIssues.length > 0 ? { namingIssues } : {}),
        },
        confidence: normalizeConfidence(llmResult.confidence),
        ...(namingIssues.length > 0
            ? { message: `Отбракованы ключи с нарушением нейминга (латиница, <группа>_<тип>, семантические): ${namingIssues.map((n) => n.key).join('; ')}` }
            : {}),
    };
}

// Экспорт: функция-контракт + helpers (для тестов/повторного использования).
module.exports = structured;
structured.buildRulesTable = buildRulesTable;
structured.extractVocabulary = extractVocabulary;
structured.validateCandidate = validateCandidate;
structured.coerceCandidates = coerceCandidates;
structured.normalizeConfidence = normalizeConfidence;
structured.validateKeyName = validateKeyName;
