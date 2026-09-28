'use strict';
// Радикальный сброс (по прямому указанию пользователя 2026-08-30): все данные, правила,
// история правил, граф — в ноль. Один пустой snapshot правил, пустые json.
// Пользовательские данные первого дня (05-29) будут внесены заново прогонами системы.
const fs = require('fs');
const path = require('path');
const DIR = path.resolve(__dirname, '../data');
const VAULT_DATA = 'G:/Obsidians/Notion/data/training/data.json';

// 1. rules.json — пустые dynamic/global
fs.writeFileSync(path.join(DIR, 'rules.json'), JSON.stringify({
    version: 0,
    updatedAt: new Date().toISOString(),
    dynamic: [],
    global: [],
}, null, 2) + '\n', 'utf8');

// 2. rulesLog.json — журнал ЛИТЕРАЛЬНО ПУСТ: { version: 0, updatedAt, entries: [] }.
// Ни истории правил, ни записи о самом сбросе («как будто в системе не было ничего
// записано» — указание пользователя 2026-08-30/2026-09-01). Та же форма, что у кнопки
// «🧹 Очистить память» (core/rulesLog.buildWipeLog). Версия 0 = начальное состояние:
// правила копятся заново, первая append-запись даст version 1.
fs.writeFileSync(path.join(DIR, 'rulesLog.json'), JSON.stringify({
    version: 0,
    updatedAt: new Date().toISOString(),
    entries: [],
}, null, 2) + '\n', 'utf8');

// 3. graph.json — пустой граф
fs.writeFileSync(path.join(DIR, 'graph.json'), JSON.stringify({ relations: [], targets: [] }, null, 2) + '\n', 'utf8');

// 4. Данные тренировок в vault — пустой массив (бэкап уже снят в repo/backup_full_wipe_20260830/)
fs.writeFileSync(VAULT_DATA, JSON.stringify([], null, 2) + '\n', 'utf8');

// 5. tmp-мусор
for (const f of fs.readdirSync(DIR)) {
    if (f.endsWith('.tmp.json') || /\.tmp\./.test(f)) { fs.unlinkSync(path.join(DIR, f)); console.log('removed tmp:', f); }
}

console.log('RESET DONE. rules/rulesLog/graph/vault-data — пусто. Бэкап: tools/backup_full_wipe_20260830/');
