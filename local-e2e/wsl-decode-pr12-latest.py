#!/usr/bin/env python3
import json, os, zstandard

root = "/root/.dsh/sessions/--root-kix-e2e-pr12--"
sids = [s for s in os.listdir(root) if os.path.isfile(os.path.join(root, s, "session.jsonl.zstd"))]
sids.sort(key=lambda s: os.path.getmtime(os.path.join(root, s, "session.jsonl.zstd")))
path = os.path.join(root, sids[-1], "session.jsonl.zstd")
print("latest:", sids[0][:13])
with open(path, "rb") as f:
    raw = zstandard.ZstdDecompressor().stream_reader(f).read()
for i, line in enumerate(raw.splitlines()):
    try:
        o = json.loads(line)
    except Exception:
        continue
    if o.get("type") != "user/message":
        continue
    d = o.get("data") or {}
    src = d.get("source") or {}
    if src.get("kind") == "plugin":
        txt = d.get("content", [{}])[0].get("text", "")
        print(f"[{i}] PLUGIN {src.get('plugin')}: {txt[:220]}")
