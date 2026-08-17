#!/usr/bin/env python3
import json
import zstandard

path = "/root/.dsh/sessions/--root-kix-p5-e2e--/session-0637a3dd-6be7-42c4-a87f-e7f880d99c96/session.jsonl.zstd"
with open(path, "rb") as f:
    dctx = zstandard.ZstdDecompressor()
    raw = dctx.stream_reader(f).read()
cwd_hits = 0
for i, line in enumerate(raw.splitlines()):
    try:
        o = json.loads(line)
    except Exception:
        continue
    t = o.get("type") or o.get("kind") or o.get("event") or ""
    if i < 5:
        print("LINE", i, "type=", t, "keys=", list(o.keys())[:16])
        if isinstance(o.get("header"), dict):
            print("  header keys", list(o["header"].keys())[:30])
            print("  header.cwd", o["header"].get("cwd"))
    s = line.decode("utf-8", "replace")
    if "cwd" in s and cwd_hits < 12:
        idx = s.find("cwd")
        print("CWD-SNIP", i, t, s[max(0, idx - 60): idx + 140])
        cwd_hits += 1
    if t in ("session/header", "session.start", "agent/session-start", "session/created"):
        print("EVENT", i, t, json.dumps(o)[:400])
