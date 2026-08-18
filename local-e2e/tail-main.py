#!/usr/bin/env python3
"""Tail the newest main session in kix-budget-e2e: last assistant text + tool calls."""
import glob, json, subprocess

files = sorted(glob.glob('/root/.dsh/sessions/--root-kix-budget-e2e--/session-*/session.jsonl.zstd'))
f = files[-1]
raw = subprocess.run(['zstd', '-dc', f], capture_output=True).stdout.decode('utf-8', 'replace')
calls = []
last_text = ''
turns = 0
for line in raw.split('\n'):
    if not line.strip():
        continue
    try:
        r = json.loads(line)
    except Exception:
        continue
    t = r.get('type')
    d = r.get('data') or {}
    if t == 'turn/end':
        turns += 1
    elif t == 'tool/call':
        calls.append((d.get('turn'), d.get('step'), d.get('name')))
    elif t == 'assistant/message':
        c = (d.get('message') or {}).get('content')
        if isinstance(c, list):
            txt = '\n'.join(b.get('text', '') for b in c if isinstance(b, dict) and b.get('type') == 'text')
            if txt.strip():
                last_text = txt
print(f'file: {f}')
print(f'turns={turns} total_calls={len(calls)}')
print('last 12 calls:', calls[-12:])
print('--- last assistant text (tail 1200) ---')
print(last_text[-1200:])
