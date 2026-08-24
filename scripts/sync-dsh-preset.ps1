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
  [switch]$Force,
  [string[]]$DirectoryPointers = @()
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

$bundle = (Resolve-Path -LiteralPath $BundleRoot).Path
$src = Join-Path $bundle $SourceDir
if (-not (Test-Path $src)) {
  Write-Error "Preset source does not exist: $src"
}

# The default preset owns one known directory pointer. Other source presets have
# none; explicit caller declarations are validated strictly below.
if (-not $PSBoundParameters.ContainsKey('DirectoryPointers')) {
  $comparison = if ([IO.Path]::DirectorySeparatorChar -eq '\') {
    [StringComparison]::OrdinalIgnoreCase
  } else {
    [StringComparison]::Ordinal
  }
  $defaultPointerSource = [IO.Path]::GetFullPath((Join-Path $bundle 'dsh/preset'))
  if ([string]::Equals([IO.Path]::GetFullPath($src), $defaultPointerSource, $comparison)) {
    $DirectoryPointers = @('dsh/preset/skills')
  }
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

# Git checkouts with core.symlinks=false represent directory symlinks as one-line
# text files (for example dsh/preset/skills -> ../preset-classic/skills). Expand
# only explicitly declared repository pointers; ordinary one-line files must keep
# their file semantics even when their content happens to name a directory.
function Get-SourceEntries([string]$SourceRoot, [string]$Root, [string[]]$PointerPaths) {
  $entries = @()
  $pointerRoots = @()
  $comparison = if ([IO.Path]::DirectorySeparatorChar -eq '\') {
    [StringComparison]::OrdinalIgnoreCase
  } else {
    [StringComparison]::Ordinal
  }
  $rootPrefix = $Root.TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
  $sourcePrefix = $SourceRoot.TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar

  foreach ($declaredPath in $PointerPaths) {
    if (-not $declaredPath -or [IO.Path]::IsPathRooted($declaredPath)) {
      throw "Directory pointer paths must be non-empty and bundle-relative: $declaredPath"
    }
    $pointerPath = [IO.Path]::GetFullPath((Join-Path $Root $declaredPath))
    $insideRoot = [string]::Equals($pointerPath, $Root, $comparison) -or $pointerPath.StartsWith($rootPrefix, $comparison)
    $insideSource = [string]::Equals($pointerPath, $SourceRoot, $comparison) -or $pointerPath.StartsWith($sourcePrefix, $comparison)
    if (-not $insideRoot) { throw "Directory pointer escapes bundle root: $declaredPath" }
    if (-not $insideSource) { throw "Directory pointer is outside the selected source: $declaredPath" }
    if (-not (Test-Path -LiteralPath $pointerPath)) { throw "Directory pointer does not exist: $declaredPath" }

    $item = Get-Item -LiteralPath $pointerPath -Force
    if ($item.PSIsContainer) {
      $linkTarget = @($item.Target)[0]
      $target = if ($item.LinkType -and $linkTarget) {
        $candidate = if ([IO.Path]::IsPathRooted($linkTarget)) { $linkTarget } else { Join-Path $item.Parent.FullName $linkTarget }
        (Resolve-Path -LiteralPath $candidate).Path
      } else {
        $item.FullName
      }
    } else {
      $linkTarget = (Get-Content -LiteralPath $item.FullName -Raw -ErrorAction Stop).Trim()
      if (-not $linkTarget -or $linkTarget.IndexOf("`n") -ge 0 -or $linkTarget.IndexOf("`r") -ge 0 -or [IO.Path]::IsPathRooted($linkTarget)) {
        throw "Configured directory pointer is not a relative one-line path: $declaredPath"
      }
      $target = (Resolve-Path -LiteralPath (Join-Path $item.DirectoryName $linkTarget)).Path
    }

    $insideTarget = [string]::Equals($target, $Root, $comparison) -or $target.StartsWith($rootPrefix, $comparison)
    if (-not $insideTarget -or -not (Test-Path -LiteralPath $target -PathType Container)) {
      throw "Configured directory pointer target is outside the bundle or not a directory: $declaredPath"
    }

    $relative = $pointerPath.Substring($SourceRoot.Length).TrimStart('\', '/')
    foreach ($linkedFile in (Get-ChildItem -Path $target -Recurse -File)) {
      $linkedRelative = $linkedFile.FullName.Substring($target.Length).TrimStart('\', '/')
      $entries += [PSCustomObject]@{
        File = $linkedFile
        Relative = Join-Path $relative $linkedRelative
      }
    }
    $pointerRoots += $pointerPath
  }

  foreach ($file in (Get-ChildItem -Path $SourceRoot -Recurse -File)) {
    $isPointerEntry = $false
    foreach ($pointerRoot in $pointerRoots) {
      $pointerPrefix = $pointerRoot.TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
      if ([string]::Equals($file.FullName, $pointerRoot, $comparison) -or $file.FullName.StartsWith($pointerPrefix, $comparison)) {
        $isPointerEntry = $true
        break
      }
    }
    if ($isPointerEntry) { continue }
    $relative = $file.FullName.Substring($SourceRoot.Length).TrimStart('\', '/')
    $entries += [PSCustomObject]@{ File = $file; Relative = $relative }
  }
  return @($entries)
}

$srcEntries = Get-SourceEntries $src $bundle $DirectoryPointers
$sourceRelatives = @{}
$added = @()
$updated = @()
$same = @()
$targetOnly = @()

foreach ($entry in $srcEntries) {
  $file = $entry.File
  $relative = $entry.Relative
  $sourceRelatives[$relative] = $true
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
    if (-not $sourceRelatives.ContainsKey($relative)) { $targetOnly += $relative }
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
