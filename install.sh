#!/usr/bin/env bash
# Kix Bundle — Installer (macOS / Linux)
#
# Usage:
#   ./install.sh                       # install to ~/.copilot (default)
#   ./install.sh /opt/copilot          # install to custom copilot home
#   ./install.sh --uninstall           # remove kix bundle
#   ./install.sh --dry-run             # preview without writing
#   ./install.sh --skip-memories       # skip user memory import
#
# What it does:
#   1. Detects COPILOT_HOME (default ~/.copilot)
#   2. Detects VS Code prompts folder
#   3. Detects VS Code memory folder
#   4. Copies every bundle skill containing SKILL.md -> $COPILOT_HOME/skills/
#   5. Copies the curated agent/instruction/prompt manifests
#   6. Copies curated user memories -> $VSCODE_MEMORY_DIR/ (unless --skip-memories)
#   7. Replaces placeholders in *.agent.md:
#        {{COPILOT_HOME}}  -> $COPILOT_HOME
#        {{HOOK_LAUNCHER}} -> bash
#        {{HOOK_EXT}}      -> sh
#   8. chmod +x all .sh hooks/scripts under skills/
#
# Idempotent: rerunning overwrites existing files.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUNDLE_ROOT="${SCRIPT_DIR}"

ACTION="install"
DRY_RUN=0
SKIP_MEMORIES=0
CUSTOM_TARGET=""

for arg in "$@"; do
  case "$arg" in
    --uninstall)     ACTION="uninstall" ;;
    --dry-run)       DRY_RUN=1 ;;
    --skip-memories) SKIP_MEMORIES=1 ;;
    -h|--help)
      grep '^#' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) CUSTOM_TARGET="$arg" ;;
  esac
done

# --- Defaults ---
if [ -n "$CUSTOM_TARGET" ]; then
  COPILOT_HOME="$CUSTOM_TARGET"
else
  COPILOT_HOME="${COPILOT_HOME:-$HOME/.copilot}"
fi

# VS Code User folders vary by platform
GSUFFIX="Code/User"
case "$(uname -s)" in
  Darwin) VSCODE_BASE="$HOME/Library/Application Support/$GSUFFIX" ;;
  *)      VSCODE_BASE="${XDG_CONFIG_HOME:-$HOME/.config}/$GSUFFIX" ;;
esac

VSCODE_PROMPTS_DEFAULT="${VSCODE_PROMPTS_DIR:-$VSCODE_BASE/prompts}"
VSCODE_MEMORY_DEFAULT="${VSCODE_MEMORY_DIR:-$VSCODE_BASE/globalStorage/github.copilot-chat/memory-tool/memories}"

# --- Output helpers ---
info() { printf '\033[36m[i]\033[0m %s\n' "$1"; }
ok()   { printf '\033[32m[v]\033[0m %s\n' "$1"; }
warn() { printf '\033[33m[!]\033[0m %s\n' "$1"; }
err()  { printf '\033[31m[x]\033[0m %s\n' "$1"; }

run() { if [ "$DRY_RUN" -eq 1 ]; then echo "    (dry-run) $*"; else "$@"; fi; }

# --- Asset policy ---
# Skills are convention-based: every directory containing SKILL.md is public.
SKILLS=()
for skill_file in "$BUNDLE_ROOT"/skills/*/SKILL.md; do
  [ -f "$skill_file" ] || continue
  SKILLS+=("$(basename "$(dirname "$skill_file")")")
done
if [ "${#SKILLS[@]}" -eq 0 ]; then err "No installable skills found under bundle skills/"; exit 1; fi
AGENTS=(kixparadigm kixpower-dev kixpower-orchestrator kixpower-producer kixpower-qa kixpower-reviewer)
INSTRUCTIONS=(kixparadigm-core)
PROMPTS=(kixpower kixpower-continue kixpower-import kixpower-new kixpower-review)
# Memories are deliberately curated: DSH capability data and legacy notes are not user-memory defaults.
MEMORIES=(ai-agent-practices vscode-copilot-customization ai-test-pruning)

# --- Uninstall ---
if [ "$ACTION" = "uninstall" ]; then
  info "Removing kix bundle from $COPILOT_HOME ..."
  for s in "${SKILLS[@]}"; do
    p="$COPILOT_HOME/skills/$s"
    [ -d "$p" ] && { run rm -rf "$p"; ok "Removed $p"; }
  done
  for a in "${AGENTS[@]}"; do
    p="$COPILOT_HOME/agents/$a.agent.md"
    [ -f "$p" ] && { run rm -f "$p"; ok "Removed $p"; }
  done
  for i in "${INSTRUCTIONS[@]}"; do
    p="$COPILOT_HOME/instructions/$i.instructions.md"
    [ -f "$p" ] && { run rm -f "$p"; ok "Removed $p"; }
  done
  if [ -d "$VSCODE_PROMPTS_DEFAULT" ]; then
    for p in "${PROMPTS[@]}"; do
      fp="$VSCODE_PROMPTS_DEFAULT/$p.prompt.md"
      [ -f "$fp" ] && { run rm -f "$fp"; ok "Removed $fp"; }
    done
  fi
  if [ "$SKIP_MEMORIES" -eq 0 ] && [ -d "$VSCODE_MEMORY_DEFAULT" ]; then
    for m in "${MEMORIES[@]}"; do
      fp="$VSCODE_MEMORY_DEFAULT/$m.md"
      [ -f "$fp" ] && { run rm -f "$fp"; ok "Removed $fp"; }
    done
  fi
  echo ""
  info "Uninstall complete."
  exit 0
fi

# --- Pre-flight ---
if [ ! -d "$BUNDLE_ROOT/skills/kixpower" ]; then
  err "Bundle root not found: $BUNDLE_ROOT/skills/kixpower"
  err "Run this script from inside the extracted kix-bundle directory."
  exit 1
fi

VSCODE_PROMPTS=""
if [ -d "$VSCODE_PROMPTS_DEFAULT" ]; then
  VSCODE_PROMPTS="$VSCODE_PROMPTS_DEFAULT"
else
  warn "VS Code prompts folder not found: $VSCODE_PROMPTS_DEFAULT"
fi

VSCODE_MEMORY=""
if [ "$SKIP_MEMORIES" -eq 0 ]; then
  VSCODE_MEMORY="$VSCODE_MEMORY_DEFAULT"
  [ -d "$VSCODE_MEMORY_DEFAULT" ] || warn "VS Code memory folder will be created: $VSCODE_MEMORY"
fi

if ! command -v git >/dev/null 2>&1; then
  warn "git not found (needed by kixpower blast-radius-check / fidelity-check)."
fi

# --- Confirm plan ---
echo ""
info "=== Install plan ==="
info "  Bundle source:    $BUNDLE_ROOT"
info "  Copilot home:     $COPILOT_HOME"
[ -n "$VSCODE_PROMPTS" ] && info "  VS Code prompts:  $VSCODE_PROMPTS" || info "  VS Code prompts:  SKIP (folder missing)"
[ -n "$VSCODE_MEMORY" ]  && info "  VS Code memory:   $VSCODE_MEMORY"  || info "  VS Code memory:   SKIP"
info "  Skills (${#SKILLS[@]}):       ${SKILLS[*]}"
info "  Agents (${#AGENTS[@]}):        ${AGENTS[*]}"
info "  Instructions (${#INSTRUCTIONS[@]}):  ${INSTRUCTIONS[*]}"
info "  Prompts (${#PROMPTS[@]}):       ${PROMPTS[*]}"
info "  Memories (${#MEMORIES[@]}):      ${MEMORIES[*]}"
info "  Hook launcher:    bash"
info "  Hook extension:   .sh"
[ "$DRY_RUN" -eq 1 ] && info "  Mode:             DRY-RUN (no writes)"
echo ""
read -r -p "Proceed? [y/N] " confirm
if [ "$confirm" != "y" ] && [ "$confirm" != "Y" ]; then info "Aborted."; exit 0; fi

# --- Execute ---
mkdir -p "$COPILOT_HOME/skills" "$COPILOT_HOME/agents" "$COPILOT_HOME/instructions"
[ -n "$VSCODE_PROMPTS" ] && mkdir -p "$VSCODE_PROMPTS"
[ -n "$VSCODE_MEMORY" ]  && mkdir -p "$VSCODE_MEMORY"

# 1. Skills
for s in "${SKILLS[@]}"; do
  src="$BUNDLE_ROOT/skills/$s"
  dst="$COPILOT_HOME/skills/$s"
  [ -d "$src" ] || { warn "skill source missing: $src"; continue; }
  run rm -rf "$dst"
  run cp -R "$src" "$dst"
  ok "skill -> $dst"
done

# 2. Agents
for a in "${AGENTS[@]}"; do
  src="$BUNDLE_ROOT/agents/$a.agent.md"
  dst="$COPILOT_HOME/agents/$a.agent.md"
  [ -f "$src" ] || { warn "agent source missing: $src"; continue; }
  run cp -f "$src" "$dst"
  ok "agent -> $dst"
done

# 3. Instructions
for i in "${INSTRUCTIONS[@]}"; do
  src="$BUNDLE_ROOT/instructions/$i.instructions.md"
  dst="$COPILOT_HOME/instructions/$i.instructions.md"
  [ -f "$src" ] || { warn "instruction source missing: $src"; continue; }
  run cp -f "$src" "$dst"
  ok "instruction -> $dst"
done

# 4. Prompts
if [ -n "$VSCODE_PROMPTS" ]; then
  for p in "${PROMPTS[@]}"; do
    src="$BUNDLE_ROOT/prompts/$p.prompt.md"
    dst="$VSCODE_PROMPTS/$p.prompt.md"
    [ -f "$src" ] || { warn "prompt source missing: $src"; continue; }
    run cp -f "$src" "$dst"
    ok "prompt -> $dst"
  done
else
  warn "Prompts skipped (VS Code prompts folder missing)."
fi

# 5. Memories
if [ -n "$VSCODE_MEMORY" ]; then
  for m in "${MEMORIES[@]}"; do
    src="$BUNDLE_ROOT/memories/$m.md"
    dst="$VSCODE_MEMORY/$m.md"
    [ -f "$src" ] || { warn "memory source missing: $src"; continue; }
    run cp -f "$src" "$dst"
    ok "memory -> $dst"
  done
else
  warn "Memories skipped."
fi

# 6. Replace placeholders in agent.md
for a in "${AGENTS[@]}"; do
  ap="$COPILOT_HOME/agents/$a.agent.md"
  [ -f "$ap" ] || continue
  if [ "$DRY_RUN" -eq 0 ]; then
    sed -i.bak \
      -e "s|{{COPILOT_HOME}}|$COPILOT_HOME|g" \
      -e "s|{{HOOK_LAUNCHER}}|bash|g" \
      -e "s|{{HOOK_EXT}}|sh|g" \
      "$ap"
    rm -f "$ap.bak"
  fi
done
ok "Replaced placeholders in agent.md files"

# 7. chmod +x hooks/scripts
if [ "$DRY_RUN" -eq 0 ]; then
  find "$COPILOT_HOME/skills" -type f -name '*.sh' -exec chmod +x {} \; 2>/dev/null || true
  ok "chmod +x on .sh hooks/scripts"
fi

echo ""
info "=== Install complete ==="
echo "Next steps:"
echo "  1. Reload VS Code window (Command Palette -> 'Developer: Reload Window')"
echo "  2. kixparadigm: auto-active every session (core instructions)."
echo "  3. kixpower: in Copilot Chat type /kixpower-new or /kixpower-import"
echo "  4. Memories load on next Copilot Chat session"
echo ""
echo "To uninstall: ./install.sh --uninstall"
