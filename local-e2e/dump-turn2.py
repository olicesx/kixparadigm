#!/usr/bin/env python3
"""Dump turn-2 subagent call errors from the main session ledger."""
import glob, json, subprocess

f = sorted(glob.glob('/root/.dsh/sessions/--root-kix-budget-e2e--/session-*/session.jsonl.zstd'))[-1]
raw = subprocess.run(['zstd', '-dc', f], capture_output=True).stdout.decode('utf-8', 'replace')
lines = raw.split('\n')
for i, line in enumerate(lines):
    if not line.strip():
        continue
    try:
        r = json.loads(line)
    except Exception:
        continue
    d = r.get('data') or {}
    if r.get('type') == 'tool/call' and (d.get('name') or '').startswith('subagent') and d.get('turn') == 2:
        print(f"=== call seq={r.get('seq')} name={d.get('name')}")
        print('args:', (d.get('arguments') or '')[:400])
    if r.get('type') == 'tool/result' and 'subagent' in line:
        m = (d.get('message') or {})
        for c in (m.get('content') or []):
            for cc in (c.get('content') or []):
                t = cc.get('text', '')
                if 'subagent' in t.lower() or 'error' in t.lower() or 'kix' in t.lower():
                    print(f"--- result seq={r.get('seq')}: {t[:600]}")
    if r.get('type') == 'assistant/message' and d.get('turn') == 2:
        c = (d.get('message') or {}).get('content')
        if isinstance(c, list):
            for b in c:
                if b.get('type') == 'text' and b.get('text', '').strip():
                    print(f"### assistant: {b['text'][:800]}")
