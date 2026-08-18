#!/usr/bin/env python3
"""Extract the decisive moments from the accepted live E2E session."""
import glob, json, subprocess

f = sorted(glob.glob('/root/.dsh/sessions/--root-kix-budget-e2e--/*/session.jsonl.zstd'))[-1]
raw = subprocess.run(['zstd', '-dc', f], capture_output=True).stdout.decode('utf-8', 'replace')
step = 0
prunes = []
for line in raw.split('\n'):
    if not line.strip():
        continue
    try:
        r = json.loads(line)
    except Exception:
        continue
    t = r.get('type')
    d = r.get('data') or {}
    if t == 'step/end':
        step += 1
    elif t == 'assistant/message' and d.get('usage'):
        u = d['usage']
        ctx = u.get('inputTokens', 0) + u.get('cacheReadTokens', 0)
        if step % 3 == 0 or step in (1, 2):
            print(f"step {step:>2}: ctx={ctx:>7,} (in={u.get('inputTokens',0):>6,} cache={u.get('cacheReadTokens',0):>7,} out={u.get('outputTokens',0):>5,})")
    elif t == 'compaction/prune':
        prunes.append((step, r.get('seq')))
    elif 'kix-budget' in line and t in ('user/message', 'tool/result'):
        for mk in ('主线程已连续', '上下文已达'):
            if mk in line:
                print(f">>> ADVISORY at step {step}: kix-budget ... {mk}")
print(f"\nprune events: {len(prunes)} at steps {[p[0] for p in prunes]}")
