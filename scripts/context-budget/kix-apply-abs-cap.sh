#!/bin/bash
# kix-apply-abs-cap.sh — switch the agent presets from the ratio encoding to the
# patched absolute caps, then restart the dsh web service exactly once.
#
# Why the restart is mandatory: dsh-compaction-basic may be patched on disk
# (maxThresholdTokens / maxRetainTokens), but a RUNNING process started before the
# patch still holds the unpatched module in memory, where an unknown config key
# aborts the mount. The config may therefore only be switched together with the
# restart — never before it.
#
# Every companion file is resolved as a SIBLING of this script, so the same bytes
# work from a checkout (scripts/context-budget/) and from a flat deployment dir.
#
# Environment overrides:
#   DSH_COMPACTION_PKG   node_modules/@deepseek-ai/dsh-compaction-basic
#   DSH_PRESET_ROOT      default $HOME/.dsh/.agent-presets
#   DSH_SESSIONS_DIR     default $HOME/.dsh/sessions
#   DSH_PRESETS          space-separated preset ids
#   DSH_WEB_SERVICE      systemd unit, default dsh-web
#   DSH_WEB_PORT         default 33236
#   KIX_CAP_LOG          default $HOME/kix-apply-cap.log
#
# Modes:
#   (no args)    dry run: patch state, drop-in state, target config resolves on the
#                patched module, what would change. Nothing is written.
#   --self-test  run the real transform on temporary COPIES and verify them.
#   --dropin     install/refresh the systemd drop-in that re-applies the patch on
#                every start (idempotent; takes effect at the next start).
#   --restart    schedule a transient systemd unit that waits for the launching
#                session to go quiet, backs up, writes, verifies, restarts the
#                service, checks it, and rolls back on any failure.
set -u

SELF_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SELF="$SELF_DIR/$(basename "${BASH_SOURCE[0]}")"
TRANSFORM="$SELF_DIR/kix-apply-abs-cap.py"
VERIFY="$SELF_DIR/kix-apply-abs-cap.verify.mjs"
PATCHER="$SELF_DIR/kix-compaction-cap-patch.mjs"
# systemd transient units and some harness shells start without HOME; resolve it
# explicitly so `set -u` cannot abort on the default expression.
HOME_DIR=${HOME:-$(getent passwd "$(id -u)" 2>/dev/null | cut -d: -f6)}
HOME_DIR=${HOME_DIR:-/root}
LOG=${KIX_CAP_LOG:-$HOME_DIR/kix-apply-cap.log}
BASE=${DSH_PRESET_ROOT:-$HOME_DIR/.dsh/.agent-presets}
SESSIONS=${DSH_SESSIONS_DIR:-$HOME_DIR/.dsh/sessions}
PRESETS=${DSH_PRESETS:-"kixparadigm kixparadigm-classic kixparadigm-classic-en kixparadigm-null"}
SERVICE=${DSH_WEB_SERVICE:-dsh-web}
PORT=${DSH_WEB_PORT:-33236}
NODE=$(command -v node)
DROPIN="/etc/systemd/system/$SERVICE.service.d/kix-cap-patch.conf"
STAMP=$(date +%Y%m%d-%H%M%S)

install_dropin() {
  mkdir -p "$(dirname "$DROPIN")" || return 1
  cat > "$DROPIN" <<EOF
# kix: keep dsh-compaction-basic patched across restarts and dsh upgrades.
# The leading '-' means a failed patch can never block the service from starting.
[Service]
ExecStartPre=-$NODE $PATCHER --apply
EOF
  systemctl daemon-reload
  systemctl show "$SERVICE" -p ExecStartPre --no-pager | grep -q "kix-compaction-cap-patch"
}

if [ "${1:-}" = "" ]; then
  echo "== dry run — nothing is written =="
  echo
  echo "-- 1. patch state on disk --"
  if node "$PATCHER" --check; then
    echo "   patched"
  else
    echo "   UNPATCHED — --restart would first run: node $PATCHER --apply"
  fi
  echo
  echo "-- 2. does the target config resolve on the patched module? --"
  node "$PATCHER" --check >/dev/null 2>&1 || node "$PATCHER" --apply >/dev/null
  node "$VERIFY" --block || { echo "   ABORT: target config does not resolve"; exit 1; }
  echo
  echo "-- 3. presets that would be rewritten (backups made first) --"
  for p in $PRESETS; do
    printf '   %-24s %s\n' "$p" "$BASE/$p/agent.cordis.yml"
  done
  echo
  echo "-- 4. patch self-heal on every future start --"
  if systemctl show "$SERVICE" -p ExecStartPre --no-pager 2>/dev/null | grep -q "kix-compaction-cap-patch"; then
    echo "   installed ($DROPIN): the patch is re-applied at each start,"
    echo "   so a dsh upgrade cannot silently leave the module unpatched."
  else
    echo "   MISSING — run: $SELF --dropin"
    echo "   otherwise the next dsh upgrade replaces node_modules and the absolute-cap"
    echo "   config would abort the mount for new sessions."
  fi
  echo
  echo "next:  $SELF --self-test     # prove the transform on copies"
  echo "       $SELF --dropin        # install the self-healing drop-in"
  echo "       $SELF --restart       # do it for real (ends the launching session)"
  exit 0
fi

if [ "${1:-}" = "--dropin" ]; then
  if install_dropin; then
    echo "OK drop-in installed: $DROPIN"
    systemctl show "$SERVICE" -p ExecStartPre --no-pager
  else
    echo "FAILED to install $DROPIN"; exit 1
  fi
  exit 0
fi

if [ "${1:-}" = "--self-test" ]; then
  TMP=$(mktemp -d)
  echo "== self-test on copies in $TMP =="
  fail=0
  for p in $PRESETS; do
    cp "$BASE/$p/agent.cordis.yml" "$TMP/$p.yml" || { echo "   no preset $p under $BASE"; fail=1; continue; }
    python3 "$TRANSFORM" "$TMP/$p.yml" || fail=1
  done
  [ "$fail" = 0 ] || { echo "   transform failed"; rm -rf "$TMP"; exit 1; }
  python3 - "$TMP" "$SELF_DIR" "$BASE" <<'SELFTEST' || fail=1
import sys, os, yaml
tmp, self_dir, base = sys.argv[1], sys.argv[2], sys.argv[3]
presets = os.environ.get("DSH_PRESETS", "kixparadigm kixparadigm-classic kixparadigm-classic-en kixparadigm-null").split()
START, ANCHOR = "    - id: compaction-basic\n", "\n\n    - id:"
WANT = {"thresholdRatio": 0.8, "maxThresholdTokens": 200000, "retainRatio": 0.044,
        "maxRetainTokens": 64000, "modelPolicies": []}
for p in presets:
    src = os.path.join(base, p, "agent.cordis.yml")
    dst = os.path.join(tmp, p + ".yml")
    if not os.path.exists(src):
        print("   MISSING preset " + src); sys.exit(1)
    before, after = open(src).read(), open(dst).read()
    for name, text in (("before", before), ("after", after)):
        if text.count(START) != 1:
            print("   " + p + ": " + name + " has " + str(text.count(START)) + " compaction entries"); sys.exit(1)
    bs = before.index(START); be = before.index(ANCHOR, bs)
    as_ = after.index(START); ae = after.index(ANCHOR, as_)
    if before[:bs] != after[:as_] or before[be:] != after[ae:]:
        print("   " + p + ": transform changed content OUTSIDE the compaction entry"); sys.exit(1)
    name = "kix-apply-abs-cap.en.block" if p.endswith("-en") else "kix-apply-abs-cap.block"
    want = yaml.safe_load(open(os.path.join(self_dir, name)).read())[0]["config"]
    got = yaml.safe_load(after[as_:ae])[0]["config"]
    if got != want or got != WANT:
        print("   " + p + ": mismatch\n     want " + str(want) + "\n     got  " + str(got)); sys.exit(1)
    print("   OK " + p + ": entry replaced, " + str(len(before[:bs])) + "B head + " +
          str(len(before[be:])) + "B tail untouched, values match " + name)
SELFTEST

  [ "$fail" = 0 ] && echo "== self-test passed: the same transform is safe to apply for real =="
  exit "$fail"
fi

if [ "${1:-}" = "--worker" ]; then
  SESSION_LOG="${2:-}"
  exec > "$LOG" 2>&1
  set -x
  echo "=== kix-apply-abs-cap worker start: $(date '+%F %T') ==="

  if [ -n "$SESSION_LOG" ] && [ -e "$SESSION_LOG" ]; then
    echo "--- grace: wait for the launching session to stop growing ---"
    prev=-1; stable=0; waited=0
    while [ "$stable" -lt 3 ] && [ "$waited" -lt 600 ]; do
      sleep 10; waited=$((waited + 10))
      cur=$(stat -c %s "$SESSION_LOG" 2>/dev/null || echo 0)
      if [ "$cur" = "$prev" ]; then stable=$((stable + 1)); else stable=0; fi
      prev=$cur
    done
    echo "--- session quiet after ${waited}s ---"
  fi

  echo "--- patch check (re-apply if a dsh upgrade replaced node_modules) ---"
  node "$PATCHER" --check || node "$PATCHER" --apply || exit 1

  echo "--- backup ---"
  for p in $PRESETS; do
    cp "$BASE/$p/agent.cordis.yml" "$BASE/$p/agent.cordis.yml.bak-abscap-$STAMP" || exit 1
  done

  echo "--- write new config ---"
  for p in $PRESETS; do
    python3 "$TRANSFORM" "$BASE/$p/agent.cordis.yml" || exit 1
  done

  echo "--- verify written presets before restarting ---"
  if ! node "$VERIFY"; then
    echo "VERIFY FAILED -> rolling back config, not restarting"
    for p in $PRESETS; do cp "$BASE/$p/agent.cordis.yml.bak-abscap-$STAMP" "$BASE/$p/agent.cordis.yml"; done
    exit 1
  fi

  echo "--- restart $SERVICE ---"
  systemctl restart "$SERVICE"
  sleep 12

  if systemctl is-active --quiet "$SERVICE" && ss -ltn | grep -q ":$PORT"; then
    echo "--- post-restart journal scan ---"
    if journalctl -u "$SERVICE" --since "-2min" --no-pager | grep -iE "unknown key|did not activate|refusing to mount"; then
      echo "MOUNT ERROR DETECTED -> rolling back config and restarting again"
      for p in $PRESETS; do cp "$BASE/$p/agent.cordis.yml.bak-abscap-$STAMP" "$BASE/$p/agent.cordis.yml"; done
      systemctl restart "$SERVICE"
      exit 1
    fi
    echo "=== SUCCESS: absolute caps active, $SERVICE restarted ==="
  else
    echo "SERVICE NOT HEALTHY -> rolling back config"
    for p in $PRESETS; do cp "$BASE/$p/agent.cordis.yml.bak-abscap-$STAMP" "$BASE/$p/agent.cordis.yml"; done
    systemctl restart "$SERVICE"
    exit 1
  fi
  exit 0
fi

if [ "${1:-}" = "--restart" ]; then
  node "$PATCHER" --check >/dev/null || node "$PATCHER" --apply || exit 1
  node "$VERIFY" --block || { echo "target config does not resolve - aborting"; exit 1; }
  install_dropin || echo "WARN: could not install the drop-in (continuing)"
  : > "$LOG"
  SESSION_LOG=""
  if [ -d "$SESSIONS" ]; then
    newest=$(ls -dt "$SESSIONS"/*/session-*/ 2>/dev/null | head -1)
    [ -n "$newest" ] && SESSION_LOG="${newest%/}/session.v3.jsonl.zstd"
  fi
  echo "scheduled: transient unit waits for the launching session to go quiet,"
  echo "then rewrites the presets, verifies, and restarts $SERVICE."
  echo "progress:  tail -f $LOG"
  systemd-run --unit="kix-apply-cap-$STAMP" --collect --quiet \
    --setenv=HOME="$HOME_DIR" \
    --setenv=DSH_PRESET_ROOT="$BASE" \
    --setenv=KIX_CAP_LOG="$LOG" \
    --setenv=DSH_WEB_SERVICE="$SERVICE" \
    --setenv=DSH_WEB_PORT="$PORT" \
    ${DSH_COMPACTION_PKG:+--setenv=DSH_COMPACTION_PKG="$DSH_COMPACTION_PKG"} \
    "$SELF" --worker "$SESSION_LOG"
  exit 0
fi

echo "unknown mode: $1"; exit 2
