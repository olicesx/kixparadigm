# install-kix-stalled.ps1 — kixst 静态插件启用脚本（用户手动运行 = 显式 opt-in）
#
# 为什么需要手动运行：kix-guards 的 CONTROL PLANE 门禁禁止【模型】改写
# ~/.dsh/.agent-presets/（防 prompt injection 诱导模型篡改用户级配置）。
# 本脚本由【用户自己的 shell】运行，不受模型工具门禁约束。
#
# kixst = L3 档 A stalled 机械检测（只读、无状态、无常驻）：
#   - /kixst-check <项目根>   零 token 原生命令，扫描 docs/sprint-*/progress.md
#   - kix_stalled_check       模型工具
# 详细设计纪律见 dsh/preset/plugins/kix-stalled.js 头注 + README.md。
#
# 用法（在 kix-bundle 源仓库根目录运行）：
#   pwsh -ExecutionPolicy Bypass -File .\scripts\install-kix-stalled.ps1
#
# 幂等：可重复运行；已启用则跳过。
# 回滚：删除 ~/.dsh/.agent-presets/kixparadigm/plugins/kix-stalled.js
#       并删除 agent.cordis.yml 中的 kix-stalled 挂载行（本脚本打印的行块）。

$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$PresetDir = Join-Path $env:USERPROFILE '.dsh\.agent-presets\kixparadigm'
$PluginsDir = Join-Path $PresetDir 'plugins'
$SrcPlugin = Join-Path $RepoRoot 'dsh\preset\plugins\kix-stalled.js'
$DstPlugin = Join-Path $PluginsDir 'kix-stalled.js'
$CordisYml = Join-Path $PresetDir 'agent.cordis.yml'

Write-Host "==> 源仓库: $RepoRoot"
Write-Host "==> preset : $PresetDir"

if (-not (Test-Path $SrcPlugin)) { throw "找不到源插件: $SrcPlugin" }
if (-not (Test-Path $CordisYml)) { throw "找不到 agent.cordis.yml: $CordisYml（请先安装 kixparadigm preset）" }

# 1. 复制插件
if (-not (Test-Path $PluginsDir)) { New-Item -ItemType Directory -Path $PluginsDir -Force | Out-Null }
Copy-Item -Path $SrcPlugin -Destination $DstPlugin -Force
Write-Host '==> [1/2] 插件已复制: ' $DstPlugin

# 2. 追加启用挂载行（幂等）
$mountBlock = @'

# ── kix-stalled（L3 档 A：stalled 机械检测，用户显式启用 2026-08-15）────
# /kixst-check 命令（零 token）+ kix_stalled_check 模型工具；只读无状态。
- id: kix-stalled
  name: ./plugins/kix-stalled.js
'@

$content = Get-Content -Path $CordisYml -Raw -Encoding UTF8
if ($content -match '(?m)^\s*- id: kix-stalled\s*$') {
  Write-Host '==> [2/2] agent.cordis.yml 已有 kix-stalled 挂载行，跳过'
} else {
  $content = $content.TrimEnd() + "`n" + $mountBlock + "`n"
  Set-Content -Path $CordisYml -Value $content -Encoding UTF8 -NoNewline
  Write-Host '==> [2/2] agent.cordis.yml 已追加 kix-stalled 启用挂载行'
}

Write-Host ''
Write-Host '==> 启用完成。生效需新会话（preset 组装在 agent 发布时安装，运行中不重读）。'
Write-Host '    1. 新建会话（kixparadigm），输入框敲 "/" 应看到 kixst-check 候选'
Write-Host '    2. 输入 /kixst-check <项目根> 应看到各 Sprint 状态与 STALLED 标记'
Write-Host '    3. 模型也可用 kix_stalled_check 工具按需检查'
Write-Host '    4. 回滚：删除 ' $DstPlugin ' 与 agent.cordis.yml 中 kix-stalled 挂载行'
