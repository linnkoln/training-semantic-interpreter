import json, re
p = r"G:\Obsidians\Notion\scripts\training\docs\repair-map.canvas"
d = json.load(open(p, encoding="utf-8"))

# Нумерация в порядке потока данных пользовательской архитектуры
numbering = [
    ("launched",  "01"),
    ("input",     "02"),
    ("process",   "03"),
    ("progress",  "04"),
    ("cutter",    "05"),
    ("cycle",     "06"),
    ("router",    "07"),
    ("ruleslog",  "08"),
    ("branch1",   "09"),
    ("branch2",   "10"),
    ("branch3",   "11"),
    ("tmp1",      "12"),
    ("tmp2",      "13"),
    ("staged",    "14"),
    ("unsat",     "15"),
    ("sat",       "16"),
    ("wipe",      "17"),
    ("save",      "18"),
    ("graphnote", "19"),
    ("build",     "20"),
]

by_id = {n["id"]: n for n in d["nodes"]}
report = []
for nid, num in numbering:
    n = by_id.get(nid)
    if not n:
        report.append("MISS " + nid)
        continue
    t = n.get("text") or ""
    t = re.sub(r"^## \d{2} · ", "## ", t)  # снять старый номер, если уже был
    if t.startswith("## "):
        n["text"] = "## " + num + " · " + t[3:]
        report.append(nid + "=" + num)
    else:
        report.append(nid + ": нет заголовка")

json.dump(d, open(p, "w", encoding="utf-8"), ensure_ascii=False, indent="\t")
print("; ".join(report))
