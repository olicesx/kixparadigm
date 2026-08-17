#!/usr/bin/env python3
import json, os, zstandard, sys

root = "/root/.dsh/sessions/--root-kix-e2e-pr12--"
sids = sorted(os.listdir(root))
print("sessions:", sids)
for sid in sids:
    path = os.path.join(root, sid, "session.jsonl.zstd")
    if not os.path.isfile(path):
        continue
    print("====", sid, "====")
    with open(path, "rb") as f:
        raw = zstandard.ZstdDecompressor().stream_reader(f).read()
    hits = 0
    for i, line in enumerate(raw.splitlines()):
        try:
            o = json.loads(line)
        except Exception:
            continue
        t = o.get("type") or ""
        s = line.decode("utf-8", "replace")
        if "kix-consistency" in s or "kix-guards" in s or "parity" in s or "由你判断" in s or "hint" in s.lower():
            hits += 1
            # 只打印注入类消息的正文与 id
            if t == "user/message" or "additionalContexts" in s or "message" in t.lower():
                print(f"[{i}] {t}")
                print("   ", s[:600].replace("\n", " "))
    print("hits:", hits)
