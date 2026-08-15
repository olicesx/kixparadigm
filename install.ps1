# Kix Bundle — Installer (Windows / PowerShell)
#
# Usage:
#   ./install.ps1                    # install to $HOME\.copilot (default)
#   ./install.ps1 -Target C:\opt\copilot
#   ./install.ps1 -Uninstall
#   ./install.ps1 -DryRun
#   ./install.ps1 -SkipMemories      # skip user memory import
#
# What it does:
#   1. Detects COPILOT_HOME (default $HOME\.copilot)
#   2. Detects VS Code prompts folder ($env:APPDATA\Code\User\prompts)
#   3. Detects VS Code memory folder ($env:APPDATA\Code\User\globalStorage\github.copilot-chat\memory-tool\memories)
#   4. Copies bundle\skills\*    -> $COPILOT_HOME\skills\
#   5. Copies bundle\agents\*    -> $COPILOT_HOME\agents\
#   6. Copies bundle\instructions\* -> $COPILOT_HOME\instructions\
#   7. Copies bundle\prompts\*   -> $VSCODE_PROMPTS_DIR\
#   8. Copies bundle\memories\*  -> $VSCODE_MEMORY_DIR\  (unless -SkipMemories)
#   9. Replaces placeholders in *.agent.md:
#        {{COPILOT_HOME}}  -> $COPILOT_HOME (forward slashes)
#        {{HOOK_LAUNCHER}} -> pwsh -NoProfile -File
#        {{HOOK_EXT}}      -> ps1
#
# Idempotent: rerunning overwrites existing files.

[CmdletBinding()]
param(
    [string]$Target,
    [switch]$Uninstall,
    [switch]$DryRun,
    [switch]$SkipMemories
)

$ErrorActionPreference = 'Stop'

# --- Resolve bundle root (parent of this script) ---
$BundleRoot = Split-Path -Parent $MyInvocation.MyCommand.Path

# --- Defaults ---
if ($Target) {
    $CopilotHome = $Target
} else {
    $CopilotHome = if ($env:COPILOT_HOME) { $env:COPILOT_HOME } else { Join-Path $HOME '.copilot' }
}

$VscodePromptsDefault  = Join-Path $env:APPDATA 'Code\User\prompts'
$VscodeMemoryDefault   = Join-Path $env:APPDATA 'Code\User\globalStorage\github.copilot-chat\memory-tool\memories'

# --- Output helpers ---
function Show-Info([string]$msg) { Write-Host "[i] $msg" -ForegroundColor Cyan }
function Show-OK([string]$msg)   { Write-Host "[v] $msg" -ForegroundColor Green }
function Show-Warn([string]$msg) { Write-Host "[!] $msg" -ForegroundColor Yellow }
function Show-Err([string]$msg)  { Write-Host "[x] $msg" -ForegroundColor Red }

# --- Asset manifest (for uninstall + plan display) ---
$Skills = @('kixparadigm', 'kixpower', 'handoff', 'write-a-skill', 'improve-codebase-architecture')
$Agents = @('kixparadigm', 'kixpower-dev', 'kixpower-orchestrator', 'kixpower-producer', 'kixpower-qa', 'kixpower-reviewer')
$Instructions = @('kixparadigm-core')
$Prompts = @('kixpower', 'kixpower-continue', 'kixpower-import', 'kixpower-new', 'kixpower-review')
$Memories = @('ai-agent-practices', 'vscode-copilot-customization', 'ai-test-pruning')

# --- Uninstall ---
if ($Uninstall) {
    Show-Info "Removing kix bundle from $CopilotHome ..."
    foreach ($s in $Skills) {
        $p = Join-Path $CopilotHome "skills\$s"
        if (Test-Path $p) { if (-not $DryRun) { Remove-Item -Recurse -Force $p }; Show-OK "Removed $p" }
    }
    foreach ($a in $Agents) {
        $p = Join-Path $CopilotHome "agents\$a.agent.md"
        if (Test-Path $p) { if (-not $DryRun) { Remove-Item -Force $p }; Show-OK "Removed $p" }
    }
    foreach ($i in $Instructions) {
        $p = Join-Path $CopilotHome "instructions\$i.instructions.md"
        if (Test-Path $p) { if (-not $DryRun) { Remove-Item -Force $p }; Show-OK "Removed $p" }
    }
    if (Test-Path $VscodePromptsDefault) {
        foreach ($p in $Prompts) {
            $fp = Join-Path $VscodePromptsDefault "$p.prompt.md"
            if (Test-Path $fp) { if (-not $DryRun) { Remove-Item -Force $fp }; Show-OK "Removed $fp" }
        }
    }
    if (-not $SkipMemories -and (Test-Path $VscodeMemoryDefault)) {
        foreach ($m in $Memories) {
            $fp = Join-Path $VscodeMemoryDefault "$m.md"
            if (Test-Path $fp) { if (-not $DryRun) { Remove-Item -Force $fp }; Show-OK "Removed $fp" }
        }
    }
    Write-Host ''
    Show-Info 'Uninstall complete.'
    exit 0
}

# --- Pre-flight ---
if (-not (Test-Path (Join-Path $BundleRoot 'skills\kixpower'))) {
    Show-Err "Bundle root not found: $BundleRoot\skills\kixpower"
    Show-Err 'Run this script from inside the extracted kix-bundle directory.'
    exit 1
}

$VscodePrompts = ''
if (Test-Path $VscodePromptsDefault) {
    $VscodePrompts = $VscodePromptsDefault
} else {
    Show-Warn "VS Code prompts folder not found: $VscodePromptsDefault"
}

$VscodeMemory = ''
if (-not $SkipMemories) {
    if (Test-Path $VscodeMemoryDefault) {
        $VscodeMemory = $VscodeMemoryDefault
    } else {
        # memory 目录在用户首次使用 Copilot memory 功能后才存在；尝试创建（递归）
        $VscodeMemory = $VscodeMemoryDefault
        Show-Warn "VS Code memory folder not found; will create: $VscodeMemory"
    }
}

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Show-Warn 'git not found (needed by kixpower blast-radius-check / fidelity-check).'
}

# --- Confirm plan ---
Write-Host ''
Show-Info '=== Install plan ==='
Show-Info "  Bundle source:    $BundleRoot"
Show-Info "  Copilot home:     $CopilotHome"
if ($VscodePrompts) { Show-Info "  VS Code prompts:  $VscodePrompts" } else { Show-Info '  VS Code prompts:  SKIP (folder missing)' }
if ($VscodeMemory)  { Show-Info "  VS Code memory:   $VscodeMemory"  } else { Show-Info '  VS Code memory:   SKIP' }
Show-Info "  Skills ($($Skills.Count)):       $($Skills -join ', ')"
Show-Info "  Agents ($($Agents.Count)):        $($Agents -join ', ')"
Show-Info "  Instructions ($($Instructions.Count)):  $($Instructions -join ', ')"
Show-Info "  Prompts ($($Prompts.Count)):       $($Prompts -join ', ')"
Show-Info "  Memories ($($Memories.Count)):      $($Memories -join ', ')"
Show-Info '  Hook launcher:    pwsh -NoProfile -File'
Show-Info '  Hook extension:   .ps1'
if ($DryRun) { Show-Info '  Mode:             DRY-RUN (no writes)' }
Write-Host ''
$confirm = Read-Host 'Proceed? [y/N]'
if ($confirm -ne 'y') { Show-Info 'Aborted.'; exit 0 }

# --- Execute ---
function New-DirIfMissing($path) {
    if (-not (Test-Path $path)) { New-Item -ItemType Directory -Path $path -Force | Out-Null }
}

New-DirIfMissing (Join-Path $CopilotHome 'skills')
New-DirIfMissing (Join-Path $CopilotHome 'agents')
New-DirIfMissing (Join-Path $CopilotHome 'instructions')
if ($VscodePrompts) { New-DirIfMissing $VscodePrompts }
if ($VscodeMemory)  { New-DirIfMissing $VscodeMemory }

# 1. Skills
foreach ($s in $Skills) {
    $src = Join-Path $BundleRoot "skills\$s"
    $dst = Join-Path $CopilotHome "skills\$s"
    if (-not (Test-Path $src)) { Show-Warn "skill source missing: $src"; continue }
    if (-not $DryRun) {
        if (Test-Path $dst) { Remove-Item -Recurse -Force $dst }
        Copy-Item -Recurse $src $dst
    }
    Show-OK "skill -> $dst"
}

# 2. Agents
foreach ($a in $Agents) {
    $src = Join-Path $BundleRoot "agents\$a.agent.md"
    $dst = Join-Path $CopilotHome "agents\$a.agent.md"
    if (-not (Test-Path $src)) { Show-Warn "agent source missing: $src"; continue }
    if (-not $DryRun) { Copy-Item $src $dst -Force }
    Show-OK "agent -> $dst"
}

# 3. Instructions
foreach ($i in $Instructions) {
    $src = Join-Path $BundleRoot "instructions\$i.instructions.md"
    $dst = Join-Path $CopilotHome "instructions\$i.instructions.md"
    if (-not (Test-Path $src)) { Show-Warn "instruction source missing: $src"; continue }
    if (-not $DryRun) { Copy-Item $src $dst -Force }
    Show-OK "instruction -> $dst"
}

# 4. Prompts
if ($VscodePrompts) {
    foreach ($p in $Prompts) {
        $src = Join-Path $BundleRoot "prompts\$p.prompt.md"
        $dst = Join-Path $VscodePrompts "$p.prompt.md"
        if (-not (Test-Path $src)) { Show-Warn "prompt source missing: $src"; continue }
        if (-not $DryRun) { Copy-Item $src $dst -Force }
        Show-OK "prompt -> $dst"
    }
} else {
    Show-Warn 'Prompts skipped (VS Code prompts folder missing).'
}

# 5. Memories
if ($VscodeMemory) {
    foreach ($m in $Memories) {
        $src = Join-Path $BundleRoot "memories\$m.md"
        $dst = Join-Path $VscodeMemory "$m.md"
        if (-not (Test-Path $src)) { Show-Warn "memory source missing: $src"; continue }
        if (-not $DryRun) { Copy-Item $src $dst -Force }
        Show-OK "memory -> $dst"
    }
} else {
    Show-Warn 'Memories skipped.'
}

# 6. Replace placeholders in agent.md (hook commands need forward-slash paths)
$CopilotHomeFwd = $CopilotHome -replace '\\', '/'
foreach ($a in $Agents) {
    $ap = Join-Path $CopilotHome "agents\$a.agent.md"
    if (-not (Test-Path $ap)) { continue }
    if (-not $DryRun) {
        $content = Get-Content $ap -Raw
        $content = $content -replace '\{\{COPILOT_HOME\}\}', $CopilotHomeFwd
        $content = $content -replace '\{\{HOOK_LAUNCHER\}\}', 'pwsh -NoProfile -File'
        $content = $content -replace '\{\{HOOK_EXT\}\}', 'ps1'
        Set-Content -Path $ap -Value $content -NoNewline
    }
}
Show-OK 'Replaced placeholders in agent.md files'

Write-Host ''
Show-Info '=== Install complete ==='
Write-Host 'Next steps:'
Write-Host '  1. Reload VS Code window (Command Palette -> "Developer: Reload Window")'
Write-Host '  2. kixparadigm: auto-active every session (core instructions). Say "/kixparadigm" for mode.'
Write-Host '  3. kixpower: in Copilot Chat type /kixpower-new (new project) or /kixpower-import (existing code)'
Write-Host '  4. Memories load on next Copilot Chat session (first ~200 lines auto-loaded)'
Write-Host ''
Write-Host 'To uninstall: ./install.ps1 -Uninstall'
