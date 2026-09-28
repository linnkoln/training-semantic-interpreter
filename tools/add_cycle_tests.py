import json
p = r"G:\Obsidians\Notion\scripts\training\docs\repair-map.canvas"
d = json.load(open(p, encoding="utf-8"))
by_id = {n["id"]: n for n in d["nodes"]}

cycle = by_id["cycle"]
cycle["text"] = (
    "## 06 · Цикл обработки данных\n\n"
    "Данные обрабатываются в порядке поступления — от более ранних дней к более поздним.\n"
    "Каждый день отдельно идёт в Router (блок 07). Очередь обрабатывается, пока данные не закончатся.\n\n"
    "Правила, придуманные днями этого же прогона, сразу видны следующим дням:\n"
    "они лежат в temp-оверлее словаря до «Сохранить» (основной файл НЕ пишется).\n\n"
    "**Вход:** список дней от нарезчика (блок 05)\n"
    "**Выход:** накопленный результат прогона — события, аппенды словаря, новые правила, связи графика\n\n"
    "Сбой на одном дне не роняет прогон: день пропускается с предупреждением, очередь продолжается.\n\n"
    "Код: `core/pipeline.js` (next: цикл по дням)\n"
    "Тесты: `tests/pipeline.test.js` (технические), `tests/pipeline-cycle.test.js` (читаемые)\n"
    "\n---\n\n"
    "## 🧪 Тесты блока (ВХОД → ВЫХОД)\n\n"
    "**1. Дни обрабатываются по очереди**\n"
    "ВХОД: ввод из 3 дней\n"
    "ВЫХОД: каждый день по разу проходит Router и свою ветку; порядок следования сохранён.\n\n"
    "**2. Правило дня 2 видно дню 3**\n"
    "ВХОД: день 2 создал новое правило\n"
    "ВЫХОД: день 3 обрабатывается уже с этим правилом в словаре (temp-оверлей), "
    "хотя в основном файле правила ещё нет.\n\n"
    "**3. Основной файл словаря во время прогона не меняется**\n"
    "ВХОД: прогон с созданием новых правил\n"
    "ВЫХОД: rulesLog.json не записан; новое живёт только в temp-оверлее.\n\n"
    "**4. Сбой одного дня не роняет прогон**\n"
    "ВХОД: день 2 из 3 дал сбой LLM\n"
    "ВЫХОД: день 2 пропущен с предупреждением, дни 1 и 3 обработаны полностью.\n\n"
    "**5. Очередь из одной группы подряд**\n"
    "ВХОД: несколько дней одной группы подряд\n"
    "ВЫХОД: обрабатываются за один проход цикла без повторных прогонов LLM.\n\n"
    "Файл: `tests/pipeline-cycle.test.js` · запускается в `npm run guard`"
)

# Убираем отдельную выноску cycle-tests, если субагент/я её уже делали: тесты теперь прямо в блоке
for extra in ("cycle-tests",):
    d["nodes"] = [n for n in d["nodes"] if n.get("id") != extra]
    d["edges"] = [e for e in d["edges"] if e.get("fromNode") != extra and e.get("toNode") != extra]

# Заодно переносим тесты из старых выносок 03/04 внутрь блоков (по новой договорённости)
if "process-tests" in by_id:
    d["nodes"] = [n for n in d["nodes"] if n.get("id") != "process-tests"]
    d["edges"] = [e for e in d["edges"] if e.get("fromNode") != "process-tests"]
if "progress-tests" in by_id:
    d["nodes"] = [n for n in d["nodes"] if n.get("id") != "progress-tests"]
    d["edges"] = [e for e in d["edges"] if e.get("fromNode") != "progress-tests"]
if "cutter-tests" in by_id:
    d["nodes"] = [n for n in d["nodes"] if n.get("id") != "cutter-tests"]
    d["edges"] = [e for e in d["edges"] if e.get("fromNode") != "cutter-tests"]
if "launched-tests" in by_id:
    d["nodes"] = [n for n in d["nodes"] if n.get("id") != "launched-tests"]
    d["edges"] = [e for e in d["edges"] if e.get("fromNode") != "launched-tests"]

json.dump(d, open(p, "w", encoding="utf-8"), ensure_ascii=False, indent="\t")
print("ok: блок 06 заполнен, выноски убраны — тесты живут в блоках")
