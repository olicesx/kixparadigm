#!/usr/bin/env python3
import json, os, zstandard

root = "/root/.dsh/sessions/--root-kix-e2e-pr12--"
sid = sorted(os.listdir(root))[0]
path = os.path.join(root, sid, "session.jsonl.zstd")
with open(path, "rb") as f:
    raw = zstandard.ZstdDecompressor().stream_reader(f).read()

for i, line in enumerate(raw.splitlines()):
    try:
        o = json.loads(line)
    except Exception:
        continue
    t = o.get("type") or ""
    d = o.get("data") or {}
    if t == "user/message":
        src = d.get("source") or {}
        kind = src.get("kind")
        txt = ""
        for c in (d.get("content") or []):
            if isinstance(c, dict) and c.get("type") == "text":
                txt = c.get("text", "")[:120]
        print(f"[{i}] USER kind={kind} plugin={src.get('plugin')} id={d.get('id','')[:8]} :: {txt}")
    elif "tool" in t.lower() or "execution" in t.lower():
        name = d.get("name") or ""
        args = d.get("arguments") or d.get("args") or {}
        if isinstance(args, dict):
            fp = args.get("file_path") or args.get("command") or ""
        else:
            fp = str(args)[:100]
        if isinstance(fp, str):
            fp = fp[:100]
        print(f"[{i}] {t} name={name} :: {fp}")
    elif t.startswith("agent/"):
        print(f"[{i}] {t}")
