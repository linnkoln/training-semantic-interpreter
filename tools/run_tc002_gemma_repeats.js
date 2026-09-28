'use strict';

// Isolated core-only TC-002 repeats using the project's local Gemma endpoint.
// Reads the immutable TC-002 seed and writes all logs/state under ignored work/.
// It never calls commitRules/Save and refuses any non-local LLM endpoint.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const pipeline = require('../core/pipeline.js');
const rulesLog = require('../core/rulesLog.js');
const tmpStore = require('../adapters/tmpStore.js');
const trace = require('../core/trace.js');

const root = path.resolve(__dirname, '..');
const fixture = path.join(root, 'docs/testing/fixtures/TC-002-after-TC-001');
const oracleDir = path.join(root, 'docs/testing/reference-data/TC-002');
const evidencePath = path.join(root, 'docs/testing/cases/TC-002-max-approaches/TC-002-evidence.json');
const input = JSON.parse(fs.readFileSync(evidencePath, 'utf8')).input;
const oracleRules = JSON.parse(fs.readFileSync(path.join(oracleDir, 'rulesLog.json'), 'utf8'));
const oracleRule = oracleRules.rules.at(-1);
const oracleGraph = JSON.parse(fs.readFileSync(path.join(oracleDir, 'graph.json'), 'utf8'));
const expectedOverlayRelations = oracleGraph.relations.filter((relation) => relation.type === 'overlay');
const outputRoot = path.join(root, 'work', `gemma-tc002-repeats-${new Date().toISOString().replace(/[:.]/g, '-')}`);
const repeats = Math.max(1, Math.min(3, Number(process.argv[2]) || 1));
const names = ['rulesLog.json', 'rulesLog.tmp.json', 'graph.json', 'graph.tmp.json'];
const expectedEvents = [
  {
    date: '2026-07-17',
    values: {
      press_reps: 100, squat_reps: 100, push_reps: 100, push_knees_reps: 0,
      running_distance_km: 10, pull_reps: 36, pull_rings_reps: 14,
    },
  },
  {
    date: '2026-07-19',
    values: {
      press_reps: 100, squat_reps: 100, push_reps: 100, push_knees_reps: 0,
      running_distance_km: 10, pull_reps: 50, pull_rings_reps: 0,
    },
  },
  {
    date: '2026-07-21',
    values: {
      press_reps: 100, squat_reps: 100, push_reps: 100, running_distance_km: 10,
      push_max_set: 32, pull_reps: 50, pull_max_set: 6,
    },
  },
];

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}
function sameJson(a, b) { return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b)); }
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function semanticExamples(examples) {
  return (Array.isArray(examples) ? examples : [])
    .map(({ input: exampleInput, values }) => ({ input: exampleInput, values }))
    .sort((a, b) => String(a.input).localeCompare(String(b.input)));
}
function semanticRelations(relations) {
  return (Array.isArray(relations) ? relations : [])
    .map(({ type, base, sub }) => ({ type, base, sub }))
    .sort((a, b) => `${a.type}:${a.base}:${a.sub || ''}`.localeCompare(`${b.type}:${b.base}:${b.sub || ''}`));
}

// TC-002 fixture files are human-readable reference data ({ rules: [...] }),
// while core/rulesLog reads the versioned runtime log ({ entries: [...] }).
// Adapt the immutable fixture inside the scratch run only.
function runtimeRulesLog(reference) {
  const versions = Array.isArray(reference?.rules) ? reference.rules : [];
  const entries = versions.map((version, index) => {
    const versionNumber = Number(version.version) || index + 1;
    const rule = {
      id: 'rule_001',
      raw: version.raw || '',
      mapping: version.mapping || {},
      examples: version.examples || [],
      __version: versionNumber,
    };
    return {
      version: versionNumber,
      timestamp: version.updatedAt || version.createdAt || new Date(0).toISOString(),
      rulesSnapshot: { version: versionNumber, updatedAt: version.updatedAt || version.createdAt || null,
        dynamic: [rule], global: [] },
      changeType: index === 0 ? 'add' : 'update',
      meta: { source: 'TC-002 isolated reference fixture' },
    };
  });
  return { version: entries.at(-1)?.version || 0, updatedAt: entries.at(-1)?.timestamp || null, entries };
}

(async () => {
  if (!fs.existsSync(fixture) || !fs.existsSync(evidencePath)) throw new Error('TC-002 seed/evidence is missing');
  fs.mkdirSync(outputRoot, { recursive: false });
  let failures = 0;

  for (let index = 1; index <= repeats; index++) {
    const runDir = path.join(outputRoot, `run-${String(index).padStart(2, '0')}`);
    fs.mkdirSync(runDir, { recursive: false });
    const paths = Object.fromEntries(names.map((name) => [name, path.join(runDir, name)]));
    for (const name of names) fs.copyFileSync(path.join(fixture, name), paths[name]);
    const referenceRules = JSON.parse(fs.readFileSync(paths['rulesLog.json'], 'utf8'));
    fs.writeFileSync(paths['rulesLog.json'], JSON.stringify(runtimeRulesLog(referenceRules), null, 2) + '\n');

    rulesLog._resetCache();
    rulesLog._setLogPath(paths['rulesLog.json']);
    tmpStore._setRulesTmpPath(paths['rulesLog.tmp.json']);
    tmpStore._setGraphTmpPath(paths['graph.tmp.json']);
    pipeline._setGraphFsPath(paths['graph.json']);
    const tracesDir = path.join(runDir, 'traces');
    const callsDir = path.join(runDir, 'calls');
    fs.mkdirSync(callsDir);
    trace._setTraceDir(tracesDir);
    trace._setFsAvailable(true);

    let callIndex = 0;
    const localFetch = async (url, init) => {
      if (!String(url).startsWith('http://localhost:11434/')) {
        throw new Error(`Refusing non-local Gemma endpoint: ${url}`);
      }
      const response = await fetch(url, init);
      const body = init && init.body ? JSON.parse(init.body) : {};
      const responseBody = await response.clone().json().catch(() => null);
      const prompt = body.messages?.[0]?.content || '';
      fs.writeFileSync(path.join(callsDir, `call-${String(++callIndex).padStart(2, '0')}.json`),
        JSON.stringify({ url: String(url), model: body.model, prompt, response: responseBody }, null, 2) + '\n');
      return response;
    };

    const result = await pipeline.next(input, {
      date: '2026-07-21',
      llmOptions: { fetch: localFetch },
    });
    const events = result.payload?.events || [];
    const groups = (result.payload?.groups || []).map((item) => item.group);
    const actualEvents = events.map((event) => ({ date: event.date, values: event.values }));
    const relations = result.payload?.relations || [];
    const proposedKeys = (result.payload?.newKeys || result.payload?.rule?.keys || []).map((item) => item.key);
    const stagedRules = JSON.parse(fs.readFileSync(paths['rulesLog.tmp.json'], 'utf8'));
    const stagedRule = (stagedRules.rules || []).find((rule) => rule.completeSnapshot)
      || (stagedRules.rules || []).at(-1)
      || null;
    const stagedGraph = JSON.parse(fs.readFileSync(paths['graph.tmp.json'], 'utf8'));
    const stagedMapping = stagedRule?.mapping || null;
    const stagedExamples = semanticExamples(stagedRule?.examples);
    const expectedExamples = semanticExamples(oracleRule.examples);
    const stagedRelations = semanticRelations(stagedGraph.relations);
    const expectedOverlays = semanticRelations(expectedOverlayRelations);
    const overlayOk = ['push_max_set', 'pull_max_set'].every((key) =>
      (result.payload?.rule?.roles || {})[key] === 'overlay')
      || ['push_max_set', 'pull_max_set'].every((key) =>
        relations.some((rel) => rel.type === 'overlay' && rel.sub === key));
    const checks = {
      status: result.status === 'success',
      perDayRouterGroups: sameJson(groups, [1, 1, 3]),
      exactUserOracleEvents: sameJson(actualEvents, expectedEvents),
      noZeroOrAbsentComponentsCarriedInto0721: !('push_knees_reps' in (events.find((e) => e.date === '2026-07-21')?.values || {}))
        && !('pull_rings_reps' in (events.find((e) => e.date === '2026-07-21')?.values || {})),
      maxRelationsUseOverlay: overlayOk,
      stagedRuleMappingMatchesOracle: sameJson(stagedMapping, oracleRule.mapping),
      stagedRuleExamplesMatchOracle: sameJson(stagedExamples, expectedExamples),
      stagedGraphRelationsMatchOracleOverlays: sameJson(stagedRelations, expectedOverlays),
    };
    const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
    failures += failed.length ? 1 : 0;
    const report = {
      runId: `${path.basename(outputRoot)}-run-${String(index).padStart(2, '0')}`,
      executedAt: new Date().toISOString(),
      model: 'gemma4 (local Ollama endpoint)',
      inputSha256: sha256(input),
      promptVersions: [...new Set([...fs.readdirSync(callsDir)].map((file) => {
        const content = JSON.parse(fs.readFileSync(path.join(callsDir, file), 'utf8')).prompt;
        return content.match(/<!--\s*version:\s*([^\s]+)\s*-->/)?.[1] || 'unknown';
      }))],
      callsCaptured: callIndex,
      status: result.status,
      groups,
      actualEvents,
      expectedEvents,
      proposedKeys,
      proposedRelations: relations,
      stagedRule: stagedRule ? { mapping: stagedMapping, examples: stagedExamples } : null,
      expectedRule: { mapping: oracleRule.mapping, examples: expectedExamples },
      stagedGraphRelations: stagedRelations,
      expectedOverlayRelations: expectedOverlays,
      checks,
      failedChecks: failed,
      message: result.message || null,
    };
    fs.writeFileSync(path.join(runDir, 'result.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ runId: report.runId, pass: failed.length === 0, failedChecks: failed, groups, actualEvents, capturedCalls: callIndex, result: path.join(runDir, 'result.json') }));
  }

  rulesLog._resetCache();
  if (failures) process.exitCode = 1;
})().catch((error) => {
  console.error(error && error.stack || String(error));
  process.exitCode = 1;
});
