// scripts/training/main.js — P7fix(3): точка входа виджета Obsidian/Dataview.
//
// КАК РАБОТАЕТ dv.view (подтверждено рабочим v1 45a9d5a и Dataview):
// файл view.js выполняется как dataviewjs-блок В СКОПЕ, где `dv` (API) и `input`
// (второй аргумент dv.view) уже ДОСТУПНЫ как переменные. Их НЕ передают аргументом
// в функцию — поэтому ОБЗАТЕЛЬНО ссылаться на верхнеуровневый `dv`, не затеняя его
// параметром вида (dv) => {...} (иначе внутри пара-undefined и пусто).
//
// ПРО КЕШ window.TrainingCore: Obsidian живёт в окне, window переживает рендеры заметки.
// Если грузить bundle только когда `!window.TrainingCore` — новый bundle не подхватится
// после пересборки (останется старый, "одним графиком"). Поэтому main.js ВСЕГДА читает
// и выполняет bundle заново, и сравнивает встроенный buildId: bundle сам полностью
// перезаписывает window.TrainingCore (см. tools/build.js), так что свежие методы побеждают.

(async () => {
    try {
        const app = dv.app;
        const container = dv.container;
        const BUNDLE_PATH = "scripts/training/bundle.js";

        // 1. Всегда читаем и выполняем актуальный bundle из vault.
        const bundleFile = app.vault.getAbstractFileByPath(BUNDLE_PATH);
        if (!bundleFile) {
            dv.paragraph('❌ Файл bundle не найден: ' + BUNDLE_PATH + '. Запустите `npm run build` (tools/build.js).');
            return;
        }
        const code = await app.vault.read(bundleFile);
        // new Function огибает строгий режим сурраунда Dataview; bundle полностью
        // перезаписывает window.TrainingCore (включая свежий buildId).
        const run = new Function('window', 'self', 'globalThis', code + '\nreturn window.TrainingCore;');
        const C = run(window, window, window);

        if (!C || !C.editor || !C.editor.mountEditor || !C.chartModel || !C.chartview) {
            dv.paragraph('❌ Некорректный bundle (нет editor.mountEditor/chartModel/chartview). Запустите `npm run build`.');
            return;
        }
        // закрепляем свежий бандл в window на случай, если run не доложил (самозащита)
        window.TrainingCore = C;

        // 1b. TRACE_FS: адаптер записи трасс через app.vault (core/trace.js в бандле
        //     не имеет Node fs — пишет трассы data/test-artifacts/trace-*.json через этот адаптер).
        //     app.vault API асинхронен — методы возвращают Promise (trace.js флешит fire-and-forget).
        C.TRACE_FS = {
            async mkdir(path) {
                const parts = String(path).split('/').filter(Boolean);
                let cur = '';
                for (const p of parts) {
                    cur = cur ? `${cur}/${p}` : p;
                    if (!app.vault.getAbstractFileByPath(cur)) {
                        try { await app.vault.createFolder(cur); } catch (_e) { /* уже есть */ }
                    }
                }
            },
            async writeFile(path, content) {
                const f = app.vault.getAbstractFileByPath(path);
                if (f) await app.vault.modify(f, content);
                else await app.vault.create(path, content);
            },
            async readDir(path) {
                const folder = app.vault.getAbstractFileByPath(path);
                if (!folder || !folder.children) return [];
                return folder.children.map((c) => c.name);
            },
            async statMtimeMs(path) {
                const f = app.vault.getAbstractFileByPath(path);
                return (f && f.stat && typeof f.stat.mtime === 'number') ? f.stat.mtime : 0;
            },
            async unlink(path) {
                const f = app.vault.getAbstractFileByPath(path);
                if (f) await app.vault.delete(f);
            },
        };

        // 2. Монтируем редактор (app и bundle передаём явно; dv/input в scope).
        const controller = C.editor.mountEditor({ container, app, bundle: C });
        await controller.render();
    } catch (e) {
        dv.paragraph('❌ Критическая ошибка: ' + ((e && e.message) || e));
        console.error(e);
    }
})();