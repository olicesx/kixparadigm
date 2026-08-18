#!/usr/bin/env bash
# Build a source-fingerprint workspace for P5 live E2E (kix-consistency + plan gate).
set -euo pipefail
export HOME=/root
WS=/root/kix-p5-e2e
rm -rf "$WS"
mkdir -p "$WS/dsh/preset/plugins" "$WS/en/preset/plugins" "$WS/scripts" \
  "$WS/dsh/preset/memories" "$WS/en/preset/memories" "$WS/docs/sprint-1"

# Fingerprint trio
printf '%s\n' 'text: |-' '      x' > "$WS/dsh/preset/agent.cordis.yml"
printf '%s\n' 'text: |-' '      x' > "$WS/en/preset/agent.cordis.yml"
printf '%s\n' '#!/usr/bin/env node' > "$WS/scripts/check-dsh-consistency.cjs"

# Minimal plugin pair (identical so first write of a NEW file will drift)
printf '%s\n' "'use strict'" "module.exports = { name: 'fixture' }" > "$WS/dsh/preset/plugins/kix-fixture.js"
cp "$WS/dsh/preset/plugins/kix-fixture.js" "$WS/en/preset/plugins/kix-fixture.js"

# Memories count 4 (so memories writes don't false-fail count unless we add)
for i in 1 2 3 4; do echo "# m$i" > "$WS/dsh/preset/memories/m$i.md"; done
for i in 1 2 3 4; do echo "# m$i" > "$WS/en/preset/memories/m$i.md"; done

echo '+ 4 记忆' > "$WS/README.md"
echo '+ 4 memories' > "$WS/README.en.md"
printf '%s\n' '{"version":"1.2.19"}' > "$WS/package.json"
printf '%s\n' '{"version":"1.2.19"}' > "$WS/en/package.json"

# Sprint marker for orchestration handoff tests (optional)
echo 1 > "$WS/docs/.kixpower-current-sprint"
# Intentionally NO plan.md / progress.md yet — write tests create them

echo "FIXTURE=$WS"
find "$WS" -type f | sort
