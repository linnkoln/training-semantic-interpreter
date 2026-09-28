'use strict';
// ui/chartview.js — P6: тонкий DOM-рендер Chart.js из декларативного конфига
// core/chartModel.toChartConfig(events, graph).
//
// ТОЛЬКО UI-слой: никакой бизнес-логики, никаких имён метрик. На вход — готовый
// сериализуемый конфиг { type, labels, datasets[], scales }. Зависимостей на core нет,
// поэтому файл встраивается в бандл и не требует require-графа.
//
// Семантика осей (идёт из конфига, а не из эвристик):
//   datasets[].yAxisID 'y'  → левая ось (part_of-стак, stacked)
//   datasets[].yAxisID 'y1' → правая ось (successor/independent линии, не stacked)
// Style: datalabels на линиях включаются (как в прежнем main.js), на барах выключены.

const CHART_CDN = 'https://cdn.jsdelivr.net/npm/chart.js';
const DATALABELS_CDN = 'https://cdn.jsdelivr.net/npm/chartjs-plugin-datalabels@2';
const chartsByElement = new WeakMap();
const renderTokenByElement = new WeakMap();

function beginRender(element) {
    for (const chart of chartsByElement.get(element) || []) {
        try { chart.destroy(); } catch (_) { /* stale canvas already detached */ }
    }
    chartsByElement.set(element, []);
    const token = (renderTokenByElement.get(element) || 0) + 1;
    renderTokenByElement.set(element, token);
    return token;
}

function loadScript(src) {
    return new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = src;
        s.onload = resolve;
        s.onerror = () => reject(new Error('Не удалось загрузить: ' + src));
        document.head.appendChild(s);
    });
}

async function ensureChartJs() {
    if (typeof window.Chart === 'undefined') {
        await loadScript(CHART_CDN);
    }
    if (typeof window.ChartDataLabels === 'undefined') {
        await loadScript(DATALABELS_CDN);
        if (window.Chart && window.ChartDataLabels) {
            window.Chart.register(window.ChartDataLabels);
        }
    }
}

function defaultLineDatalabels() {
    return {
        display: true,
        color: 'black',
        font: { weight: 'bold', size: 10 },
        backgroundColor: 'rgba(255,255,255,0.7)',
        borderRadius: 4,
        align: 'top',
        offset: 4,
        // ВАЖНО: возвращаем null (а не '') для скрытых точек — chartjs-plugin-datalabels
        // НЕ рисует метку и её белую подложку, когда formatter возвращает null/undefined.
        // Пустая строка '' всё равно рисует пустой бокс с фоном (источник «подложка остаётся»).
        formatter: (value) => (value === null || value === undefined ? null : value),
    };
}

/**
 * Рендерит график Chart.js в element из конфига chartModel.toChartConfig.
 * @param {HTMLElement} element контейнер (очищается)
 * @param {{type:string, labels:string[], datasets:Object[], scales:Object}} config
 * @returns {Promise<Chart|null>} экземпляр Chart или null, если нет данных.
 */
/**
 * Рендерит GРУППУ графиков (по одному на part_of-группу) в element.
 * @param {HTMLElement} element контейнер (очищается)
 * @param {{title:string, config:Object}[]} groups из chartModel.toChartConfigs
 * @returns {Promise<Chart[]>} массив экземпляров Chart
 */
function renderChartGrouped(element, groups) {
    if (!element) return Promise.resolve([]);
    const token = beginRender(element);
    element.innerHTML = '';
    if (!Array.isArray(groups) || groups.length === 0) {
        element.innerHTML = '📊 Нет данных для отображения графика.';
        return Promise.resolve([]);
    }
    return ensureChartJs()
        .then(() => {
            if (renderTokenByElement.get(element) !== token) return [];
            element.innerHTML = '';
            const charts = [];
            for (const group of groups) {
                const title = document.createElement('h5');
                title.textContent = group.title || '📊';
                title.style.cssText = 'margin:16px 0 4px 0; color:var(--text-normal);';
                element.appendChild(title);

                const wrapper = document.createElement('div');
                wrapper.style.cssText = 'width:100%; height:320px; margin-bottom:16px;';
                element.appendChild(wrapper);

                const chartsHolder = renderChartIntoTarget(wrapper, group.config);
                charts.push(...chartsHolder);
            }
            if (renderTokenByElement.get(element) !== token) {
                for (const chart of charts) { try { chart.destroy(); } catch (_) {} }
                return [];
            }
            chartsByElement.set(element, charts);
            return charts;
        })
        .catch((err) => {
            element.innerHTML = '⚠️ График не построен: ' + ((err && err.message) || err);
            return [];
        });
}

function renderChart(element, config) {
    if (!element) return Promise.resolve(null);
    const token = beginRender(element);
    element.innerHTML = '';
    if (!config || !Array.isArray(config.datasets) || config.datasets.length === 0) {
        element.innerHTML = '📊 Нет данных для отображения графика.';
        return Promise.resolve(null);
    }
    return ensureChartJs()
        .then(() => {
            if (renderTokenByElement.get(element) !== token) return null;
            element.innerHTML = '';
            const chart = renderChartIntoTarget(element, config)[0] || null;
            if (renderTokenByElement.get(element) !== token) {
                if (chart) { try { chart.destroy(); } catch (_) {} }
                return null;
            }
            chartsByElement.set(element, chart ? [chart] : []);
            return chart;
        })
        .catch((err) => {
            element.innerHTML = '⚠️ График не построен: ' + ((err && err.message) || err);
            return null;
        });
}

/** Внутренний помощник: строит один canvas+Chart в элементе из конфига. Возвращает [Chart]. */
function renderChartIntoTarget(element, config) {
    if (!config || !Array.isArray(config.datasets) || config.datasets.length === 0) {
        element.innerHTML = '📊 Нет данных для отображения графика.';
        return [];
    }

    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'width:100%; height:320px; margin-bottom:16px;';
    element.appendChild(wrapper);

    const canvas = document.createElement('canvas');
    wrapper.appendChild(canvas);

    const labels = config.labels || [];
    const datasets = (config.datasets || []).map((ds) => {
        const d = Object.assign({}, ds);
        if (d.type === 'line') {
            const active = Array.isArray(d._labelActive) ? d._labelActive : null;
            d.datalabels = Object.assign(defaultLineDatalabels(), {
                formatter: (value, ctx) => {
                    // подпись + её подложка рисуются только на «активных» точках
                    // (последний тренд — все; ранние — локальные экстремумы).
                    // null (не '') → плагин НЕ рисует ни текст, ни центр-фон.
                    if (active && !active[ctx.dataIndex]) return null;
                    return (value === null || value === undefined) ? null : value;
                },
            }, d.datalabels || {});
        }
        return d;
    });

    const scatterScales = Object.assign({}, config.scales || {});

    const chart = new window.Chart(canvas.getContext('2d'), {
        type: config.type || 'bar',
        data: { labels, datasets },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            // Резервируем место под верхние подписи-цифры трендов (align:'top'):
            // без этого «100» на верхних точках обрезаются верхним краем холста.
            layout: { padding: { top: 24 } },
            scales: scatterScales.y
                ? scatterScales
                : {
                      x: { stacked: true },
                      y: { stacked: true, beginAtZero: true, position: 'left' },
                      y1: {
                          stacked: false,
                          beginAtZero: true,
                          position: 'right',
                          grid: { drawOnChartArea: false },
                          ticks: { display: false },
                      },
                  },
            plugins: {
                // legend СНИЗУ, чтобы верхняя зона графика была свободна для подписей-цифр
                // (при position:'top' верхние тренд-метки залезали под легенду).
                legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 10 } } },
                tooltip: { mode: 'index', intersect: false },
                datalabels: { display: false }, // по умолч. выкл; вкл только в линиях
            },
        },
    });
    return [chart];
}

module.exports = { renderChart, renderChartGrouped, ensureChartJs, CHART_CDN, DATALABELS_CDN };
