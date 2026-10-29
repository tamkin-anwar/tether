#!/usr/bin/env python3
"""Builds _locales/<lang>/messages.json from the string tables in this folder.

    python3 tools/build_locales.py

Checks every locale has exactly the English keys, the same $n substitutions,
and a store summary within Chrome's 132-character limit.
"""
import json, os, re, sys
sys.path.insert(0, os.path.dirname(__file__))
from messages_en import EN
from messages_es_pt import ES, PT_BR
from messages_fr_de import FR, DE
from messages_hi_ja import HI, JA

LOCALES = {"en": EN, "es": ES, "pt_BR": PT_BR, "fr": FR, "de": DE, "hi": HI, "ja": JA}
root = os.path.join(os.path.dirname(__file__), "..", "_locales")
subs = lambda s: sorted(set(re.findall(r"\$\d", s)))
ok = True
for lang, table in LOCALES.items():
    if set(table) != set(EN):
        print(lang, "keys differ:", set(EN) ^ set(table)); ok = False
    for k, v in table.items():
        if subs(v) != subs(EN[k]):
            print(lang, k, "substitutions differ"); ok = False
    if len(table["extDescription"]) > 132 or len(table["extName"]) > 75:
        print(lang, "name/summary too long"); ok = False
    # The name and summary are Store metadata. A list of streaming brands in
    # them is rejected as keyword spam (it happened twice, with 6 names and
    # with more); the listing names no services at all, and neither do these.
    brands = ("Netflix", "Prime Video", "Hulu", "Disney+", "Max", "YouTube", "Crunchyroll", "HBO")
    for key in ("extName", "extDescription"):
        named = [b for b in brands if b in table[key]]
        if len(named) > 2:
            print(lang, key, "lists streaming brands (keyword spam):", ", ".join(named)); ok = False
if not ok:
    sys.exit(1)
for lang, table in LOCALES.items():
    os.makedirs(os.path.join(root, lang), exist_ok=True)
    out = {k: {"message": v} for k, v in table.items()}
    with open(os.path.join(root, lang, "messages.json"), "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
        f.write("\n")
print("built", ", ".join(LOCALES))
