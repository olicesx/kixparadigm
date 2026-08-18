#!/usr/bin/env bash
set -euo pipefail
SOURCE_ROOT=/mnt/c/Users/37112/Desktop/kix-bundle
GLOBAL_ROOT=$(npm root -g)
EXPECTED_ZH=$(node -p "require('$SOURCE_ROOT/package.json').version")
EXPECTED_EN=$(node -p "require('$SOURCE_ROOT/en/package.json').version")
ACTUAL_ZH=$(node -p "require('$GLOBAL_ROOT/kixparadigm/package.json').version")
ACTUAL_EN=$(node -p "require('$GLOBAL_ROOT/kixparadigm-en/package.json').version")
echo "version source=$EXPECTED_ZH/$EXPECTED_EN global=$ACTUAL_ZH/$ACTUAL_EN"
[ "$ACTUAL_ZH" = "$EXPECTED_ZH" ] && [ "$ACTUAL_EN" = "$EXPECTED_EN" ]
echo 'PASS global package versions'
for t in kix-guards kix-commands kix-cost kix-route kix-discipline kix-orchestration kix-focus kix-consistency kix-budget; do
  for c in kixparadigm kixparadigm-en; do
    node "$HOME/.dsh/.agent-presets/$c/plugins/$t.test.js" >/dev/null
    echo "PASS installed/$c/$t"
  done
done
for t in kix-budget kix-focus; do
  for pair in "kixparadigm:$SOURCE_ROOT/dsh" "kixparadigm-en:$SOURCE_ROOT/en"; do
    c=${pair%%:*}; base=${pair##*:}
    cmp -s "$base/preset/plugins/$t.js" "$HOME/.dsh/.agent-presets/$c/plugins/$t.js"
    echo "PASS installed/source parity $c/$t"
  done
done
for f in verify-budget-e2e.cjs verify-child-e2e.cjs verify-focus-e2e.cjs replay-budget-check.cjs; do
  node --check "$SOURCE_ROOT/local-e2e/$f"
  echo "PASS verifier syntax $f"
done
echo 'DEPLOY-CHECK-ACCEPT'