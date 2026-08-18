#!/bin/bash
# Wait for the live E2E session to finish (turn/end appears), then run the verifier.
set -u
F=$(ls -t /root/.dsh/sessions/--root-kix-budget-e2e--/*/session.jsonl.zstd | head -1)
for i in $(seq 1 60); do
  sleep 30
  N=$(zstd -dc "$F" 2>/dev/null | grep -c '"turn/end"' || true)
  echo "poll $i: turn/end=$N ($(date +%H:%M:%S))"
  if [ "$N" -gt 0 ]; then
    echo "== turn ended, running verifier =="
    node /mnt/c/Users/37112/Desktop/kix-bundle/local-e2e/verify-budget-e2e.cjs 8
    exit $?
  fi
done
echo "TIMEOUT waiting for turn end"
exit 2
