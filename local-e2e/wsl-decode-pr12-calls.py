#!/usr/bin/env python3
import json, os, zstandard, sys

root = "/root/.dsh/sessions/--root-kix-e2e-pr12--"
want = sys.argv[1] if len(sys.argv) > 1 else None
for sid in sorted(os.listdir(root)):
    if want and want not in sid:
        continue
    path = os.path.join(root, sid, "session.jsonl.zstd")
    if not os.path.isfile(path):
        continue
    print("====", sid[:13], "====")
    with open(path, "rb") as f:
        raw = zstandard.ZstdDecompressor().stream_reader(f).read()
    for i, line in enumerate(raw.splitlines()):
        try:
            o = json.loads(line)
        except Exception:
            continue
        t = o.get("type") or ""
        d = o.get("data") or {}
        if t == "tool/call":
            args = d.get("arguments")
            a = args if isinstance(args, str) else json.dumps(args, ensure_ascii=False)
            print(f"[{i}] CALL {d.get('name')} :: {a[:160]}")
