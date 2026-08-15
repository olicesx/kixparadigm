param(
    [Parameter(Mandatory = $true)]
    [string]$ProjectRoot,

    [Parameter(Mandatory = $true)]
    [string]$ProjectName
)

<#
.SYNOPSIS
    Kixpower Orchestration — 初始化项目目录结构
.DESCRIPTION
    创建 AI 多智能体团队协作所需的目录结构。
    在每个团队的独立 clone 中运行。
#>

$ProjectRoot = Resolve-Path $ProjectRoot

Write-Host "🔨 初始化项目结构: $ProjectName" -ForegroundColor Cyan
Write-Host "   路径: $ProjectRoot" -ForegroundColor Cyan

# 创建目录结构
$dirs = @(
    "docs/brainstorm",
    "docs/qa",
    ".kixpower/memory/repo"
)
# v5.0 注（U4 反过拟合）：不再硬编码预建 sprint-2。小项目/单 Sprint 场景避免空目录噪音；
# 后续 Sprint 由 new-sprint.ps1 按需创建（Sprint 数应随项目演进，非假设固定 >=2）。

foreach ($dir in $dirs) {
    $path = Join-Path $ProjectRoot $dir
    New-Item -ItemType Directory -Path $path -Force | Out-Null
    Write-Host "  ✅ Created: $dir" -ForegroundColor Green
}

# 创建基础目录占位；Sprint 文档由 new-sprint.ps1 统一生成。
$gitkeepDirs = @(
    "docs/brainstorm",
    "docs/qa"
)
foreach ($dir in $gitkeepDirs) {
    $path = Join-Path $ProjectRoot $dir ".gitkeep"
    if (-not (Test-Path $path)) {
        Set-Content -Path $path -Value "" -NoNewline
    }
}

foreach ($memoryFile in @('harness-backlog.md', 'lessons-learned.md')) {
    $memoryPath = Join-Path $ProjectRoot ".kixpower/memory/repo/$memoryFile"
    if (-not (Test-Path $memoryPath)) {
        Set-Content -LiteralPath $memoryPath -Value "# $memoryFile`n" -Encoding utf8
    }
}

$newSprintScript = Join-Path $PSScriptRoot 'new-sprint.ps1'
& $newSprintScript -ProjectRoot $ProjectRoot -SprintNumber 1 -SprintName '初始 Sprint'

Write-Host ""
Write-Host "✅ 项目结构初始化完成！" -ForegroundColor Cyan
Write-Host ""
Write-Host "下一步：由 Producer 填充 Sprint 1 plan.md/progress.md 与 PROJECT_BRIEF.md" -ForegroundColor Yellow
