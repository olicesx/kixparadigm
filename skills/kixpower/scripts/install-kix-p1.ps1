# install-kix-p1.ps1 — P1-8 落地安装脚本（用户手动运行）
#
# 为什么需要手动安装：kix-guards 的 CONTROL PLANE 门禁禁止【模型】改写
# ~/.dsh/.agent-presets/（防 prompt injection 诱导模型篡改用户级配置）。
# 本脚本由【用户自己的 shell】运行，不受模型工具门禁约束——这是 kix 的
# 安全模型：模型不碰用户级配置，安装由用户显式执行。
#
# 用法（在 kix-bundle 源仓库根目录运行）：
#   pwsh -ExecutionPolicy Bypass -File .\skills\kixpower\scripts\install-kix-p1.ps1
#
# 安装内容（幂等，可重复运行）：
#   1. 复制 plugins/kix-commands.js → ~/.dsh/.agent-presets/kixparadigm/plugins/
#   2. 在 agent.cordis.yml 追加挂载行（已存在则跳过）
#   3. 同步源仓库 plugins/kix-guards.js + kix-guards.test.js（v2 接线补全，
#      2026-08-15 起纳入源仓库；agent.cordis.yml 的 kix-guards 挂载行 preset 自带）
#   4. 打印验证指引

$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSCommandPath))
# 上面: skills/kixpower/scripts/install-kix-p1.ps1 -> skills/kixpower/scripts -> skills/kixpower -> skills -> repo
# 修正：install 脚本在 skills/kixpower/scripts/ 下，repo 根 = 上 3 级
$RepoRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSCommandPath))
$RepoRoot = Split-Path -Parent $RepoRoot

$PresetDir = Join-Path $env:USERPROFILE '.dsh\.agent-presets\kixparadigm'
$PluginsDir = Join-Path $PresetDir 'plugins'
$SrcPlugin = Join-Path $RepoRoot 'skills\kixpower\scripts\kix-commands.js'
$DstPlugin = Join-Path $PluginsDir 'kix-commands.js'
$CordisYml = Join-Path $PresetDir 'agent.cordis.yml'

Write-Host "==> 源仓库: $RepoRoot"
Write-Host "==> preset : $PresetDir"

if (-not (Test-Path $SrcPlugin)) { throw "找不到源插件: $SrcPlugin" }
if (-not (Test-Path $CordisYml)) { throw "找不到 agent.cordis.yml: $CordisYml" }

# 1. 复制插件
if (-not (Test-Path $PluginsDir)) { New-Item -ItemType Directory -Path $PluginsDir -Force | Out-Null }
Copy-Item -Path $SrcPlugin -Destination $DstPlugin -Force
Write-Host '==> [1/3] 插件已复制: ' $DstPlugin

# 2. 追加挂载行（幂等）
$mountBlock = @'

# ── kix 流程命令（P1-8：DSH 原生命令平面，2026-08 落地）────────────────
# 注册 /kixpower-new /kixpower-import /kixpower-continue /kixpower-review
# /kixpower 五个原生命令：UI 命令候选 + 零 token 触发 + handler 读
# prompts/*.prompt.md 注入 user 消息（与 /plan 命令同语义）。
- id: kix-commands
  name: ./plugins/kix-commands.js
'@

$content = Get-Content -Path $CordisYml -Raw -Encoding UTF8
if ($content -match '(?m)^\s*- id: kix-commands\s*$') {
  Write-Host '==> [2/3] agent.cordis.yml 已有 kix-commands 行，跳过'
} else {
  $content = $content.TrimEnd() + "`n" + $mountBlock + "`n"
  Set-Content -Path $CordisYml -Value $content -Encoding UTF8 -NoNewline
  Write-Host '==> [2/3] agent.cordis.yml 已追加 kix-commands 挂载行'
}

# 3. 同步 kix-guards（v2，2026-08-15 起源仓库 plugins/ 为准；幂等）
$SrcGuards = Join-Path $RepoRoot 'plugins\kix-guards.js'
$SrcGuardsTest = Join-Path $RepoRoot 'plugins\kix-guards.test.js'
if (Test-Path $SrcGuards) {
  Copy-Item -Path $SrcGuards -Destination (Join-Path $PluginsDir 'kix-guards.js') -Force
  if (Test-Path $SrcGuardsTest) {
    Copy-Item -Path $SrcGuardsTest -Destination (Join-Path $PluginsDir 'kix-guards.test.js') -Force
  }
  Write-Host '==> [3/3] kix-guards（v2）已同步（源仓库 plugins/ 为准）'
} else {
  Write-Host '==> [3/3] 源仓库无 plugins/kix-guards.js，跳过（保留安装副本现有版本）'
}

Write-Host ''
Write-Host '==> 安装完成。验证（需新会话，preset 组装在 agent 发布时安装）：'
Write-Host '    1. 新建会话，输入框敲 "/" 应看到 kixpower-new 等命令候选'
Write-Host '    2. 输入 /kixpower-new 应看到"已注入 kixpower-new 流程"'
Write-Host '    3. 模型下一轮按流程执行（等价旧行为：读取 prompts/*.prompt.md 执行）'
Write-Host '    4. 若需回滚：删除插件文件 + 删除 agent.cordis.yml 中 kix-commands 两行'
