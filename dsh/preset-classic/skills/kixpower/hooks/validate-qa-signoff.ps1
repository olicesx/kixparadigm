# Validate final QA evidence before Producer closeout.
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$inputJson = $Input | Out-String
if ([string]::IsNullOrWhiteSpace($inputJson)) { exit 0 }
try { $hookInput = $inputJson | ConvertFrom-Json } catch {
    [Console]::Error.WriteLine('QA SIGNOFF: hook input 不是有效 JSON，拒绝收尾。')
    exit 2
}

$toolName = [string]$hookInput.tool_name
$toolLeaf = ($toolName -split '\.')[-1]
if ($toolLeaf -ne 'runSubagent') { exit 0 }
$argsObj = $hookInput.tool_input
if (-not $argsObj) { exit 0 }
$targetAgent = [string]$argsObj.agentName
if (-not $targetAgent) { $targetAgent = [string]$argsObj.subagentName }
if (-not $targetAgent) { $targetAgent = [string]$argsObj.subagent }
if (-not $targetAgent) { $targetAgent = [string]$argsObj.agent_name }
if ($targetAgent -ne 'kixpower-producer') { exit 0 }
$prompt = ([string]$argsObj.prompt) -replace '\r\n?', "`n"
if ($prompt -notmatch '(?im)^[ \t]*(?:stage|handoff_stage):\s*producer_closeout[ \t]*(?:#.*)?$') { exit 0 }

$contractScript = Join-Path $PSScriptRoot '..\scripts\kixpower-contract.ps1'
if (-not (Test-Path $contractScript)) { exit 2 }
. (Resolve-Path $contractScript)

function Write-DenyResult([string]$reason) {
    Write-Output (@{
            hookSpecificOutput = @{
                hookEventName = 'PreToolUse'
                permissionDecision = 'deny'
                permissionDecisionReason = $reason
            }
        } | ConvertTo-Json -Depth 3)
}

$projectRoot = $hookInput.workspaceFolder
if (-not $projectRoot) { $projectRoot = $hookInput.cwd }
if (-not $projectRoot) { $projectRoot = (Get-Location).Path }
$projectRoot = [System.IO.Path]::GetFullPath([string]$projectRoot)
$memoryValidator = Join-Path $PSScriptRoot '..\scripts\validate-memory-backlog.ps1'
if (-not (Test-Path $memoryValidator)) {
    Write-DenyResult 'canonical Memory lifecycle validator 缺失，不能收尾。'
    exit 2
}
$memoryOutput = & pwsh -NoProfile -File (Resolve-Path $memoryValidator) -ProjectRoot $projectRoot 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-DenyResult "canonical Memory backlog 未通过 lifecycle 校验：$($memoryOutput -join ' ')"
    exit 2
}

$sprint = 0
if ($prompt -match '(?im)^[ \t]*current_sprint:\s*(\d+)[ \t]*(?:#.*)?$') { $sprint = [int]$Matches[1] }
if ($sprint -le 0) {
    $marker = Join-Path $projectRoot 'docs/.kixpower-current-sprint'
    if (Test-Path $marker) {
        $value = (Get-Content $marker -Raw -ErrorAction SilentlyContinue).Trim()
        if ($value -match '^\d+$') { $sprint = [int]$value }
    }
}
if ($sprint -le 0) { Write-DenyResult 'Producer closeout 必须携带有效 current_sprint。'; exit 2 }

$planFile = Join-Path $projectRoot "docs/sprint-$sprint/plan.md"
$progressFile = Join-Path $projectRoot "docs/sprint-$sprint/progress.md"
$qaFile = Join-Path $projectRoot "docs/qa/qa-signoff-$sprint.md"
if (-not (Test-Path $planFile) -or -not (Test-Path $progressFile) -or -not (Test-Path $qaFile)) {
    Write-DenyResult "Sprint $sprint 缺少 plan.md、progress.md 或最终 qa-signoff-$sprint.md，不能收尾。"
    exit 2
}

$planText = Get-Content $planFile -Raw -ErrorAction SilentlyContinue
$progressText = Get-Content $progressFile -Raw -ErrorAction SilentlyContinue
$qaText = Get-Content $qaFile -Raw -ErrorAction SilentlyContinue
$conflicts = @(Get-KixGateManifestConflicts -PlanText $planText)
if ($conflicts.Count -gt 0) {
    Write-DenyResult "Sprint $sprint plan 的 verifiable_gates 存在同 ID 不同定义，不能收尾。"
    exit 2
}
$qaFrontmatter = Get-KixFrontmatter -Text $qaText
$progressFrontmatter = Get-KixFrontmatter -Text $progressText
$status = Get-KixYamlScalar -Text $qaFrontmatter -Key 'status'
if ($status -notin @('PASS', 'CONDITIONAL')) {
    Write-DenyResult "Sprint $sprint QA 状态为 '$status'，只有最终 PASS 或仅 CI pending 的 CONDITIONAL 才能收尾。"
    exit 2
}
if ($status -eq 'CONDITIONAL' -and (Get-KixYamlScalar -Text $qaFrontmatter -Key 'ci_pending') -ne 'true') {
    Write-DenyResult "Sprint $sprint 的 CONDITIONAL 未声明 ci_pending: true，不能进入 L4/收尾。"
    exit 2
}
$requiredGates = @(Get-KixRequiredLocalGates -PlanText $planText)
$expectedManifestSha = Get-KixSha256 -Text (Get-KixGateManifestJson -Gates $requiredGates)
$manifestSha = Get-KixYamlScalar -Text $qaFrontmatter -Key 'l2_gate_manifest_sha256'
if (-not $manifestSha -or -not $manifestSha.Equals($expectedManifestSha, [System.StringComparison]::OrdinalIgnoreCase)) {
    Write-DenyResult "Sprint $sprint QA signoff 的 gate manifest digest 缺失或过期。"
    exit 2
}
$qaManifestSha = Get-KixYamlScalar -Text $qaFrontmatter -Key 'qa_gate_manifest_sha256'
if (-not $qaManifestSha -or -not $qaManifestSha.Equals($expectedManifestSha, [System.StringComparison]::OrdinalIgnoreCase)) {
    Write-DenyResult "Sprint $sprint QA signoff 的 qa_gate_manifest_sha256 缺失或与 L2 manifest 不一致。"
    exit 2
}

$currentSha = (git -C $projectRoot rev-parse HEAD 2>$null | Select-Object -First 1).Trim()
$progressL2Sha = Get-KixYamlScalar -Text $progressFrontmatter -Key 'l2_verified_sha'
$progressManifestSha = Get-KixYamlScalar -Text $progressFrontmatter -Key 'l2_gate_manifest_sha256'
if (-not (Test-KixSha $progressL2Sha) -or -not $progressL2Sha.Equals($currentSha, [System.StringComparison]::OrdinalIgnoreCase)) {
    Write-DenyResult "Sprint $sprint progress.md 的权威 l2_verified_sha 未绑定当前 HEAD。"
    exit 2
}
if (-not $progressManifestSha -or -not $progressManifestSha.Equals($expectedManifestSha, [System.StringComparison]::OrdinalIgnoreCase)) {
    Write-DenyResult "Sprint $sprint progress.md 的 L2 manifest digest 缺失或过期。"
    exit 2
}
$qaStartedSha = Get-KixYamlScalar -Text $qaFrontmatter -Key 'qa_started_sha'
$qaVerifiedSha = Get-KixYamlScalar -Text $qaFrontmatter -Key 'qa_verified_sha'
$l2Sha = Get-KixYamlScalar -Text $qaFrontmatter -Key 'l2_verified_sha'
foreach ($pair in @(
        @('qa_started_sha', $qaStartedSha),
        @('qa_verified_sha', $qaVerifiedSha),
        @('l2_verified_sha', $l2Sha)
    )) {
    if (-not (Test-KixSha -Sha $pair[1]) -or -not $pair[1].Equals($currentSha, [System.StringComparison]::OrdinalIgnoreCase)) {
        Write-DenyResult "Sprint $sprint QA signoff 的 $($pair[0]) 未绑定当前完整 HEAD。"
        exit 2
    }
}
if (-not $l2Sha.Equals($progressL2Sha, [System.StringComparison]::OrdinalIgnoreCase)) {
    Write-DenyResult "Sprint $sprint QA signoff 的 l2_verified_sha 与 progress.md 权威 L2 SHA 不一致。"
    exit 2
}

$reverifyMarker = Join-Path $projectRoot 'docs/.kixpower-qa-reverify.json'
if (Test-Path $reverifyMarker) {
    try {
        $markerRecord = Get-Content -LiteralPath $reverifyMarker -Raw -ErrorAction Stop | ConvertFrom-Json
        $markerBaseline = [string]$markerRecord.baseline_l2_sha
        if (-not (Test-KixSha $markerBaseline)) {
            Write-DenyResult "检测到无法验证基线的 QA 测试变更 marker，必须完成并记录 L2 reverify。"
            exit 2
        }
        Write-DenyResult "检测到 QA 测试变更 marker（基线 L2 SHA: $markerBaseline）。必须完成全量 L2 与重新 QA，由 Orchestrator 清除 marker 后才能收尾。"
        exit 2
    } catch {
        Write-DenyResult "QA reverify marker 无法解析，不能收尾。"
        exit 2
    }
}

$qaSessionMarker = Join-Path $projectRoot 'docs/.kixpower-qa-session.json'
if (-not (Test-Path $qaSessionMarker)) {
    Write-DenyResult "缺少 QA session marker，无法证明 QA 期间工作树和 stash 未被隐藏修改。"
    exit 2
}
try {
    $l2StashScalar = Get-KixYamlScalar -Text $progressFrontmatter -Key 'l2_stash_refs'
    if ($progressFrontmatter -notmatch '(?m)^[ \t]*l2_stash_refs:\s*' -or $l2StashScalar -in @('null', '~')) {
        Write-DenyResult "progress.md 缺少 L2 完成时的 l2_stash_refs 基线，不能收尾。"
        exit 2
    }
    $l2StashRefs = @(Get-KixYamlList -Text $progressFrontmatter -Key 'l2_stash_refs' | Sort-Object -Unique)
    if ($l2StashRefs | Where-Object { -not (Test-KixSha $_) }) {
        Write-DenyResult "progress.md 的 l2_stash_refs 包含无效 stash SHA，不能收尾。"
        exit 2
    }
    $currentStashRefs = @(Get-KixGitStashRefs -ProjectRoot $projectRoot)
    if (($l2StashRefs -join "`n") -ne ($currentStashRefs -join "`n")) {
        Write-DenyResult "L2 记录后的 git stash 状态与当前不一致；不能把隐藏变更当作已验证。"
        exit 2
    }
    $qaSession = Get-Content -LiteralPath $qaSessionMarker -Raw -ErrorAction Stop | ConvertFrom-Json
    if ([string]$qaSession.l2_verified_sha -ne $progressL2Sha) {
        Write-DenyResult "QA session marker 的 L2 SHA 与当前 progress 权威 SHA 不一致。"
        exit 2
    }
    $sessionStashRefs = @($qaSession.stash_refs | ForEach-Object { [string]$_ } | Where-Object { $_ } | Sort-Object)
    if (($sessionStashRefs -join "`n") -ne ($currentStashRefs -join "`n")) {
        Write-DenyResult "QA 期间 git stash 状态发生变化；不能把隐藏的测试变更当作已验证。"
        exit 2
    }
} catch {
    Write-DenyResult "QA session marker 无法解析，不能收尾。"
    exit 2
}

$testChanges = @(Get-KixYamlList -Text $qaFrontmatter -Key 'qa_test_changes')
if ($testChanges.Count -gt 0) {
    Write-DenyResult "Sprint $sprint QA signoff 仍记录 qa_test_changes；必须先标记 REVERIFY_REQUIRED 并在新 revision 完成全量 L2/QA。"
    exit 2
}

$nonDocChanges = @(git -c core.quotepath=false -C $projectRoot status --porcelain 2>$null |
    ForEach-Object { if ($_.Length -ge 4) { $_.Substring(3).Trim('"') } } |
    Where-Object { $_ -and $_ -notmatch '^(docs/|PROJECT_BRIEF\.md$|\.kixpower/memory/repo/.*\.md$)' })
if ($nonDocChanges.Count -gt 0) {
    Write-DenyResult "Sprint $sprint QA 签署后存在未验证的非文档变更：$($nonDocChanges -join ', ')。"
    exit 2
}
exit 0
