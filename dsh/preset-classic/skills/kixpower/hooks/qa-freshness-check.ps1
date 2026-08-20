# QA test edits create a reverify marker consumed by the closeout hook.
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$inputJson = $Input | Out-String
if ([string]::IsNullOrWhiteSpace($inputJson)) { exit 0 }
try { $hookInput = $inputJson | ConvertFrom-Json } catch { exit 0 }

$toolName = [string]$hookInput.tool_name
$toolLeaf = ($toolName -split '\.')[-1]
$editTools = @('apply_patch','replace_string_in_file','insert_edit_into_file','edit_notebook_file','create_file','delete_file','create_or_update_file','push_files','run_in_terminal')
$isRemoteFileEdit = $toolName -match '(?i)mcp_github.*(?:create_or_update_file|delete_file|push_files)'
if (($editTools -notcontains $toolLeaf) -and -not $isRemoteFileEdit) { exit 0 }

$argsObj = $hookInput.tool_input
$workspace = $hookInput.workspaceFolder
if (-not $workspace) { $workspace = $hookInput.cwd }
if (-not $workspace) { $workspace = (Get-Location).Path }
$workspace = [System.IO.Path]::GetFullPath([string]$workspace).Replace('\', '/')

$contractScript = Join-Path $PSScriptRoot '..\scripts\kixpower-contract.ps1'
if (Test-Path $contractScript) { . (Resolve-Path $contractScript) }

$paths = [System.Collections.Generic.List[string]]::new()
if ($toolLeaf -eq 'apply_patch' -and $argsObj.input) {
    foreach ($match in [regex]::Matches([string]$argsObj.input, '(?m)^\*\*\* (?:Add|Update|Delete) File:\s*(.+?)(?:\s+->.*)?\s*$')) {
        $paths.Add($match.Groups[1].Value)
    }
} elseif ($isRemoteFileEdit) {
    foreach ($pathValue in (Get-KixPathValues -ToolInput $argsObj)) { $paths.Add($pathValue) }
} elseif ($argsObj.filePath) {
    $paths.Add([string]$argsObj.filePath)
} elseif ($argsObj.path) {
    $paths.Add([string]$argsObj.path)
} elseif ($argsObj.files) {
    foreach ($file in $argsObj.files) { if ($file.path) { $paths.Add([string]$file.path) } }
}

$testPath = $false
if ($isRemoteFileEdit) { $testPath = $true }
foreach ($path in $paths) {
    try {
        if (-not [System.IO.Path]::IsPathRooted($path)) { $path = Join-Path $workspace $path }
        $fullPath = [System.IO.Path]::GetFullPath($path).Replace('\', '/')
        $relative = $fullPath.Substring($workspace.Length).TrimStart('/')
        if ($relative -match '(^|/)(tests?|e2e|cypress)/|_test\.|\.test\.|\.spec\.|\.stories\.') {
            $testPath = $true
            break
        }
    } catch {
        exit 0
    }
}

$changedTestPaths = [System.Collections.Generic.List[string]]::new()
$activeSprintForDiff = 0
$activeSprintFileForDiff = Join-Path $workspace 'docs/.kixpower-current-sprint'
if (Test-Path $activeSprintFileForDiff) {
    $activeValueForDiff = (Get-Content -LiteralPath $activeSprintFileForDiff -Raw -ErrorAction SilentlyContinue).Trim()
    if ($activeValueForDiff -match '^\d+$') { $activeSprintForDiff = [int]$activeValueForDiff }
}
if ($activeSprintForDiff -gt 0) {
    $progressFileForDiff = Join-Path $workspace "docs/sprint-$activeSprintForDiff/progress.md"
    if (Test-Path $progressFileForDiff) {
        $progressTextForDiff = Get-Content -LiteralPath $progressFileForDiff -Raw -ErrorAction SilentlyContinue
        $progressFrontmatterForDiff = Get-KixFrontmatter -Text $progressTextForDiff
        $l2ShaForDiff = Get-KixYamlScalar -Text $progressFrontmatterForDiff -Key 'l2_verified_sha'
        if (Test-KixSha $l2ShaForDiff) {
            $changedTestPaths += git -c core.quotepath=false -C $workspace diff --name-only $l2ShaForDiff HEAD 2>$null
            $changedTestPaths += git -c core.quotepath=false -C $workspace status --porcelain 2>$null |
                ForEach-Object { if ($_.Length -ge 4) { $_.Substring(3).Trim('"') } }
            $changedTestPaths = @($changedTestPaths | Where-Object {
                    $_ -and $_ -match '(^|/)(tests?|e2e|cypress)/|_test\.|\.test\.|\.spec\.|\.stories\.'
                } | Sort-Object -Unique)
            if ($changedTestPaths.Count -gt 0) { $testPath = $true }
        }
    }
}

if ($testPath) {
    $activeSprint = 0
    $activeSprintFile = Join-Path $workspace 'docs/.kixpower-current-sprint'
    if (Test-Path $activeSprintFile) {
        $activeValue = (Get-Content -LiteralPath $activeSprintFile -Raw -ErrorAction SilentlyContinue).Trim()
        if ($activeValue -match '^\d+$') { $activeSprint = [int]$activeValue }
    }
    $baselineSha = ''
    if ($activeSprint -gt 0) {
        $progressFile = Join-Path $workspace "docs/sprint-$activeSprint/progress.md"
        if (Test-Path $progressFile) {
            $progressText = Get-Content -LiteralPath $progressFile -Raw -ErrorAction SilentlyContinue
            $progressFrontmatter = Get-KixFrontmatter -Text $progressText
            $baselineSha = Get-KixYamlScalar -Text $progressFrontmatter -Key 'l2_verified_sha'
        }
    }
    $markerPath = Join-Path $workspace 'docs/.kixpower-qa-reverify.json'
    $existing = $null
    if (Test-Path $markerPath) {
        try { $existing = Get-Content -LiteralPath $markerPath -Raw | ConvertFrom-Json } catch { $existing = $null }
    }
    $keepExisting = $existing -and [int]$existing.sprint -eq $activeSprint -and
        [string]$existing.baseline_l2_sha -eq $baselineSha
    $recordedPaths = if ($keepExisting) { @($existing.paths) } else { @() }
    $recordedPaths += @($paths | ForEach-Object {
            try {
                $candidate = $_
                if (-not [System.IO.Path]::IsPathRooted($candidate)) { $candidate = Join-Path $workspace $candidate }
                $full = [System.IO.Path]::GetFullPath($candidate).Replace('\', '/')
                $full.Substring($workspace.Length).TrimStart('/')
            } catch { $_ }
        })
    $recordedPaths += @($changedTestPaths)
    $record = [ordered]@{
        schema_version = 1
        sprint = $activeSprint
        baseline_l2_sha = $baselineSha
        paths = @($recordedPaths | Where-Object { $_ } | Sort-Object -Unique)
        recorded_at = (Get-Date).ToUniversalTime().ToString('o')
    }
    try {
        $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::WriteAllText($markerPath, ($record | ConvertTo-Json -Compress -Depth 4), $utf8NoBom)
    } catch {
        Write-Output (@{
                systemMessage = 'QA 测试变更已发现，但 reverify marker 写入失败；必须停止签署并由 Orchestrator 手动核对。'
            } | ConvertTo-Json -Compress)
        exit 0
    }
    Write-Output (@{
            systemMessage = 'QA 修改了测试或测试 fixture：当前签署必须标记 REVERIFY_REQUIRED，记录受影响测试并返回 Orchestrator 重跑完整 required local_gate。'
        } | ConvertTo-Json -Compress)
}
exit 0
