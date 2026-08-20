#!/usr/bin/env bash
# Check every installed agent preset for loader-entry plugin files referenced
# in agent.cordis.yml but missing on disk (the ⑩-class failure mode: preset
# rows pointing at plugin files that were never installed / got pruned).
# Scope: install plane only — reads ${DSH_HOME:-$HOME/.dsh}/.agent-presets.
set -u
base="${DSH_HOME:-$HOME/.dsh}/.agent-presets"
fail=0
for dir in "$base"/*/; do
  name=$(basename "$dir")
  yml="$dir/agent.cordis.yml"
  [ -f "$yml" ] || continue
  refs=$(grep -o '\./plugins/[a-zA-Z0-9._-]*\.js' "$yml" | sort -u)
  for ref in $refs; do
    f="$dir$ref"
    if [ ! -f "$f" ]; then
      echo "MISSING  $name :: $ref"
      fail=1
    fi
  done
done
[ "$fail" = 0 ] && echo "ALL PRESETS OK"
exit "$fail"
