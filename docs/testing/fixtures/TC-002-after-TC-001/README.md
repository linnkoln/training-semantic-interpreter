# TC-002: состояние после TC-001

Это начальная фикстура для каждого независимого прогона TC-002. Её три основных файла **побайтно совпадают** с `../../reference-data/TC-001/{data.json,rulesLog.json,graph.json}`. В журнале две непустые версии с реальными примерами; в графе две прежние пары A+B; три события расположены от поздней даты к ранней. Временные файлы пусты.

| Файл фикстуры | Путь в Vault |
|---|---|
| `data.json` | `data/training/data.json` |
| `data.tmp.json` | `data/training/data.tmp.json` |
| `rulesLog.json` | `scripts/training/data/rulesLog.json` |
| `rulesLog.tmp.json` | `scripts/training/data/rulesLog.tmp.json` |
| `graph.json` | `scripts/training/data/graph.json` |
| `graph.tmp.json` | `scripts/training/data/graph.tmp.json` |

Перед восстановлением проверить `SHA256SUMS`. Результат TC-002 после Save сравнивается с `../../reference-data/TC-002/` и полным JSON в `TC-002-spec.canvas`. Фикстура задаёт целевое состояние; она не служит доказательством успешного живого Save. `tools/prepare_tc002_seed.js` повторно собирает её из текущего эталона TC-001 и отказывается перезаписывать существующий каталог. Текущий runtime может требовать доработки под новый формат; при расхождении фиксировать дефект реализации и не заменять эталон данными прогона.
