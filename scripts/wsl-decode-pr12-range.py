#!/usr/bin/env python3
import json, os, zstandard, sys

root = "/root/.dsh/sessions/--root-kix-e2e-pr12--"
sid = sorted(os.listdir(root))[0]
path = os.path.join(root, sid, "session.jsonl.zstd")
with open(path, "rb") as f:
    raw = zstandard.ZstdDecompressor().stream_reader(f).read()
lines = raw.splitlines()
lo, hi = int(sys.argv[1]), int(sys.argv[2])
for i in range(lo, min(hi, len(lines))):
    s = lines[i].decode("utf-8", "replace")
    print(f"===== [{i}] =====")
    print(s[:1500])
