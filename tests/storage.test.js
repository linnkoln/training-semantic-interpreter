'use strict';
// tests/storage.test.js — P6: vault-адаптер storage (makeStorage) с ПОДДЕЛЬНЫМ app.
// Чистый (нет dv/DOM). Проверяем: однократную миграцию легаси (D2), что
// уже-версионированные события не трогаются, и сохранение с бэкапом.
const test = require('node:test');
const assert = require('node:assert/strict');

const { makeStorage, LEGACY_VERSION } = require('../adapters/storage.js');

/** Построение поддельного Obsidian vault: in-memory файловая модель. */
function makeFakeApp(initialFiles) {
    const files = Object.assign({}, initialFiles || {});
    return {
        vault: {
            getAbstractFileByPath(path) {
                return Object.prototype.hasOwnProperty.call(files, path)
                    ? { path, _name: path }   // фальшивый TFile: имеет поле path
                    : null;
            },
            async read(file) { return files[file.path]; },
            async create(path, content) { files[path] = content; return { path }; },  // eslint-disable-line no-unused-vars
            async createFolder() {},
            async modify(file, content) { files[file.path] = content; return file; },
            async delete(file) { delete files[file.path]; },
        },
        _files: files,
    };
}

const DATA_PATH = 'data/training/data.json';

test('migrateLegacy: легаси {date,values} получают interpretation_version:0 и createdAt (D2)', () => {
    const st = makeStorage(makeFakeApp());
    const res = st.migrateLegacy([{ date: '2026-08-19', values: { push_full: 100 } }]);
    assert.equal(res.changed, true);
    assert.equal(res.events.length, 1);
    assert.equal(res.events[0].date, '2026-08-19');
    assert.deepEqual(res.events[0].values, { push_full: 100 });
    assert.equal(res.events[0].interpretation_version, LEGACY_VERSION);
    assert.ok(res.events[0].createdAt, 'у легаси должен появиться createdAt');
});

test('migrateLegacy: уже-версионированные события НЕ трогаются', () => {
    const st = makeStorage(makeFakeApp());
    const existing = {
        date: '2026-08-20',
        values: { push_max_set: 50 },
        interpretation_version: 3,
        createdAt: '2026-08-20T00:00:00.000Z',
    };
    const res = st.migrateLegacy([existing]);
    assert.equal(res.changed, false, 'версионированное событие — не изменение');
    assert.equal(res.events[0], existing, 'объект не должен пересоздаваться');
    assert.equal(res.events[0].interpretation_version, 3);
});

test('migrateLegacy: смесь легаси и версионированных мигрируется частично', () => {
    const st = makeStorage(makeFakeApp());
    const versioned = { date: 'a', values: {}, interpretation_version: 2, createdAt: 'x' };
    const res = st.migrateLegacy([
        versioned,
        { date: '2026-01-01', values: { pull_full: 5 } },
    ]);
    assert.equal(res.changed, true);
    assert.equal(res.events[0], versioned);
    assert.equal(res.events[1].interpretation_version, LEGACY_VERSION);
});

test('migrateLegacy: не-массив → { events: [], changed: false }', () => {
    const st = makeStorage(makeFakeApp());
    const res = st.migrateLegacy(null);
    assert.deepEqual(res.events, []);
    assert.equal(res.changed, false);
});

test('loadData: читает файл и ОДНОКРАТНО персистит миграцию легаси', async () => {
    const app = makeFakeApp({ [DATA_PATH]: JSON.stringify([{ date: '2026-08-01', values: { push_full: 10 } }]) });
    const st = makeStorage(app);
    const events = await st.loadData();
    // Возвращённые события версионированы.
    assert.equal(events.length, 1);
    assert.equal(events[0].interpretation_version, LEGACY_VERSION);
    // Персист миграции: файл перезаписан с версиями (и сделал бэкап).
    const persisted = JSON.parse(app._files[DATA_PATH]);
    assert.equal(persisted[0].interpretation_version, LEGACY_VERSION);
    assert.ok(persisted[0].createdAt);
});

test('saveData: модифицирует файл и делает timestamped-бэкап', async () => {
    const app = makeFakeApp({ [DATA_PATH]: JSON.stringify([{ date: '1', values: {} }]) });
    const st = makeStorage(app);
    const newData = [{ date: '2026-09-01', values: { pull_full: 8 }, interpretation_version: 1, createdAt: 'now' }];
    const res = await st.saveData(newData, { backup: true });
    assert.equal(res.saved, true);
    assert.equal(res.backup, true);
    // Основной файл обновлён.
    assert.deepEqual(JSON.parse(app._files[DATA_PATH]), newData);
    // Появился бэкап data/training/backups/data_*.json с прежним содержимым.
    const backupPaths = Object.keys(app._files).filter((p) => p.indexOf('data/training/backups/data_') === 0);
    assert.equal(backupPaths.length, 1);
    assert.deepEqual(JSON.parse(app._files[backupPaths[0]]), [{ date: '1', values: {} }]);
});

test('saveData: создаёт файл, если его нет (без бэкапа)', async () => {
    const app = makeFakeApp({});
    const st = makeStorage(app);
    const data = [];
    const res = await st.saveData(data, { backup: true });
    assert.equal(res.saved, true);
    assert.equal(res.backup, false);
    assert.deepEqual(JSON.parse(app._files[DATA_PATH]), []);
});

test('saveData с дополнительными файлами атомарен при отказе записи любого main-файла', async (t) => {
    const paths = [
        'scripts/training/data/rulesLog.json',
        'scripts/training/data/graph.json',
        DATA_PATH,
    ];
    for (const failedPath of paths) {
        await t.test(`откат после отказа ${failedPath}`, async () => {
            const initial = {
                [DATA_PATH]: JSON.stringify([{ date: '2026-09-01', values: { push_reps: 10 } }]),
                'scripts/training/data/rulesLog.json': JSON.stringify({ version: 1, entries: [] }),
                'scripts/training/data/graph.json': JSON.stringify({ relations: [], targets: [], trends: [] }),
            };
            const app = makeFakeApp(initial);
            const modify = app.vault.modify.bind(app.vault);
            let failOnce = true;
            app.vault.modify = async (file, content) => {
                // Имитируем частичную запись: содержимое меняется, затем Vault бросает ошибку.
                filesWrite(file, content);
                function filesWrite(target, value) { app._files[target.path] = value; }
                if (file.path === failedPath && failOnce) {
                    failOnce = false;
                    throw new Error('simulated partial Vault write');
                }
                return modify(file, content);
            };
            const st = makeStorage(app);
            await assert.rejects(
                st.saveData([{ date: '2026-09-02', values: { push_reps: 12 } }], {
                    additionalWrites: [
                        { path: 'scripts/training/data/rulesLog.json', data: { version: 2, entries: [{ version: 2 }] } },
                        { path: 'scripts/training/data/graph.json', data: { relations: [{ type: 'successor', parent: 'push_reps', child: 'push_max' }], targets: [] } },
                    ],
                }),
                /Сохранение отменено: .*прежние main-файлы восстановлены/,
            );
            for (const filePath of paths) {
                assert.equal(app._files[filePath], initial[filePath], `${filePath} восстановлен побайтно`);
            }
        });
    }
});
