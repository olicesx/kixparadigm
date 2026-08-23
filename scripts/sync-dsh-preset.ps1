# sync-dsh-preset.ps1 - synchronize a repository preset into DSH_HOME.
#
# The repository preset is the source of truth. This script adds missing files
# and updates changed files. Target-only files are reported but never deleted.
# Compatible with Windows PowerShell 5.1 and PowerShell 7+.
#
# Examples:
#   .\scripts\sync-dsh-preset.ps1 -DryRun
#   .\scripts\sync-dsh-preset.ps1 -Force
#   .\scripts\sync-dsh-preset.ps1 -Force -PresetId kixparadigm-null -SourceDir dsh\preset-null
#   .\scripts\sync-dsh-preset.ps1 -Force -PresetId kixparadigm-classic-en -SourceDir en\preset-classic-en

param(
  [string]$BundleRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')),
  [string]$PresetId = 'kixparadigm',
  [string]$SourceDir = 'dsh\preset',
  [string]$PresetRoot = '',
  [switch]$DryRun,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'

if (-not $PresetRoot) {
  $dshHome = if ($env:DSH_HOME) {
    $env:DSH_HOME
  } else {
    Join-Path $env:USERPROFILE '.dsh'
  }
  $PresetRoot = Join-Path $dshHome ('.agent-presets\' + $PresetId)
}

$src = Join-Path $BundleRoot $SourceDir
if (-not (Test-Path $src)) {
  Write-Error "Preset source does not exist: $src"
}

if (-not (Test-Path $PresetRoot)) {
  Write-Host "[sync] Target does not exist and will be created: $PresetRoot" -ForegroundColor Yellow
  if (-not $DryRun -and -not $Force) {
    $answer = Read-Host 'Create the target? (y/N)'
    if ($answer -notin @('y', 'Y')) { exit 1 }
  }
}

function Get-FileHashSafe([string]$Path) {
  try { return (Get-FileHash -Path $Path -Algorithm SHA256).Hash } catch { return '' }
}

$srcFiles = Get-ChildItem -Path $src -Recurse -File
$added = @()
$updated = @()
$same = @()
$targetOnly = @()

foreach ($file in $srcFiles) {
  $relative = $file.FullName.Substring($src.Length).TrimStart('\', '/')
  $destination = Join-Path $PresetRoot $relative
  if (-not (Test-Path $destination)) {
    $added += $relative
    if (-not $DryRun) {
      New-Item -ItemType Directory -Path (Split-Path $destination) -Force | Out-Null
      Copy-Item $file.FullName $destination -Force
    }
  } elseif ((Get-FileHashSafe $file.FullName) -ne (Get-FileHashSafe $destination)) {
    $updated += $relative
    if (-not $DryRun) {
      if ($Force) {
        Copy-Item $file.FullName $destination -Force
      } else {
        $answer = Read-Host "Overwrite $relative ? (y/N)"
        if ($answer -in @('y', 'Y')) { Copy-Item $file.FullName $destination -Force }
        else { Write-Host "  Skipped: $relative" -ForegroundColor DarkGray }
      }
    }
  } else {
    $same += $relative
  }
}

if (Test-Path $PresetRoot) {
  foreach ($file in (Get-ChildItem -Path $PresetRoot -Recurse -File)) {
    $relative = $file.FullName.Substring($PresetRoot.Length).TrimStart('\', '/')
    if (-not (Test-Path (Join-Path $src $relative))) { $targetOnly += $relative }
  }
}

$mode = if ($DryRun) { 'dry-run' } else { 'sync' }
Write-Host ''
Write-Host "[sync] $mode complete: added $($added.Count) / updated $($updated.Count) / unchanged $($same.Count) / target-only $($targetOnly.Count)"
if ($added.Count) { Write-Host "  Added: $($added -join ', ')" -ForegroundColor Green }
if ($updated.Count) { Write-Host "  Updated: $($updated -join ', ')" -ForegroundColor Yellow }
if ($targetOnly.Count) { Write-Host "  Target-only (not deleted): $($targetOnly -join ', ')" -ForegroundColor Cyan }
if (-not $DryRun -and ($added.Count -or $updated.Count)) {
  Write-Host ''
  Write-Host '[sync] Restart DSH and open a new session to load the synchronized preset.' -ForegroundColor Magenta
}
