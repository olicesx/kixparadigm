#!/usr/bin/env bash
# verify-gate-clear-e2e.sh - structured transition/result pairing proof.
set -euo pipefail
if [ "$#" -ne 1 ]; then echo 'usage: verify-gate-clear-e2e.sh /path/session.jsonl.zstd' >&2; exit 2; fi
LEDGER="$1"
TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT
zstd -dc "$LEDGER" > "$TMP"
RESULT=$(awk '
function value(s, key, t) {
  t = s
  sub(".*\"" key "\":\"", "", t)
  sub("\".*", "", t)
  return t
}
/"type":"tool\/result"/ && /kix-budget gate:/ && /"isError":true/ { gate++ ; seen_gate=1 }
/"type":"tool\/result"/ && /必须先完成可回放|下一步只能调用/ { deny++ }
/"type":"tool\/result"/ && /"plugin":"kix-budget"/ && /"form":"gate"/ { source++ }
/"type":"tool\/call"/ {
  id = value($0, "callId")
  if ($0 ~ /"name":"kix_capability_call"/ && $0 ~ /subagent_lite|create_goal/) transition[id]=1
  else if ($0 ~ /"name":"subagent_lite"|"name":"create_goal"/) transition[id]=1
  if (armed && $0 ~ /"name":"read"/) { read_call[id]=1; read_after++ }
}
/"type":"tool\/result"/ {
  id = value($0, "callId")
  if (transition[id] && seen_gate && $0 !~ /"isError":true/ && $0 !~ /"ok":false/ && ($0 ~ /"ok":true/ || $0 ~ /"isError":false/)) { armed=1; success++ }
  if (read_call[id] && $0 ~ /"isError":true/) read_error++
}
END { printf "%d %d %d %d %d %d\n", gate+0, source+0, deny+0, success+0, read_after+0, read_error+0 }
' "$TMP")
read -r GATE SOURCE DENY SUCCESS READ_AFTER READ_ERROR <<< "$RESULT"
printf 'gate_errors=%s gate_sources=%s deny_reasons=%s successful_transitions=%s read_after_transition=%s read_error_after=%s\n' "$GATE" "$SOURCE" "$DENY" "$SUCCESS" "$READ_AFTER" "$READ_ERROR"
if [ "$GATE" -gt 0 ] && [ "$DENY" -gt 0 ] && [ "$SUCCESS" -gt 0 ] && [ "$READ_AFTER" -gt 0 ] && [ "$READ_ERROR" -eq 0 ]; then
  echo 'GATE-CLEAR-E2E-ACCEPT'
else
  echo 'GATE-CLEAR-E2E-REJECT'
  exit 1
fi
