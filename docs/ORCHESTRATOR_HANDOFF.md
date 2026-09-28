# Передача работы оркестратору

> **Восстановление temp, 2026-09-26:** актуальная пользовательская `architecture.canvas` заменяет прежнюю стартовую очистку. Рендер читает main + три temp; непустые временные события/правила/граф включают уведомление и кнопку «Очистить временные файлы». Save после reload фиксирует полный черновик вместе с минорными примерами и обновлениями правил. При перемонтировании во время LLM новый bundle получает статус и завершённый результат из Vault. Повторное «Обработать» по-прежнему очищает temp перед новым циклом. Проверки: `tests/temp-recovery.test.js`, `tests/branch2-save-temp.test.js`, `tests/requirements.test.js`; живой Obsidian ещё проверить по обновлённому runbook. Этот абзац заменяет прежние указания об очистке при старте ниже; датированные отчёты остаются историей.

> **Последнее исправление 2026-09-26:** потеря 05-29 в TC-001 вызвана лишней `)` в LLM-цитате: построитель отклонял весь новый rule. Теперь недословный пример нового правила исключается отдельно, корректные события сохраняются; строгий update snapshot не ослаблен. `failedDays` показывает дату/причину неполного результата в UI. Один live TC-001 на пустой изолированной базе дал все три даты и 21 правильное значение, но Router `[3,3,1]` вместо `[3,2,1]` остаётся расхождением. Guard 368/368; bundle 528127 байт, SHA-256 `7DD199094B6CA730CF701A86994FBB50E7168123E3259393274627B3B8F86FBA`. Evidence: `work/cycle-loss-2026-09-26/`; детали: `docs/testing/reports/2026-09-24-repair-map-audit.md`. Рабочие main/temp сохранены; полный live Obsidian Save новой сборки ещё не проверен. Этот абзац приоритетнее старых статусов ниже.

> Контекст обновлён 2026-09-23. Обновлять этот документ после завершения каждого смыслового этапа.
> Этот файл самодостаточен для старта без истории чата; при расхождении пользовательские решения имеют приоритет.

> **Коррекция статуса 2026-09-23:** приведённые ниже утверждения «TC-001/002 core PASS 3/3» относятся к Router v29 с кодовой поправкой классификации; они **не подтверждают текущую сборку**. Поправка удалена, так как нарушала границу LLM/кода. Текущие изменения: Router v32 для сохранённых правил и v34 для временного правила, дословная привязка примеров к пользовательскому вводу, исключение временных правил из Save. Сквозной повтор TC-001 → Save → TC-002 запущен; его результат записать отдельно до объявления готовности UI-приёмки. Не менять рабочие JSON Vault автоматическими тестами: использовать `work/` и фикстуры. См. captures `work/anchor-save-chain-*` и `work/router-day2-probe-*`.

## Цель пользователя

Довести Semantic Training Interpreter до завершённого рабочего состояния. Главная цель — работающий целостный конвейер: Gemma и промпты, кодовые узлы, передача данных, временное состояние, Save и граф. Документация — средство воспроизводимости и передачи, а не конечный результат.

Проверяются все этапы 01–20 с приоритетом первых двух пользовательских кейсов. Целевая Gemma 4 запускается штатным проектным путём; Hermes/OpenRouter используется только для узких вспомогательных задач с учётом остатка около $2. Доступные недорогие модели: DeepSeek V4.1 Flash и GLM 5.3 Flash.

## Актуальное состояние — 2026-09-23

> **Приоритет статуса:** ниже указан текущий статус; он и `docs/testing/TEST_MATRIX.md` заменяют старые планы и блокеры в датированных ORCH-записях ниже. Пользовательские ответы разрешили прежние вопросы по эталонам. Датированные ORCH-разделы — история выполненной работы, не актуальные запросы или блокеры.

- **Цель активной работы:** довести рабочий проект и весь pipeline до завершения по пользовательским эталонам. Текущая локальная работа закрывает дефекты по мере нахождения; документация — handoff-инструмент, а не конечная цель.
- **Пользовательские решения 2026-09-23:** сначала Cutter делит весь raw input на дни, затем Router обрабатывает каждый день отдельным вызовом по порядку; TC-001/002 specs нужно привести к архитектуре. `pull_reps:50` сохраняется на 07-21. Явный `(50+0)` хранит `pull_rings_reps:0`; если следующая запись не содержит компоненты, не достраивать ноль из истории — отсутствие может указывать на изменение правила. Постоянные max relations используют `overlay`, который система выводит из контекста записи. Event temp: `data/training/data.tmp.json`.
- **Источник истины:** пользовательская документация `docs/user/` и прямые разъяснения пользователя. `docs/repair-map.canvas` вспомогателен; прочие документы и старые run reports не могут переопределить user oracle.
- **Восстановление при старте, 2026-09-26:** `ui/editor.js` восстанавливает три temp при `render()` и показывает main + temp без записи. Очистка доступна отдельно по кнопке; Save переносит восстановленный черновик в main. UI-настройки сохраняются. Требуется подтвердить этот путь в текущем Obsidian Vault.
- **Save-гейт:** транзакционный mock/fault-injection путь для трёх main JSON исправлен и прошёл тесты; отказ/recovery ещё нужно подтвердить в текущем Obsidian Vault.
- **TC-001 Save issue reported by user:** UI showed `Невозможно сохранить правила/граф через Vault`. Root cause found in `pipeline.commitRules`: mixed Branch 1 + Branch 3 fallback could report added rules without returning `payload.log` when graph was unchanged. Fixed to return the complete rules log and added a regression test. New bundle must be loaded in Obsidian, then retry Save while the TC-001 preview/temp data is still present; verify main JSON, temp cleanup, reload, and graph.
- **Chart duplication confirmed by user screenshots:** the extra panels are duplicate chart groups inside the widget (Push and Pull repeat), not a separate OS/browser window. Fixed `core/chartModel.js` to create one group per entity prefix when `part_of` parents overlap with `A+B`/`overlay` bases; existing async render cleanup remains. Added a mixed `part_of` + `overlay` regression; chart model/view suite passed 7/7. Requires visual confirmation in Obsidian after reload.
- **Exploratory empty-data runs (not TC-002):** user clarified that their two experimental runs used the same dataset as test 1 against empty data. They are not formal TC-002 results. User will report TC-002 separately.
- **Branch 2/3 human-loop defect исправлен 2026-09-23:** Branch 2 approval теперь только помечает предложение как одобренное; commit происходит на Save. Если одобрения нет, событие можно сохранить без предложения. Карточка результата Branch 2 теперь реально отображается (ранее `cardForLine` существовал, но не вызывался). Browser-like `commitRules` формирует Branch 2 и multi-rule Branch 3 журнал в памяти, чтобы запись прошла общей Vault-транзакцией.
- **TC-001 Gemma repeat diagnosis:** three isolated runs on Router prompt v25 all returned `[3,1,1]` instead of `[3,2,1]`. Captured reasoning treated a bare `(A+B)` as known because it found a pair nested inside the original detailed `(+из них … (A+B))` example, despite a later contrary sentence in the prompt. Prompt v26 removes that ambiguity: only a standalone pair example teaches the bare form. Three independent clean v26 runs returned `[3,2,1]` with expected values. Evidence folders: `work/gemma-tc001-repeats-2026-09-23T09-48-57-145Z/` (v25 fail), `work/gemma-tc001-repeats-2026-09-23T09-59-35-193Z/` and `work/gemma-tc001-repeats-2026-09-23T10-01-33-771Z/` (v26 pass); local Gemma only, no Save/OpenRouter. This satisfies the three-run **core-only** repeat check, not live Obsidian acceptance or full end-to-end user case.
- **Автотесты/сборка (2026-09-23, текущая рабочая копия):** `npm test` — 325/325; `npm run build` — 15 QA-проверок, bundle 474986 bytes, SHA-256 `0637F75299BE9655335D7B40A04196E18B3AD9281E3B0735B6E1E9304A080708`; `node tools/check_test_docs.js` — pass (10 handoff docs, 14 local links, 20 matrix steps, 25 test refs, 17 source Canvas nodes, 20 repair-map stages, два fixture / 12 hashes, TC-002 seed/runbook oracle). Anchor runs использовали локальную Ollama/Gemma, OpenRouter не вызывался.
- **Автотесты/сборка (2026-09-23, последний прогон):** `npm test` — 325/325; build/doc checker запускаются после обновления отчётов ниже. Ни один из якорных прогонов не пишет в пользовательский Vault; OpenRouter не вызывался.
- **Gemma evidence — core PASS для обоих anchors:** TC-001: 3/3 локальных Gemma 4 `gemma4:latest`, группы `[3,2,1]`, значения совпали с oracle; captures в `work/gemma-tc001-repeats-2026-09-23T12-30-37-178Z/`. TC-002: 3/3 локальных Gemma 4 `gemma4:latest`, группы `[1,1,3]`, явные нули в первых двух датах, нули/отсутствующие компоненты не перенесены на 07-21, `pull_reps:50`, новые max keys и `overlay`; captures в `work/gemma-tc002-repeats-2026-09-23T12-35-00-680Z/`. Выполнены по per-day architecture после актуальных prompts, через изолированные scratch-копии без Save и без OpenRouter.
- **Live Obsidian/Vault/chart:** не проверены и остаются пользовательской UI-приёмкой. В частности, загрузить свежий bundle, перепроверить ранее сообщённый Save-отказ, восстановление temp и отдельную очистку, preview → Save → reload и отсутствие дублированных chart panels. Backend/mock coverage и local Gemma PASS не доказывают эти визуальные/host-specific условия.
- **Hermes CLI handoff audit:** две read-only заявки были отправлены на настроенный OpenRouter/GLM 5.3 Flash endpoint, но не смогли прочитать этот checkout: агентский cwd/root оставался `C:\AI\hermes-project` даже при `--in G:\Obsidians\Notion\scripts\training`. Вывод не засчитан; Hermes проект не изменил. Списание неизвестно и не проверено. Проектный skill прочитан напрямую из `.hermes/skills/training-orchestrator/SKILL.md`; новых Hermes заявок не отправлять без конкретной необходимости.
- **Live Obsidian/Vault/chart:** не проверены. Выполнять UI-проверки в текущем Vault по `docs/testing/OBSIDIAN_ACCEPTANCE_RUNBOOK.md`, перед кейсом использовать штатную кнопку полного сброса. Пользователь подтвердил, что данные можно сбросить.
- **Расположение среды:** checkout проекта — `G:\Obsidians\Notion\scripts\training`, внутри текущего Vault `G:\Obsidians\Notion` (в корне найден `.obsidian`).
- **Документы для продолжения:** `docs/testing/TESTING_PROTOCOL.md`, `TEST_MATRIX.md`, `OBSIDIAN_ACCEPTANCE_RUNBOOK.md`, `EXECUTION_REPORT_TEMPLATE.md`; fixtures TC-001 и TC-002 — `docs/testing/fixtures/TC-001-empty-state/README.md` и `TC-002-after-TC-001/README.md` с шестью SHA-256 файлами каждый; TC-002 seed generator — `node tools/prepare_tc002_seed.js`; локальный отчёт — `docs/testing/reports/2026-09-23-local-regression.md`; consistency checker — `node tools/check_test_docs.js`.
- Рабочее дерево уже содержит пользовательские и агентские изменения. Не откатывать, не stash-ить, не коммитить пакетно; сначала сверить status/diff целевого файла.

## Решения пользователя — не спрашивать повторно и не переиначивать

1. Проверять весь data-flow, не только LLM. Ответы Gemma 4 — главный фокус оценки.
2. Первые два тест-кейса — ключевые пользовательские эталоны. Дополнительные кейсы допустимо извлекать из сохранённых данных, но пользовательский ввод/указания остаются источником истины.
3. При противоречии пользовательских указаний модель/оркестратор сообщает конфликт и спрашивает пользователя. Не разрешает конфликт за него.
4. Canvas нужен для визуального участия человека, но не обязателен для машинных тестов.
5. Не раздувать набор искусственными edge cases: один пользователь вводит данные добросовестно и может уточнить формулировку. Ясный пользовательский сигнал появления нового правила должен быть обработан как новое правило.
6. Handoff и документация обязательны: другой оркестратор должен продолжить без чата.

## Авторитет и границы

Прочитать `AGENTS.md` и `docs/GOVERNANCE.md`. Пользовательские артефакты `docs/user/` выше машинной документации. Нельзя придумывать пользовательский смысл и фиксировать его как принятое решение. Если обнаружено реальное противоречие в пользовательских источниках — записать точные фрагменты и задать один конкретный вопрос до зависимых изменений.

Инварианты INV-1…INV-5 описаны в `AGENTS.md` и `docs/REQUIREMENTS.md`; таблицы статуса старые и не являются evidence текущей сборки. `docs/QA_TESTING.md`, `docs/ARCHITECTURE.md` и `README.md` содержат прежние схемы/примеры — не использовать их как текущие test oracle. Активные критерии: user Canvas + anchor specs + `docs/testing/TESTING_PROTOCOL.md`/`TEST_MATRIX.md`/runbook. Не сужать произвольный пользовательский ввод детерминированными шаблонами.

## Быстрый старт и экономия контекста

Использовать навык `.hermes/skills/training-orchestrator/SKILL.md`. Hermes обнаруживает project-local skills в `.hermes/skills/`, когда запущен из корня git checkout. **Текущее подтверждённое состояние:** `hermes` доступен из Codex PowerShell (`hermes --help`, `hermes status` работают); `hermes status` показывает `z-ai/glm-5.3-flash` через OpenRouter. Однако read-only code review с `--in G:\Obsidians\Notion\scripts\training` запустил инструменты в `C:\AI\hermes-project` и не нашёл файлы проекта на G:. Поэтому не отправлять Hermes задания только со ссылками на G:-пути, пока не исправлен `--in`/workspace mapping. Для узкой модели-задачи либо сначала передать точные файлы в query-контекст безопасным способом, либо устранить неверный workspace; review, который не увидел код, не является evidence. Устанавливать CLI/перенастраивать OpenRouter не требуется. Desktop project skill discoverability отдельно не проверялась. При добавлении/изменении навыка в Hermes-сессии обновить их поддерживаемым способом (документация указывает `/reload-skills`) или открыть новую сессию.

Загружать постепенно:
1. Эта передача + `AGENTS.md` — при каждом входе.
2. `docs/testing/TESTING_PROTOCOL.md` + `docs/testing/TEST_MATRIX.md` — при работе над тест-планом.
3. `docs/user/artifacts/architecture.canvas` + якорные spec TC-001/TC-002 — перед оценкой смысла data-flow.
4. Конкретную трассу, код узла и его тест — только когда разбирается этот этап.
Не перечитывать весь архив/весь `data/prompt-lab/` без конкретного поискового вопроса. Использовать `rg` с точным термином, датой, trace ID или именем кейса; читать совпавшие фрагменты.

При делегации одному исполнителю назначать один результат, точный список файлов для чтения, явные границы редактирования, формат ответа и проверяемый критерий завершения. Не просить повторно «изучить проект». Передавать общие решения ссылкой на этот handoff, не копировать полный контекст в каждый запрос. Не делать параллельные задания, если они редактируют общие файлы или зависят от незакрытых пользовательских решений.

## Точка состояния репозитория на начало этой работы

- Ветка: `master`, HEAD при осмотре: `908476d`; последние записи истории до неё относятся к pipeline/router.
- Рабочее дерево было уже изменено до этой работы. Не откатывать, не stash-ить и не перезаписывать изменения без просмотра актуального diff.
- Перед первым редактированием было изменено: `data/graph.json`, `data/rulesLog.json`, `docs/testing/TESTING_PROTOCOL.md`, `docs/testing/cases/TC-001-empty-rules-table/TC-001-spec.canvas`, `docs/user/artifacts/architecture.canvas`.
- Незатрекано на момент осмотра: `data/graph.tmp.json`, `data/prompt-lab/`, `data/rulesLog.tmp.json`, `docs/repair-map.canvas`, `tests/program-started-readable.test.js`, вспомогательные скрипты в `tools/`.
- Перед любым новым изменением снова выполнить `git status --short` и `git diff -- <целевой файл>`. Текущее продолжение может содержать дополнительные изменения настоящей работы.

## Якорные кейсы и текущие сведения

- TC-001: spec/report и неизменённый пользовательский Canvas находятся в `docs/testing/cases/TC-001-empty-rules-table/`; актуальные evidence — `TC-001-evidence.json`.
- TC-002: пользовательский spec Canvas, run-report и evidence находятся в `docs/testing/cases/TC-002-max-approaches/`.
- TC-001: три свежих повтора текущего core pipeline дали `[3,2,1]` и ожидаемые значения во всех прогонах; evidence-папка указана вверху handoff и anchor report.
- TC-002: три свежих повтора текущего core pipeline дали `[1,1,3]`; zero/absence, `pull_reps:50`, max keys и `overlay` соответствуют oracle; evidence-папка указана вверху handoff и anchor report.
- Ни один из core runs не заменяет проверку реального Obsidian UI/Vault.
- Пользовательские spec Canvas не переписывать вслед за реализацией. Если виден конфликт пользовательских источников — записать точные фрагменты и спросить пользователя.

## Документы, созданные/обновлённые в этом этапе

- `docs/testing/TESTING_PROTOCOL.md` — протокол полного покрытия и правила эталонов.
- `docs/testing/TEST_MATRIX.md` — coverage и фактические остатки по этапам 01–20.
- `docs/testing/OBSIDIAN_ACCEPTANCE_RUNBOOK.md` / `EXECUTION_REPORT_TEMPLATE.md` и `fixtures/TC-001-empty-state/` — инструкция live-исполнителю, шаблон evidence, seed, карта Vault-path и проверенный SHA256 manifest.
- `docs/testing/reports/2026-09-23-local-regression.md` — последняя локальная сборка/guard и точные ограничения evidence.
- `node tools/check_test_docs.js` — повторяемая проверка наличия project skill, Markdown links, test-file refs, всех 20 matrix/repair-map этапов, cited Canvas node IDs и шести SHA-256 fixture.
- `.hermes/skills/training-orchestrator/SKILL.md` — короткая project-local процедура контекстно-экономной оркестрации.
- docs/HANDOFF.md — помечен как исторический и перенаправляет на актуальную передачу.
- .gitignore — разрешает отслеживать только project skill; остальное содержимое .hermes по-прежнему игнорируется.
- Эта передача — решения, состояние на старте, источники и следующие шаги.

## Следующий шаг

1. Проверить полный содержательный цикл TC-001 в текущем Vault, каждый повтор начинать штатным полным сбросом: новый bundle, ввод, preview, новый rule, Branch 2 review, Save, main/temp snapshots, reload и граф.
2. Создать TC-002 seed из чистого сохранённого состояния TC-001; выполнить 3 независимых Gemma core/full-pipeline runs и сравнить явные нули 07-17/19, отсутствие компонентов 07-21, `pull_reps:50`, max keys и overlay с user oracle.
3. В текущем Obsidian Vault завершить TC-002 UI → preview → Save → reload → chart; отдельно проверить восстановление temp после reload, отдельную очистку, перемонтирование во время LLM, повторный run после preview и ошибку/retry общего Save.
4. Закрыть каждую строку matrix ссылкой на evidence либо оставить точный blocker; выполнить build/test/docs checker после последней правки.
4. Сверить каждый этап матрицы со свидетельством и обновлять этот handoff; перед передачей запускать `node tools/check_test_docs.js`.
5. Не коммитить; сохранить исходники пользователя и все существующие изменения.

## Историческая запись: подготовка протокола до завершения якорей

Документация и навыковый файл подготовлены. Проверены ссылки на локальные файлы, структура frontmatter навыка и git diff --check для изменённого протокола. Команда Hermes не найдена в PATH этого shell, поэтому активацию skill в CLI подтвердить нельзя. Автоматические тесты продукта и build/guard не запускались; runtime-код не изменялся.

## Проверка доступности Hermes из Codex — 2026-09-23

- Пользователь сообщил, что проект раньше разрабатывался в Hermes Desktop; считать это подтверждённым пользовательским фактом.
- В этой сессии Windows показал работающие процессы Hermes Desktop, но cua.getState() вернул пустой список native apps, поэтому управлять его окном через текущий UI bridge нельзя.
- Get-Command hermes не нашёл CLI в PATH Codex. Каталог runtime присутствует, но его содержимое недоступно shell даже после запроса точечного read-доступа. Никаких переустановок или изменений Hermes-конфигурации не выполнялось.
- Поэтому Hermes не считается отсутствующим; пока недоступен именно интерфейс отправки задач из Codex. Перед следующим шагом запросить у пользователя доступный путь к CLI/терминалу или согласовать временный fallback.
- Подготовленная первая узкая задача (ORCH-001): один дешёвый Hermes-модельный read-only аудит TESTING_PROTOCOL.md и TEST_MATRIX.md. Контекст: AGENTS.md, решения пользователя из этого handoff, протокол и матрица; repair-map.canvas читать только для сверки списка этапов. Не читать архив и весь prompt-lab. Выход: до 10 конкретных замечаний по приоритету, каждое с путём/строкой и объяснением: (a) пропуск шага data-flow, (b) несоответствие тестовой ссылки фактическому тесту, (c) противоречие пользовательским решениям. Если замечаний нет — сказать явно. Запретить правки файлов, выводы о Gemma без её фактических ответов и самостоятельное разрешение пользовательских противоречий. Рекомендуемая модель для этой небольшой задачи: DeepSeek V4.1 Flash; вызов не делать, пока Hermes интерфейс не доступен.

## Выполнено ORCH-001 — 2026-09-23

- Пользователь подтвердил, что `hermes` работает из обычного CMD. PATH менять не потребовалось; из Codex вызван существующий Hermes CLI.
- DeepSeek V4.1 Flash через OpenRouter получил только текст `TESTING_PROTOCOL.md` и `TEST_MATRIX.md`, без доступа к инструментам/редактированию. Был возвращён read-only аудит; тесты, build и Gemma не запускались.
- Полезные замечания аудита: формализовать критерий оценки вариативных ответов Gemma на якорных эталонах; сделать видимыми по этапам уровни покрытия/типы свидетельств; указывать версию модели и промпта для LLM-проверок; фиксировать происхождение сохранённых данных и блокирующие вопросы пользователю.
- Аудит назвал P1 требование к новому handoff противоречием. Это замечание отклонено: пользователь говорил об устаревшем `docs/HANDOFF.md`; `docs/ORCHESTRATOR_HANDOFF.md` создан в этой работе как актуальный документ непрерывности по прямому требованию пользователя. Запрос аудиту был сформулирован двусмысленно («handoff-файл исторический»), из-за чего модель не различила два файла. Не переносить это замечание в протокол без повторной точной проверки.
- Аудитор не видел файлы якорных кейсов, поэтому его выводы об отсутствии адресуемых эталонов ограничены. В дереве найдены `TC-001-spec.canvas`, `TC-001-run.canvas`, `TC-001-report.md` и `TC-002-spec.canvas`; у TC-002 run/report нет. Не считать проверкой смыслового утверждения пользователя и не менять эталоны.
- Результат — ориентир для следующего шага, не авторитет по пользовательскому смыслу. Никакие файлы аудируемых документов не изменены. Аудит не видел anchor specs; его замечание о нерешённых user Canvas расхождениях было superseded более поздними пользовательскими решениями.

## Выполнено ORCH-002 — 2026-09-23

- Проверен узел стартовой очистки: architecture Canvas требовала очистить все `.tmp`, а реализация поднимала `graph.tmp` обратно в preview и не очищала `rulesLog.tmp` при открытии.
- Исправлено: `ui/editor.js` теперь очищает `rulesLog.tmp.json` и `graph.tmp.json` перед чтением committed данных при `render()`. `data.tmp.json` очищается прежним путём, его `state.hiddenGroups` сохраняется. При ошибке очистки пользователь видит ошибку; обработчик нового прогона также прекращает выполнение, если не смог очистить temp.
- Добавлен стартовый регрессионный сценарий в `tests/program-started-readable.test.js`. Таргетный файл 5/5; build 15 QA; полный guard 304/304. Guard содержит один локальный Gemma/Ollama integration-тест; OpenRouter не использовался.
- Обновлены `TEST_MATRIX.md` и `TESTING_PROTOCOL.md`. Это закрывает mock/code уровень этапа 01 и часть этапа 17; live Obsidian/Vault остаётся открытым.
- Следующий шаг: продолжить этапы, не зависящие от якорей, затем выполнить runbook в текущем Vault после полного сброса, провести три независимых Gemma прогона на каждый якорь, проверить multi-file Save failure/recovery, сохранить screenshots/trace и оформить signoff. Не менять пользовательские TC-001/TC-002 эталоны самостоятельно.
- После последнего изменения прогнать целевой suite и build/guard уже выполнено; повторно проверить `git diff --check`, точное число целевого suite и свежесть документации. Live Obsidian acceptance, три прогона на якорь и user-oracle ответы остаются открытыми.
- Дополнительный fault-injection: если Vault отказывает при очистке temp, обработка и Save заблокированы до успешной очистки; committed JSON и незакрытое temp предложение остаются без применения. Это покрыто в тех же 6 тестах.
- Live-проверка пока технически недоступна через текущий UI bridge: `cua.getState()` показал `apps: []`, отдельные окна Obsidian недоступны; основной пользовательский Vault не открыт для тестовых записей. Не считать текущие mock/CLI проверки live acceptance.
- Запрошенный DeepSeek Flash read-only review свежего патча не дал результата: первая попытка ответила, что ей не передан код, вторая зависла без отчёта использования и была остановлена. Не считать это аудитом или независимым свидетельством; не повторять без отдельного обоснования.
- Ещё один ограниченный Hermes review Branch 2/3 также не состоялся: Hermes CLI/tool workspace видел `C:\AI\hermes-project` и не находил ни одного из путей текущего репозитория на G:. Финальный ответ `None` означал «не смог выполнить ревью», а не «дефектов нет». Не учитывать это как code review/test evidence; не повторять через Hermes CLI, пока не настроено чтение G: либо пока код не передан прямо в запросе.

## Выполнено ORCH-003 — 2026-09-23

- Устранена неатомарная запись: прежний UI писал правила и граф, игнорировал ошибку фиксации и после этого всё равно мог записать события. Теперь `storage.saveData(data, { additionalWrites })` записывает `rulesLog.json`, `graph.json`, `data.json` одним транзакционным вызовом. Перед изменениями сохраняются точные исходные байты; при отказе затронутые файлы восстанавливаются в обратном порядке. Если rollback тоже падает, ошибка перечисляет не восстановленные пути.
- UI сначала получает payload `commitRules`, затем вызывает транзакционное сохранение. Temp и preview очищаются только после успешной записи main JSON. При ошибке данные остаются для retry, правила в runtime cache возвращаются к исходному snapshot, граф обновляется после успешной транзакции.
- В `tests/storage.test.js` fault injection отказа каждого из трёх main-файлов, включая частичную запись, подтверждает побайтный rollback. В `tests/program-started-readable.test.js` UI-сценарий проверяет частичный отказ `graph.json`, сохранность всех main/temp/staged файлов и успешный повтор без дубликатов.
- Следующий обязательный этап: пройти runbook в текущем Obsidian Vault после штатного полного сброса, сделать по три независимых чистых Gemma прогона TC-001/TC-002 и оформить результаты. Не объявлять проект завершённым до этого signoff.

## Выполнено ORCH-004 — 2026-09-23

- Закрыто core/mock покрытие UI feedback по этапу 04. В `tests/program-started-readable.test.js` pipeline приостанавливается, тест по очереди наблюдает статусы Cutter, Router и Structured в пользовательском поле, затем возвращает ошибку.
- Проверено, что ошибку видно явно и она не маскируется как успешный preview: committed JSON не меняется, staged events остаются пустыми.
- Таргетный Save/start/storage suite — 28/28, `npm run guard` — 311/311. Build уже актуален, так как в этом этапе менялись только тест и документация.
- Live визуальная проверка статусов в Obsidian всё ещё требуется; строки 01–20 проверяются в текущем Vault после штатного полного сброса перед общим PASS.

## Выполнено ORCH-005 — 2026-09-23

- Исправлено нарушение сохранности сырого ввода: `ui/editor.js` больше не применяет `.trim()` к тексту перед `pipeline.next`; whitespace проверяется только для пустого ввода.
- Регрессионный UI-сценарий передаёт строку с начальными/конечными пробелами и переносами как есть, проверяет отсутствие вызова до нажатия, неизменность main JSON, отказ whitespace-only ввода и защиту от двойного клика.
- Таргетный Save/start/storage suite — 29/29; сборка — 15 QA; полный guard — 312/312. Осталась live проверка Obsidian/Vault.

## Выполнено ORCH-006 — 2026-09-23

- Новый цикл обработки сбрасывает `lastResult`, proposal, preview keys и staged events до начала следующего pipeline; граф и JSON preview немедленно возвращаются к committed state.
- Тест воспроизводит успешную попытку с новым событием/ключом → следующую попытку с ошибкой → Save. Старое событие не показывается, temp очищены, Save не вызывает `commitRules` для результата предыдущего прогона.
- Целевой Save/start/storage suite — 30/30; build — 15 QA; guard — 313/313. Следом нужно закрывать оставшиеся независимые UI-мок этапы и затем выполнить полный live acceptance.

## Выполнено ORCH-007 — 2026-09-23

- Исправлен human-loop Branch 2: результат теперь действительно отображается карточкой; кнопка «Принять правило» только одобряет черновик и не пишет main до общей Save-транзакции. Без одобрения пользовательские события сохраняются без model-proposed rule.
- Browser-like `pipeline.commitRules` теперь готовит Branch 2 и multi-rule Branch 3 rulesLog в памяти после недоступной fs-записи; подготовленный log возвращается UI для атомарной Vault-транзакции вместе с данными/графом.
- Добавлены UI-регрессии approve/defer и browser-like core-регрессии Branch 2/3. Таргетный Save/start/storage suite — 34/34; `npm run build` — 15 QA; `npm run guard` — 317/317; `git diff --check` без ошибок (есть стандартные предупреждения Git о будущей LF→CRLF конвертации).
- Live UI/Vault acceptance остаётся обязательным и не выполнен; ограничение UI bridge и ответы по oracle-вопросам остаются открытыми. Не считать проект завершённым.

## Выполнено ORCH-008 — 2026-09-23

- Сверил практический пакет с текущим repo: исправлено число seed-файлов (шесть, не пять); добавлены fixture README с Vault path mapping и SHA256SUMS; тестовый matrix row 01 обновлён с 10/10 до 12/12.
- Добавлен `tools/check_test_docs.js`. Текущий результат: 7 документов, project skill найден, 12 локальных ссылок, 20 matrix и repair-map этапов, 24 существующие test-file refs, 17 source Canvas node IDs, 6 совпавших fixture hashes. `git diff --check` — exit 0.
- В runbook добавлена воспроизводимая процедура startup temp cleanup с реальными форматами файлов из staging/tmpStore адаптеров и проверкой, что main JSON остаются побайтно прежними.
- Историческое расхождение event temp filename разрешено пользователем: использовать `data/training/data.tmp.json`; актуальная фикстура и кодовый путь обновлены.
- Добавлен `docs/testing/reports/2026-09-23-local-regression.md` с локальными build/test/guard результатами, bundle hash и чётким пределом evidence. Live Vault и oracle gates остаются незакрытыми.
