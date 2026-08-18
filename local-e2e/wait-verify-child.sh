#!/bin/bash
# Wait for the v5.10 child E2E: newest child session appears + turn ends, then verify.
set -u
ROOT=/root/.dsh/sessions/--root-kix-budget-e2e--
# 1) wait for a child session newer than the marker file
for i in $(seq 1 40); do
  sleep 20
  NEWEST=$(ls -t $ROOT/*/session.jsonl.zstd 2>/dev/null | head -1)
  SID=$(basename $(dirname "$NEWEST"))
  if [ "${SID#session-}" != "$SID" ]; then
    # newest is a main session; check whether any bare-uuid child exists newer than marker
    C=$(find $ROOT -maxdepth 1 -type d -name '*-*-*-*' -newer /root/kix-budget-e2e/big01.txt 2>/dev/null | head -1)
    [ -z "$C" ] && { echo "poll $i: no child yet"; continue; }
    NEWEST="$C/session.jsonl.zstd"
    SID=$(basename "$C")
  fi
  echo "poll $i: child=$SID"
  # 2) wait for its turn to end (report settles)
  for j in $(seq 1 40); do
    sleep 20
    N=$(zstd -dc "$NEWEST" 2>/dev/null | grep -c '"turn/end"' || true)
    R=$(zstd -dc "$NEWEST" 2>/dev/null | grep -c '"tool/call"' || true)
    echo "  inner $j: turn/end=$N toolcalls=$R"
    if [ "$N" -ge 1 ]; then
      echo "== child turn ended, running verifier =="
      node "$(dirname "$0")/verify-child-e2e.cjs" 8
      exit $?
    fi
  done
done
echo TIMEOUT
exit 2
