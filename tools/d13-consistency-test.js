'use strict';
// tools/d13-consistency-test.js — целевой тест D13: улучшают ли examples в {{RULES}}
// стабильность ключей распознавания? Прогон одних и тех же входов до/после через
// core/structured.js против РЕАЛЬНОЙ Ollama (localhost:11434, модель из adapters/llm.js).
//
// Режимы:
//   A = срез правил С examples (examples добавлены в тестовый снапшот — реальный
//       data/rulesLog.json examples не содержит, поэтому их создаёт ТЕСТ, core не меняется);
//   B = тот же срез, но с удалённым полем examples.
//
// Каждый вход прогоняется N=5 раз последовательно в каждом режиме. Метрика: доля
// модального набора keys(values) среди 5 прогонов. Отдельно: дата в input vs без —
// меняются ли ключи (сомнение пользователя про «абстрактный паттерн по дате»).
//
// Запуск: node tools/d13-consistency-test.js
// Результат: таблица в stdout + tools/d13-report.json

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const rulesLog = require(path.join(ROOT, 'core', 'rulesLog.js'));
const structured = require(path.join(ROOT, 'core', 'structured.js'));

const N_RUNS = 5;
const FIXED_DATE = '2026-08-24';

// --- Тестовый набор входов (реальные формы из docs/DECISIONS.md D9/D13, prompts/mode_parse.md) ---
const INPUTS = [
    { id: 'push_split', text: '100 отжимания (73+27)', withDate: false },
    { id: 'push_planka', text: '100 отжимания одним подходом (43 в одной планке)', withDate: false },
    { id: 'push_max', text: '- 100 отжимания (макс за раз: 100)', withDate: false },
    { id: 'press', text: 'пресс', withDate: false },
    { id: 'squat', text: 'присяд 30', withDate: false },
    { id: 'bike', text: 'велосипед 2ч', withDate: false },
    { id: 'run_km', text: '~6км (боли в ноге)', withDate: false },
    { id: 'week_table', text: [
        '| День | *08-24* | *08-26* |',
        '| --- | --- | --- |',
        '| Утро | - 100 отжимания<br>- 100 пресс | - 100 отжимания<br>- 100 пресс |',
        '| Вечер | - присяд 30<br>- велосипед 2ч | - присяд 30<br>- велосипед 2ч |',
    ].join('\n'), withDate: false },
    // Сомнение про дату: один и тот же вход С датой и БЕЗ даты в тексте
    { id: 'dated_push', text: `${FIXED_DATE}: 100 отжимания`, withDate: true },
    { id: 'undated_push', text: '100 отжимания', withDate: true },
];

// --- Тестовый снапшот правил: 2 правила, mode A добавляет examples, mode B — нет ---
// (в реальном data/rulesLog.json у последних правил examples пустые — поэтому примеры
//  для режима A конструирует ТЕСТ по семантике правил; core/ и data/ не изменяются.)
const BASE_SNAPSHOT = {
    version: 1,
    updatedAt: '2026-08-30',
    dynamic: [
        {
            id: 'rule_005',
            __version: 1,
            when: { pattern: '^отжимания\\s*(\\d+)\\s*$' },
            then: { entity: 'push', metric: 'full', composition: 'single' },
            // examples для режима A добавляются ниже (см. WITH_EXAMPLES)
        },
        {
            id: 'rule_010',
            __version: 1,
            when: { pattern: '^отжимания\\s*(\\d+)\\s*одним\\s*подходом\\s*\\((\\d+)\\s*в\\s*одной\\s*планке\\)$' },
            then: { entity: 'push', metric: 'max_set', composition: 'single' },
        },
    ],
    global: [],
};

const WITH_EXAMPLES = {
    rule_005: [{ input: '100 отжимания', date: FIXED_DATE, values: { push_full: 100 } }],
    rule_010: [{ input: '100 отжимания одним подходом (43 в одной планке)', date: FIXED_DATE, values: { push_full: 100, push_max_set: 43 } }],
};

/** Пишет временный rulesLog-файл и переключает rulesLog на него. Возвращает путь. */
function useTempLog(withExamples) {
    const snapshot = JSON.parse(JSON.stringify(BASE_SNAPSHOT));
    for (const r of snapshot.dynamic) {
        r.examples = withExamples && WITH_EXAMPLES[r.id] ? WITH_EXAMPLES[r.id] : [];
    }
    const log = {
        version: 1,
        updatedAt: '2026-08-30T00:00:00.000Z',
        entries: [{ version: 1, timestamp: '2026-08-30T00:00:00.000Z', rulesSnapshot: snapshot, changeType: 'add', meta: { description: 'D13 test fixture' } }],
    };
    const p = path.join(__dirname, `.d13-rulesLog-${withExamples ? 'with' : 'no'}-examples.json`);
    fs.writeFileSync(p, JSON.stringify(log, null, 2), 'utf8');
    rulesLog._setLogPath(p);
    rulesLog._resetCache();
    return p;
}

/** Стабильный ключ-набор одного прогона: sorted keys(values), склеенные. */
function keysSignature(result) {
    if (!result || result.status !== 'success') return '(error)';
    const sigs = result.payload.events.map((ev) => Object.keys(ev.values || {}).sort().join(','));
    return sigs.sort().join(' | ');
}

/** Доля модального значения среди массива сигнатур. */
function modalShare(sigs) {
    const counts = new Map();
    for (const s of sigs) counts.set(s, (counts.get(s) || 0) + 1);
    let best = null, bestN = 0;
    for (const [s, n] of counts) if (n > bestN) { best = s; bestN = n; }
    return { modal: best, count: bestN, share: bestN / sigs.length, distinct: counts.size };
}

async function checkOllama() {
    try {
        const res = await fetch('http://localhost:11434/api/tags');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const j = await res.json();
        return { ok: true, models: (j.models || []).map((m) => m.name) };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

async function main() {
    const ollama = await checkOllama();
    if (!ollama.ok) {
        console.error(`ОШИБКА: Ollama недоступна на localhost:11434 (${ollama.error}). Результаты НЕ выдумываются — тест прерван.`);
        fs.writeFileSync(path.join(__dirname, 'd13-report.json'), JSON.stringify({ error: 'ollama_unavailable', detail: ollama.error }, null, 2));
        process.exit(2);
    }
    console.log(`Ollama доступна. Модели: ${ollama.models.join(', ')}`);
    console.log('Модель: gemma4 (DEFAULT_MODEL из adapters/llm.js)\n');

    const report = { date: FIXED_DATE, nRuns: N_RUNS, modes: {}, dateDoubt: {}, anomalies: [] };

    for (const mode of ['A', 'B']) {
        const withExamples = mode === 'A';
        const tmpLog = useTempLog(withExamples);
        console.log(`=== Режим ${mode} (${withExamples ? 'С examples' : 'БЕЗ examples'}, лог: ${path.basename(tmpLog)}) ===`);
        console.log(rulesLog.formatRecentRules(2).split('\n').slice(0, 4).join('\n') + '\n');
        const perInput = {};
        for (const inp of INPUTS) {
            const sigs = [];
            for (let i = 0; i < N_RUNS; i++) {
                let result;
                try {
                    result = await structured(inp.text, { date: FIXED_DATE, context: '' });
                } catch (e) {
                    result = { status: 'error', payload: { events: [] } };
                }
                const sig = keysSignature(result);
                sigs.push(sig);
                console.log(`  [${inp.id}] прогон ${i + 1}/${N_RUNS}: ${result.status} -> ${sig}`);
                if (result.status !== 'success') report.anomalies.push({ mode, input: inp.id, run: i + 1, status: 'error' });
            }
            const m = modalShare(sigs);
            perInput[inp.id] = { runs: sigs, modal: m.modal, modalCount: m.count, stability: m.share, distinct: m.distinct };
            console.log(`  [${inp.id}] стабильность: ${(m.share * 100).toFixed(0)}% (${m.count}/${N_RUNS}, вариантов: ${m.distinct})\n`);
        }
        const agg = Object.values(perInput).reduce((a, r) => a + r.stability, 0) / Object.keys(perInput).length;
        report.modes[mode] = { perInput, aggregateStability: agg };
        console.log(`АГРЕГАТ ${mode}: ${(agg * 100).toFixed(1)}%\n`);
    }

    // --- Сомнение про дату: прогоны с датой в input vs без ---
    console.log('=== Дата в input vs без (внутри обоих режимов) ===');
    report.dateDoubt = {};
    for (const mode of ['A', 'B']) {
        const a = report.modes[mode].perInput.dated_push;
        const b = report.modes[mode].perInput.undated_push;
        const same = a.modal === b.modal;
        report.dateDoubt[mode] = { withDateModal: a.modal, withoutDateModal: b.modal, same };
        console.log(`  [${mode}] с датой: ${a.modal} | без даты: ${b.modal} | совпадают: ${same}`);
        if (!same) report.anomalies.push({ mode, type: 'date_changed_keys', withDateModal: a.modal, withoutDateModal: b.modal });
    }

    // Вывод
    const aggA = report.modes.A.aggregateStability, aggB = report.modes.B.aggregateStability;
    console.log('\n=== ИТОГ ===');
    console.log(`Агрегатная стабильность A (с examples): ${(aggA * 100).toFixed(1)}%`);
    console.log(`Агрегатная стабильность B (без examples): ${(aggB * 100).toFixed(1)}%`);
    console.log(`Разница: ${((aggA - aggB) * 100).toFixed(1)} п.п. ${aggA > aggB ? 'examples улучшают стабильность' : aggA < aggB ? 'examples НЕ улучшают (или ухудшают)' : 'без разницы'}`);
    report.verdict = { aggA, aggB, delta: aggA - aggB };
    report.inputs = INPUTS.map((i) => ({ id: i.id, text: i.text, withDate: i.withDate }));

    fs.writeFileSync(path.join(__dirname, 'd13-report.json'), JSON.stringify(report, null, 2));
    console.log(`\nОтчёт: tools/d13-report.json`);
    // подчистка временных логов
    for (const f of ['.d13-rulesLog-with-examples.json', '.d13-rulesLog-no-examples.json']) {
        try { fs.unlinkSync(path.join(__dirname, f)); } catch (_) {}
    }
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
