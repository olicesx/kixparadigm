# Kixpower Orchestration — Hook: Blast Radius Control
# 来源：9 Ways AI Coding Agents Break in Production (2026) — Loop blast radius 失败模式
# 单次坏 run 可能造成 30 错 commits 或 100 删 DB rows，必须在 commit 前拦截。
#
# 触发：PreToolUse on
#   - 'run_in_terminal' 当命令含 git commit/amend/push 或 DROP/DELETE FROM
#   - 'mcp_github_*_create_or_update_file' / 'mcp_github_*_delete_file'（直接写远端，绕过 git）
#   - 'create_or_update_file'（远程 GitHub MCP）
# 策略：
#   1. 统计本会话已 commit 次数（git log --since=1.hour.ago）
#   2. 超 commit_budget（默认 3，冷启动兜底）→ 阻止，提示拆分或停止
#   3. 命令含破坏性 SQL（DROP/DELETE FROM without WHERE）→ 强制要求 --dry-run 标志或拒绝
#   4. MCP GitHub 写远端必须先确认在 feature branch（防直接 push main）

$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$inputJson = $Input | Out-String
if ([string]::IsNullOrWhiteSpace($inputJson)) { exit 0 }

try {
    $hookInput = $inputJson | ConvertFrom-Json
} catch {
    [Console]::Error.WriteLine('BLAST RADIUS: hook input 不是有效 JSON，拒绝执行。')
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

function Write-AskResult([string]$reason) {
    Write-Output (@{
        hookSpecificOutput = @{
            hookEventName = "PreToolUse"
            permissionDecision = "ask"
            permissionDecisionReason = $reason
        }
    } | ConvertTo-Json -Depth 3)
}

$toolName = [string]$hookInput.tool_name
$toolLeaf = ($toolName -split '\.')[-1]
$argsObj = $hookInput.tool_input
if (Test-KixSuspiciousExecutionTool -ToolName $toolName) {
    Write-DenyResult 'BLAST RADIUS: 未登记的代码执行/脚本工具无法验证副作用，拒绝执行。'
    exit 2
}
$cmd = ''
if ($argsObj) {
    $cmd = Get-KixTerminalCommand -ToolLeaf $toolLeaf -ToolInput $argsObj
}

# 控制平面自保护：kixpower agent 不得改写自身 Agent/Skill/Prompt/全局设置后再绕过门禁。
$localEditTools = @('apply_patch','replace_string_in_file','insert_edit_into_file','edit_notebook_file','create_file','create_directory','delete_file','vscode_renameSymbol')
if ($localEditTools -contains $toolLeaf) {
    $targetPaths = [System.Collections.Generic.List[string]]::new()
    if ($toolLeaf -eq 'apply_patch' -and $hookInput.tool_input.input) {
        foreach ($match in [regex]::Matches([string]$hookInput.tool_input.input, '(?m)^\*\*\* (?:Add|Update|Delete) File:\s*(.+?)(?:\s+->.*)?\s*$')) {
            $targetPaths.Add($match.Groups[1].Value)
        }
    } else {
        foreach ($pathValue in (Get-KixPathValues -ToolInput $hookInput.tool_input)) {
            $targetPaths.Add($pathValue)
        }
    }
    if ($toolLeaf -eq 'apply_patch' -and $targetPaths.Count -eq 0 -and $hookInput.tool_input.input) {
        Write-DenyResult "CONTROL PLANE: 无法从 patch 提取目标路径，拒绝可能改写用户级控制平面。"
        exit 2
    }
    if ($targetPaths.Count -eq 0 -and $toolLeaf -in @('create_file','delete_file','replace_string_in_file','insert_edit_into_file')) {
        Write-DenyResult "CONTROL PLANE: 编辑工具未提供可验证目标路径，拒绝执行。"
        exit 2
    }

    $protectedRoots = @(
        (Join-Path $HOME '.copilot'),
        (Join-Path $env:APPDATA 'Code\User')
    ) | ForEach-Object { [System.IO.Path]::GetFullPath($_).Replace('\', '/').TrimEnd('/') }
    $protectedFiles = @(
        [System.IO.Path]::GetFullPath((Join-Path $env:APPDATA 'Code\User\settings.json')).Replace('\', '/')
    )
    foreach ($targetPath in $targetPaths) {
        $normalizedTarget = Get-KixNormalizedPath -Value ([string]$targetPath) -BasePath $hookInput.workspaceFolder
        if (-not $normalizedTarget) {
            Write-DenyResult "CONTROL PLANE: 无法规范化编辑目标路径，拒绝执行。"
            exit 2
        }
        $isProtected = $protectedFiles -contains $normalizedTarget
        foreach ($protectedRoot in $protectedRoots) {
            if ($normalizedTarget.Equals($protectedRoot, [System.StringComparison]::OrdinalIgnoreCase) -or
                $normalizedTarget.StartsWith("$protectedRoot/", [System.StringComparison]::OrdinalIgnoreCase)) {
                $isProtected = $true
                break
            }
        }
        if ($isProtected) {
            Write-DenyResult "CONTROL PLANE: 当前 kixpower agent 禁止修改用户级 Agent/Skill/Prompt/Hook/设置。请退出该 agent 后由用户在普通会话中维护。"
            exit 2
        }
    }
}

$projectRoot = $hookInput.workspaceFolder
if (-not $projectRoot) { $projectRoot = $hookInput.cwd }
if (-not $projectRoot) { $projectRoot = (Get-Location).Path }

# 工具分类
$isTerminal = $toolLeaf -in @('run_in_terminal','create_and_run_task')
$isGitHubWrite = $toolName -match '(?i)(mcp_github.*(?:create_or_update_file|delete_file|push_files)|create_or_update_file|delete_file|push_files)'
$isGitHubMutation = $toolName -match '(?i)mcp_github.*(?:_write|create_|update_|delete_|merge_|add_.*comment|assign_|fork_|push_files|request_|submit_|resolve_|unresolve_)'
$isSqlTool = $toolName -match '(?i)(dbx.*execute|sql.*execute|execute.*sql)'
$sqlFieldFound = $false
if ($isSqlTool) {
    foreach ($sqlField in @('sql', 'query', 'statement', 'command')) {
        if ($hookInput.tool_input.PSObject.Properties.Name -contains $sqlField -and $hookInput.tool_input.$sqlField) {
            $cmd = [string]$hookInput.tool_input.$sqlField
            $sqlFieldFound = $true
            break
        }
    }
    if (-not $sqlFieldFound) {
        Write-DenyResult "BLAST RADIUS: SQL mutation 工具未提供可检查的 sql/query/statement 字段，拒绝执行。"
        exit 2
    }
}
if (-not ($isTerminal -or $isGitHubWrite -or $isGitHubMutation -or $isSqlTool)) { exit 0 }

$isGitCommand = $isTerminal -and $cmd -match '(?i)\bgit(?:\.exe)?\b'
$gitParts = if ($isGitCommand) { @(Get-KixGitCommandPartsAll -Command $cmd) } else { @() }
$isGitCommit = $isGitCommand -and (Test-KixGitCommitCommand -Command $cmd)
$isGitPush = $isGitCommand -and @($gitParts | Where-Object { @('push', 'send-pack') -contains $_.subcommand }).Count -gt 0
$isTerminalSql = $isTerminal -and $cmd -match '(?i)\b(psql|mysql|mariadb|sqlite3|sqlcmd|clickhouse-client|duckdb)\b'
$terminalSqlForInspection = $cmd
$sqlRefsForInspection = @()
if ($isTerminalSql) {
    $sqlRefsForInspection = @(Get-KixSqlFileReferences -Command $cmd)
    foreach ($sqlRef in $sqlRefsForInspection) {
        $terminalSqlForInspection = $terminalSqlForInspection -replace [regex]::Escape($sqlRef.path), ' '
    }
}

$operationRoot = $projectRoot
if ($isGitCommand) {
    $gitCMatch = [regex]::Match($cmd, '(?i)\bgit(?:\.exe)?\b(?:(?![;&|]).)*?\s-C\s+(?:"([^"]+)"|''([^'']+)''|([^\s;&|]+))')
    if ($gitCMatch.Success) {
        $gitCPath = @($gitCMatch.Groups[1].Value, $gitCMatch.Groups[2].Value, $gitCMatch.Groups[3].Value) |
            Where-Object { $_ } | Select-Object -First 1
        try {
            if (-not [System.IO.Path]::IsPathRooted($gitCPath)) { $gitCPath = Join-Path $projectRoot $gitCPath }
            $operationRoot = [System.IO.Path]::GetFullPath($gitCPath)
        } catch {
            Write-DenyResult "无法解析 git -C 的目标仓库路径，拒绝执行 Git 写操作。"
            exit 2
        }
    }
}

if ($isTerminal -and $cmd -match '(?i)\b(Set-Content|Add-Content|Out-File|Clear-Content|Copy-Item|Move-Item|Remove-Item|New-Item|sed\s+-i|perl\s+-pi|tee\b)|\[(?:System\.)?IO\.File\]|::(?:WriteAllText|WriteAllBytes|AppendAllText)|>{1,2}') {
    $writesControlPlane = $false
    $protectedRootsForCommand = @(
        (Join-Path $HOME '.copilot'),
        (Join-Path $env:APPDATA 'Code\User')
    ) | ForEach-Object { [System.IO.Path]::GetFullPath($_).Replace('\', '/').TrimEnd('/') }
    foreach ($root in $protectedRootsForCommand) {
        if ($cmd -match [regex]::Escape($root) -or
            $cmd -match '(?i)(\.copilot|AppData[\\/]+Roaming[\\/]+Code[\\/]+User)' -or
            ($cmd -match '(?i)(\$HOME|\$env:USERPROFILE)' -and $cmd -match '(?i)\.copilot') -or
            ($cmd -match '(?i)\$env:APPDATA' -and $cmd -match '(?i)Code[/\\]+User')) {
            $writesControlPlane = $true
            break
        }
    }
    if ($writesControlPlane) {
        Write-DenyResult "CONTROL PLANE: 禁止通过命令改写用户级 Agent/Skill/Prompt/Hook/设置。"
        exit 2
    }
}

# === 配置（v5.0：默认值不再锚定论文均值，仅作 DAG 不可用时的冷启动兜底）===
#   v4.x 默认 5 来自「Sync_watcher 实测」+ 论文均值，是过拟合常数。
#   v5.0：commit_budget 必须由 plan.md task_sizing（DAG 的 δ 派生）提供；
#   此处 $commitBudget 仅在 plan.md/progress.md 都无 task_sizing 时的保守兜底。
$commitBudget = 3                      # 冷启动兜底（δ 未知时的保守值，非论文均值）
$commitHardCap = 10                    # 绝对硬上限（9 Ways 论文防线，真硬约束，不可配）
$commitWarnThreshold = 10              # 冷启动软警告（plan.md 的 warn_threshold=δ*3+bug_reserve 会覆盖）
$branchRequired = $true
$blockForcePush = $true
$blockDestructiveSql = $true

# 优先读 docs/sprint-*/progress.md 的 blast_radius.commit_budget（运行时实际值）
# 其次读 docs/sprint-*/plan.md 的 task_sizing.derived_commit_budget（v4.0 派生值）
# 最后回退默认 3（冷启动兜底）
$commitBudgetSource = "default"
$commitBudgetPlan = 0                  # plan.md 派生值（用于一致性检查）

$allSprintDirs = Get-ChildItem -Path (Join-Path $operationRoot "docs") -Filter "sprint-*" -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '^sprint-\d+$' } |
    Sort-Object { [int]($_.Name -replace '^sprint-','') } -Descending
$contextSprint = 0
$activeSprintFile = Join-Path $operationRoot 'docs/.kixpower-current-sprint'
if (Test-Path $activeSprintFile) {
    $activeValue = (Get-Content $activeSprintFile -Raw -ErrorAction SilentlyContinue).Trim()
    if ($activeValue -match '^\d+$') { $contextSprint = [int]$activeValue }
}
$contextBranch = git -C $operationRoot rev-parse --abbrev-ref HEAD 2>$null | Select-Object -First 1
if ($contextSprint -le 0) {
    foreach ($contextValue in @([string]$contextBranch, [string]$operationRoot)) {
        if ($contextValue -match '(?i)(?:^|[\\/])(?:kixpower[\\/])?sprint-(\d+)(?:-|[\\/]|$)') {
            $contextSprint = [int]$Matches[1]
            break
        }
    }
}
$sprintDirs = if ($contextSprint -gt 0) {
    $allSprintDirs | Where-Object { $_.Name -eq "sprint-$contextSprint" } | Select-Object -First 1
} else {
    $allSprintDirs | Select-Object -First 1
}
foreach ($sprintDir in $sprintDirs) {
    # 先读 progress.md（hook 实际生效的目标）
    $progressFile = Join-Path $sprintDir.FullName "progress.md"
    if (Test-Path $progressFile) {
        try {
            $content = Get-Content $progressFile -Raw -ErrorAction Stop
            if ($content -match '(?s)^---.*?blast_radius:[\s\S]*?commit_budget:\s*(\d+)') {
                $commitBudget = [int]$Matches[1]
                $commitBudgetSource = "progress.md"
            }
            if ($content -match '(?s)^---.*?blast_radius:[\s\S]*?branch_required:\s*(\w+)') { $branchRequired = ($Matches[1] -eq 'true') }
            if ($content -match '(?s)^---.*?blast_radius:[\s\S]*?block_force_push:\s*(\w+)') { $blockForcePush = ($Matches[1] -eq 'true') }
            if ($content -match '(?s)^---.*?blast_radius:[\s\S]*?block_destructive_sql:\s*(\w+)') { $blockDestructiveSql = ($Matches[1] -eq 'true') }
        } catch {}
    }

    # 再读 plan.md 的 task_sizing（v4.0）— 用于一致性检查 + warn_threshold 同步
    $planFile = Join-Path $sprintDir.FullName "plan.md"
    if (Test-Path $planFile) {
        try {
            $planContent = Get-Content $planFile -Raw -ErrorAction Stop
            if ($planContent -match '(?s)task_sizing:[\s\S]*?derived_commit_budget:\s*(\d+)') {
                $commitBudgetPlan = [int]$Matches[1]
                # 若 progress.md 未指定，回退到 plan.md 派生值
                if ($commitBudgetSource -eq "default") {
                    $commitBudget = $commitBudgetPlan
                    $commitBudgetSource = "plan.md(task_sizing)"
                }
            }
            if ($planContent -match '(?s)task_sizing:[\s\S]*?warn_threshold:\s*(\d+)') {
                $commitWarnThreshold = [int]$Matches[1]
            }
        } catch {}
    }
}

# 一致性警告：progress.md 和 plan.md 不一致（应该同步，但允许 Producer 暂时手动调整）
if ($commitBudgetPlan -gt 0 -and $commitBudget -ne $commitBudgetPlan -and $commitBudgetSource -eq "progress.md") {
    Write-Output (@{
        systemMessage = "⚠️ BLAST RADIUS: progress.md commit_budget=$commitBudget 与 plan.md task_sizing.derived_commit_budget=$commitBudgetPlan 不一致。`n" +
                        "建议：让 Producer 同步 progress.md 的 blast_radius.commit_budget 与 plan.md 的派生值。"
    } | ConvertTo-Json)
    # 不 block，只警告
}

# === 检查 1: Commit Budget（v4.0 三级：hard_cap 硬熔断 / budget 软阻止 / warn_threshold 软警告）===
if ($isGitCommit) {
    $gitDir = Join-Path $operationRoot ".git"
    if (Test-Path $gitDir) {
        try {
            # 用 HEAD reflog 的本地操作时间计数；不按 author/commit date 过滤，避免 --author/-c/GIT_*_DATE 伪造绕过预算。
            $recentCommits = git -C $operationRoot reflog --since="1 hour ago" --format="%H" HEAD 2>$null
            $commitCount = ($recentCommits | Measure-Object).Count

            # 硬上限：无论如何不能超（9 Ways 失控防线）
            if ($commitCount -ge $commitHardCap) {
                Write-DenyResult ("BLAST RADIUS HARD CAP: 已 commit $commitCount 次（绝对硬上限 $commitHardCap）。立即停止并拆分 Sprint；不得从 plan.md 覆盖硬上限。")
                exit 2
            }

            # 预算超限：阻止（可手动调高）
            if ($commitCount -ge $commitBudget) {
                Write-DenyResult ("BLAST RADIUS: 已 commit $commitCount 次（预算 $commitBudget，来源：$commitBudgetSource）。Producer 必须按 DAG 重算并同步预算；派生值超过 $commitHardCap 时拆分 Sprint。")
                exit 2
            }

            # 软警告：接近预算或超 warn_threshold
            if ($commitCount -ge $commitWarnThreshold -or $commitCount -ge $commitBudget - 1) {
                Write-Output (@{
                    systemMessage = "⚠️ BLAST RADIUS: 已 commit $commitCount 次（预算 $commitBudget，软警告阈值 $commitWarnThreshold）。`n" +
                                    "建议：① 复查 progress.md 是否有 silent_failure（commit 多但任务没进展）；② 若 task_sizing.warn_threshold 被触发，说明 task 拆分粒度过细。"
                } | ConvertTo-Json)
                # 不 block，只警告
            }
        } catch {}
    }
}

# === 检查 2: 危险 SQL ===
# 终端 SQL：无法可靠静态解析，含破坏性关键字一律硬拦（保守，防绕过）。
if ($blockDestructiveSql -and $isTerminalSql -and $terminalSqlForInspection -match '(?i)\b(DELETE|UPDATE|DROP|TRUNCATE|ALTER)\b') {
    Write-DenyResult "BLAST RADIUS: 终端数据库客户端中的破坏性 SQL 无法可靠静态解析。请改用结构化 DBX 工具或先在事务/只读副本中验证。"
    exit 2
}
if ($blockDestructiveSql -and $isTerminalSql) {
    $sqlRefs = $sqlRefsForInspection
    foreach ($sqlRef in $sqlRefs) {
        if (-not $sqlRef.resolvable) {
            Write-DenyResult "BLAST RADIUS: SQL 文件路径无法静态解析，拒绝执行。"
            exit 2
        }
        $sqlPath = Get-KixNormalizedPath -Value $sqlRef.path -BasePath $projectRoot
        if (-not $sqlPath -or -not (Test-Path -LiteralPath $sqlPath -PathType Leaf)) {
            Write-DenyResult "BLAST RADIUS: SQL 文件不存在或无法读取，拒绝执行。"
            exit 2
        }
        try {
            $fileSql = Get-Content -LiteralPath $sqlPath -Raw -ErrorAction Stop
        } catch {
            Write-DenyResult "BLAST RADIUS: SQL 文件无法读取，拒绝执行。"
            exit 2
        }
        $normalizedSql = [regex]::Replace($fileSql, "'(?:''|[^'])*'", ' ')
        $normalizedSql = [regex]::Replace($normalizedSql, '"(?:""|[^"])*"', ' ')
        $normalizedSql = [regex]::Replace($normalizedSql, '(?s)/\*.*?\*/', ' ')
        $normalizedSql = [regex]::Replace($normalizedSql, '(?m)(?:--|#).*$', ' ')
        if ($normalizedSql -match '(?i)\b(DROP|TRUNCATE|ALTER)\b') {
            Write-DenyResult "BLAST RADIUS: SQL 文件包含破坏性 DDL（DROP/TRUNCATE/ALTER）。"
            exit 2
        }
        foreach ($statement in ($normalizedSql -split ';')) {
            if (($statement -match '(?i)\bDELETE\b[^;]*?\bFROM\b' -or
                 $statement -match '(?i)\bUPDATE\b[^;]*?\bSET\b') -and
                $statement -notmatch '(?i)\bWHERE\b') {
                Write-DenyResult "BLAST RADIUS: SQL 文件包含 DELETE/UPDATE without WHERE。"
                exit 2
            }
        }
    }
}
# DBX 结构化工具：只做确定性判断（0% 误报）；方言/注释可能伪造 WHERE 时交用户确认。
if ($blockDestructiveSql -and $isSqlTool) {
    $sqlToInspect = $cmd
    $sqlToInspect = [regex]::Replace($sqlToInspect, "'(?:''|[^'])*'", "''")
    $sqlToInspect = [regex]::Replace($sqlToInspect, '"(?:""|[^"])*"', '""')
    $sqlToInspect = [regex]::Replace($sqlToInspect, '(?s)/\*.*?\*/', ' ')
    $sqlToInspect = [regex]::Replace($sqlToInspect, '(?m)(?:--|#).*$', ' ')
    $hasDestructiveKeyword = $sqlToInspect -match '(?i)\b(DELETE|UPDATE|DROP|TRUNCATE|ALTER)\b'
    if ($sqlToInspect -match '(?i)\b(DROP|TRUNCATE|ALTER)\b') {
        Write-DenyResult "BLAST RADIUS: 检测到破坏性 DDL（DROP/TRUNCATE/ALTER）。确认目标对象后再操作。"
        exit 2
    }
    foreach ($statement in ($sqlToInspect -split ';')) {
        if (($statement -match '(?i)\bDELETE\b[^;]*?\bFROM\b' -or $statement -match '(?i)\bUPDATE\b[^;]*?\bSET\b') -and
            $statement -notmatch '(?i)\bWHERE\b') {
            Write-DenyResult "BLAST RADIUS: 检测到 DELETE/UPDATE without WHERE。加 WHERE，或先在事务中验证并回滚。"
            exit 2
        }
    }
    # 有破坏性关键字但无法确定性证明安全 → 交用户确认（人类确认点，不承诺 0% 误报）。
    if ($hasDestructiveKeyword) {
        Write-AskResult "BLAST RADIUS: 检测到破坏性 SQL，且静态无法确定性确认影响范围。请确认目标表、影响行数与回滚方案。"
        exit 0
    }
}

# === 检查 3: Force push ===
if ($blockForcePush -and $isGitPush -and
    ($cmd -match '(?i)(?<![\w-])--force(?:=(?:true|1))?(?![\w-])' -or
     $cmd -match '(?i)(?<!\S)-f(?!\S)' -or
    $cmd -match '(?i)\bpush\b[^;&|]*\s\+\S+' -or
    $cmd -match '(?i)(?<![\w-])--mirror(?![\w-])')) {
    Write-DenyResult "BLAST RADIUS: git push --force 会重写远端历史。需用户明确确认；优先使用 --force-with-lease 或 git revert。"
    exit 2
}

# reset/clean/强制删分支等会丢失本地工作，必须由用户逐次确认。
if ($isGitCommand -and $cmd -match '(?i)\bgit(?:\.exe)?\b(?:(?![;&|]).)*\b(?:reset\s+--hard|clean\b[^;&|]*-[a-z]*f|branch\s+-D|stash\s+(?:drop|clear)|checkout\s+--|restore\b)') {
    Write-AskResult "检测到会丢失本地工作的 Git 操作。请确认目标仓库、分支和待丢弃内容。"
    exit 0
}

# 直接推送 main/master 会绕过 PR；其他非 force push 也属于共享系统写操作，需确认。
if ($isGitPush) {
    $pushesProtected = $false
    foreach ($pushPart in @($gitParts | Where-Object { @('push', 'send-pack') -contains $_.subcommand })) {
        $nonOptions = @($pushPart.arguments | Where-Object { $_ -and -not $_.StartsWith('-') })
        $implicitPushToMain = ($contextBranch -eq 'main' -or $contextBranch -eq 'master') -and
            ($nonOptions.Count -le 1 -or ($nonOptions.Count -ge 2 -and $nonOptions[-1] -match '^(?i:HEAD|@)$'))
        $explicitProtectedRef = @($pushPart.arguments | Where-Object { $_ -match '(?i)(?<![\w/-])(main|master)(?![\w/-])|refs/heads/(?:main|master)' }).Count -gt 0
        $pushAll = @($pushPart.arguments | Where-Object { $_ -match '^(?i:--all)$' }).Count -gt 0
        if ($implicitPushToMain -or $explicitProtectedRef -or $pushAll) { $pushesProtected = $true; break }
    }
    if ($pushesProtected) {
        Write-DenyResult "BLAST RADIUS: 禁止直接 push 到 main/master。请推送 feature 分支并通过 PR 合并。"
        exit 2
    }
    Write-AskResult "git push 会写入共享远端。确认远端、源分支和目标分支后再继续。"
    exit 0
}

# === 检查 4: 必须在 feature branch ===
if ($branchRequired -and $isGitCommit) {
    try {
        $branch = git -C $operationRoot rev-parse --abbrev-ref HEAD 2>$null
        if ($branch -eq 'main' -or $branch -eq 'master') {
            Write-DenyResult "BLAST RADIUS: 禁止在 $branch 分支直接 commit。先创建 feature 分支并通过 PR/MR 合并。"
            exit 2
        }
    } catch {}
}

# === 检查 5: MCP GitHub 直接写远端（绕过 git 工作流）===
if ($isGitHubWrite) {
    # 提取目标 branch（如果工具参数含 branch）
    $targetBranch = $hookInput.tool_input.branch
    if (-not $targetBranch) { $targetBranch = $hookInput.tool_input.target_branch }
    if (-not $targetBranch) { $targetBranch = $hookInput.tool_input.ref }
    if (-not $targetBranch) {
        Write-DenyResult "BLAST RADIUS: GitHub 远程写入未提供目标 branch，无法确认不是 main/master。请显式提供 feature branch。"
        exit 2
    }
    if ($targetBranch -and ($targetBranch -eq 'main' -or $targetBranch -eq 'master')) {
        Write-DenyResult "BLAST RADIUS: 禁止通过 GitHub 工具直接写 main/master。写入 feature 分支并通过 PR 合并。"
        exit 2
    }
}

# GitHub 发布/合并/远程写属于共享系统副作用，即使全局 autoApprove 开启也必须让用户确认。
if ($isGitHubMutation) {
    Write-AskResult "该 GitHub 操作会写入共享系统。确认目标、内容与分支后再继续。"
    exit 0
}

exit 0
