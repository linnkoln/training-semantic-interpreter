
> ⚠️ **Состояние документа:** legacy-снимок от прежней архитектурной итерации. Примеры ключей/ожиданий и статусы ниже нельзя использовать как oracle якорных TC-001/TC-002 или как актуальную оценку runtime. Для текущей проверки следовать `docs/testing/TESTING_PROTOCOL.md`, `TEST_MATRIX.md`, `OBSIDIAN_ACCEPTANCE_RUNBOOK.md` и пользовательским Canvas/specs. Расхождения пользовательских источников перечислены в `docs/ORCHESTRATOR_HANDOFF.md`; не разрешать их самостоятельно.
> ⚠️ МАШИННАЯ ДОКУМЕНТАЦИЯ (написано агентами). Пользовательская документация (docs/user/ — цитаты и артефакты пользователя) имеет высший приоритет и перекрывает эти инструкции.
> Конфликт с docs/user/ → выносится пользователю. Правила: docs/GOVERNANCE.md.
# QA_TESTING — как QA гейтит пакет

QA гейтит по Acceptance Criteria (не автор фич). Пакет мержится только при зелёном гейте.

## Чек-лист по AC

| # | Требование | Как проверить | Статус |
|---|---|---|---|
| AC1 | Интерпретатор, а не LLM-финал | При ParserMode 1 событие создаётся ТОЛЬКО если правило Layer 2 сматчило. Без правила → `ambiguous`, не `success` | ✅ (P4) |
| AC2 | Layer 1 Vocabulary | `data/vocabulary.json`: сущности + `aliases[]`. Парсинг ищет по алиасам | ⬜ (файл ✅ P2; бандл ✅ P6; применение алиасов — сверить при ручном тесте в Obsidian P7) |
| AC3 | Layer 2 Semantic rules | `data/rules.json`: `version`; `when{pattern,context}`/`then{entity,metric,composition}`. Подмассивы `dynamic`/`global` | ✅ (P2) |
| AC4 | Layer 3 Semantic graph | `data/graph.json`: `part_of`,`successor`,`independent` с parent/child. Renderer читает его, не хардкодит | ✅ (P3) |
| AC5 | Версия/дата версии | Правила имеют `version`+дату. Interpreter использует только конкретную версию | ✅ (P2+P4, `interpretation_version`=версии правил) |
| AC6 | Иммутабельность | `data.json` — события `{date,values,interpretation_version,createdAt}`. Ни один LLM-путь не перезаписывает существующую дату | ✅ (P0+P4+storage D2 миграция) |
| AC7 | Накопление + дописывание | Режим Resolve позволяет дописать трактовку и сохранить как новую версию правил | ✅ (P4+editor кнопка «Принять правило») |
| AC8 | Чистка мусора | Правила/вокабуларий поддерживают `deprecated`; модуль может предложить удаление при давней неактивности | ✅ (P2) |
| AC9 | 4 режима LLM | Отдельные промпты `prompts/mode_*.md`. Адаптер возвращает типизированный `{status,payload}` | ✅ (P1+embedded в bundle PROMPTS) |
| AC10 | LLM не источник истины | LLM-вывод проходит через `core/responseParser`; правила применяет интерпретатор, не LLM. Два разных LLM-ответа для одного ввода → одинаковый результат (mocked) | ✅ (P1 gateway + P4) |
| AC11 | Гибкий рендерер | `chartModel` маппит relation→chart type из графа. Новая метрика/отношение — правка данных, без правки JS | ✅ (P3+chartview из toChartConfig; ручной тест в P7) |

## Процедура гейта

1. `node --test tests/**/*.test.js` — зелёный (полная регрессия).
2. Прогнать integration-кейс: входная таблица из старого `prompt.md` → ожидаемые события.
3. Проверить иммутабельность: дубликат даты отклоняется, существующая дата не изменяется.
4. Только после этого — пакет мержится.

## Интеграционный кейс (регрессия от старого поведения)

Вход — «грязная таблица» из старого `prompt.md` (и собственный реальный ввод по домену). Правила интерпретации (правила из prompt.md → события):

| Вход (строка таблицы) | Ожидаемые events.values |
|---|---|
| `- 100 отжимания (73+27)` | `{ push_full: 73, push_knee: 27 }` |
| `- 100 отжимания макс: 73` | `{ push_full: 100, push_max_set: 73 }` |
| `- 50 подтягивания (38+12)` | `{ pull_full: 38, pull_assisted: 12 }` |
| `- 50 подтягиваний макс: 15` | `{ pull_full: 50, pull_max_set: 15 }` |
| одиночное число без скобок | `{ *_full: число }` |

Проверки: каждое событие содержит `interpretation_version` (AC5), дубликат даты отклоняется (AC6), два разных LLM-ответа для одного ввода дают одинаковый набор событий (AC10).
`tests/integration.test.js` материализует этот кейс (появляется после P2+P4).

## Роли

- **QA** — гейт, не автор фич. Проверяет AC, ведёт таблицу.
- **Исполнители** — реализуют, пишут PROBLEMS.md, коммитят после каждого шага. Не мержат без QA.

## Релайнмент P-A..P-Q — результаты гейтов (2026-08-29)

QA гейтил каждый батч по AC-R (§5 DISCREPANCIES_PLAN — файл удалён 2026-09-01 при инвентаризации). Все пакеты закоммичены стеком; guard зелёный на каждом шаге.

| Пакет | Файлы | AC | Гейт |
|---|---|---|---|
| **P-A** Router | core/router.js, prompts/mode_router.md, tests/router.test.js | AC-R1 | ✅ 13 тестов, инжектируемый fetch, контракт `{status,payload:{branch,confidence}}`, никогда не бросает |
| **P-B** Structured | core/structured.js, tests/structured.test.js | AC-R2, AC-R6 | ✅ 9 тестов; события из ДЕТЕРМИНИРОВАННОГО интерпретатора, не из payload LLM (AC10) |
| **P-C** Conflict | core/conflict.js, tests/conflict.test.js | AC-R3, AC-R4 | ✅ 16 тестов; proposeRule + confirmProposal(appendRule, версия+1), temp-лог |
| **P-P** Pipeline | core/pipeline.js, tests/pipeline.test.js | AC-R1..R5 | ✅ 15 тестов; next→Branch1/2, confirm→Rule Evolution |
| **P-F** UI | ui/editor.js (+bundle) | AC-R9 | ✅ рефакторинг на staged/committed; поле2 не пишет файл до «Сохранить»; b.pipeline?.next/confirm |
| **P-Q** QA | tools/build.js, bundle.js, tests/integration.test.js | AC-R1..R9 | ✅ bundle с LLM-слоями (12 QA); integration по pipeline.next/confirm; mock-AC10; реальная Ollama (t.skip при недоступности) |

**Порядок стека коммитов (сверху вниз):**
```
qa(P-Q) — build.js + integration + bundle (после финального гейта)
refactor(ui) — P-F (AC-R9)
feat(pipeline) — P-P (AC-R1..R5)
feat(conflict)/feat(structured)/feat(router) — P-C/P-B/P-A
docs — PROBLEMS (double-escape + P-Q)
```
Итог: **guard 219/219** (было 153 на базе a17a947). Полная цепочка `raw input → Router → Branch1/Json | Branch2/правило+пример → Rule Evolution` реализована и покрыта интеграционно.

**Не сделано (ручной гейт, не автоматизируется):** **AC-R7** «график обновляется после добавления/принятия» и **AC-R5** «дата из ввода (MM-DD+год), а не сегодня» — требуют ручного Obsidian-прогона; `D7` (дата editor.js) остаётся открытым по §4.2. См. PROBLEMS.md P-Q.
