#!/usr/bin/env python3
"""Live progress for the budget E2E session (python-only parsing)."""
import glob, json, subprocess, sys

files = sorted(glob.glob('/root/.dsh/sessions/--root-kix-budget-e2e--/*/session.jsonl.zstd'))
if not files:
    print('no session file'); sys.exit(1)
f = files[-1]
raw = subprocess.run(['zstd', '-dc', f], capture_output=True).stdout.decode('utf-8', 'replace')
types = {}
ctxs = []
advisories = []
last_text = ''
for line in raw.split('\n'):
    if not line.strip():
        continue
    try:
        r = json.loads(line)
    except Exception:
        continue
    t = r.get('type')
    types[t] = types.get(t, 0) + 1
    d = r.get('data') or {}
    if t == 'assistant/message':
        u = d.get('usage') or {}
        if u:
            ctxs.append((u.get('inputTokens', 0), u.get('cacheReadTokens', 0), u.get('outputTokens', 0)))
        c = (d.get('message') or {}).get('content')
        if isinstance(c, list):
            last_text = '\n'.join(b.get('text', '') for b in c if isinstance(b, dict) and b.get('type') == 'text')
    if 'kix-budget' in line:
        for marker in ('主线程已连续', '上下文已达'):
            if marker in line:
                advisories.append(marker)
print(f'file: {f}')
print(f'types: {dict(sorted(types.items(), key=lambda x: -x[1]))}')
print(f'usage samples: {len(ctxs)}; ctx trajectory (in+cache): {[a+b for a,b,c in ctxs][-8:]}')
print(f'kix-budget advisories: {advisories}')
print(f'prune events: {types.get("compaction/prune", 0)}')
print(f'last assistant text (tail 300): {last_text[-300:]!r}')
