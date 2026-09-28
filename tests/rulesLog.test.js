'use strict';
// tests/rulesLog.test.js — P-D: Rules Log тесты.
// Версионирование, иммутабельность, монотонные версии.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const RULES_LOG_PATH = path.resolve(__dirname, '../data/rulesLog.json');

/** Читает JSON файл. */
function readLog(p) {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/** Записывает JSON файл. */
function writeLog(p, data) {
    fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
}

/** Создаёт чистый тестовый лог: СИНТЕТИЧЕСКАЯ фикстура (data/rulesLog.json пуст
 *  после сброса — версия 0). Фикстура: версия 1, один init-entry, снапшот с
 *  rule_001/rule_002/rule_003 — на нём проверяются appendRule/deprecate/migrate. */
function createTestLog(targetPath) {
    const snapshot = {
        version: 1,
        updatedAt: '2026-01-01T00:00:00.000Z',
        dynamic: [
            { id: 'rule_001', __version: 1, when: { pattern: '^фикстура\\s*(\\d+)$' }, then: { entity: 'fix', metric: 'full', composition: 'single' } },
            { id: 'rule_002', __version: 1, when: { pattern: '^фикстура2\\s*(\\d+)$' }, then: { entity: 'fix2', metric: 'full', composition: 'single' } },
            { id: 'rule_003', __version: 1, when: { pattern: '^фикстура3\\s*(\\d+)$' }, then: { entity: 'fix3', metric: 'full', composition: 'single' } },
        ],
        global: [],
    };
    const testLog = {
        version: 1,
        updatedAt: snapshot.updatedAt,
        entries: [
            {
                version: 1,
                timestamp: snapshot.updatedAt,
                changeType: 'init',
                rulesSnapshot: snapshot,
                meta: { description: 'фикстура тестов rulesLog' },
            },
        ],
    };
    writeLog(targetPath, testLog);
}

/** Создаёт уникальный путь для тестового лога. */
function uniqueTestLogPath() {
    const suffix = crypto.randomBytes(8).toString('hex');
    return path.resolve(__dirname, `../data/rulesLog.test.${suffix}.tmp.json`);
}

/** Создаёт новый экземпляр модуля rulesLog, привязанный к уникальному тестовому файлу. */
function createRulesLogInstance() {
    const testLogPath = uniqueTestLogPath();
    createTestLog(testLogPath);
    // Очищаем кэш require для этого модуля
    const modPath = require.resolve('../core/rulesLog.js');
    delete require.cache[modPath];
    const mod = require(modPath);
    // Подменяем путь к логу
    mod._resetCache();
    mod._setLogPath(testLogPath);
    // Возвращаем и модуль, и путь для очистки
    return { mod, testLogPath };
}

/** Очищает тестовый файл. */
function cleanupTestLog(testLogPath) {
    if (fs.existsSync(testLogPath)) {
        fs.unlinkSync(testLogPath);
    }
}

test('getRulesLog возвращает полный лог с версией и записями', () => {
    const { mod: rulesLog, testLogPath } = createRulesLogInstance();
    try {
        const log = rulesLog.getRulesLog();
        assert.equal(log.version, 1);
        assert.ok(Array.isArray(log.entries));
        assert.equal(log.entries.length, 1);
        assert.equal(log.entries[0].version, 1);
        assert.equal(log.entries[0].changeType, 'init');
    } finally {
        cleanupTestLog(testLogPath);
    }
});

test('getVersion возвращает текущую версию лога', () => {
    const { mod: rulesLog, testLogPath } = createRulesLogInstance();
    try {
        assert.equal(rulesLog.getVersion(), 1);
    } finally {
        cleanupTestLog(testLogPath);
    }
});

test('getLatestRules возвращает снапшот правил последней версии', () => {
    const { mod: rulesLog, testLogPath } = createRulesLogInstance();
    try {
        const latest = rulesLog.getLatestRules();
        assert.equal(latest.version, 1);
        assert.ok(Array.isArray(latest.dynamic));
        assert.ok(Array.isArray(latest.global));
        assert.equal(latest.dynamic.length, 3);
        assert.equal(latest.global.length, 0);
    } finally {
        cleanupTestLog(testLogPath);
    }
});

test('appendRule add: добавляет новое правило, поднимает версию, сохраняет историю', () => {
    const { mod: rulesLog, testLogPath } = createRulesLogInstance();
    try {
        const beforeVersion = rulesLog.getVersion();
        const newRule = {
            id: 'rule_010',
            when: { pattern: '^тест\\\\s*(\\\\d+)$' },
            then: { entity: 'push', metric: 'full', composition: 'single' },
        };
        const entry = rulesLog.appendRule(newRule, 'add', { rationale: 'тестовое правило' });

        // Проверяем возвращаемую запись
        assert.equal(entry.version, beforeVersion + 1);
        assert.equal(entry.changeType, 'add');
        assert.equal(entry.meta.rationale, 'тестовое правило');
        assert.ok(entry.timestamp);
        assert.ok(entry.rulesSnapshot);

        // Проверяем, что версия увеличилась
        assert.equal(rulesLog.getVersion(), beforeVersion + 1);

        // Проверяем, что лог содержит новую запись
        const log = rulesLog.getRulesLog();
        assert.equal(log.version, beforeVersion + 1);
        assert.equal(log.entries.length, 2);
        assert.equal(log.entries[1].version, beforeVersion + 1);
        assert.equal(log.entries[1].changeType, 'add');

        // Проверяем, что новое правило в снапшоте
        const latest = rulesLog.getLatestRules();
        const added = latest.dynamic.find(r => r.id === 'rule_010');
        assert.ok(added, 'новое правило должно быть в dynamic');
        assert.equal(added.when.pattern, '^тест\\\\s*(\\\\d+)$');
    } finally {
        cleanupTestLog(testLogPath);
    }
});

test('appendRule add: запрещает дубликат id', () => {
    const { mod: rulesLog, testLogPath } = createRulesLogInstance();
    try {
        assert.throws(
            () => rulesLog.appendRule({ id: 'rule_001', when: { pattern: 'x' }, then: {} }, 'add'),
            /уже существует/
        );
    } finally {
        cleanupTestLog(testLogPath);
    }
});

test('appendRule update: обновляет существующее правило, инкрементит __version', () => {
    const { mod: rulesLog, testLogPath } = createRulesLogInstance();
    try {
        const beforeVersion = rulesLog.getVersion();
        const entry = rulesLog.appendRule(
            { id: 'rule_001', when: { pattern: '^новое\\\\s*(\\\\d+)$' } },
            'update',
            { rationale: 'обновление паттерна' }
        );

        assert.equal(entry.version, beforeVersion + 1);
        assert.equal(entry.changeType, 'update');

        const latest = rulesLog.getLatestRules();
        const updated = latest.dynamic.find(r => r.id === 'rule_001');
        assert.ok(updated);
        assert.equal(updated.when.pattern, '^новое\\\\s*(\\\\d+)$');
        assert.equal(updated.__version, 2); // было 1, стало 2
    } finally {
        cleanupTestLog(testLogPath);
    }
});

test('appendRule update: запрещает обновление несуществующего', () => {
    const { mod: rulesLog, testLogPath } = createRulesLogInstance();
    try {
        assert.throws(
            () => rulesLog.appendRule({ id: 'rule_999', when: { pattern: 'x' } }, 'update'),
            /не найдено/
        );
    } finally {
        cleanupTestLog(testLogPath);
    }
});

test('appendRule deprecate: помечает правило как deprecated, инкрементит __version', () => {
    const { mod: rulesLog, testLogPath } = createRulesLogInstance();
    try {
        const beforeVersion = rulesLog.getVersion();
        const entry = rulesLog.appendRule({ id: 'rule_002' }, 'deprecate', { reason: 'устарело' });

        assert.equal(entry.version, beforeVersion + 1);
        assert.equal(entry.changeType, 'deprecate');

        const latest = rulesLog.getLatestRules();
        const deprecated = [...latest.dynamic, ...latest.global].find(r => r.id === 'rule_002');
        assert.ok(deprecated);
        assert.equal(deprecated.deprecated, true);
        assert.equal(deprecated.__version, 2);
    } finally {
        cleanupTestLog(testLogPath);
    }
});

test('appendRule deprecate: запрещает депрекацию несуществующего', () => {
    const { mod: rulesLog, testLogPath } = createRulesLogInstance();
    try {
        assert.throws(
            () => rulesLog.appendRule({ id: 'rule_999' }, 'deprecate'),
            /не найдено/
        );
    } finally {
        cleanupTestLog(testLogPath);
    }
});

test('appendRule migrate: применяет пакетную миграцию через applyMigration', () => {
    const { mod: rulesLog, testLogPath } = createRulesLogInstance();
    try {
        const beforeVersion = rulesLog.getVersion();
        const batch = [
            {
                id: 'rule_003',
                rule: { when: { pattern: '^подтягивания\\\\s*(\\\\d+)$' }, then: { entity: 'pull', metric: 'full', composition: 'single' } },
            },
        ];
        const entry = rulesLog.appendRule(batch, 'migrate', { rationale: 'миграция rule_003' });

        assert.equal(entry.version, beforeVersion + 1);
        assert.equal(entry.changeType, 'migrate');

        const latest = rulesLog.getLatestRules();
        const migrated = latest.dynamic.find(r => r.id === 'rule_003');
        assert.ok(migrated);
        assert.equal(migrated.when.pattern, '^подтягивания\\\\s*(\\\\d+)$');
        assert.equal(migrated.__version, 2);
    } finally {
        cleanupTestLog(testLogPath);
    }
});

test('appendRule migrate: требует массив изменений', () => {
    const { mod: rulesLog, testLogPath } = createRulesLogInstance();
    try {
        assert.throws(
            () => rulesLog.appendRule({ id: 'rule_001' }, 'migrate'),
            /ожидает массив/
        );
    } finally {
        cleanupTestLog(testLogPath);
    }
});

test('Иммутабельность: getRulesLog возвращает замороженный объект', () => {
    const { mod: rulesLog, testLogPath } = createRulesLogInstance();
    try {
        const log = rulesLog.getRulesLog();
        assert.ok(Object.isFrozen(log), 'лог должен быть заморожен');
        assert.ok(Object.isFrozen(log.entries), 'entries должен быть заморожен');
        assert.ok(Object.isFrozen(log.entries[0]), 'запись должна быть заморожена');
        assert.ok(Object.isFrozen(log.entries[0].rulesSnapshot), 'rulesSnapshot должен быть заморожен');
    } finally {
        cleanupTestLog(testLogPath);
    }
});

test('Иммутабельность: getLatestRules возвращает замороженный снапшот', () => {
    const { mod: rulesLog, testLogPath } = createRulesLogInstance();
    try {
        const latest = rulesLog.getLatestRules();
        assert.ok(Object.isFrozen(latest), 'latest должен быть заморожен');
        assert.ok(Object.isFrozen(latest.dynamic), 'dynamic должен быть заморожен');
        assert.ok(Object.isFrozen(latest.global), 'global должен быть заморожен');
        assert.throws(() => { latest.dynamic.push({}); }, TypeError, 'dynamic не должен мутироваться');
    } finally {
        cleanupTestLog(testLogPath);
    }
});

test('Иммутабельность: appendRule не мутирует предыдущие версии в логе', () => {
    const { mod: rulesLog, testLogPath } = createRulesLogInstance();
    try {
        const logBefore = JSON.parse(JSON.stringify(rulesLog.getRulesLog()));
        rulesLog.appendRule(
            { id: 'rule_011', when: { pattern: '^immut\\\\s*(\\\\d+)$' }, then: { entity: 'push', metric: 'full', composition: 'single' } },
            'add'
        );
        const logAfter = rulesLog.getRulesLog();

        // Первая запись не должна измениться
        assert.deepEqual(logAfter.entries[0], logBefore.entries[0], 'первая запись лога не должна мутировать');
        assert.deepEqual(logAfter.entries[0].rulesSnapshot, logBefore.entries[0].rulesSnapshot, 'rulesSnapshot первой записи не должен мутировать');
    } finally {
        cleanupTestLog(testLogPath);
    }
});

test('Монотонность версий: каждая appendRule увеличивает версию ровно на 1', () => {
    const { mod: rulesLog, testLogPath } = createRulesLogInstance();
    try {
        const versions = [];
        for (let i = 0; i < 5; i++) {
            versions.push(rulesLog.getVersion());
            rulesLog.appendRule(
                { id: `rule_mono_${i}`, when: { pattern: `^mono${i}\\\\s*(\\\\d+)$` }, then: { entity: 'push', metric: 'full', composition: 'single' } },
                'add'
            );
        }
        versions.push(rulesLog.getVersion());

        // Проверяем строгую монотонность
        for (let i = 1; i < versions.length; i++) {
            assert.equal(versions[i], versions[i - 1] + 1, `версия ${i} должна быть ${versions[i - 1] + 1}, а не ${versions[i]}`);
        }
    } finally {
        cleanupTestLog(testLogPath);
    }
});

test('Монотонность версий: версии записей в логе строго возрастают', () => {
    const { mod: rulesLog, testLogPath } = createRulesLogInstance();
    try {
        const log = rulesLog.getRulesLog();
        const entryVersions = log.entries.map(e => e.version);
        for (let i = 1; i < entryVersions.length; i++) {
            assert.ok(entryVersions[i] > entryVersions[i - 1], `версия записи ${i} (${entryVersions[i]}) должна быть > ${entryVersions[i - 1]}`);
        }
        // Последняя версия лога равна версии последней записи
        assert.equal(log.version, entryVersions[entryVersions.length - 1]);
    } finally {
        cleanupTestLog(testLogPath);
    }
});

test('История сохраняется: все предыдущие снапшоты доступны', () => {
    const { mod: rulesLog, testLogPath } = createRulesLogInstance();
    try {
        const log = rulesLog.getRulesLog();
        // Должна быть хотя бы исходная запись
        assert.ok(log.entries.length >= 1);
        // Каждая запись имеет свой rulesSnapshot
        for (const entry of log.entries) {
            assert.ok(entry.rulesSnapshot, `запись v${entry.version} должна иметь rulesSnapshot`);
            assert.equal(entry.rulesSnapshot.version, entry.version);
            assert.ok(Array.isArray(entry.rulesSnapshot.dynamic));
            assert.ok(Array.isArray(entry.rulesSnapshot.global));
        }
    } finally {
        cleanupTestLog(testLogPath);
    }
});

test('Неизвестный changeType выбрасывает ошибку', () => {
    const { mod: rulesLog, testLogPath } = createRulesLogInstance();
    try {
        assert.throws(
            () => rulesLog.appendRule({ id: 'x' }, 'invalid'),
            /неизвестный changeType/
        );
    } finally {
        cleanupTestLog(testLogPath);
    }
});

test('Правило без id выбрасывает ошибку', () => {
    const { mod: rulesLog, testLogPath } = createRulesLogInstance();
    try {
        assert.throws(
            () => rulesLog.appendRule({ when: { pattern: 'x' } }, 'add'),
            /должно иметь id/
        );
    } finally {
        cleanupTestLog(testLogPath);
    }
});