#!/usr/bin/env python3
"""Makes public/i18n_data.js from the dictionaries in public/i18n/<lang>.json.

Each dictionary is {"exact": {"English text": "translation"}, "patterns": {"Earn {0} by sharing": "..."}}.
public/i18n/en.json is the list of English texts to translate (no translations).
Run it after changing a dictionary (demo/build.py runs it too)."""
import json, pathlib
ROOT = pathlib.Path(__file__).resolve().parent.parent
out = {}
for f in sorted((ROOT / "public" / "i18n").glob("*.json")):
    if f.stem == "en": continue
    d = json.loads(f.read_text(encoding="utf-8"))
    out[f.stem] = {"exact": {k: v for k, v in d.get("exact", {}).items() if v}, "patterns": {k: v for k, v in d.get("patterns", {}).items() if v}}
js = "// Made by tools/i18n-bundle.py from public/i18n/*.json. Do not edit by hand.\nwindow.__I18N = " + json.dumps(out, ensure_ascii=False, separators=(",", ":")) + ";\n"
(ROOT / "public" / "i18n_data.js").write_text(js, encoding="utf-8")
counts = ", ".join("%s %d" % (k, len(v["exact"]) + len(v["patterns"])) for k, v in out.items())
print("i18n_data.js: " + (counts or "no dictionaries yet"))
