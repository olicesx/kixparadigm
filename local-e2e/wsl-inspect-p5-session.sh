#!/usr/bin/env bash
set -euo pipefail
export HOME=/root
echo '=== session trees ==='
ls -lt /root/.dsh/sessions | head -8
echo
echo '=== p5 sessions ==='
find /root/.dsh/sessions/--root-kix-p5-e2e-- -maxdepth 2 -type d | head -20
echo
LATEST=$(ls -1dt /root/.dsh/sessions/--root-kix-p5-e2e--/*/ 2>/dev/null | head -1 || true)
echo "LATEST=$LATEST"
if [ -n "${LATEST:-}" ]; then
  ls -la "$LATEST" | head
  echo '=== header/cwd grep ==='
  rg -n "\"cwd\"|workspaceRoot|kix-p5-e2e" "$LATEST" --glob '*.json' --max-count 40 || true
  echo '=== files ==='
  find "$LATEST" -maxdepth 2 -type f | head -40
fi
echo
echo '=== fixture drift ==='
echo '--- zh ---'
cat /root/kix-p5-e2e/dsh/preset/plugins/kix-fixture.js
echo '--- en ---'
cat /root/kix-p5-e2e/en/preset/plugins/kix-fixture.js
