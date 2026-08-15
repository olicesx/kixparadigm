# sync-dsh-preset.ps1 — 把 kix-bundle/dsh/preset（DSH 唯一事实源）同步到
# ~/.dsh/.agent-presets/kixparadigm（DSH 实际安装的 preset）。
#
# 方向（单向）：
#   kix-bundle/dsh/preset/  ──►  ~/.dsh/.agent-presets/kixparadigm/
#
# 规则：
#   - 镜像（dsh/preset/）是唯一事实源。维护 preset 内容 = 改镜像，再跑本脚本同步。
#   - 幂等：内容相同的文件跳过；目标缺失 → 新增；内容不同 → -Force 覆盖（默认询问）。
#   - 只同步 preset 布局（agent.cordis.yml / preset.yml / README.md / DSH-ADAPTATION.md /
#     skills/ / agents/ / instructions/ / prompts/ / memories/ / plugins/）。
#   - 目标侧独有文件（镜像没有的）只报告不删除——人工确认后再清理。
#
# 用法：
#   .\scripts\sync-dsh-preset.ps1 -DryRun        # 预览差异
#   .\scripts\sync-dsh-preset.ps1                # 交互（逐文件确认覆盖）
#   .\scripts\sync-dsh-preset.ps1 -Force         # 全量同步（覆盖差异）
#
# 同步后：重启 DSH 进程（Ctrl+C → `dsh web`）再开新会话，preset 才重新组装。

param(
  [string]$BundleRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')),
  [string]$PresetRoot = (Join-Path ($env:DSH_HOME ?? (Join-Path $env:USERPROFILE '.dsh')) '.agent-presets\kixparadigm'),
  [switch]$DryRun,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$src = Join-Path $BundleRoot 'dsh\preset'

if (-not (Test-Path $src)) {
  Write-Error "镜像不存在: $src（需要 kix-bundle 的 dsh/preset 目录）"
}
if (-not (Test-Path $PresetRoot)) {
  Write-Host "[sync] 目标不存在，将全新安装: $PresetRoot" -ForegroundColor Yellow
  if (-not $DryRun -and -not $Force) {
    $ans = Read-Host '确认全新安装? (y/N)'
    if ($ans -notin @('y', 'Y')) { exit 1 }
  }
}

function Get-FileHashSafe([string]$p) {
  try { return (Get-FileHash -Path $p -Algorithm SHA256).Hash } catch { return '' }
}

$srcFiles = Get-ChildItem -Path $src -Recurse -File
$added = @(); $updated = @(); $same = @(); $removed = @()

foreach ($f in $srcFiles) {
  $rel = $f.FullName.Substring($src.Length).TrimStart('\', '/')
  $dst = Join-Path $PresetRoot $rel
  if (-not (Test-Path $dst)) {
    $added += $rel
    if (-not $DryRun) {
      New-Item -ItemType Directory -Path (Split-Path $dst) -Force | Out-Null
      Copy-Item $f.FullName $dst -Force
    }
  }
  elseif ((Get-FileHashSafe $f.FullName) -ne (Get-FileHashSafe $dst)) {
    $updated += $rel
    if (-not $DryRun) {
      if ($Force) { Copy-Item $f.FullName $dst -Force }
      else {
        $ans = Read-Host "覆盖 $rel ? (y/N)"
        if ($ans -in @('y', 'Y')) { Copy-Item $f.FullName $dst -Force }
        else { Write-Host "  跳过 $rel" -ForegroundColor DarkGray }
      }
    }
  }
  else { $same += $rel }
}

if (Test-Path $PresetRoot) {
  $dstFiles = Get-ChildItem -Path $PresetRoot -Recurse -File
  foreach ($f in $dstFiles) {
    $rel = $f.FullName.Substring($PresetRoot.Length).TrimStart('\', '/')
    if (-not (Test-Path (Join-Path $src $rel))) { $removed += $rel }
  }
}

$mode = if ($DryRun) { '预览' } else { '同步' }
Write-Host ''
Write-Host "[sync] $mode 完成: 新增 $($added.Count) / 更新 $($updated.Count) / 相同 $($same.Count) / 目标独有 $($removed.Count)"
if ($added.Count)   { Write-Host "  新增: $($added -join ', ')" -ForegroundColor Green }
if ($updated.Count) { Write-Host "  更新: $($updated -join ', ')" -ForegroundColor Yellow }
if ($removed.Count) { Write-Host "  目标独有(未删，人工确认): $($removed -join ', ')" -ForegroundColor Cyan }
if (-not $DryRun -and ($added.Count -or $updated.Count)) {
  Write-Host ''
  Write-Host "[sync] 请重启 DSH 进程(Ctrl+C → dsh web)后开新会话，preset 才会重新组装并生效。" -ForegroundColor Magenta
}
