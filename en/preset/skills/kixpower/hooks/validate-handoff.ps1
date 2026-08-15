# Kixpower Orchestration — Hook: Validate Handoff Readiness
# 精准拦截：仅在 orchestrator 调用 runSubagent 切换到 dev/qa 阶段时检查 progress.md
# 其他工具调用一律放行，避免误伤文件编辑/搜索/规划写入

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
    [Console]::Error.WriteLine('HANDOFF: hook input 不是有效 JSON，拒绝交接。')
    exit 2
}

$contractScript = Join-Path $PSScriptRoot '..\scripts\kixpower-contract.ps1'
if (Test-Path $contractScript) { . (Resolve-Path $contractScript) }

function Write-DenyResult([string]$reason) {
    Write-Output (@{
        hookSpecificOutput = @{
            hookEventName = "PreToolUse"
            permissionDecision = "deny"
            permissionDecisionReason = $reason
        }
    } | ConvertTo-Json -Depth 3)
}

# 只在 PreToolUse + 工具为 runSubagent 时介入
$toolName = [string]$hookInput.tool_name
$toolLeaf = ($toolName -split '\.')[-1]
if ($toolLeaf -ne 'runSubagent') {
    exit 0
}

# 提取目标子 agent 名（容错多种字段命名）
$argsObj = $hookInput.tool_input
if (-not $argsObj) {
    exit 0
}
$targetAgent = $argsObj.agentName
if (-not $targetAgent) { $targetAgent = $argsObj.subagent }
if (-not $targetAgent) { $targetAgent = $argsObj.subagentName }
if (-not $targetAgent) { $targetAgent = $argsObj.agent_name }
if (-not $targetAgent) { $targetAgent = $argsObj.name }
if (-not $targetAgent) { $targetAgent = $argsObj.agent }

if (-not $targetAgent) {
    Write-DenyResult "runSubagent 未提供可识别的目标 agent，拒绝跳过 Dev/QA 交接门禁。"
    exit 2
}
$knownTargets = @('kixpower-producer', 'kixpower-dev', 'kixpower-qa', 'kixpower-reviewer')
if ($knownTargets -notcontains [string]$targetAgent) {
    Write-DenyResult "runSubagent 目标 agent '$targetAgent' 未在 Orchestrator 合约中登记。"
    exit 2
}

$handoffPrompt = ([string]$argsObj.prompt) -replace "\r\n?", "`n"
$projectRoot = $hookInput.workspaceFolder
if (-not $projectRoot) { $projectRoot = $hookInput.cwd }
if (-not $projectRoot) { $projectRoot = (Get-Location).Path }

if ($targetAgent -eq 'kixpower-reviewer') {
    if ($handoffPrompt -notmatch '(?im)^[ \t]*handoff_mode:\s*review[ \t]*(?:#.*)?$' -or
        $handoffPrompt -notmatch '(?im)^[ \t]*review_readonly:\s*true[ \t]*(?:#.*)?$' -or
        $handoffPrompt -notmatch '(?im)^[ \t]*review_origin:\s*kixpower-review[ \t]*(?:#.*)?$' -or
        $handoffPrompt -notmatch '(?im)(?:^[ \t]*pr:\s*#?\d+|\bPR\s+#\d+)' -or
        $handoffPrompt -notmatch '(?im)^[ \t]*review_worktree:\s*(.+?)[ \t]*(?:#.*)?$' -or
        $handoffPrompt -notmatch '(?im)^[ \t]*review_head_sha:\s*([0-9a-fA-F]{40})[ \t]*(?:#.*)?$') {
        Write-DenyResult "kixpower-reviewer 必须来自 kixpower-review 的只读 PR handoff。"
        exit 2
    }
    $reviewWorktree = ''
    $reviewHeadSha = ''
    if ($handoffPrompt -match '(?im)^[ \t]*review_worktree:\s*(.+?)[ \t]*(?:#.*)?$') { $reviewWorktree = $Matches[1].Trim() }
    if ($handoffPrompt -match '(?im)^[ \t]*review_head_sha:\s*([0-9a-fA-F]{40})[ \t]*(?:#.*)?$') { $reviewHeadSha = $Matches[1] }
    $normalizedReviewWorktree = Get-KixNormalizedPath -Value $reviewWorktree -BasePath $projectRoot
    $normalizedProjectRoot = Get-KixNormalizedPath -Value ([string]$projectRoot)
    if (-not $normalizedReviewWorktree -or -not (Test-Path $normalizedReviewWorktree -PathType Container) -or
        $normalizedReviewWorktree.Equals($normalizedProjectRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        Write-DenyResult "reviewer handoff 的 review_worktree 不存在或不是独立工作树。"
        exit 2
    }
    $registeredReviewWorktree = $false
    foreach ($row in @(git -C $projectRoot worktree list --porcelain 2>$null)) {
        if ($row -match '^worktree\s+(.+)$') {
            $registeredPath = Get-KixNormalizedPath -Value $Matches[1]
            if ($registeredPath -and $registeredPath.Equals($normalizedReviewWorktree, [System.StringComparison]::OrdinalIgnoreCase)) {
                $registeredReviewWorktree = $true
                break
            }
        }
    }
    if (-not $registeredReviewWorktree) {
        Write-DenyResult "reviewer handoff 的 review_worktree 未登记在 git worktree list --porcelain 中。"
        exit 2
    }
    $actualReviewHead = (git -C $normalizedReviewWorktree rev-parse HEAD 2>$null | Select-Object -First 1).Trim()
    if (-not $actualReviewHead -or -not $actualReviewHead.Equals($reviewHeadSha, [System.StringComparison]::OrdinalIgnoreCase)) {
        Write-DenyResult "reviewer handoff 的 review_head_sha 与独立 worktree HEAD 不一致。"
        exit 2
    }
    exit 0
}

# 切到 producer 是规划起步，不检查；Dev/QA 必须进入 Sprint handoff 全部检查。
if ($targetAgent -eq 'kixpower-producer') {
    exit 0
}

$partitionId = ''
$handoffRoot = ''
$planSnapshotSha = ''
if ($handoffPrompt -match '(?im)^[ \t]*partition_id:\s*(\S+)[ \t]*(?:#.*)?$') { $partitionId = $Matches[1] }
if ($partitionId) {
    if ($handoffPrompt -notmatch '(?im)^[ \t]*handoff_root:\s*(.+?)[ \t]*(?:#.*)?$' -or
        $handoffPrompt -notmatch '(?im)^[ \t]*plan_snapshot_sha:\s*([0-9a-fA-F]{40})[ \t]*(?:#.*)?$') {
        Write-DenyResult "parallel/hybrid handoff 必须携带 handoff_root 与完整 40 位 plan_snapshot_sha。"
        exit 2
    }
    $handoffRoot = $Matches[1].Trim()
    if ($handoffPrompt -match '(?im)^[ \t]*handoff_root:\s*(.+?)[ \t]*(?:#.*)?$') { $handoffRoot = $Matches[1].Trim() }
    if ($handoffPrompt -match '(?im)^[ \t]*plan_snapshot_sha:\s*([0-9a-fA-F]{40})[ \t]*(?:#.*)?$') { $planSnapshotSha = $Matches[1] }
    $normalizedHandoffRoot = Get-KixNormalizedPath -Value $handoffRoot -BasePath $projectRoot
    if (-not $normalizedHandoffRoot -or -not (Test-Path $normalizedHandoffRoot -PathType Container)) {
        Write-DenyResult "parallel/hybrid handoff_root 不存在或无法规范化。"
        exit 2
    }
    $worktreeRows = @(git -C $projectRoot worktree list --porcelain 2>$null)
    $registered = $false
    foreach ($row in $worktreeRows) {
        if ($row -match '^worktree\s+(.+)$') {
            $registeredPath = Get-KixNormalizedPath -Value $Matches[1]
            if ($registeredPath -and $registeredPath.Equals($normalizedHandoffRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
                $registered = $true
                break
            }
        }
    }
    if (-not $registered) {
        Write-DenyResult "parallel/hybrid handoff_root 未登记在 git worktree list --porcelain 中。"
        exit 2
    }
    $handoffHead = (git -C $normalizedHandoffRoot rev-parse HEAD 2>$null | Select-Object -First 1).Trim()
    if (-not $handoffHead -or -not $handoffHead.Equals($planSnapshotSha, [System.StringComparison]::OrdinalIgnoreCase)) {
        Write-DenyResult "parallel/hybrid worktree HEAD 未绑定 plan_snapshot_sha；禁止从漂移快照启动 Dev/QA。"
        exit 2
    }
    if (-not (Test-Path (Join-Path $normalizedHandoffRoot 'docs/.kixpower-current-sprint'))) {
        Write-DenyResult "parallel/hybrid worktree 缺少本地 active Sprint marker。"
        exit 2
    }
    $projectRoot = $normalizedHandoffRoot
}

$requestedSprint = 0
if ($handoffPrompt -match '(?im)^[ \t]*current_sprint:\s*(\d+)[ \t]*(?:#.*)?$') { $requestedSprint = [int]$Matches[1] }
if ($requestedSprint -le 0) {
    Write-DenyResult "Dev/QA Sprint 交接必须显式携带 current_sprint；禁止回退猜测最新 Sprint。"
    exit 2
}
$activeSprintFile = Join-Path $projectRoot 'docs/.kixpower-current-sprint'
$activeSprint = 0
if (Test-Path $activeSprintFile) {
    $activeValue = (Get-Content $activeSprintFile -Raw -ErrorAction SilentlyContinue).Trim()
    if ($activeValue -match '^\d+$') { $activeSprint = [int]$activeValue }
}
if ($activeSprint -le 0 -or $activeSprint -ne $requestedSprint) {
    Write-DenyResult "current_sprint=$requestedSprint 与 active Sprint marker=$activeSprint 不一致。请由 Orchestrator 先写 docs/.kixpower-current-sprint。"
    exit 2
}

# 查找与 active marker 一致的 Sprint 目录。
$docsRoot = Join-Path $projectRoot "docs"
$sprintDirs = Get-ChildItem -Path $docsRoot -Directory -Filter "sprint-*" -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '^sprint-\d+$' } |
    Sort-Object { [int]($_.Name -replace '^sprint-','') } -Descending
if (-not $sprintDirs) {
    Write-DenyResult "未找到任何 docs/sprint-* 目录。请先调用 kixpower-producer 生成 Sprint plan。"
    exit 2
}

$sprintDir = $sprintDirs | Where-Object { $_.Name -eq "sprint-$requestedSprint" } | Select-Object -First 1
if (-not $sprintDir) {
    Write-DenyResult "请求交接 Sprint $requestedSprint，但 docs/sprint-$requestedSprint 不存在。"
    exit 2
}

$sprintName = $sprintDir.Name
$progressFile = Join-Path $sprintDir.FullName "progress.md"
$planFile = Join-Path $sprintDir.FullName "plan.md"

# 同时要求 plan.md 和 progress.md 存在，才算"规划完成可进入开发"
if (-not (Test-Path $planFile) -or -not (Test-Path $progressFile)) {
    Write-DenyResult "$sprintName 的 plan.md 或 progress.md 不存在。Producer 必须先完成规划与进度文件初始化，再切换到 $targetAgent。"
    exit 2
}

$planContent = (Get-Content $planFile -Raw -ErrorAction SilentlyContinue) -replace "\r\n?", "`n"
if ([string]::IsNullOrWhiteSpace($planContent) -or
    $planContent -notmatch '(?m)^\s*task_dag:\s*$' -or
    $planContent -notmatch '(?m)^\s*verifiable_gates:\s*(?:\[\])?\s*$') {
    Write-DenyResult "$sprintName 的 plan.md 缺少 task_dag 或 verifiable_gates，规划未达到可交接状态。"
    exit 2
}
$planGateRecords = @(Get-KixPlanGateRecords -PlanText $planContent)
$taskDagRecords = @(Get-KixTaskDagRecords -PlanText $planContent)
if ($taskDagRecords.Count -eq 0 -or $planGateRecords.Count -eq 0) {
    Write-DenyResult "$sprintName 的 plan.md 仍是空骨架。Producer 必须先填充 task DAG 与 verifiable_gates，再交接 $targetAgent。"
    exit 2
}
$gateConflicts = @(Get-KixGateManifestConflicts -PlanText $planContent)
if ($gateConflicts.Count -gt 0) {
    $conflictIds = @($gateConflicts | ForEach-Object { $_.id }) -join ', '
    Write-DenyResult "$sprintName 的 verifiable_gates 存在同 ID 不同定义（$conflictIds）。必须显式消歧，禁止按块顺序猜测。"
    exit 2
}

$content = (Get-Content $progressFile -Raw -ErrorAction SilentlyContinue) -replace "\r\n?", "`n"
$frontmatter = $content
if ($content -match '(?s)^---\s*(.*?)\s*---') { $frontmatter = $Matches[1] }
# 剥离 frontmatter 字段的行内注释（文档模板允许 `key: value # 注释`），再统一解析。
$frontmatter = [regex]::Replace($frontmatter, '(?m)^([ \t]*[A-Za-z_][\w]*:[^\r\n#]*?)[ \t]+#[^\r\n]*$', '$1')
$statusBlocked = $frontmatter -match '(?m)^status:\s*blocked[ \t]*(?:#.*)?$'
$blockedTasks = 0
if ($frontmatter -match '(?m)^blocked_tasks:\s*(\d+)[ \t]*(?:#.*)?$') { $blockedTasks = [int]$Matches[1] }
$hasBlockedEntry = $content -match '(?m)^\s*(?:[-*]\s*)?❌\s*Blocked:\s*\S+'
if ($statusBlocked -or $blockedTasks -gt 0 -or $hasBlockedEntry) {
    Write-DenyResult "$sprintName 存在阻塞项。解决所有 blocker 后再进入 $targetAgent 阶段。"
    exit 2
}

if ($targetAgent -eq 'kixpower-qa') {
    $completedTasks = -1
    $totalTasks = -1
    if ($frontmatter -match '(?m)^completed_tasks:\s*(\d+)[ \t]*(?:#.*)?$') { $completedTasks = [int]$Matches[1] }
    if ($frontmatter -match '(?m)^total_tasks:\s*(\d+)[ \t]*(?:#.*)?$') { $totalTasks = [int]$Matches[1] }
    if ($completedTasks -lt 0 -or $totalTasks -lt 0 -or $completedTasks -ne $totalTasks) {
        Write-DenyResult "$sprintName 尚未完成全部任务（$completedTasks/$totalTasks），不能交接 QA。"
        exit 2
    }

    $requiredGates = @(Get-KixRequiredLocalGates -PlanText $planContent)
    $requiredIds = @($requiredGates | ForEach-Object { [string]$_.id } | Sort-Object -Unique)
    $l2Ids = @(Get-KixYamlList -Text $frontmatter -Key 'l2_verification_passed')
    $l2Ids = @($l2Ids | Sort-Object -Unique)
    if ($requiredIds.Count -eq 0) {
        $l2Status = Get-KixYamlScalar -Text $frontmatter -Key 'l2_verification_status'
        if ($l2Status -ne 'not-applicable') {
            Write-DenyResult "$sprintName 未声明 required local_gate，也未明确 l2_verification_status: not-applicable。"
            exit 2
        }
    }
    $missingIds = @($requiredIds | Where-Object { $l2Ids -notcontains $_ })
    $unknownIds = @($l2Ids | Where-Object { $requiredIds -notcontains $_ })
    if ($missingIds.Count -gt 0 -or $unknownIds.Count -gt 0 -or
        ($requiredIds.Count -gt 0 -and $l2Ids.Count -ne $requiredIds.Count)) {
        $missingText = if ($missingIds.Count) { $missingIds -join ', ' } else { '无' }
        $unknownText = if ($unknownIds.Count) { $unknownIds -join ', ' } else { '无' }
        Write-DenyResult "$sprintName 的 L2 gate 集合不完整。缺失：$missingText；未知/多余：$unknownText。必须覆盖 plan.md 全部 required local_gate。"
        exit 2
    }

    $manifestJson = Get-KixGateManifestJson -Gates $requiredGates
    $expectedManifestSha = Get-KixSha256 -Text $manifestJson
    $recordedManifestSha = Get-KixYamlScalar -Text $frontmatter -Key 'l2_gate_manifest_sha256'
    if (-not $recordedManifestSha -or $recordedManifestSha -notmatch '^[0-9a-fA-F]{64}$' -or
        -not $recordedManifestSha.Equals($expectedManifestSha, [System.StringComparison]::OrdinalIgnoreCase)) {
        Write-DenyResult "$sprintName 的 l2_gate_manifest_sha256 缺失或与当前 plan.md gate manifest 不一致。必须在同一计划版本上重跑全部 L2 local_gate。"
        exit 2
    }
    $promptManifestSha = ''
    if ($handoffPrompt -match '(?im)^[ \t]*l2_gate_manifest_sha256:\s*([0-9a-fA-F]{64})[ \t]*(?:#.*)?$') { $promptManifestSha = $Matches[1] }
    if (-not $promptManifestSha -or -not $promptManifestSha.Equals($expectedManifestSha, [System.StringComparison]::OrdinalIgnoreCase)) {
        Write-DenyResult "$sprintName 的 QA handoff 未携带与当前 plan 一致的 l2_gate_manifest_sha256。"
        exit 2
    }

    $l2Sha = ''
    if ($frontmatter -match '(?m)^l2_verified_sha:\s*([0-9a-fA-F]{40})[ \t]*(?:#.*)?$') { $l2Sha = $Matches[1] }
    if (-not $l2Sha -or -not (Test-KixSha $l2Sha)) {
        Write-DenyResult "$sprintName 缺少完整 40 位 l2_verified_sha，无法证明 L2 结果对应当前代码。"
        exit 2
    }
    $qaStartedSha = ''
    if ($handoffPrompt -match '(?im)^[ \t]*qa_started_sha:\s*([0-9a-fA-F]{40})[ \t]*(?:#.*)?$') { $qaStartedSha = $Matches[1] }
    try {
        $currentSha = (git -C $projectRoot rev-parse HEAD 2>$null | Select-Object -First 1).Trim()
        if (-not $currentSha -or -not $currentSha.Equals($l2Sha, [System.StringComparison]::OrdinalIgnoreCase)) {
            Write-DenyResult "$sprintName 的 L2 验证 SHA（$l2Sha）与当前 HEAD（$currentSha）不一致。请重跑 L2。"
            exit 2
        }
        if (-not $qaStartedSha -or -not $qaStartedSha.Equals($currentSha, [System.StringComparison]::OrdinalIgnoreCase)) {
            Write-DenyResult "$sprintName 的 QA handoff 必须携带与 l2_verified_sha/HEAD 相同的完整 qa_started_sha。"
            exit 2
        }
        $l2StashScalar = Get-KixYamlScalar -Text $frontmatter -Key 'l2_stash_refs'
        if ($frontmatter -notmatch '(?m)^[ \t]*l2_stash_refs:\s*' -or $l2StashScalar -in @('null', '~')) {
            Write-DenyResult "$sprintName 缺少 L2 完成时的 l2_stash_refs 基线；必须重新运行 L2。"
            exit 2
        }
        $l2StashRefs = @(Get-KixYamlList -Text $frontmatter -Key 'l2_stash_refs' | Sort-Object -Unique)
        if ($l2StashRefs | Where-Object { -not (Test-KixSha $_) }) {
            Write-DenyResult "$sprintName 的 l2_stash_refs 包含无效 stash SHA；必须重新运行 L2。"
            exit 2
        }
        $currentStashRefs = @(Get-KixGitStashRefs -ProjectRoot $projectRoot)
        if (($l2StashRefs -join "`n") -ne ($currentStashRefs -join "`n")) {
            Write-DenyResult "$sprintName 在 L2 记录后 git stash 状态发生变化；必须恢复并重新运行全部 L2。"
            exit 2
        }
        $nonDocChanges = git -c core.quotepath=false -C $projectRoot status --porcelain 2>$null |
            ForEach-Object { if ($_.Length -ge 4) { $_.Substring(3).Trim('"') } } |
            Where-Object { $_ -and $_ -notmatch '^(docs/|PROJECT_BRIEF\.md$|\.kixpower/memory/repo/.*\.md$)' }
        if ($nonDocChanges) {
            Write-DenyResult "$sprintName 在 L2 后仍有未验证的非文档变更。提交并重跑 L2 后再交接 QA。"
            exit 2
        }

        $qaSessionMarker = Join-Path $projectRoot 'docs/.kixpower-qa-session.json'
        $qaStashRefs = @(Get-KixGitStashRefs -ProjectRoot $projectRoot)
        $reverifyMarker = Join-Path $projectRoot 'docs/.kixpower-qa-reverify.json'
        if (Test-Path $reverifyMarker) {
            try {
                $reverifyRecord = Get-Content -LiteralPath $reverifyMarker -Raw -ErrorAction Stop | ConvertFrom-Json
                $reverifyBaseline = [string]$reverifyRecord.baseline_l2_sha
                if (-not (Test-KixSha $reverifyBaseline) -or $reverifyBaseline.Equals($currentSha, [System.StringComparison]::OrdinalIgnoreCase)) {
                    Write-DenyResult "QA reverify marker 仍绑定当前 L2 revision；必须先在新 revision 完成全量 L2。"
                    exit 2
                }
                Remove-Item -LiteralPath $reverifyMarker -Force -ErrorAction Stop
            } catch {
                Write-DenyResult "QA reverify marker 无法验证或清除，不能启动新的 QA revision。"
                exit 2
            }
        }
        $qaSession = [ordered]@{
            schema_version = 1
            sprint = $requestedSprint
            l2_verified_sha = $currentSha
            stash_refs = @($qaStashRefs)
            started_at = (Get-Date).ToUniversalTime().ToString('o')
        }
        try {
            $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
            [System.IO.File]::WriteAllText($qaSessionMarker, ($qaSession | ConvertTo-Json -Compress -Depth 4), $utf8NoBom)
        } catch {
            Write-DenyResult "QA session marker 写入失败，拒绝启动 QA。"
            exit 2
        }
    } catch {
        Write-DenyResult "$sprintName 无法核对 l2_verified_sha。请确认仓库状态并重跑 L2。"
        exit 2
    }
}

exit 0
