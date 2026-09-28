'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class Element {
    constructor(tag) {
        this.tagName = tag;
        this.children = [];
        this.listeners = new Map();
        this.style = {};
        this.value = '';
        this._text = '';
    }
    appendChild(child) { this.children.push(child); child.parent = this; return child; }
    setAttribute() {}
    addEventListener(name, fn) { this.listeners.set(name, fn); }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter((item) => item !== this); }
    set textContent(text) { this._text = String(text); this.children = []; }
    get textContent() { return this._text + this.children.map((child) => child.textContent).join(''); }
    set innerHTML(text) { this._text = String(text); this.children = []; }
    get innerHTML() { return this._text; }
}

function findAll(node, predicate) {
    return [...(predicate(node) ? [node] : []), ...node.children.flatMap((child) => findAll(child, predicate))];
}

const PATHS = {
    data: 'data/training/data.json',
    rules: 'scripts/training/data/rulesLog.json',
    graph: 'scripts/training/data/graph.json',
    dataTmp: 'data/training/data.tmp.json',
    rulesTmp: 'scripts/training/data/rulesLog.tmp.json',
    graphTmp: 'scripts/training/data/graph.tmp.json',
};

function createHarness({ fetch, initial = {} } = {}) {
    const files = new Map(Object.entries({
        [PATHS.data]: '[]',
        [PATHS.rules]: JSON.stringify({ version: 0, updatedAt: null, entries: [] }),
        [PATHS.graph]: '{"relations":[]}',
        ...initial,
    }));
    const writes = [];
    let failedPath = null;
    const write = async (filePath, content) => {
        writes.push(filePath);
        files.set(filePath, content);
        if (filePath === failedPath) {
            failedPath = null;
            throw new Error('injected partial write: ' + filePath);
        }
    };
    const app = { vault: {
        getAbstractFileByPath: (filePath) => files.has(filePath) ? { path: filePath } : null,
        read: async (file) => files.get(file.path),
        create: write,
        modify: async (file, content) => write(file.path, content),
        createFolder: async () => {},
        delete: async (file) => { files.delete(file.path); },
    } };
    const document = {
        createElement: (tag) => new Element(tag),
        createTextNode: (text) => { const node = new Element('#text'); node.textContent = text; return node; },
    };
    const context = vm.createContext({
        window: {}, document, fetch, console: { log() {}, debug() {}, warn() {}, error() {} },
        setTimeout, clearTimeout, AbortController,
    });
    function mountView() {
        // main.js evaluates a fresh bundle after every Obsidian rerender;
        // window and app.vault retain their identity.
        vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../../bundle.js'), 'utf8'), context);
        const bundle = context.window.TrainingCore;
        bundle.chartview = { renderChartGrouped: (element) => { element.innerHTML = ''; return []; } };
        const container = new Element('container');
        const controller = bundle.editor.mountEditor({ container, app, bundle });
        return {
            bundle, container, controller,
            field: (index) => findAll(container, (node) => node.tagName === 'textarea')[index],
            click: async (label) => {
                const button = findAll(container, (node) => node.tagName === 'button' && node.textContent === label)[0];
                if (!button) throw new Error('Missing button: ' + label);
                await button.listeners.get('click')();
            },
        };
    }
    const view = mountView();
    return {
        ...view, files, writes, remount: mountView,
        json: (filePath) => JSON.parse(files.get(filePath)),
        mainBytes: () => [PATHS.data, PATHS.rules, PATHS.graph].map((filePath) => files.get(filePath)),
        failNext: (filePath) => { failedPath = filePath; },
    };
}

module.exports = { createHarness, findAll, PATHS };
