# Шаблон отчёта сквозного прогона

## Идентификация

- Case/run ID:
- Дата/время:
- Изолированный Vault:
- Build ID / bundle SHA-256:
- Ollama endpoint / модель / версия или digest:
- Prompt versions / hashes:
- Источник эталона (путь + узел Canvas):
- Начальное состояние: fixture hashes для data, rules, graph и tmp:
- Слой запуска: `core harness` / `текущий Obsidian Vault` / `user exploratory`:
- Версия/date пользовательского oracle:
- Граница evidence: какие слои этот run не проверяет:

## Фактический прогон

- Trace ID / путь:
- Router calls: количество, input unit(s), output groups:
- Calls по стадиям: Cutter / Router / Structured / MinorRuleUpdate / RuleUpdate:
- Первый расходящийся шаг (если есть):
- Точное количество/порядок Router calls и текст chunks по дням:
- Для каждого ожидаемого поля: присутствует ли ключ, значение, `0` или отсутствует:
- Console/UI warnings:

| Stage | Expected (источник) | Actual (trace/UI/file) | Result |
|---|---|---|---|
| Input/Cutter | | | |
| Router/dispatch | | | |
| Branch 1 | | | |
| Branch 2 | | | |
| Branch 3 | | | |
| Preview/events | | | |
| Preview/graph | | | |

При сравнении событий сверять и набор ключей, и значения. Например, `{ "pull_rings_reps": 0 }` не равно событию без ключа `pull_rings_reps`. Нулевое значение и отсутствие поля фиксировать отдельно.

## Снимки состояния

| Vault file | SHA-256 before | After preview | After Save | After reload |
|---|---|---|---|---|
| `data/training/data.json` | | | | |
| `scripts/training/data/rulesLog.json` | | | | |
| `scripts/training/data/graph.json` | | | | |
| `data/training/data.tmp.json` | | | | |
| `scripts/training/data/rulesLog.tmp.json` | | | | |
| `scripts/training/data/graph.tmp.json` | | | | |

## Проверка интерфейса

- Screenshot input / статус:
- Screenshot preview field 2:
- Screenshot chart preview:
- Количество панелей и уникальные entity prefixes из `graph.json` совпали? Дубликаты:
- Checkbox-фильтры проверены по одному? Есть ли потеря series или перестройка/дублирование панелей:
- Save result:
- Reload result:
- Screenshot persisted chart:

## Решение

- Статус: `PASS` / `FAIL` / `BLOCKED` / `NOT RUN`
- Причина и первый узел расхождения:
- Связанные этапы матрицы:
- Следующее действие:
- Требуется пользовательское решение? Если да, точные варианты и ссылки на источники:
