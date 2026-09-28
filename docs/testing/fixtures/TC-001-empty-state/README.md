# TC-001: пустое начальное состояние

Эта фикстура содержит шесть файлов для начала TC-001. Пустой `rulesLog.json` равен `{ "rules": [] }`: до первого дня нет ни правила, ни пустых версий. `graph.json` равен `{ "relations": [] }`, `data.json` равен `[]`; временные файлы также пусты. После Save результат сравнивается с `../../reference-data/TC-001/` и полным JSON внутри `TC-001-spec.canvas`.

| Файл фикстуры | Путь в Vault |
|---|---|
| `data.json` | `data/training/data.json` |
| `data.tmp.json` | `data/training/data.tmp.json` |
| `rulesLog.json` | `scripts/training/data/rulesLog.json` |
| `rulesLog.tmp.json` | `scripts/training/data/rulesLog.tmp.json` |
| `graph.json` | `scripts/training/data/graph.json` |
| `graph.tmp.json` | `scripts/training/data/graph.tmp.json` |

Перед восстановлением проверить шесть SHA-256 из `SHA256SUMS`. Эта фикстура выражает новый целевой формат; текущий runtime может потребовать отдельной доработки, прежде чем её удастся использовать для живого прогона. Расхождение runtime с этой фикстурой фиксируется как дефект реализации, не как повод менять эталон.
