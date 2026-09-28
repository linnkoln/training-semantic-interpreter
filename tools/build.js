'use strict';

// tools/build.js — P6: бандлер чистых модулей в browser-бандл bundle.js (window.TrainingCore).

//

// Зачем: main.js выполняется в браузере Obsidian (Dataview dv.view), где НЕТ require /

// module.exports. Все core/ и adapters/ модули — CommonJS. Этот build-скрипт собирает

// их в единый IIFE-бандл с микро-shim'ом require, который в браузере не нужен —

// модули стягиваются в window.TrainingCore.

//

// ПОДХОД (почему такой): модули НЕЛЬЗЯ редактировать (запрет на core/, adapters/llm.js —

// только читаем). Поэтому каждый модуль оборачивается:

//     "core/events.js": function(module, exports, require){ <исходный текст> }

// а __require разрешает относительные id ("../data/rules.json" → "data/rules.json")

// по правилам Node. JSON-ресурсы (data/rules.json, data/graph.json)

// инжектируются как виртуальные модули. Промпты mode_*.md вшиваются строками в

// window.TrainingCore.PROMPTS.

//

// QA бандла (браузерный код под node --test не запускается): node --check (синтаксис)

// + строковые проверки, что бандл непустой и содержит ожидаемые API.



const fs = require('fs');

const path = require('path');

const child = require('child_process');



const ROOT = path.resolve(__dirname, '..'); // .../scripts/training

const OUT = path.join(ROOT, 'bundle.js');



/** Список CommonJS-модулей к бандлу: bundle-id → путь от ROOT. */

const MODULES = {

    'core/events.js': 'core/events.js',

    'core/rules.js': 'core/rules.js',

    'core/graph.js': 'core/graph.js',

    'core/responseParser.js': 'core/responseParser.js',

    'core/chartModel.js': 'core/chartModel.js',

    'core/interpreter.js': 'core/interpreter.js',

    // P-A..P-P LLM-движок (router/structured/conflict/rulesLog/llmGateway/pipeline)

    'core/router.js': 'core/router.js',

    'core/rulesLog.js': 'core/rulesLog.js',

    'core/structured.js': 'core/structured.js',

    'core/llmGateway.js': 'core/llmGateway.js',

    'core/conflict.js': 'core/conflict.js',

    'core/pipeline.js': 'core/pipeline.js',

        'core/cutter.js': 'core/cutter.js',

        'core/trace.js': 'core/trace.js',

    'core/renderRules.js': 'core/renderRules.js',

    'core/keyNaming.js': 'core/keyNaming.js',

    'core/loadGraph.js': 'core/loadGraph.js',

    'adapters/llm.js': 'adapters/llm.js',

    'adapters/storage.js': 'adapters/storage.js',

    'adapters/vaultWriter.js': 'adapters/vaultWriter.js',

    'adapters/staging.js': 'adapters/staging.js',

    'adapters/tmpStore.js': 'adapters/tmpStore.js',

    'ui/chartview.js': 'ui/chartview.js',

    'ui/editor.js': 'ui/editor.js',

};



/** JSON-ресурсы как виртуальные модули (не редактируем, лишь читаем на build). */

const RESOURCES = {

    'data/graph.json': 'data/defaults/graph.json',

    'data/rulesLog.json': 'data/defaults/rulesLog.json',

};



/** Что выставить в window.TrainingCore на верхнем уровне. */

const API = {

    events: 'core/events.js',

    rules: 'core/rules.js',

    graph: 'core/graph.js',

    responseParser: 'core/responseParser.js',

    chartModel: 'core/chartModel.js',

    interpreter: 'core/interpreter.js',

    llm: 'adapters/llm.js',

    storage: 'adapters/storage.js',

    chartview: 'ui/chartview.js',

    editor: 'ui/editor.js',

    // P-A..P-P LLM-слои (b.pipeline использует ui/editor.js)

    router: 'core/router.js',

    structured: 'core/structured.js',

    conflict: 'core/conflict.js',

    rulesLog: 'core/rulesLog.js',

    llmGateway: 'core/llmGateway.js',

    pipeline: 'core/pipeline.js',

    vaultWriter: 'adapters/vaultWriter.js',

    staging: 'adapters/staging.js',

    tmpStore: 'adapters/tmpStore.js',

    loadGraph: 'core/loadGraph.js',

    renderRules: 'core/renderRules.js',

    keyNaming: 'core/keyNaming.js',

};



/** Промпты mode_*.md вшиваются строками (окончательная замена prompt.md). */

const PROMPT_MODES = ['parse', 'cutter', 'router', 'routerSession', 'minorRuleUpdate', 'ruleUpdate'];



function readUtf8(p) {

    return fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

}



// Детерминированный идентификатор сборки: hash от содержимого всех модулей/ресурсов.

// Меняется только когда реально изменился исходник → main.js может надёжно понять,

// что bundle устарел и должен быть перезагружен (инвалидация кеша window.TrainingCore).

function computeSourcesHash() {

    const parts = [];

    for (const id of Object.keys(MODULES)) parts.push(readUtf8(MODULES[id]));

    for (const id of Object.keys(RESOURCES)) parts.push(readUtf8(RESOURCES[id]));

    for (const m of PROMPT_MODES) parts.push(readUtf8(`prompts/mode_${m}.md`));

    // build.js сам участвует — правки бандлера тоже должны менять buildId.

    parts.push(readUtf8('tools/build.js'));

    const str = parts.join('\u0000\x01');

    let h = 0x811c9dc5;

    for (let i = 0; i < str.length; i++) {

        h ^= str.charCodeAt(i);

        h = (h * 0x01000193) >>> 0;

    }

    return 'b' + h.toString(16);

}



// ---------------------------------------------------------------------------

// Glue для LLM-движка (P-A..P-P) в браузерном бандле.
// Core-модули используют относительные require и Node-встроенные fs/path/__dirname.
// В IIFE-бандле Node-встроенных модулей нет, поэтому:
//   1) fs/path виртуализируются минимальными shim'ами для загрузки ресурсов;
//   2) __dirname задаётся по bundle-id модуля.
// rewriteRequires оставлен для совместимости со старыми абсолютными импортами.
// ---------------------------------------------------------------------------



/** Содержимое, которое LLM-слои читают через fs в браузере (вместо реального диска):

 *  промпты mode_*.md и data/rulesLog.json. Ключи — маркеры подстроки в вычисленном

 *  пути (path-шим даёт искажённые относительные пути вида 'core/prompts/mode_router.md'). */

function buildFsShimSource() {

    const map = {

        'mode_router.md': readUtf8('prompts/mode_router.md'),
        'mode_routerSession.md': readUtf8('prompts/mode_routerSession.md'),

        'mode_cutter.md': readUtf8('prompts/mode_cutter.md'),

        'mode_parse.md': readUtf8('prompts/mode_parse.md'),

        'mode_minorRuleUpdate.md': readUtf8('prompts/mode_minorRuleUpdate.md'),

        'mode_ruleUpdate.md': readUtf8('prompts/mode_ruleUpdate.md'),

        // rulesLog.json читается через fs.readFileSync + JSON.parse (rulesLog.loadLog) — нужен сырой текст.

        'rulesLog.json': readUtf8(RESOURCES['data/rulesLog.json']),

        // graph.json читается loadGraph.js через fs.readFileSync (F-1) — маркер обязателен,

        // иначе браузерный рендер после Save остаётся с пустым графом (баг 2026-08-31).

        'graph.json': readUtf8(RESOURCES['data/graph.json']),

    };

    const keys = JSON.stringify(Object.keys(map));

    const vals = JSON.stringify(Object.keys(map).map((k) => map[k]));

    return "module.exports = {\n" +

        "    readFileSync: function (p) {\n" +

        "        var s = String(p || '').replace(/\\\\/g, '/');\n" +

        "        var keys = " + keys + ";\n" +

        "        var vals = " + vals + ";\n" +

        "        for (var i = 0; i < keys.length; i++) { if (s.indexOf(keys[i]) !== -1) return vals[i]; }\n" +

        "        throw new Error('fs не доступен в браузере (bundle): нет ресурса для ' + s);\n" +

        "    },\n" +

        "    writeFileSync: function () { throw new Error('fs не доступен в браузере (bundle): запись правил/файлов через fs не выполняется.'); },\n" +

        "    existsSync: function () { return false; },\n" +

        "};\n";

}



/** Виртуальные Node-встроенные модули, недоступные в браузере, но нужные LLM-слоям. */

const SHIMS = {

    fs: buildFsShimSource(),

    path: "module.exports = {\n" +

        "    resolve: function () { return Array.prototype.slice.call(arguments).filter(function (s) { return s && s !== '..'; }).join('/'); },\n" +

        "    join: function () { return Array.prototype.slice.call(arguments).filter(function (s) { return s && s !== '..'; }).join('/'); },\n" +

        "};\n",

};



/** Поддержка legacy-импортов с абсолютным путём из старых модулей.
 *  Новые и обновлённые модули должны использовать относительный require. */

function rewriteRequires(source, fromId) {

    const absRe = /require\(\s*['"]G:\/Obsidians\/Notion\/scripts\/training\/([^'"]+)['"]\s*\)/g;

    return source.replace(absRe, (_m, toId) => {

        const fromDir = fromId.split('/').slice(0, -1); // каталог запрашивающего модуля

        const toParts = toId.split('/');

        let common = 0;

        while (common < fromDir.length && common < toParts.length - 1 && fromDir[common] === toParts[common]) {

            common++;

        }

        const up = fromDir.length - common;

        const segs = [];

        for (let i = 0; i < up; i++) segs.push('..');

        segs.push(...toParts.slice(common));

        let rel = segs.join('/');

        if (rel.charAt(0) !== '.') rel = './' + rel;

        return `require('${rel}')`;

    });

}



// buildId строится ОДИН раз на сборку и вшивается в window.TrainingCore.

let _buildId = null;

function buildId() {

    if (!_buildId) _buildId = computeSourcesHash();

    return _buildId;

}



function buildModuleDefs() {

    let defs = '';

    for (const id of Object.keys(MODULES)) {

        let body = readUtf8(MODULES[id]);

        // LLM-слои требуют core-соседей по абсолютному пути диска — сводим к относительному.

        body = rewriteRequires(body, id);

        defs += `  ${JSON.stringify(id)}: function(module, exports, require, __dirname){${body}\n  },\n`;

    }

    // JSON-ресурсы: валидируем и встраиваем сериализованно (гарантия корректного JS).

    for (const id of Object.keys(RESOURCES)) {

        const parsed = JSON.parse(readUtf8(RESOURCES[id]));

        defs += `  ${JSON.stringify(id)}: function(module, exports, require){ module.exports = ${JSON.stringify(parsed)};\n  },\n`;

    }

    // Node-встроенные fs/path — виртуальные shim'ы для LLM-слоёв (P-A..P-P).

    for (const id of Object.keys(SHIMS)) {

        defs += `  ${JSON.stringify(id)}: function(module, exports, require){${SHIMS[id]}\n  },\n`;

    }

    return defs;

}



function buildBundle() {

    const header =

        '/* AUTO-GENERATED by tools/build.js — DO NOT EDIT. */\n' +

        `/* P6 UI migration. Generated: ${new Date().toISOString()}. */\n`;



    const moduleDefs = buildModuleDefs();



    const apiLines = Object.keys(API)

        .map((k) => `            ${k}: __require("bundle", ${JSON.stringify(API[k])}),`)

        .join('\n');



    const resourcesLines = Object.keys(RESOURCES)

        .map((id) => {

            const name = id.slice(id.lastIndexOf('/') + 1).replace(/\.json$/, '');

            return `            ${JSON.stringify(name)}: __require("bundle", ${JSON.stringify(id)}),`;

        })

        .join('\n');



    const assignment = '    window.TrainingCore = {\n'

            + apiLines + '\n'

            + '        resources: {\n'

            + resourcesLines + '\n'

            + '        },\n'

            + '        buildId: ' + JSON.stringify(buildId()) + '\n'

            + '    };\n';



        const prompts = {};

        for (const m of PROMPT_MODES) {

            prompts[m] = readUtf8(`prompts/mode_${m}.md`);

        }



        return `${header}

    (function () {

        "use strict";



        var __modules = {

    ${moduleDefs}    };



        var __cache = {};



        // Разрешение относительного require-спецификатора ('../core/x.js') к id бандла.

        function __resolve(fromId, rel) {

            if (typeof rel !== 'string' || rel.charAt(0) !== '.') return rel;

            var base = fromId.split('/'); base.pop(); // каталог запрашивающего модуля

            var parts = rel.split('/');

            for (var i = 0; i < parts.length; i++) {

                var p = parts[i];

                if (p === '' || p === '.') continue;

                if (p === '..') { base.pop(); continue; }

                base.push(p);

            }

            return base.join('/');

        }



        function __require(fromId, rel) {

            var id = __resolve(fromId, rel);

            if (__cache[id]) return __cache[id].exports;

            var mod = { exports: {} };

            __cache[id] = mod;

            // Каталог модуля (по bundle-id) — становится __dirname внутри модуля

            // (LLM-слои P-A..P-P используют его для PROMPTS_DIR/путей лога).

            var _sep = id.lastIndexOf('/');

            __modules[id](mod, mod.exports, function (r) { return __require(id, r); },

                _sep >= 0 ? id.slice(0, _sep) : '');

            return mod.exports;

        }



    ${assignment}

        window.TrainingCore.PROMPTS = ${JSON.stringify(prompts, null, 2)};

    })();

    `;

    }



    function verify(contents) {

    fs.writeFileSync(OUT, contents, 'utf8');

    // Синтаксис — node --check (не исполняем браузерный код, только parse).

    child.execFileSync(process.execPath, ['--check', OUT], { encoding: 'utf8' });



    const checks = [

        ['непустой', contents.length > 1000],

        ['содержит window.TrainingCore', contents.includes('window.TrainingCore')],

        ['содержит PROMPTS', contents.includes('PROMPTS')],

        ['метод interpret', contents.includes('interpret')],

        ['метод match', contents.includes('match')],

        ['метод toChartConfig', contents.includes('toChartConfig')],

        ['метод makeEvent', contents.includes('makeEvent')],

        ['метод chat', contents.includes('chat')],

        ['ресурсы graph', contents.includes('"graph": __require')],

        ['LLM-слой pipeline', contents.includes('pipeline: __require') && contents.includes('core/pipeline.js')],

        ['ресурс rulesLog', contents.includes('"rulesLog": __require') && contents.includes('data/rulesLog.json')],

        ['fs-шим вшивает mode_router.md (иначе Router не стартует в браузере)', contents.includes('"mode_router.md"')],

        ['fs-шим вшивает rulesLog.json (иначе rulesLog.loadLog бросает в браузере)', contents.includes('"rulesLog.json"')],

        ['fs-шим вшивает mode_minorRuleUpdate.md и mode_ruleUpdate.md (Branch 2/3 в браузере)', contents.includes('"mode_minorRuleUpdate.md"') && contents.includes('"mode_ruleUpdate.md"')],

        ['вшиты 4 промпта', PROMPT_MODES.every((m) => promptsEmbedded(contents, m))],

    ];

    const failed = checks.filter(([, ok]) => !ok);

    if (failed.length) {

        throw new Error('ПРОВАЛ QA бандла: ' + failed.map(([n]) => n).join(', '));

    }

    return checks.length;

}



function promptsEmbedded(contents, mode) {

    return contents.includes('"' + mode + '":');

}



if (require.main === module) {

    const bundle = buildBundle();

    const nChecks = verify(bundle);

    console.log(`✅ bundle.js собран (${bundle.length} байт) и прошёл ${nChecks} проверок QA.`);

    console.log(`   → ${OUT}`);

}



module.exports = { buildBundle, verify, MODULES, API };
