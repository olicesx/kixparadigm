#!/bin/bash
# live progress check for the budget E2E session
set -u
DIR=/root/.dsh/sessions/--root-kix-budget-e2e--
F=$(ls -t $DIR/*/session.jsonl.zstd 2>/dev/null | head -1)
if [ -z "$F" ]; then echo "no session file yet"; exit 1; fi
echo "FILE=$F"
zstd -dc "$F" > /tmp/live-e2e.jsonl
echo "steps: $(grep -c '"type": "step/end"' /tmp/live-e2e.jsonl)"
echo "turns ended: $(grep -c '"type": "turn/end"' /tmp/live-e2e.jsonl)"
echo "kix-budget advisories:"
grep -o 'kix-budget: [^"]\{0,80\}' /tmp/live-e2e.jsonl | sort | uniq -c | head -10
echo "prune events: $(grep -c 'compaction/prune' /tmp/live-e2e.jsonl)"
echo "last ctx (input+cache of last assistant message):"
python3 - <<'PY'
import json
last = None
for line in open('/tmp/live-e2e.jsonl', encoding='utf-8', errors='replace'):
    if '"assistant/message"' not in line: continue
    try: r = json.loads(line)
    except: continue
    u = (r.get('data') or {}).get('usage') or {}
    if u: last = (u.get('inputTokens',0), u.get('cacheReadTokens',0), u.get('outputTokens',0))
print(last)
PY
