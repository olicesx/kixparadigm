#!/usr/bin/env python3
import json
import os
import zstandard

root = "/root/.dsh/sessions/--root-kix-p5-e2e--"
sessions = sorted(os.listdir(root))
print("sessions:", sessions)
for sid in sessions:
    path = os.path.join(root, sid, "session.jsonl.zstd")
    if not os.path.isfile(path):
        continue
    print("====", sid, "====")
    with open(path, "rb") as f:
        raw = zstandard.ZstdDecompressor().stream_reader(f).read()
    for i, line in enumerate(raw.splitlines()):
        try:
            o = json.loads(line)
        except Exception:
            continue
        t = o.get("type") or ""
        s = line.decode("utf-8", "replace")
        if "kix-consistency" in s or "lacks an identified" in s:
            print(i, t, s[:500])
            print("---")
        if t == "user/message" and "kix-consistency" in s:
            data = o.get("data") or o
            msg = data.get("message") or data
            print("MSG id=", msg.get("id") if isinstance(msg, dict) else None)
            print("MSG keys=", list(msg.keys())[:20] if isinstance(msg, dict) else type(msg))
