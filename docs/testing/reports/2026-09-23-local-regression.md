# Локальная проверка кода и сборки — 2026-09-23

> Oracle update: per-day Router after Cutter; event temp path `data/training/data.tmp.json`; explicit zero remains numeric; absent components are not carried forward; max relations are `overlay`. Pending-question notes below are historical and superseded by `docs/ORCHESTRATOR_HANDOFF.md`.

Этот отчёт фиксирует только воспроизводимые локальные проверки рабочего дерева. Он не закрывает пользовательские якоря TC-001/TC-002, live Obsidian/Vault или нерешённые user-oracle вопросы.

## Результаты

| Команда | Результат | Охват и предел evidence |
|---|---|---|
| `npm run build` | Успех; 15 QA-проверок. Build сообщил 370659 символов bundle. | Подтверждает генерацию и QA bundle в текущем checkout, не подтверждает загрузку Dataview/Obsidian. |
| `node --test tests/program-started-readable.test.js tests/storage.test.js tests/save-preview.test.js` | 34 tests, 34 pass, 0 fail. | Mock-UI, browser-like persistence и transaction/fault-injection. Не является live Vault проверкой. |
| `node --test tests/program-started-readable.test.js` | 12 tests, 12 pass, 0 fail. | Включает Branch 2 approve/defer сценарии в mock-UI. |
| `npm run guard` | 317 tests, 317 pass, 0 fail. | Включает один локальный Ollama/Gemma путь `pipeline.next`; не включает три независимых чистых Gemma anchor runs. OpenRouter не вызывался этими проверками. |
| `git diff --check` | Exit 0; замечаний whitespace нет. Git выводит предупреждения о будущей LF→CRLF нормализации рабочей копии. | Проверяет формат diff, не семантику или поведение runtime. |
| Fixture SHA-256 | Все шесть файлов совпали с [manifest](../fixtures/TC-001-empty-state/SHA256SUMS). | Проверяет исходный seed; при необходимости восстановить им состояние текущего Vault. |
| `node tools/check_test_docs.js` | Pass: 7 handoff-документов, project skill найден, 12 локальных ссылок, 20 строк matrix и repair-map, 24 test-file refs, 17 cited Canvas nodes, 6 fixture hashes. | Проверяет внутреннюю связность handoff-пакета, не валидирует фактическое UI/runtime-поведение. |

## Проверенная сборка

- Файл: `bundle.js` в корне проекта.
- SHA-256: `CAD7998076B9092F3D6F63EBBE1D1325551DE8E578EF91635080476DC937ECC9`.
- Размер на диске: 459988 UTF-8 bytes; build-лог сообщает длину JavaScript-строки (370659 символов).
- Build проверил 15 QA-условий и сгенерировал bundle из текущих модулей.

## Повторная проверка оркестратором — 2026-09-23

После повторной сборки и `npm run guard`:

- `npm run build` — успешно, 15 QA-проверок.
- `npm run guard` — 317/317 pass; локальная Ollama доступна, в списке моделей есть `gemma4:latest` (digest `c6eb396dbd5992bbe3f5cdb947e8bbc0ee413d7c17e2beaae69f5d569cf982eb`). Guard покрывает только свой один короткий живой integration input, не TC-001/TC-002.
- SHA-256 пересобранного `bundle.js`: `BCD0B302B70F120E74E67370ADCA6CEFE88DDD7277C6F6C6FA895C2FCE3BB7B3`; размер — 459988 UTF-8 bytes. Этот hash заменяет прежнее значение выше.
- `git diff --check` — exit 0; только предупреждения Git о нормализации LF→CRLF.
- Процесс Obsidian 1.13.7 запущен, но текущий UI bridge не предоставляет доступ к окну для управления/снимков. Поэтому live Vault-gate остался открытым.

## Связанные регрессии

- `tests/program-started-readable.test.js`: результат Branch 2 показывает карточку; одобрение кнопкой не меняет main до Save; Save передаёт одобренное предложение; Save без одобрения передаёт событие без model-proposed rule.
- `tests/save-preview.test.js`: browser-like Branch 2 proposal и Branch 3 multi-rule proposal возвращают последовательный rulesLog snapshot для общего Vault Save, не записывая основной файл через Node `fs`.
- `tests/storage.test.js`: частичная запись любого из трёх main JSON откатывается byte-for-byte в тестовой Vault-заглушке.

## Что остаётся открытым

- Выполнить runbook в текущем Obsidian Vault после штатного полного сброса: заметка/Dataview → ввод → UI-стадии → preview → одобрение/отказ Branch 2 → Save → reload → граф.
- Сделать три чистых Gemma 4 прогона для каждого из двух якорей после разрешения конфликтующих пользовательских ожиданий.
- Получить ответы на первые три user-oracle вопроса: Router-call granularity TC-001; `pull_reps:50` на 07-21 в TC-002; постоянный тип relation для max.
- Исторический блокер имени event temp разрешён: активный путь `data/training/data.tmp.json`; повторить acceptance после сборки.
- Очистка `data/training/data.tmp.json` покрыта core/mock тестами; live Vault проверка остаётся открытой.
- Не считать live acceptance или общий PASS достигнутыми до завершения этих пунктов. См. [handoff](../../ORCHESTRATOR_HANDOFF.md), [matrix](../TEST_MATRIX.md) и [runbook](../OBSIDIAN_ACCEPTANCE_RUNBOOK.md).

## Повторная проверка после исправлений — 2026-09-23 12:45 MSK

- `npm test`: **325/325 pass, 0 fail**.
- `npm run build`: pass; 15 QA checks, bundle size 474986 bytes, SHA-256 `0637F75299BE9655335D7B40A04196E18B3AD9281E3B0735B6E1E9304A080708`.
- `node tools/check_test_docs.js`: pass; 10 handoff docs, 14 local links, 20 matrix steps, 25 test-file refs, 17 cited source Canvas nodes, 20 repair-map stages, two fixtures/12 hashes, TC-002 seed and runbook oracle.
- TC-001: **3/3** локальных Gemma 4 per-day core-pipeline runs прошли ожидаемые группы `[3,2,1]` и значения. Evidence: `work/gemma-tc001-repeats-2026-09-23T12-30-37-178Z/`.
- TC-002: **3/3** локальных Gemma 4 per-day core-pipeline runs прошли ожидаемые группы `[1,1,3]`, explicit zeros, absence/no-carry-forward, `pull_reps:50`, max keys и `overlay`. Evidence: `work/gemma-tc002-repeats-2026-09-23T12-35-00-680Z/`.
- Runs использовали `gemma4:latest` по локальной Ollama, digest `c6eb396dbd5992bbe3f5cdb947e8bbc0ee413d7c17e2beaae69f5d569cf982eb`, изолированные scratch fixtures; не писали в пользовательский Vault, не нажимали Save и не вызывали OpenRouter.
- **Остаток:** anchor results подтверждают локальный core pipeline. Они не закрывают живой Obsidian UI/Vault acceptance, включая повтор TC-001 Save, reload и визуальную проверку графа/фильтров.
- Hermes CLI read-only audit made two low-token requests to the configured OpenRouter/GLM 5.3 Flash endpoint, but its agent environment stayed rooted at `C:\AI\hermes-project` and could not access this G: checkout, including with `--in`. Neither result counts as a review; no files were changed by Hermes. Credit usage was not reported, so avoid further calls unless an independent Hermes task is necessary.

## Повторная проверка и UI-регрессии — 2026-09-23 12:47 MSK

Подтверждённые пользовательские решения (per-day Router, явный ноль как числовое значение, отсутствие поля без переноса, `overlay` для max) и TC-002 oracle зафиксированы в обновлённом handoff/runbook. Старые заметки выше о нерешённых oracle вопросах исторические и больше не актуальны.

| Команда/изменение | Результат | Предел evidence |
|---|---|---|
| `npm test` | 320/320 pass, 0 fail. | Включает один локальный Ollama/Gemma integration-test; anchors не выполнялись по пользовательскому Vault. |
| `npm run build` | Успех, 15 QA-проверок; build сообщает 376371 байт JavaScript строки. Bundle на диске: 467390 bytes, SHA-256 `D9A98B864B8C4DD9C0913AD9EE7787EBAEC524EFD9E19057FCEA35F09EBDE4E3`. | Подтверждает локальный bundle, не загрузку в Obsidian. |
| `node tools/check_test_docs.js` | Pass: 7 handoff docs, 12 local links, 20 matrix steps, 25 test refs, 17 Canvas IDs, 20 repair-map stages, 6 fixture hashes. | Только внутренняя согласованность документов/фикстур. |
| Grouped chart regression | `tests/chartconfigs.test.js tests/chartview.test.js tests/pipeline-commit-rules.test.js`: 18/18 pass. Одна сущность на префикс убирает повторные Push/Pull от `part_of` + `overlay`; chart rerender очищает старые экземпляры. | Скриншот пользователя подтвердил симптомы, но визуальная проверка исправления требует reload в Obsidian. |
| `git diff --check` | Exit 0; только предупреждения Git о LF→CRLF нормализации. | Формат diff. |

Save root cause устранён в коде и покрыт тестом: mixed Branch 1 + Branch 3 fallback теперь всегда возвращает rules log, даже если граф не изменился. Чтобы подтвердить fix на экране, нужно перезагрузить Dataview/widget на свежем bundle и повторить Save в текущем Vault после штатного полного сброса; исходный пользовательский Save завершился до `storage.saveData`, поэтому превью не должно было фиксироваться в main JSON, однако это проверяется сравнением файлов.

**Остаток до завершения:** пользователь должен проверить TC-001 Save и chart redraw на свежем bundle; затем провести формальный TC-002 и передать результат. Кроме того, нужны 3 чистых Gemma-прогона на каждый anchor и live acceptance (оба кейса) в текущем Vault после штатного полного сброса. До этого не отмечать проект общим PASS.

### Локальная Gemma-проверка Router v25 → v26

После принятия v26 повторный `npm test` прошёл 320/320; `npm run build` прошёл 15 QA-проверок, build сообщил 376416 bytes. На момент отчёта `bundle.js` имел размер 467521 bytes и SHA-256 `C690100BB25C41343F3F415C8D646365CB0C03B298B80D378A45DAC58D3E8279`. Актуальный `node tools/check_test_docs.js` прошёл: 10 документов, 16 локальных ссылок, 20 шагов матрицы, 25 ссылок на тесты, 17 ссылок на исходные Canvas-узлы, 20 этапов repair-map, две фикстуры с шестью файлами каждая (12 hashes) и проверка содержимого TC-002 seed. `git diff --check` exit 0, только LF→CRLF warnings.

- Три независимых прогона с v25 дали `[3,1,1]`; для TC-001 ожидалось `[3,2,1]`. Захваченные объяснения Router считали голую пару уже известной, потому что в Branch-3 исходном примере присутствовала вложенная пара `(... (A+B))`.
- Источник проблемы — неоднозначные инструкции v25: broad rule «известная пара уже есть в examples» конфликтовала с уточнением, что подробная форма не учит голой паре.
- В v26 устранена коллизия: структура сравнивается на том же уровне; пара внутри пояснения не считается standalone example. Первая голая пара с прежними ключами → Branch 2; после примера та же форма → Branch 1.
- Три чистых прогона v26: все дали `[3,2,1]`; все события совпали с ожидаемыми числовыми значениями. При этом Branch 2 append содержал bare-pair примеры, которые увидел Router следующего дня, и он выбрал Branch 1.
- Повторно проверены raw captures всех трёх успешных v26 runs: Cutter вернул даты `05-29`, `05-31`, `06-02`; каждый raw chunk является дословным substring исходного user input. Router trace по run: `[3,2,1]`; события и значения сверены с anchor expected.
- Доказательства лежат в `work/gemma-tc001-repeats-2026-09-23T09-48-57-145Z/` (v25, runs 01–03) и `work/gemma-tc001-repeats-2026-09-23T09-59-35-193Z/` (v26, run 01; root timestamp формируется в UTC). Это локальный core pipeline без Obsidian Vault/Save и без OpenRouter.
- Дополнительная пара v26 runs (run 01 и 02) — `work/gemma-tc001-repeats-2026-09-23T10-01-33-771Z/`. Вместе с run 01 из каталога 09-59-35 образует три чистых успешных core-повтора.
