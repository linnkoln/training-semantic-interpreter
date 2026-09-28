# NOTES — Branch 2 «Минорное дополнение правил» (2026-09-02)

## Что сделано
- `prompts/mode_minorRuleUpdate.md` (v1): Branch 2 — по куску группы 2 найти ключ правила
  по семантике и выдать аппенд «ключ → новый пример употребления»; без дубля базового
  примера. Заголовок содержит «Минорное» — маркер для fake-fetch в тестах.
- `adapters/llm.js`: `MODE_TO_STATUS.minorRuleUpdate = 'success'`; шаблон подхватывается
  `loadTemplate('minorRuleUpdate')` из llmGateway автоматически.
- `adapters/tmpStore.js`:
  - `appendMinorMappingFs(appends[, tmpPath])` — node/fs-аппенд в `data/rulesLog.tmp.json`
    (дедуп по key+exampleText, нормализация в newKeys с `source:'minorRuleUpdate'`).
    НИКОГДА не пишет rulesLog.json (INV-2/3).
  - `readRulesTmpFs`, `mergeMinorAppends`, хуки `_setRulesTmpPath`/`_getRulesTmpPath` (тесты).
  - `makeTmpStore().appendMinorMapping` — vault-версия для UI-контекста.
  - `mergeRuleSnapshots`: маппинг tmp-правила теперь ключ → exampleText (формат §4),
    а не ключ → ключ.
- `core/pipeline.js` — Branch 2: chunks1(гр.1) → structured ∥ minorChunks(гр.2) →
  callLLM('minorRuleUpdate') ∥ conflict(гр.3). После аппенда — повторный
  structured(гр.2) с дополненным словарём: оверлей main ∪ tmp через
  `mergeRuleSnapshots` + `rulesLog.setCachedLog` (только в памяти, кэш
  восстанавливается в finally; версия лога остаётся целой — interpretation_version
  событий требует Number.isInteger). События всех structured-прогонов сливаются.
  Сбой Branch 2 → warning + fallback-structured группы 2 без аппенда, ветки 1/3 живы.
  Новая стадия `STAGES.MINOR` для onStage.
- `tests/pipeline.test.js`: makeFetch различает minor по /Минорное/ (+throwMinor);
  новые тесты: (а) аппенды в rulesLog.tmp.json и rulesLog.json не тронут,
  (б) во 2-м parse-промпте виден дополненный словарь (ключ+exampleText), события
  групп 1+2 слиты, (в) сбой minorRuleUpdate → warnings, события Branch 1 живы.

## Известные ограничения
- Оверлей словаря работает через rulesLog.setCachedLog (in-memory). Restore
  оригинала в finally — параллельные next() в одном процессе могли бы видеть
  оверлей чужого прогона (для Obsidian-UI с последовательными вызовами не критично).
- Промпт mode_minorRuleUpdate.md — черновик, показать пользователю до вшивания.

## 2026-09-02 — Branch 3 «Разрешение конфликта — новое правило» (ruleUpdate)
- `prompts/mode_RuleUpdate.md` — ЧЕРНОВИК (показать пользователю до вшивания).
  Стиль mode_router.md v3. Умеет: разделять куски на «старые ключи»/«новые»,
  придумывать новый ключ (нейминг по цитате 2026-08-31: латиница, никакой
  кириллицы/транслита, короткие семантические `<группа>_<метрика>`, без Type A/B),
  определять отношения старое↔новое (A+B — сумма и расфасовка; subset —
  усложнение/упрощение). Слоты {{INPUT}}/{{RULES}}/{{CONTEXT}}.
- Контракт ответа (строгий JSON): payload { rule: {semantics, keys:[{key, role}],
  composition}, oldKeysEvents: [...], newKeys: [...], relations: [...], confidence }.
  Роли: 'overlay' = надстройка в стеке, 'stack' = база; 'trend' НЕ используется.
- `adapters/llm.js`: MODE_TO_STATUS['ruleUpdate'] = 'success' — шаблон подхватывается
  loadTemplate('ruleUpdate') автоматически. ⚠️ Файл mode_RuleUpdate.md vs искомый
  mode_ruleUpdate.md — Windows FS читает case-insensitive; на Linux-деплое придётся
  унифицировать регистр.
- `core/conflict.js`: proposeRule переведён на TRANSPORT_MODE='ruleUpdate';
  {{RULES}} — opts.rules-строка (только для промпта; в buildProposal/renderExample
  объект правил не просачивается). buildProposal диспетчеризует: payload.rule
  (новый контракт) → buildProposalFromRuleUpdate; массив-кандидатов → легаси-путь
  (совместимость со старыми тестами/прогонами). Нейминг — детерминированная
  структурная проверка KEY_RE (латиница, ≥2 сегмента); кириллица/транслит →
  отбраковка ключа, без валидных ключей → {status:'error'}. proposeRule возвращает
  расширенный payload { rule, exampleEvents, oldKeysEvents, oldChunks, newKeys,
  relations } — контракт {rule, exampleEvents} сохранён (pipeline/confirm не тронуты).
  Правило строится в формате rulesLog: id (следующий свободный), semantics,
  when.pattern (детерминированный), then{entity, metric, composition}, mapping,
  roles, examples {input, date, values}.
- `core/pipeline.js` — диспетчеризация группы 3: в proposeRule передаётся
  {{RULES}}-срез; если LLM разделила данные (есть oldChunks И newKeys), старые
  куски гонятся через structured() (перевод по старым правилам), события сливаются
  в общий payload.events. Сбой перевода — warning 'Branch 3 (conflict): …', не
  роняет правило и остальные ветки.
- Тесты: makeFetch в pipeline/pipeline-commit-rules различает ruleUpdate-вызов по
  /RuleUpdate/ в заголовке промпта (parse остался за structured). Новые кейсы:
  (а) группа 3 → rule с mapping/roles, нейминг проверен структурно (кириллица и
  транслит-односегмент → error); (б) разделение старое/новое → события по старым
  ключам + правило для новых, сбой structured → warning; (в) confirm-регресс по
  новому контракту. Прогон: pipeline+commit-rules+llm = 39/39; npm test = 233/233;
  npm run build — bundle 258129 байт, 14 QA-проверок.

## 2026-09-02 — Branch 3 LLM-relations → граф + переименование промпта
- `core/renderRules.js`: `relationsFromLLM(rels)` — LLM-формат {type:'A+B'|'subset', old, new, note}
  → графовый {type:'part_of', parent, child}: A+B → parent=old, child=new (новое — часть суммы);
  subset → parent=new, child=old (усложнение — подмножество старого). note не пишется в граф,
  мусор/дубли отбраковываются (dedupe по JSON-сигнатуре).
- `adapters/tmpStore.js`: fs-хуки для node-контекста — `_setGraphTmpPath/_getGraphTmpPath`,
  `readGraphTmpFs`, `appendGraphTmpRelationsFs` (дедуп, targets/trends сохраняются),
  `clearGraphTmpRelationsFs`. graph.tmp.json никогда не пишет graph.json (INV-2/3).
- `core/pipeline.js`: next() при успехе Branch 3 конвертирует payload.relations и дописывает
  в graph.tmp.json (сбой — warning, не роняет правило); relations пробрасываются в payload.
  commitRules: `commitGraphRelations(result, graph)` мержит LLM-связи (payload) ∪ temp-связи
  (graph.tmp.json) в граф от ключей (branch 1) или rebuildGraphFromRules([]) (branch 2 proposal),
  пишет graph.json и ОЧИЩАЕТ temp-связи. fs-путь graph.json — через `_setGraphFsPath` (тесты).
- `prompts/mode_RuleUpdate.md` → `prompts/mode_ruleUpdate.md` (untracked → простой mv; git mv
  отказал). loadTemplate('ruleUpdate') и так ищет mode_ruleUpdate.md — захардкоженных ссылок
  с большой буквы нет (только комментарии). Шапка: `<!-- version: 1 -->` без пометки черновика.
- Тесты (pipeline-commit-rules.test.js, +3): next() → связи в graph.tmp.json и graph.json
  не создаётся; смешанный прогон (группы 1+3) → commitRules мержит в graph.json без дублей
  (part_of от групп ключей + LLM-связи), temp очищается; unit relationsFromLLM.
  Прогон: pipeline+commit-rules = 32/32; npm test = 236/236; npm run build — 266198 байт, 14 QA.

## 2026-09-02 — Пункт 5: сверка STAGED-превью и Save с канвой
- Сверка с docs/user/artifacts/architecture.canvas (узлы staged, save, «Очистка .tmp»,
  85523caae96c4e85, 876517b7408594de, 2c1755c54f1f38fb). Найдено и ПОЧИНЕНО:
  1) Повторное «Обработать» НЕ очищало tmp (канва: «Очистка .tmp» → Router) —
     handleInterpret теперь clearRulesTmp + clearGraphTmp + сброс tmpGraphCache до
     pipeline.next (ui/editor.js), иначе tmp-ключи прошлого неудовлетворённого прогона
     подмешивались в {{RULES}} через main ∪ tmp.
  2) Превью-граф main ∪ tmp обновлялся только при монтировании виджета: после
     «Обработать» tmpGraphCache не перечитывался → связь Branch 3 из graph.tmp.json
     появлялась на графике лишь после перемонтирования. Теперь после успешного next():
     payload.relations дописываются в graph.tmp.json через vault (идемпотентно к fs-аппенду
     pipeline в node — mergeGraphs дедуплирует) и tmpGraphCache перечитывается.
- Расхождения, зафиксированные БЕЗ правки (семантика канвы соблюдена иначе / спорно):
  • data-слой: канва называет temp-слой событий «data.tmp.json»; фактически это
    data/training/staged.tmp.json (adapters/staging.js) + in-memory stagedEvents —
    превью = main ∪ staged, очищается при повторной обработке и на Save (семантика
    канвы выполнена, имя файла другое). Комментарий tmpStore.js поправлен.
  • Save-транзакция не атомарна целиком: правила/граф пишутся ДО данных (сбой записи
    данных при уже зафиксированных правилах — не откатывается). Повторный Save безопасен
    (commitRules дедуплирует ключи). «Насколько-возможно атомарно» — оставлено как есть.
  • tmp-ключи теряются, если Save сделан после перемонтирования виджета (lastResult=null):
    commitRules пропускается, tmp очищается без переноса в main. Узкий кейс, требует
    решения пользователя (persist lastResult в staging vs оставить).
- Тесты: tests/tmpStore.test.js (новый, 7): mergeGraphs/mergeRuleSnapshots (main ∪ tmp),
  fs-аппенды/очистки tmp, vault-контракт очистки tmp при Save/повторной обработке;
  tests/save-preview.test.js (+2): Save-транзакция graph.tmp→graph.json + очистка tmp,
  tmp-ключи сессии → правило в main-логе. Прогон: node --test = 16/16; npm test = 245/245;
  npm run build — bundle.js пересобран (14 QA).

## 2026-09-02 — Branch 3: несколько групп новых упражнений + устойчивость транспорта LLM
- Диагноз (живой прогон через реальную Ollama): ввод «*09-02* отжимания 100 (73+27)\nжим
  от груди 40» → LLM правильно вернула rule.keys по ДВУМ группам (pushups_reps,
  bench_press_reps) + newKeys, но buildProposalFromRuleUpdate давала null: deriveEntity
  требовала ровно одну группу (entities.size !== 1 → null). Branch 3 по канве — как раз
  про НЕСКОЛЬКО новых упражнений. ПОЧИНЕНО (core/conflict.js):
  1) buildProposalFromRuleUpdate группирует ключи по первой сегмент-группе
     (split('_')[0]) и строит ОДНО правило на ГРУППУ (deriveEntity вызывается внутри
     группы, сам не тронут). Новый контракт: built = { rules: Rule[] (все группы),
     rule: rules[0] (обратная совместимость), exampleEvents (по всем группам),
     oldKeysEvents, oldChunks, newKeys, relations }. id групп уникальны (пул правил
     расширяется в памяти); opts.id — только первому правилу. buildPattern при
     нескольких кусках — по первому куску newKeys ГРУППЫ (не весь ввод).
  2) proposeRule: payload.rules = rules[] (все группы) + rule = rules[0].
  3) pipeline: runConflict/next пробрасывают payload.rules; commitRules (branch 2)
     фиксирует ВСЕ правила групп через confirmProposal по очереди (added = число групп).
- Транспорт LLM (adapters/llm.js): 2 повтора с задержками 500/1500ms при сетевом сбое,
  HTTP 5xx и таймауте (AbortSignal.timeout(120000)); 4xx НЕ ретраится. Каждый
  контрактный error несёт поле error = причина (HTTP-статус/текст сетевого сбоя/
  «таймаут 120000ms»); для тестов — options.retryDelays. proposeRule зовёт chat()
  напрямую (validateResponse шлюза отбрасывал поле error) и включает причину в
  reason: «LLM-вызов упал: <причина>».
- Тесты: tests/pipeline.test.js (+6): multi-group buildProposalFromRuleUpdate (2
  группы → 2 правила, примеры по всем newKeys, уникальные id), multi-group через
  пайплайн + commitRules (added=2, версия +2), proposeRule rules[], retry fake-fetch
  (падает 1 раз → success), 5xx ретраится/4xx нет + причина в error, reason содержит
  причину сбоя. Прогон: pipeline+commit-rules+llm = 48/48; npm test = 251/251;
  npm run build — bundle.js 276218 байт (14 QA).
## 2026-09-03 — Отказоустойчивый structured: нарушение нейминга бракует ключ, а не прогон

- Диагноз (живые прогоны через Ollama): LLM возвращает почти валидные события, но ОДИН
  плохой ключ (напр. pull_accessory_variant — запрещённое слово 'variant') делал
  structured status='ambiguous' и выбрасывались ВСЕ события прогона (старый
  early-return в блоке 5a). Три прогона подряд не удалось сохранить. Контракт D16
  (плохие имена запрещены) остаётся, но браковать из-за одного ключа весь прогон —
  не соответствует духу REQ-1 (детерминизм — верификатор, не guillotine).
- ПОЧИНЕНО (core/structured.js): блок проверки нейминга (5a) перенесён ДО построения
  событий (5b) и отбраковывает ТОЛЬКО пары (ключ → значение) с нарушением контракта
  именования; события строятся из оставшихся ключей как обычно. Забракованные ключи
  не теряются молча: payload.namingIssues = [{key, reason}] + краткий message.
  Статус 'success' если хотя бы одно событие построено (плохой ключ не попадает в
  newKeys — правило по браку не фиксируется); 'ambiguous' ТОЛЬКО если после отбраковки
  не осталось ни одного события (все ключи плохие), с перечнем причин в payload.namingIssues;
  'error' — как раньше, при структурном мусоре без нейминг-нарушений. Ключи из
  вокабуляра правил по-прежнему не пере-проверяются (D10/D11, регресс покрыт тестом
  с инжектом rulesLog в require.cache). Даты: поведение не менялось (контекст подставляет).
- Тесты: tests/structured.test.js (+3): (а) 2 валидных ключа + 1 с 'variant' → success,
  событие только из валидных, namingIssues=[{key,reason}], message содержит ключ;
  (б) все ключи плохие (pull_accessory_variant + way2_push) → ambiguous с namingIssues;
  (в) вокабулярный ключ pull_variant_full (сегмент 'variant' запрещён контрактом, но
  ключ зафиксирован в правилах) проходит без отбраковки. Прогон:
  node --test tests/structured.test.js = 19/19; npm test = 254/254.

## 2026-09-03 — Сквозная оценка групп в pipeline.next: очередь по датам + понижение 3→2→1 + повторный structured пониженных кусков после Branch 3
- Правило (канва, узел Router): «если обнаружены группы 2 или 3, то последующие даты мы
  оцениваем как будто бы правило уже появилось»: День 1 гр.3 → День 2 (относительно RULES
  гр.3) → 2, День 3 (гр.2) → 1.
- Реализовано (core/pipeline.js, next()):
  1) Блок 2а перед диспетчеризацией: грубая дата куска regex-ом (YYYY-MM-DD | *MM-DD* |
     MM-DD после |, нет даты → null; НЕ глубокий парсинг); сортировка кусков по возрастанию
     даты, куски без даты — в конец с сохранением порядка LLM.
  2) Понижение: триггер — кусок группы 3 (или группы 2); первый триггер сам не понижается,
     все последующие: 3→2, 2→1, помечены g.downgraded=true. Понижение задним числом
     запрещено: [гр.1, гр.2, гр.3] остаётся без изменений (кусок гр.3 до первого гр.3 не
     понижается). Пониженные куски исключены из chunks1/minorChunks/chunks3.
  3) Блок 3c после Branch 3/2: пониженные куски идут через runStructuredWithOverlay —
     повторный structured с tmp-оверлеем словаря в памяти (main ∪ minor-аппенды ∪ правила
     Branch 3 из cRes.rules; кэш rulesLog восстанавливается в finally, INV-2/3 — на диск
     next() не пишет). События сливаются в общий контракт (как minor); сбой — warning
     «Пониженные куски (сквозная оценка)», не роняет правило и остальные ветки.
- Тесты (tests/pipeline.test.js, +3): (а) [гр.3 D1, гр.3 D2] → D2 понижен до 2 → после
  conflict ровно один parse с новым словарём (ключ+пример правила Branch 3 в промпте),
  события слиты; порядок router→ruleUpdate→parse; (б) [D2, D1] в обратном порядке →
  сортировка переворачивает, D1 (триггер) обрабатывается первым; (в) [гр.1, гр.2, гр.3] по
  возрастанию дат — ничего не понижено, ветки отработали как раньше (2 parse, правило
  Branch 3, без warning про пониженные).
- Прогон: node --test tests/pipeline.test.js = 33/33; npm test = 257/257; npm run build —
  bundle.js 294712 байт (15 QA).

## 2026-09-03 — Инструментальная трасса data-flow: core/trace.js + зацепки pipeline (next/commitRules)
- `core/trace.js` — чистый CommonJS-модуль трассировки (JSON-файл прогона в
  `data/test-artifacts/`): `begin(kind, meta)` → { id: 'trace-<timestamp>', kind:
  'interpret'|'save'|'wipe', startedAt, steps, files }; `step(tr, step, data)` —
  запись { step, at, data } (любой JSON: куски, ветки, LLM-вывод; циклические
  ссылки гасятся stringify-предохранителем); `fileSnapshot(tr, label, path,
  content)` — снимок файла (size + JSON.stringify обрезан до 2000 символов);
  `end(tr)` — пишет `trace-<ts>-<kind>.json` (mkdirSync recursive, синхронно).
  Ошибка записи — console.warn, никогда не бросает. Ретеншн: в test-artifacts
  не больше 50 файлов трасс (MAX_TRACE_FILES), при новой записи самые старые
  (по mtime) удаляются. Тест-хуки: `_setTraceDir/_getTraceDir/_setFsAvailable`.
- Браузерная безопасность (UI не тронут): трасса живёт только в node-контексте.
  begin/step/fileSnapshot — чистые операции над объектом; end() проверяет
  наличие fs-возможностей (writeFileSync+mkdirSync+readdirSync+unlinkSync) —
  fs-шим бандла их не даёт → тихий no-op (без warn), трасса не пишется.
- `core/pipeline.js` — зацепки (INV: контракт payload не засоряем — трасса
  ТОЛЬКО в файл, наружу только `_traceId`):
  - next(): begin('interpret', {inputLen}) → step('router.groups', groups) →
    step('dispatch', {chunks12, minorChunks, chunks3}) → step('branch1.structured',
    sRes) / step('branch2.minor', mRes) / step('branch3.conflict', cRes) после
    Promise.all → step('final.payload', сводка {status, branch, events,
    newKeys, hasRule, appends, warnings}). Все ранние error-выходы (router
    fail, dispatch fail, ни одна ветка) тоже закрывают трассу (endedAt).
    payload._traceId = tr.id — для сопоставления с файлом.
  - commitRules(): begin('save') → step('commitRules', {added, version}) →
    fileSnapshot('rulesLog.json после', rulesLog._getLogPath()) +
    fileSnapshot('graph.json после', _graphFsPath) перед каждым успехом/noop;
    catch тоже закрывает трассу. Чтение файлов для снимков — fs в try/catch
    (браузер: снимки просто отсутствуют).
- `tests/trace.test.js` (+6): (а) begin/step/fileSnapshot/end → файл создан,
  валидный JSON, шаги/снимок/обрезка 2000; no-op при _setFsAvailable(false);
  null-контент снимка не бросает; (б) next() с mock-fetch и изолированным
  tmp-каталогом (_setTraceDir) → трасса interpret с router.groups/dispatch/
  branch1.structured/final.payload, payload._traceId == id файла; сбой
  Router-LLM → трасса всё равно закрыта (endedAt); (в) ретеншн 51 → 50,
  удаляется самый старый по mtime.
- Прогон: node --test tests/trace.test.js tests/pipeline.test.js
  tests/pipeline-commit-rules.test.js = 47/47; npm test = 263/263;
  npm run build — bundle.js 297903 байт (15 QA), trace в бандле тихо no-op
  (fs-шим не даёт readdirSync/unlinkSync).
