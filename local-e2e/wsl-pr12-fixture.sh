#!/usr/bin/env bash
# PR#12 live E2E fixture: FOREIGN-layout multi-preset workspace (no contract script).
# Tests the universal layer only: identity sets + parity hint + shell channel.
set -euo pipefail
export HOME=/root
WS=/root/kix-e2e-pr12
rm -rf "$WS"
mkdir -p "$WS/pkgs/zh/plugins" "$WS/pkgs/en/plugins" "$WS/pkgs/zh/skills" "$WS/src"

# Double-marker preset roots (custom layout — NOT dsh/en names)
for r in pkgs/zh pkgs/en; do
  printf '%s\n' 'text: |-' '      x' > "$WS/$r/agent.cordis.yml"
  printf '%s\n' 'id: probe' > "$WS/$r/preset.yml"
done

# Identical plugin pair: a NEW plugin file on one side = drift
printf '%s\n' "'use strict'" "module.exports = { name: 'pair' }" > "$WS/pkgs/zh/plugins/pair.js"
cp "$WS/pkgs/zh/plugins/pair.js" "$WS/pkgs/en/plugins/pair.js"

# A skills file (translation-relation zone → parity hint on write)
printf '%s\n' '# probe skill' > "$WS/pkgs/zh/skills/existing.md"

# Plain source outside preset roots (must stay zero-overhead)
printf '%s\n' 'console.log(1)' > "$WS/src/main.js"

# NO scripts/check-dsh-consistency.cjs → contract layer must stay OFF

echo "FIXTURE=$WS"
find "$WS" -type f | sort
