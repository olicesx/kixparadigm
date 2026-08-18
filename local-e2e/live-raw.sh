#!/bin/bash
set -u
echo "lines: $(wc -l < /tmp/live-e2e.jsonl)"
grep -o '"type": "[a-z/-]*"' /tmp/live-e2e.jsonl | sort | uniq -c | sort -rn | head -14
ls -la /root/.dsh/sessions/--root-kix-budget-e2e--/*/
