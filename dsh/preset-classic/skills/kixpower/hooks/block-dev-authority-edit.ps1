# Kixpower Orchestration — Hook: Protect authoritative L2/QA fields from Dev edits
# Dev/Producer 可以更新各自允许的任务文档，但不能写入会证明 L2/QA 已完成的权威字段。

$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$Env:LC_ALL = 'C.UTF-8'
$Env:LANG = 'C.UTF-8'

$inputJson = $Input | Out-String
if ([string]::IsNullOrWhiteSpace($inputJson)) { exit 0 }

try {
    $hookInput = $inputJson | ConvertFrom-Json
} catch {
    [Console]::Error.WriteLine('DEV AUTHORITY: hook input 不是有效 JSON，拒绝可能改写权威字段。')
    exit 2
}

function Write-DenyResult([string]$reason) {
    Write-Output (@{
        hookSpecificOutput = @{
            hookEventName = 'PreToolUse'
            permissionDecision = 'deny'
            permissionDecisionReason = $reason
        }
    } | ConvertTo-Json -Depth 3)
}

$contractScript = Join-Path $PSScriptRoot '..\scripts\kixpower-contract.ps1'
if (-not (Test-Path $contractScript)) {
    Write-DenyResult 'Dev 权威字段保护 helper 缺失，拒绝可能改写 progress.md。'
    exit 2
}
. (Resolve-Path $contractScript)

$toolName = [string]$hookInput.tool_name
$toolLeaf = ($toolName -split '\.')[-1]
$argsObj = $hookInput.tool_input
if (-not $argsObj) { exit 0 }

if (Test-KixSuspiciousExecutionTool -ToolName $toolName) {
    Write-DenyResult '当前 agent 禁止使用未登记的代码执行/脚本工具；请使用受边界检查的终端或编辑工具。'
    exit 2
}
if ($toolLeaf -eq 'run_notebook_cell') {
    $notebookCode = @($argsObj.code, $argsObj.cell, $argsObj.content) -join "`n"
    if ([string]::IsNullOrWhiteSpace($notebookCode)) {
        Write-DenyResult 'Dev notebook cell 的代码正文不可验证；拒绝可能改写 progress.md 或 L2/QA 权威字段的执行。'
        exit 2
    }
    if ($notebookCode -match '(?i)(?:progress\.md|l2_verification_passed|l2_verified_sha|l2_gate_manifest_sha256|l2_stash_refs|qa_started_sha|qa_verified_sha|qa_test_changes)') {
        Write-DenyResult 'Dev notebook 执行不得改写 progress.md 或 L2/QA 权威字段。'
        exit 2
    }
    exit 0
}

$editTools = @('apply_patch', 'replace_string_in_file', 'insert_edit_into_file', 'edit_notebook_file', 'create_file', 'create_or_update_file', 'delete_file', 'push_files')
$isRemoteFileEdit = $toolName -match '(?i)mcp_github.*(?:create_or_update_file|delete_file|push_files)'
$targetPaths = [System.Collections.Generic.List[string]]::new()
if ($toolLeaf -eq 'apply_patch' -and $argsObj.input) {
    foreach ($match in [regex]::Matches([string]$argsObj.input, '(?m)^\*\*\* (?:Add|Update|Delete) File:\s*(.+?)(?:\s+->.*)?\s*$')) {
        $targetPaths.Add($match.Groups[1].Value)
    }
} elseif ($editTools -contains $toolLeaf -or $isRemoteFileEdit) {
    foreach ($pathValue in (Get-KixPathValues -ToolInput $argsObj)) {
        $targetPaths.Add($pathValue)
    }
}

if ($toolLeaf -in @('run_in_terminal', 'create_and_run_task')) {
    $command = Get-KixTerminalCommand -ToolLeaf $toolLeaf -ToolInput $argsObj
    if (Test-KixTerminalWriteCommand -Command $command -AllowFormatting) {
        Write-DenyResult 'Dev/Producer 不得通过终端写文件或改变 Git 状态（Dev 的 cargo fmt --all 格式化例外除外）；请使用受路径检查的编辑工具，权威 L2/QA 字段由 Orchestrator 写入。'
        exit 2
    }
    exit 0
}

if ($editTools -notcontains $toolLeaf -and -not $isRemoteFileEdit) { exit 0 }
if ($targetPaths.Count -eq 0) {
    if (($toolLeaf -eq 'apply_patch' -and [string]$argsObj.input -match '(?i)progress\.md') -or $isRemoteFileEdit) {
        Write-DenyResult '无法从 patch 解析 progress.md 目标路径，拒绝可能改写权威字段。'
        exit 2
    }
    exit 0
}

$workspace = $hookInput.workspaceFolder
if (-not $workspace) { $workspace = $hookInput.cwd }
if (-not $workspace) { $workspace = (Get-Location).Path }
$normalizedWorkspace = Get-KixNormalizedPath -Value ([string]$workspace)
if (-not $normalizedWorkspace) {
    Write-DenyResult '无法规范化工作区路径，拒绝可能改写 progress.md。'
    exit 2
}

$serializedInput = $argsObj | ConvertTo-Json -Compress -Depth 20
$authorityPattern = '(?im)(?:^|[^\w]|\\[nrt])(?:l2_verification_passed|l2_verification_status|l2_verified_sha|l2_gate_manifest_sha256|l2_stash_refs|qa_started_sha|qa_verified_sha|qa_gate_manifest_sha256|qa_test_changes|ci_pending)\s*:'

function Test-KixAuthorityLineOverlap {
    param(
        [Parameter(Mandatory = $true)][string]$FileText,
        [Parameter(Mandatory = $true)][string]$Fragment
    )
    if (-not $Fragment) { return $false }
    $authorityLines = @($FileText -split '\r?\n' | Where-Object { $_ -match $authorityPattern })
    if (-not $authorityLines) { return $false }
    $searchFrom = 0
    while ($searchFrom -lt $FileText.Length) {
        $index = $FileText.IndexOf($Fragment, $searchFrom, [System.StringComparison]::Ordinal)
        if ($index -lt 0) { break }
        $lineStart = $FileText.LastIndexOf("`n", $index)
        if ($lineStart -lt 0) { $lineStart = 0 } else { $lineStart++ }
        $lineEnd = $FileText.IndexOf("`n", $index + $Fragment.Length)
        if ($lineEnd -lt 0) { $lineEnd = $FileText.Length }
        $line = $FileText.Substring($lineStart, $lineEnd - $lineStart).TrimEnd("`r")
        if ($line -match $authorityPattern) { return $true }
        $searchFrom = $index + [Math]::Max(1, $Fragment.Length)
    }
    return $false
}

foreach ($targetPath in $targetPaths) {
    $normalizedTarget = Get-KixNormalizedPath -Value ([string]$targetPath) -BasePath $normalizedWorkspace
    if (-not $normalizedTarget) {
        if ([string]$targetPath -match '(?i)progress\.md') {
            Write-DenyResult '无法规范化 progress.md 目标路径，拒绝编辑。'
            exit 2
        }
        continue
    }
    if (-not $normalizedTarget.StartsWith("$normalizedWorkspace/", [System.StringComparison]::OrdinalIgnoreCase)) { continue }
    $relativePath = $normalizedTarget.Substring($normalizedWorkspace.Length).TrimStart('/')
    if ($relativePath -match '(?i)^\.git(?:/|$)') {
        Write-DenyResult 'Dev/Producer 不得直接编辑 .git/ 内部文件（config/logs/refs/stash）；此操作可注入 alias/hook 或篡改 reflog/stash baseline。'
        exit 2
    }
    if ($relativePath -notmatch '(?i)^docs/sprint-\d+/progress\.md$') { continue }

    if ($isRemoteFileEdit) {
        Write-DenyResult 'Dev/Producer 不得通过 GitHub 远程文件工具修改 progress.md；请由 Orchestrator 在本地记录权威状态。'
        exit 2
    }

    if ($toolLeaf -in @('create_file', 'create_or_update_file', 'delete_file', 'push_files')) {
        Write-DenyResult 'Dev 不得整体创建、覆盖、删除或推送 progress.md；请使用受保护的局部任务状态编辑，并由 Orchestrator 记录权威 L2/QA 字段。'
        exit 2
    }

    $authorityEdit = $serializedInput -match $authorityPattern
    foreach ($fieldName in @('content', 'newString', 'new_str', 'newText', 'replacement', 'input')) {
        if ($argsObj.PSObject.Properties.Name -contains $fieldName -and
            [string]$argsObj.$fieldName -match $authorityPattern) {
            $authorityEdit = $true
            break
        }
    }
    if (-not $authorityEdit -and $toolLeaf -in @('replace_string_in_file', 'insert_edit_into_file')) {
        $progressText = if (Test-Path -LiteralPath $normalizedTarget) { Get-Content -LiteralPath $normalizedTarget -Raw -ErrorAction SilentlyContinue } else { '' }
        $oldFragment = ''
        foreach ($key in @('oldString', 'old_str', 'oldText', 'old_code')) {
            if ($argsObj.PSObject.Properties.Name -contains $key -and $argsObj.$key) {
                $oldFragment = [string]$argsObj.$key
                break
            }
        }
        if ($oldFragment -and (Test-KixAuthorityLineOverlap -FileText $progressText -Fragment $oldFragment)) {
            $authorityEdit = $true
        }
        if ($toolLeaf -eq 'insert_edit_into_file' -and -not $oldFragment) {
            $authorityEdit = $true
        }
    }
    if ($authorityEdit) {
        Write-DenyResult 'Dev 不得写入权威 L2/QA 字段（l2_* / qa_*）；请由 Orchestrator 记录验证结果。'
        exit 2
    }
    if ($toolLeaf -eq 'apply_patch' -and [string]$argsObj.input -match '(?im)^\*\*\* Delete File:') {
        Write-DenyResult 'Dev 不得删除 progress.md；权威 L2/QA 状态必须保持可验证。'
        exit 2
    }
}

exit 0
