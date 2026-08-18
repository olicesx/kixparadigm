#!/usr/bin/env bash
# Sync current Windows kix-bundle preset trees into WSL2 DSH installs.
set -euo pipefail
export HOME=/root
SRC=$(cd "$(dirname "$0")/.." && pwd)
ZH=/root/.dsh/.agent-presets/kixparadigm
EN=/root/.dsh/.agent-presets/kixparadigm-en

echo "== dry-run ZH =="
rsync -rcn --out-format='%i %n' "$SRC/dsh/preset/" "$ZH/" | grep -v '^\.' | head -100 || true
echo "== dry-run EN =="
rsync -rcn --out-format='%i %n' "$SRC/en/preset/" "$EN/" | grep -v '^\.' | head -100 || true

echo "== sync ZH =="
rsync -a "$SRC/dsh/preset/" "$ZH/"
echo "== sync EN =="
rsync -a "$SRC/en/preset/" "$EN/"

echo "== verify =="
ls -l "$ZH/plugins/kix-consistency.js" "$ZH/plugins/consistency-lib.cjs" "$EN/plugins/kix-consistency.js"
grep -n 'id: kix-consistency' "$ZH/agent.cordis.yml" "$EN/agent.cordis.yml"
sha256sum "$ZH/plugins/kix-consistency.js" "$EN/plugins/kix-consistency.js"
sha256sum "$ZH/plugins/kix-consistency.test.js" "$EN/plugins/kix-consistency.test.js"
echo SYNC-OK
