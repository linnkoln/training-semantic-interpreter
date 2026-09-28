# -*- coding: utf-8 -*-
"""Проверка «текст блока влезает в его высоту» по реальным метрикам шрифта.

Модель рендера: Obsidian canvas-карточка, шрифт Segoe UI 16px, line-height 1.3,
внутренние отступы 10px/12px; `## ` — заголовок 19px, `---` — разделитель.
"""
import json
import sys
from PIL import ImageFont

FONT = "C:/Windows/Fonts/segoeui.ttf"
F16 = ImageFont.truetype(FONT, 16)
F19 = ImageFont.truetype(FONT, 19)
PAD_H, PAD_V = 12, 10
LH16, LH19 = 20.8, 25.0


def wrapped_lines(seg, font, max_w):
    if not seg.strip():
        return 1
    words, lines, cur = seg.split(" "), 1, ""
    for w in words:
        probe = (cur + " " + w).strip()
        if font.getlength(probe) <= max_w or not cur:
            cur = probe
        else:
            lines += 1
            cur = w
    return lines


def needed_height(text, width):
    max_w = width - 2 * PAD_H
    h = 2 * PAD_V
    for raw in text.split("\n"):
        if raw.startswith("---"):
            h += 17          # hr + отступы
            continue
        if raw.startswith("## "):
            h += wrapped_lines(raw[3:], F19, max_w) * LH19 + 6
            continue
        h += wrapped_lines(raw, F16, max_w) * LH16
    return h


if __name__ == "__main__":
    path = sys.argv[1]
    data = json.load(open(path, encoding="utf-8"))
    clipped, tight = [], []
    for n in data["nodes"]:
        if n.get("type") == "group":
            continue
        need = needed_height(n["text"], n["width"])
        slack = n["height"] - need
        if slack < 0:
            clipped.append((n["id"], n["height"], round(need), round(slack)))
        elif slack < 30:
            tight.append((n["id"], n["height"], round(need), round(slack)))
    print("узлов проверено:", len([n for n in data["nodes"] if n.get("type") != "group"]))
    print("ОБРЕЗАНО:", len(clipped))
    for c in clipped:
        print("   ", c)
    print("впритык (<30px запаса):", len(tight))
    for t in tight:
        print("   ", t)