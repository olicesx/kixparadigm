# Kixpower Orchestration — Hook: Auto-Remind Progress Update
# 从 stdin 读取 JSON，编辑操作后检测 git 变更并提醒更新进度
# 优化：只对编辑类工具触发，减少不必要的 git status 调用

# 强制设置脚本和控制台使用 UTF-8 编码，防止 Windows 默认的 GBK 处理 Git/Markdown 时引发乱码和宿主警告
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$Env:LC_ALL = "C.UTF-8"
$Env:LANG = "C.UTF-8"

$inputJson = $Input | Out-String
if ([string]::IsNullOrWhiteSpace($inputJson)) {
    exit 0
}

try {
    $hookInput = $inputJson | ConvertFrom-Json
} catch {
    exit 0
}

# 只在编辑类工具成功后检查 git 变更
$toolName = [string]$hookInput.tool_name
$toolLeaf = ($toolName -split '\.')[-1]
$editTools = @('apply_patch','replace_string_in_file','insert_edit_into_file','edit_notebook_file','create_file','create_or_update_file','delete_file','run_in_terminal','create_and_run_task','run_notebook_cell')
if ($editTools -notcontains $toolLeaf) {
    exit 0
}

$projectRoot = $hookInput.workspaceFolder
if (-not $projectRoot) { $projectRoot = $hookInput.cwd }
if (-not $projectRoot) {
    $projectRoot = (Get-Location).Path
}

$gitDir = Join-Path $projectRoot ".git"
if (-not (Test-Path $gitDir)) {
    exit 0
}

try {
    $status = git -c core.quotepath=false -C $projectRoot status --short 2>$null
    # v5.0 注（U7 反过拟合）：避免逐文件编辑刷屏（Dev 连续编辑同一文件会被重复提醒→狼来了）。
    # 仅在变更文件数 >= 5（批量变更）或含源码扩展名变更时才提醒，降低噪音。
    $changedCount = ($status -split "`n" | Where-Object { $_.Trim() }).Count
    $hasSourceChange = $status -match '\.(go|rs|ts|tsx|js|jsx|py|java|cpp|c|h|cs|rb|php|kt|swift|dart|lua|sh|sql|proto|vue|svelte)(?:\s|$)'
    if ($status -and ($changedCount -ge 5 -or $hasSourceChange)) {
        Write-Output (@{
            systemMessage = "💡 检测到 $changedCount 个文件变更。完成一个阶段后请更新 docs/sprint-*/progress.md。"
        } | ConvertTo-Json)
    }
} catch {}

exit 0
