'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const chartview = require('../ui/chartview.js');

function fakeElement(tag = 'div') {
    return {
        tag,
        children: [],
        style: {},
        textContent: '',
        appendChild(child) { this.children.push(child); return child; },
        set innerHTML(value) { this._html = value; this.children = []; },
        get innerHTML() { return this._html || ''; },
        getContext() { return {}; },
    };
}

test('group toggle rerender removes stale charts and destroys prior Chart.js instances', async () => {
    const oldWindow = global.window;
    const oldDocument = global.document;
    const charts = [];
    class FakeChart {
        constructor(canvas, config) { this.canvas = canvas; this.config = config; this.destroyed = false; charts.push(this); }
        destroy() { this.destroyed = true; }
    }
    global.window = { Chart: FakeChart, ChartDataLabels: {} };
    global.document = { createElement: fakeElement };

    try {
        const host = fakeElement('host');
        const groups = ['Push', 'Pull'].map((name) => ({
            title: name,
            config: { type: 'bar', labels: ['07-17'], datasets: [{ label: name, data: [1] }] },
        }));
        const initial = await chartview.renderChartGrouped(host, groups);
        assert.equal(initial.length, 2);
        assert.equal(host.children.length, 4, 'each group renders one heading and one canvas wrapper');

        const filtered = await chartview.renderChartGrouped(host, groups.slice(0, 1));
        assert.equal(filtered.length, 1);
        assert.equal(host.children.length, 2, 'rerender leaves only the visible group');
        assert.ok(charts.slice(0, 2).every((chart) => chart.destroyed), 'old charts are destroyed before rerender');
    } finally {
        if (oldWindow === undefined) delete global.window; else global.window = oldWindow;
        if (oldDocument === undefined) delete global.document; else global.document = oldDocument;
    }
});
