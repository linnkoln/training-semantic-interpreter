'use strict';
// adapters/storage.js — P6: vault-адаптер данных тренировок.
//
// ЧИСТЫЙ адаптер: `app` (объект Obsidian) инжектируется через makeStorage(app),
// поэтому тестируется с поддельным app без реального хранилища (tests/storage.test.js).
//
// КОНТРАКТ ГДЕ ЖИВУТ ДАННЫЕ (идентично прежнему main.js, не менять):
//   DATA_PATH = "data/training/data.json" — относительно КОРНЯ хранилища Obsidian
//   бэкап     = data/training/backups/data_<ts>.json
//
// МИГРАЦИЯ (D2): события в легаси-форме { date, values } БЕЗ interpretation_version —
// это старый формат данных (см. CONTEXT). При первом чтении migrateLegacy добавляет
//   interpretation_version: 0,  createdAt: <now>
// к СТАРЫМ событиям и loadData персистит результат ОДНОКРАТНО (помечено в коде).
// Уже-версионированные события НЕ трогаются никогда.

const DATA_PATH = "data/training/data.json";
const DATA_FOLDER = "data/training";
const BACKUP_FOLDER = "data/training/backups";

// D2: легаси-события трактуются как версия интерпретации 0 (до появления версий).
const LEGACY_VERSION = 0;

function timestring(d) {
    return (d && typeof d.toISOString === 'function') ? d.toISOString() : d;
}

/**
 * ОДНОКРАТНАЯ миграция легаси-формата (D2) { date, values } → полная модель
 * { date, values, interpretation_version, createdAt }. Иммутабельная по смыслу:
 * возвращает НОВЫЙ массив, не мутируя вход. Уже-версионированные события
 * (Number.isInteger(interpretation_version)) остаются без изменений.
 *
 * @param {*} data сырые данные из файла
 * @returns {{ events: Array, changed: boolean, skipped?: string }}
 */
function migrateLegacy(data) {
    if (!Array.isArray(data)) {
        return { events: [], changed: false, skipped: 'not-an-array' };
    }
    let changed = false;
    const events = data.map((evt) => {
        if (evt && Number.isInteger(evt.interpretation_version)) {
            return evt; // уже-версионированное — не трогаем
        }
        changed = true;
        const createdAt = new Date();
        return Object.assign({}, evt, {
            interpretation_version: LEGACY_VERSION, // D2: однократно для легаси
            createdAt: timestring(createdAt),
        });
    });
    return { events, changed };
}

/**
 * Фабрика адаптера хранилища.
 * @param {object} app объект Obsidian (app.vault.getAbstractFileByPath / read / create / createFolder / modify / delete)
 */
function makeStorage(app) {
    if (!app || !app.vault) {
        throw new TypeError('makeStorage: требуется объект Obsidian `app` (app.vault отсутствует)');
    }

    // -- помощники ------------------------------------------------------------
    async function ensureFolder(folderPath) {
        const folder = app.vault.getAbstractFileByPath(folderPath);
        if (folder) return folder;
        try {
            await app.vault.createFolder(folderPath);
        } catch (e) {
            if (!String((e && e.message) || e).includes('exists')) throw e;
        }
        return null;
    }

    async function readRaw(path) {
        const file = app.vault.getAbstractFileByPath(path);
        if (!file) return null;
        return app.vault.read(file);
    }

    async function snapshotPath(path) {
        const file = app.vault.getAbstractFileByPath(path);
        return file ? { exists: true, content: await app.vault.read(file) } : { exists: false, content: null };
    }

    async function writeRaw(path, content) {
        const file = app.vault.getAbstractFileByPath(path);
        if (file) await app.vault.modify(file, content);
        else await app.vault.create(path, content);
    }

    async function restorePath(path, snapshot) {
        const file = app.vault.getAbstractFileByPath(path);
        if (snapshot.exists) {
            if (file) await app.vault.modify(file, snapshot.content);
            else await app.vault.create(path, snapshot.content);
        } else if (file) {
            await app.vault.delete(file);
        }
    }

    async function ensureFolderPath(folderPath) {
        let current = '';
        for (const part of String(folderPath || '').split('/').filter(Boolean)) {
            current = current ? `${current}/${part}` : part;
            if (!app.vault.getAbstractFileByPath(current)) await ensureFolder(current);
        }
    }

    // -- публичный API ---------------------------------------------------------

    /**
     * Загружает данные и АВТОМАТИЧЕСКИ персистит однократную миграцию легаси (D2).
     * @returns {Promise<Array>} массив событий в полной модели.
     */
    async function loadData() {
        const content = await readRaw(DATA_PATH);
        if (content === null) return [];
        let parsed;
        try {
            parsed = JSON.parse(content);
        } catch (e) {
            return []; // битый файл — начинаем с чистого листа (best-effort)
        }
        const { events, changed } = migrateLegacy(parsed);
        if (changed) {
            // ОДНОКРАТНАЯ миграция (D2): персистим версии легаси-событий сразу.
            await saveData(events, { backup: true });
        }
        return events;
    }

    /**
     * Сохраняет данные. Перед modify делает timestamped-бэкап текущего файла
     * в data/training/backups/data_<ts>.json (поведение прежнего main.js).
     * @param {Array} data массив событий
     * @param {{backup?: boolean, additionalWrites?: Array<{path:string, data:*}>}} [options]
     * @returns {Promise<{saved: boolean, path: string, backup: boolean}>}
     */
    async function saveData(data, options = {}) {
        const makeBackup = options.backup !== false;
        const additionalWrites = Array.isArray(options.additionalWrites) ? options.additionalWrites : [];
        await ensureFolder(DATA_FOLDER);
        const json = JSON.stringify(data, null, 2);
        const writes = [
            ...additionalWrites.map((item) => {
                if (!item || typeof item.path !== 'string' || !item.path || item.path === DATA_PATH) {
                    throw new TypeError('additionalWrites: каждый путь должен быть задан и отличаться от data.json');
                }
                return { path: item.path, content: JSON.stringify(item.data, null, 2) + '\n' };
            }),
            { path: DATA_PATH, content: json },
        ];
        const paths = writes.map((item) => item.path);
        if (new Set(paths).size !== paths.length) throw new TypeError('saveData: дублирующиеся пути транзакции');
        for (const item of writes.slice(0, -1)) {
            const slash = item.path.lastIndexOf('/');
            if (slash > 0) await ensureFolderPath(item.path.slice(0, slash));
        }

        const snapshots = new Map();
        for (const item of writes) snapshots.set(item.path, await snapshotPath(item.path));
        let backup = false;
        const dataSnapshot = snapshots.get(DATA_PATH);
        if (makeBackup && dataSnapshot.exists) {
            await ensureFolder(BACKUP_FOLDER);
            try {
                const now = new Date();
                const ts = now.toISOString().replace(/[:.]/g, '-');
                const backupPath = `${BACKUP_FOLDER}/data_${ts}.json`;
                await app.vault.create(backupPath, dataSnapshot.content);
                backup = true;
            } catch (_) { /* бэкап — best-effort, не роняем сохранение */ }
        }

        const attempted = [];
        try {
            for (const item of writes) {
                attempted.push(item.path);
                await writeRaw(item.path, item.content);
            }
        } catch (writeError) {
            const rollbackErrors = [];
            for (const path of attempted.reverse()) {
                try { await restorePath(path, snapshots.get(path)); }
                catch (rollbackError) { rollbackErrors.push(`${path}: ${((rollbackError && rollbackError.message) || rollbackError)}`); }
            }
            const detail = rollbackErrors.length ? `; откат не завершён (${rollbackErrors.join('; ')})` : '; прежние main-файлы восстановлены';
            throw new Error(`Сохранение отменено: ${((writeError && writeError.message) || writeError)}${detail}`);
        }

        return { saved: true, path: DATA_PATH, backup };
    }

    return {
        DATA_PATH,
        migrateLegacy,
        loadData,
        saveData,
    };
}

module.exports = { makeStorage, DATA_PATH, DATA_FOLDER, BACKUP_FOLDER, LEGACY_VERSION };
