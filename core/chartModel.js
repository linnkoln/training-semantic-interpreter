'use strict';
// core/chartModel.js — декларативный конфиг графика из СЕМАНТИКИ (слой 3, AC4/AC11).
//
// РАНЬШЕ — эвристика строк: k.split('_')[0] группировал по префиксу,
//   k.includes('full')/k.includes('max') решали, что стек, а что линия,
//   k.includes('full') красил линию чёрным. Имена метрик жили в JS.
// ТЕПЕРЬ — семантика: слой 3 (data/graph.json) читается через core/graph.js,
//   и сами отношения диктуют маппинг (AC11):
//     part_of      → stacked bar  (дети стакаются в родителя, ось y)
//     successor    → timeline line (ось y1, прогрессия умения)
//     independent  → отдельные multi-line (ось y1)
//   В ЛОГИКЕ НЕТ НИ ОДНОГО ИМЕНИ МЕТРИКИ — всё выведено из графа.
// Модуль чистый: без dv/app/DOM, конфиг — сериализуемый объект (без функций).

const { childrenOf, relationsOfType, targetNodes } = require('./graph.js');

const PALETTE = [
    '#4e79a7', '#f28e2b', '#e15759', '#76b7b2', '#59a14f',
    '#edc948', '#b07aa1', '#ff9da7', '#9c755f', '#bab0ac',
];

function sortByDate(events) {
    return [...events].sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

function collectKeys(events) {
    const s = new Set();
    for (const e of events) {
        const vals = (e && e.values) ? e.values : {};
        for (const k of Object.keys(vals)) {
            const v = vals[k];
            if (v !== null && v !== undefined) s.add(k);
        }
    }
    return s;
}

// Отсутствующая компонента остаётся пропуском. Явный ноль сохраняется числом.
function series(events, key) {
    return events.map(e => {
        const v = (e && e.values && key in e.values) ? e.values[key] : undefined;
        if (v === undefined || v === null) return null;
        return v;
    });
}

/** Группы стака: каждый part_of-родитель + его дети, что реально есть в данных. */
function stackedGroups(keys, graph) {
    const parents = new Set(relationsOfType(graph, 'part_of').map(r => r.parent));
    const groups = [];
    for (const parent of parents) {
        const children = childrenOf(parent, graph).filter(c => keys.has(c));
        if (children.length) groups.push({ parent, children });
    }
    return groups;
}

/** Группы A+B (2026-09-03, расхождение №3): base + parts, порядок полосок —
 *  stackOrder СНИЗУ ВВЕРХ (снизу сложное/base, сверху лёгкое/упрощения).
 *  Ушедшая метрика (часть без данных) не рисуется. part_of остаётся fallback'ом. */
function abGroups(keys, graph) {
    const groups = [];
    for (const r of relationsOfType(graph, 'A+B')) {
        if (!r || typeof r.base !== 'string' || !r.base) continue;
        const parts = Array.isArray(r.parts) ? r.parts.filter((p) => typeof p === 'string' && p) : [];
        const members = [r.base, ...parts];
        let order = Array.isArray(r.stackOrder)
            ? r.stackOrder.filter((m) => typeof m === 'string' && members.includes(m))
            : [];
        for (const m of members) if (!order.includes(m)) order.push(m);
        const bars = order.filter((m) => keys.has(m)); // нулевая/ушедшая часть не рисуется
        if (bars.length) groups.push({ id: r.base, bars });
    }
    return groups;
}

/** Overlay-пары (TC-002): base сзади целиком, sub спереди поверх. */
function overlayRels(keys, graph) {
    return relationsOfType(graph, 'overlay')
        .filter((r) => r && typeof r.base === 'string' && typeof r.sub === 'string' && r.base && r.sub && keys.has(r.sub));
}

/**
 * Локальные экстремумы дискретного ряда (пики и впадины). Возвращает массив булей
 * по длине ряда: true на точках, являющихся локальным мах/мин (сравнение с соседями).
 * null-значения игнорируются (пропуски данных не ломают сравнение).
 * ОБОСНОВАНИЕ: для трендов «раньше последнего» пользователь хочет подписи только там,
 * где значение реально информативно (пик/прорыв/падение), а не на каждой точке —
 * так цифры не налезают друг на друга на однородных участках.
 */
function localExtrema(arr) {
    const flags = new Array(arr.length).fill(false);
    // массив индексов не-null значений
    const idx = [];
    for (let i = 0; i < arr.length; i++) {
        if (arr[i] !== null && arr[i] !== undefined) idx.push(i);
    }
    for (let k = 0; k < idx.length; k++) {
        const i = idx[k];
        const v = arr[i];
        const prevVal = k > 0 ? arr[idx[k - 1]] : null;
        const nextVal = k < idx.length - 1 ? arr[idx[k + 1]] : null;
        // точка — локальный максимум, если больше (хотя бы одного) соседа и не меньше остального
        const isPeak = (prevVal === null || v > prevVal) && (nextVal === null || v >= nextVal)
            || (prevVal === null || v >= prevVal) && (nextVal === null || v > nextVal);
        const isValley = (prevVal === null || v < prevVal) && (nextVal === null || v <= nextVal)
            || (prevVal === null || v <= prevVal) && (nextVal === null || v < nextVal);
        // без соседа в конкретную сторону точку считаем «несравнимой» (не подписываем),
        // кроме одноточечных рядов, где экстремум сам по себе информативен.
        if (prevVal === null && nextVal === null) {
            flags[i] = true;
        } else {
            flags[i] = isPeak || isValley;
        }
    }
    return flags;
}

/** Multi-line: участники independent-отношений, по линии на каждого, ось y1. */
function independentParts(keys, graph) {
    const parts = new Set();
    for (const r of relationsOfType(graph, 'independent')) {
        if (keys.has(r.parent)) parts.add(r.parent);
        if (keys.has(r.child)) parts.add(r.child);
    }
    return [...parts];
}

// Читаемое имя сущности из имени родителя группы: первый сегмент ('push_total' → 'push',
// 'push_reps' → 'push'). Выводится из графа, не хардкодится.
function entityPrefixFromParent(parentName) {
    return String(parentName).split('_')[0] || String(parentName);
}

function capitalize(s) {
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/**
 * Строит один конфиг Chart.js из events+graph, опционально отфильтровав датасеты
 * по префиксу сущности (для множественной раскладки). Если filterPrefix задан,
 * включаются только метрики этой сущности (part_of-бары одного родителя + его
 * successor/independent-линии). Если не задан — все группы (единый график).
 */
function buildConfig(events, graph, members, groupParent, extra) {
    const sorted = sortByDate(events);
    const labels = sorted.map(e => String(e.date).slice(5));
    const keys = collectKeys(sorted);

    const belongs = (key) => !members || members.has(key);

    const datasets = [];
    let ci = 0;
    const color = () => PALETTE[ci++ % PALETTE.length];

    // Метрики, уже отрисованные линией — чтобы один и тот же ключ не рисовался дважды.
    const lineKeysDrawn = new Set();
    // Метрики, уже отрисованные барами (A+B/overlay/part_of) — один ключ, один бар.
    const drawn = new Set();
    // Метрики-цели (graph.targets) — накладывающиеся бары поверх стека.
    const targets = targetNodes(graph);

    // 1a) A+B-стеки (2026-09-03, расхождение №3): полоски в порядке stackOrder
    //     СНИЗУ ВВЕРХ — снизу сложное (base), сверху лёгкое (упрощения). part_of
    //     (legacy) остаётся fallback-форматом стека ниже.
    for (const { id, bars } of abGroups(keys, graph)) {
        if (!belongs(id)) continue;
        for (const key of bars) {
            if (drawn.has(key)) continue;
            drawn.add(key);
            const c = color();
            datasets.push({
                label: key,
                data: series(sorted, key),
                type: 'bar',
                stack: id,
                yAxisID: 'y',
                backgroundColor: c,
                order: 3,
                z: 1,
            });
        }
    }

    // 1b) overlay (TC-002): base сзади целиком (полупрозрачным не гасим), sub спереди
    // поверх — отдельная ось y1 (startAtZero), полупрозрачный с рамкой, order 2.
    for (const { base, sub } of overlayRels(keys, graph)) {
        if (!belongs(base)) continue;
        if (!drawn.has(base) && keys.has(base)) {
            drawn.add(base);
            const c = color();
            datasets.push({
                label: base,
                data: series(sorted, base),
                type: 'bar',
                stack: `overlay_${base}`,
                yAxisID: 'y',
                backgroundColor: c,
                order: 3,
                z: 1,
            });
        }
        if (!drawn.has(sub)) {
            drawn.add(sub);
            const c = color();
            datasets.push({
                label: sub,
                data: series(sorted, sub),
                type: 'bar',
                yAxisID: 'y',
                stack: `overlay_${sub}`,
                grouped: false,
                backgroundColor: c + '99', // полупрозрачный — видна base позади
                borderColor: c,
                borderWidth: 2,
                order: 2,   // поверх base-бара, под линиями
                z: 2,
            });
        }
    }

    for (const { parent, children } of stackedGroups(keys, graph)) {
        if (groupParent && parent !== groupParent) continue;
        for (const child of children) {
            if (drawn.has(child)) continue;
            // Ф1 (2026-09-01): тренд-ключ остаётся В СТЕКЕ (маленькая полоска рядом с базой),
            // тренд-линия рисуется поверх в шаге 2.5 (раньше ключ выбрасывался — тренд
            // рисовался «вместо данных», а не вместе).
            // узел, который одновременно цель (max_set), рисуется отдельным баром ниже —
            // НЕ в этом стеке, а как накладывающийся бар (см. шаг 2).
            if (targets.includes(child)) continue;
            drawn.add(child);
            const c = color();
            datasets.push({
                label: child,
                data: series(sorted, child),
                type: 'bar',
                stack: parent,
                yAxisID: 'y',
                backgroundColor: c,
                // z-order из leaacy: бары стека ПОЗАДИ линий и таргет-баров.
                order: 3,
                z: 1,
            });
        }
    }

    // 1.5) targets → накладывающиеся бары (ось y1, startAtZero, полупрозрачные) поверх стека.
    // Это ВОССТАНОВЛЕНИЕ leaacy: max_set был отдельным наклаывающимся баром на оси y1.
    for (const target of targets) {
        if (!belongs(target) || !keys.has(target) || drawn.has(target)) continue;
        drawn.add(target);
        const c = color();
        datasets.push({
            label: target + ' (max)',
            data: series(sorted, target),
            type: 'bar',
            yAxisID: 'y',
            stack: `overlay_${target}`, // отдельный стек поверх основного бара
            grouped: false,
            backgroundColor: c + '99', // полупрозрачный — виден стек позади (leaacy)
            borderColor: c,
            borderWidth: 2,
            order: 2,                  // поверх основного стека, под линиями
            z: 2,
        });
    }

    // 2) successor → trend line (ось y1). Рисуем линию на КАЖДЫЙ узел цепи (и full, и max_set),
    //    восстанавливая тренды, что пропали в этой миграции. Датолаблы:
    //    - последний/новейший узел цепи → все цифры;
    //    - предыдущие (full) → только локальные экстремумы.
    const successorEdges = relationsOfType(graph, 'successor');
    // «последний» тренд = узел с данными, у которого НЕТ successor-ребёнка с данными
    // (т.е. самый новый измеряемый уровень в цепи). Если push_best пуст, последним
    // является push_max_set. ОБОСНОВАНИЕ: подписи всех значений даём только самому
    // новому измерению; ранние уровни — по экстремумам.
    const isLastTrend = (node) => keys.has(node)
        && !successorEdges.some(e => e.parent === node && keys.has(e.child));
    const trendNodes = new Set();
    for (const e of successorEdges) { trendNodes.add(e.parent); trendNodes.add(e.child); }

    // Окно тренда: старый тренд рисуется ТОЛЬКО до момента, когда начинается его
    // successor-потомок (новая фаза измерения). Это и есть обещанное правило
    // «тренд перестаётся, когда начинается новый тренд — чтобы не засорять верхние
    // значения точками». Данные старого тренда после границы перехода обнуляются.
    const trendDataCache = {};
    function firstDataIndex(node) {
        const d = trendDataCache[node];
        if (!d) return Infinity;
        for (let i = 0; i < d.length; i++) if (d[i] !== null && d[i] !== undefined) return i;
        return Infinity;
    }
    // граница перехода: первый индекс, где successor-ребёнок (с данными) имеет значение
    function transitionBoundary(node) {
        for (const e of successorEdges) {
            if (e.parent !== node || !keys.has(e.child)) continue;
            const idx = firstDataIndex(e.child);
            if (idx !== Infinity) return idx;
        }
        return Infinity;
    }
    // предварительно кэшируем данные всех трендов (нужны для границ и самих линий)
    for (const node of trendNodes) {
        if (belongs(node) && keys.has(node)) trendDataCache[node] = series(sorted, node, false);
    }

    for (const node of trendNodes) {
        if (!belongs(node) || !keys.has(node) || lineKeysDrawn.has(node)) continue;
        lineKeysDrawn.add(node);
        let data = trendDataCache[node];
        const isLast = isLastTrend(node);
        // НЕ-посл тренд: обрезаем с момента начала нового уровня (иначе засоряет)
        if (!isLast) {
            const boundary = transitionBoundary(node);
            if (boundary < data.length) {
                data = data.map((v, i) => (i >= boundary ? null : v));
            }
        }
        // подписи: последний — все значения; раньше — только локальные экстремумы.
        const labelsActive = isLast
            ? data.map(v => v !== null && v !== undefined)
            : localExtrema(data);
        const c = color();
        datasets.push({
            label: node + (isLast ? '' : ' (тренд)'),
            data,
            type: 'line',
            yAxisID: 'y1',
            borderColor: isLast ? 'black' : c,   // последний тренд — чёрный (акцент, как leaacy full)
            borderWidth: isLast ? 3 : 2,
            fill: false,
            pointRadius: isLast ? 5 : 3,
            pointBackgroundColor: isLast ? 'black' : c,
            tension: 0.1,
            spanGaps: true,
            order: 1,   // ПОВЕРХ всего
            z: 50,
            // карта отображаемых подписей: конфиг остаётся сериализуемым, функция в ui.
            _labelActive: labelsActive,
        });
    }

    // Сохранённый граф TC-001/TC-002 содержит A+B и overlay, без successor.
    // Нижняя полоска A+B — старый тренд; появление overlay-компоненты начинает
    // новый тренд и закрывает окно старого. Отношения уже заданы графом.
    const abTrendBases = new Set();
    for (const { id, bars } of abGroups(keys, graph)) {
        if (!belongs(id)) continue;
        if (bars.length < 2) continue;
        const base = bars[0];
        abTrendBases.add(base);
        if (lineKeysDrawn.has(base)) continue;
        const next = overlayRels(keys, graph).find((r) => r.base === base);
        const nextData = next ? series(sorted, next.sub) : null;
        const boundary = nextData ? nextData.findIndex((v) => v !== null) : -1;
        const active = boundary < 0;
        const data = series(sorted, base).map((v, i) => (boundary >= 0 && i >= boundary ? null : v));
        const c = color();
        datasets.push({
            label: base + (active ? '' : ' (тренд)'),
            data,
            type: 'line',
            yAxisID: 'y',
            borderColor: active ? 'black' : c,
            borderWidth: active ? 3 : 2,
            pointRadius: active ? 5 : 3,
            pointBackgroundColor: active ? 'black' : c,
            fill: false,
            tension: 0.1,
            spanGaps: false,
            order: 1,
            z: 50,
            _labelActive: active ? data.map((v) => v !== null) : localExtrema(data),
        });
        lineKeysDrawn.add(base);
    }
    for (const { base, sub } of overlayRels(keys, graph)) {
        if (!belongs(base)) continue;
        if (!abTrendBases.has(base) || lineKeysDrawn.has(sub)) continue;
        const data = series(sorted, sub);
        datasets.push({
            label: sub,
            data,
            type: 'line',
            yAxisID: 'y',
            borderColor: 'black',
            borderWidth: 3,
            pointRadius: 5,
            pointBackgroundColor: 'black',
            fill: false,
            tension: 0.1,
            spanGaps: false,
            order: 1,
            z: 50,
            _labelActive: data.map((v) => v !== null),
        });
        lineKeysDrawn.add(sub);
    }

    // 2.5) ДЕТЕРМИНИРОВАННЫЕ ТРЕНДЫ (правило пользователя 2026-09-01):
    // «тренд накладывается на график, который визуально касается низа».
    // A+B (ровно две компоненты в одном part_of-стеке): тренд рисуется на НИЖНЕЙ
    // полоске — той, что появилась раньше по датам (база существует до появления
    // надстройки); при равенстве — у которой больше непустых точек.
    // Никаких тегов из данных: graph.trends НЕ читается, отрисовка зависит только
    // от формы стека и самих данных (детерминизм отрисовки, docs/user).
    for (const { parent, children } of stackedGroups(keys, graph)) {
        if (groupParent && parent !== groupParent) continue;
        // Тренд = пара «база + надстройка» (правило: тренд на полоску, что касается низа).
        // Пара = два ребёнка с САМЫМ РАННИМ появлением данных: нижняя полоска стека (база)
        // и надстройка над ней. Всё, что появилось позже (max-метрика, разовая полоска),
        // в пару не входит; цели (targets) исключаются всегда.
        const targets = new Set(targetNodes(graph));
        const firstIdx = (key) => { const d = series(sorted, key, false); const i = d.findIndex((v) => v !== null && v !== undefined); return i === -1 ? Infinity : i; };
        const dataChildren = children.filter((c) => !targets.has(c) && keys.has(c) && firstIdx(c) !== Infinity);
        if (dataChildren.length < 2) continue; // нет пары — тренда нет
        const sortedByStart = [...dataChildren].sort((x, y) => firstIdx(x) - firstIdx(y));
        // База (низ стека) = метрика, существовавшая ДО появления усложнения: ребёнок
        // с самым ранним появлением данных. Роли относительны: когда старая метрика
        // сатирируется и приходит новая — новый тренд сменяет старый (граница = появление
        // нового тренда). Третья метрика группы (max-подход и т.п.) в пару не входит.
        const base = sortedByStart[0];
        const baseData = series(sorted, base, false);
        if (!keys.has(base) || baseData.every((v) => v === null || v === undefined)) continue;
        if (lineKeysDrawn.has(base)) continue;
        lineKeysDrawn.add(base);
        datasets.push({
            label: base,
            data: baseData,
            type: 'line',
            yAxisID: 'y',   // ОСЬ СТЕКА: линия обязана лежать ровно на своей полоске.
                            // y1 (правая, отдельный автомасштаб) давал визуальный сдвиг —
                            // «следует тенденции нижней, но начинается с верхней».
            borderColor: 'black',   // единственный/последний тренд группы — чёрный жирный
            borderWidth: 3,
            fill: false,
            pointRadius: 4,
            pointBackgroundColor: 'black',
            tension: 0.1,
            spanGaps: true,
            order: 1,   // поверх всего
            z: 50,
            _labelActive: baseData.map(v => v !== null && v !== undefined),
        });
    }

    // 3) independent → multi-line (ось y1)
    for (const key of independentParts(keys, graph)) {
        if (!belongs(key) || lineKeysDrawn.has(key)) continue;
        lineKeysDrawn.add(key);
        const c = color();
        datasets.push({
            label: key,
            data: series(sorted, key, false),
            type: 'line',
            yAxisID: 'y1',
            borderColor: c,
            fill: false,
            tension: 0.1,
            spanGaps: true,
            order: 1,
            z: 50,
            _labelActive: series(sorted, key, false).map(v => v !== null && v !== undefined),
        });
    }

    // Непомеченная или одиночная метрика — обычный бар без тренд-линии.
    for (const key of keys) {
        if (!belongs(key) || drawn.has(key) || lineKeysDrawn.has(key)) continue;
        const c = color();
        datasets.push({
            label: key,
            data: series(sorted, key),
            type: 'bar',
            yAxisID: 'y',
            backgroundColor: c,
            order: 3,
            z: 1,
        });
    }

    const hasBars = datasets.some((d) => d.type === 'bar');
    if (!hasBars) {
        for (const dataset of datasets) {
            if (dataset.yAxisID === 'y1') dataset.yAxisID = 'y';
        }
    }
    const scales = {
        x: { stacked: hasBars },
        y: { stacked: hasBars, beginAtZero: true },
    };
    if (datasets.some((d) => d.yAxisID === 'y1')) {
        scales.y1 = { position: 'right', stacked: false, beginAtZero: true };
    }
    const cfg = {
        type: 'bar',
        labels,
        datasets,
        scales,
        _source: 'semantic', // AC11: конфиг построен из графа, не из эвристик строк
    };
    if (groupParent) cfg._group = groupParent;
    if (extra) Object.assign(cfg, extra);
    return cfg;
}

/**
 * События → единый декларативный конфиг Chart.js (по дате по возрастанию).
 * Сохранён как есть для обратной совместимости (см. toChartConfigs для раскладки).
 */
function toChartConfig(events, graph) {
    return buildConfig(events, graph, null, null);
}

/**
 * События → НЕСКОЛЬКО графиков, по одному на каждую part_of-группу (например,
 * отдельно push_total и pull_total). СЕМАНТИЧЕСКАЯ группировка: делит по именам
 * родителя из графа, а не по префиксу строки (AC11). Возвращает массив
 * { title, config }, где config — конфиг только для датасетов этой сущности.
 *
 * Это восстанавливает прошлое поведение (в legacy main.js разные упражнения
 * рисовались отдельными холстами "🏋️ Push", "🏋️ Pull"), но вывод родителя и
 * имя заголовка идут из графа.
 *
 * ОБОСНОВАНИЕ: линии (successor/independent) не привязаны к родителю-бару напрямую,
 * потому их принадлежность к группе выводим по префиксу сущности: метрика
 * 'pull_max_set' принадлежит родителю 'pull_total' (префикс 'pull'). Так
 * successor-линия pull_full→pull_max_set попадает к pull_total, а не в отдельный график.
 */
function toChartConfigs(events, graph) {
    events = events || [];
    graph = graph || { relations: [] };
    const definitions = [];
    const findGroup = (key) => definitions.find((d) => d.members.has(key));
    const ensureGroup = (root) => {
        let group = findGroup(root);
        if (!group) {
            group = { root, members: new Set([root]) };
            definitions.push(group);
        }
        return group;
    };
    for (const r of relationsOfType(graph, 'part_of')) {
        if (r.parent && r.child) ensureGroup(r.parent).members.add(r.child);
    }
    for (const r of relationsOfType(graph, 'A+B')) {
        if (!r.base) continue;
        const group = ensureGroup(r.base);
        for (const part of (r.parts || [])) group.members.add(part);
    }
    for (const type of ['overlay', 'successor', 'independent']) {
        for (const r of relationsOfType(graph, type)) {
            const base = r.base || r.parent;
            const sub = r.sub || r.child;
            if (base && sub) ensureGroup(base).members.add(sub);
        }
    }
    // Непомеченные метрики тоже должны оставаться видимыми, каждая в своей группе.
    for (const key of collectKeys(events)) ensureGroup(key);

    const groups = [];
    for (const { root, members } of definitions) {
        const config = buildConfig(events, graph, members, root);
        if (!config.datasets.length) continue;
        groups.push({ title: `🏋️ ${capitalize(entityPrefixFromParent(root))}`, config });
    }
    return groups;
}

module.exports = { toChartConfig, toChartConfigs, entityPrefixFromParent };
