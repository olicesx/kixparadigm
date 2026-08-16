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
#
# v6.1（2026-08-16，kix-vscode-mechanism-audit.md 驱动）：
#   - 多载荷形态解析（修复静默放行）：真实运行时（copilot-agent 1.0.70+）preToolUse
#     载荷是 `toolCalls:[{id,name,args}]` 数组（args 为 JSON 字符串）、postToolUse 是
#     `toolName`/`toolArgs`（toolArgs 为 JSON 字符串）；旧格式是 `tool_name`/`tool_input`。
#     本版三形态全兼容：先归一化为调用列表，逐个跑门禁，deny > ask > allow 聚合输出。
#   - 工具名归一：运行时名（powershell/bash/edit/create/view/grep/glob/ask_user/task/
#     web_fetch/web_search）+ Claude 名（Bash/Read/Write/Edit/Grep/Glob/WebFetch/
#     WebSearch/AskUserQuestion/TodoWrite/Agent）+ 旧扩展名（run_in_terminal/...）同时认。
#   - GitHub 工具名加 `GitHub-*` 前缀匹配（真实运行时 MCP 命名），保留旧 `mcp_github_*`。
#   - 崩溃 fail-closed：解析/判定异常 → 输出 deny + exit 2，绝不 exit 0 静默放行。
#   - 输出契约：仍输出嵌套 hookSpecificOutput（VS Code Chat 扩展面）；CLI/cloud 官方为
#     顶层 permissionDecision——需按目标运行时二选一（见 audit §5 P0）。

$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$contractScript = Join-Path $PSScriptRoot '..\scripts\kixpower-contract.ps1'
if (Test-Path $contractScript) { . (Resolve-Path $contractScript) }

function New-KixDenyJson([string]$reason) {
    return (@{
        hookSpecificOutput = @{
            hookEventName = "PreToolUse"
            permissionDecision = "deny"
            permissionDecisionReason = $reason
        }
    } | ConvertTo-Json -Depth 3)
}

function New-KixAskJson([string]$reason) {
    return (@{
        hookSpecificOutput = @{
            hookEventName = "PreToolUse"
            permissionDecision = "ask"
            permissionDecisionReason = $reason
        }
    } | ConvertTo-Json -Depth 3)
}

# ── v6.1 工具名归一：真实运行时名 / Claude 名 / 旧扩展名 ──────────────────────
# 返回小写规范工具名（供分类匹配），无法识别时原样小写返回。
# 注意：PowerShell 哈希键大小写不敏感，Claude 名（Bash/Edit/...）与运行时名
# （bash/edit/...）同键——统一小写键，同一工具只保留一行（Claude 名 ToLower 后
# 命中运行时名键；Read→view、Write→create、WebFetch→web_fetch 等映射单独成键）。
function Get-KixCanonicalToolName {
    param([AllowNull()][string]$ToolName)
    if ([string]::IsNullOrWhiteSpace($ToolName)) { return '' }
    $name = $ToolName.Trim()
    $leaf = ($name -split '\.')[-1]
    $map = @{
        # 运行时名（即 Claude 名 ToLower 同键：bash/edit/grep/glob/task 等）
        'powershell' = 'powershell'; 'bash' = 'bash'; 'edit' = 'edit'; 'create' = 'create'
        'view' = 'view'; 'grep' = 'grep'; 'glob' = 'glob'; 'ask_user' = 'ask_user'
        'task' = 'task'; 'web_fetch' = 'web_fetch'; 'web_search' = 'web_search'
        'update_todo' = 'update_todo'; 'read_powershell' = 'read_powershell'
        'stop_powershell' = 'stop_powershell'
        'sql' = 'sql'; 'skill' = 'skill'
        # Claude 名 → 运行时名（PascalCase PreToolUse 载荷下的 tool_name）
        'read' = 'view'; 'write' = 'create'; 'webfetch' = 'web_fetch'
        'websearch' = 'web_search'; 'askuserquestion' = 'ask_user'
        'todowrite' = 'update_todo'; 'agent' = 'task'
        # 旧扩展名（保留兼容）
        'run_in_terminal' = 'run_in_terminal'; 'create_and_run_task' = 'create_and_run_task'
        'replace_string_in_file' = 'replace_string_in_file'
        'insert_edit_into_file' = 'insert_edit_into_file'
        'edit_notebook_file' = 'edit_notebook_file'
        'apply_patch' = 'apply_patch'
        'create_file' = 'create_file'; 'create_directory' = 'create_directory'
        'delete_file' = 'delete_file'; 'vscode_renamesymbol' = 'vscode_renameSymbol'
        'runsubagent' = 'runSubagent'; 'explore_subagent' = 'explore_subagent'
        'read_file' = 'read_file'
        'grep_search' = 'grep_search'; 'semantic_search' = 'semantic_search'
        'file_search' = 'file_search'; 'list_dir' = 'list_dir'
        'manage_todo_list' = 'manage_todo_list'; 'vscode_askquestions' = 'vscode_askQuestions'
        'run_notebook_cell' = 'run_notebook_cell'; 'get_terminal_output' = 'get_terminal_output'
    }
    if ($map.ContainsKey($leaf.ToLowerInvariant())) { return $map[$leaf.ToLowerInvariant()] }
    if ($map.ContainsKey($name.ToLowerInvariant())) { return $map[$name.ToLowerInvariant()] }
    return $leaf.ToLowerInvariant()
}

# ── v6.1 载荷归一：把任意形态输入归一为调用列表（deny > ask > allow 聚合用）────
# 返回 @( @{ toolName; toolInput; toolArgsRaw } )
function Get-KixNormalizedToolCalls {
    param($HookInput)
    $calls = [System.Collections.Generic.List[object]]::new()
    if ($null -eq $HookInput) { return @($calls) }

    # 形态 1：真实运行时 preToolUse —— toolCalls 数组（name + args JSON 字符串）
    $toolCalls = $HookInput.PSObject.Properties.Name -contains 'toolCalls' ? $HookInput.toolCalls : $null
    if ($toolCalls) {
        foreach ($call in @($toolCalls)) {
            if ($null -eq $call) { continue }
            $name = [string]$call.name
            $input = $null
            $raw = $null
            if ($null -ne $call.args) {
                $raw = [string]$call.args
                try { $input = $raw | ConvertFrom-Json } catch { $input = $null }
            }
            $calls.Add(@{ toolName = $name; toolInput = $input; toolArgsRaw = $raw })
        }
        return @($calls)
    }

    # 形态 2：camelCase 单值（官方）—— toolName + toolArgs（toolArgs 为 JSON 字符串）
    if ($HookInput.PSObject.Properties.Name -contains 'toolName') {
        $name = [string]$HookInput.toolName
        $input = $null
        $raw = $null
        if ($null -ne $HookInput.toolArgs) {
            $raw = [string]$HookInput.toolArgs
            try { $input = $raw | ConvertFrom-Json } catch { $input = $null }
        }
        $calls.Add(@{ toolName = $name; toolInput = $input; toolArgsRaw = $raw })
        return @($calls)
    }

    # 形态 3：snake_case（VS Code compatible / 旧格式）—— tool_name + tool_input
    $name = [string]$HookInput.tool_name
    $input = $HookInput.tool_input
    if ($input -is [string]) {
        $raw = $input
        try { $input = $raw | ConvertFrom-Json } catch { $input = $null }
    }
    $calls.Add(@{ toolName = $name; toolInput = $input; toolArgsRaw = $null })
    return @($calls)
}

# ── v6.1 单调用门禁（原 blast-radius 主体；deny/ask 返回 JSON，allow 返回 $null）──
function Invoke-KixBlastRadiusCall {
    param(
        [string]$ToolName,
        $ToolInput,
        [AllowNull()][string]$WorkspaceFolder,
        [AllowNull()][string]$Cwd
    )
    try {
        $toolName = $ToolName
        $toolCanonical = Get-KixCanonicalToolName -ToolName $toolName
        $toolLeaf = $toolCanonical
        $argsObj = $ToolInput
        if (Test-KixSuspiciousExecutionTool -ToolName $toolName -Canonical $toolCanonical) {
            return (New-KixDenyJson 'BLAST RADIUS: 未登记的代码执行/脚本工具无法验证副作用，拒绝执行。')
        }
        $cmd = ''
        if ($argsObj) {
            $cmd = Get-KixTerminalCommand -ToolLeaf $toolLeaf -ToolInput $argsObj
            if (-not $cmd -and $argsObj.command) { $cmd = [string]$argsObj.command }
        }
        if (-not $cmd -and $argsObj -is [System.Management.Automation.PSCustomObject]) {
            # run_code / 程序化工具：toolInput 可能带 code/sql 字段
            if ($argsObj.PSObject.Properties.Name -contains 'code') { $cmd = [string]$argsObj.code }
        }

        # 控制平面自保护：kixpower agent 不得改写自身 Agent/Skill/Prompt/全局设置后再绕过门禁。
        $localEditTools = @('apply_patch','replace_string_in_file','insert_edit_into_file','edit_notebook_file','create_file','create_directory','delete_file','vscode_renameSymbol','edit','create','write')
        if ($localEditTools -contains $toolCanonical) {
            $targetPaths = [System.Collections.Generic.List[string]]::new()
            if ($toolCanonical -eq 'apply_patch' -and $argsObj.input) {
                foreach ($match in [regex]::Matches([string]$argsObj.input, '(?m)^\*\*\* (?:Add|Update|Delete) File:\s*(.+?)(?:\s+->.*)?\s*$')) {
                    $targetPaths.Add($match.Groups[1].Value)
                }
            } else {
                foreach ($pathValue in (Get-KixPathValues -ToolInput $argsObj)) {
                    $targetPaths.Add($pathValue)
                }
            }
            if ($toolCanonical -eq 'apply_patch' -and $targetPaths.Count -eq 0 -and $argsObj.input) {
                return (New-KixDenyJson "CONTROL PLANE: 无法从 patch 提取目标路径，拒绝可能改写用户级控制平面。")
            }
            if ($targetPaths.Count -eq 0 -and $toolCanonical -in @('create_file','delete_file','replace_string_in_file','insert_edit_into_file')) {
                return (New-KixDenyJson "CONTROL PLANE: 编辑工具未提供可验证目标路径，拒绝执行。")
            }

            $protectedRoots = @(
                (Join-Path $HOME '.copilot'),
                (Join-Path $env:APPDATA 'Code\User')
            ) | ForEach-Object { [System.IO.Path]::GetFullPath($_).Replace('\', '/').TrimEnd('/') }
            $protectedFiles = @(
                [System.IO.Path]::GetFullPath((Join-Path $env:APPDATA 'Code\User\settings.json')).Replace('\', '/')
            )
            foreach ($targetPath in $targetPaths) {
                $base = $WorkspaceFolder
                if (-not $base) { $base = $Cwd }
                $normalizedTarget = Get-KixNormalizedPath -Value ([string]$targetPath) -BasePath $base
                if (-not $normalizedTarget) {
                    return (New-KixDenyJson "CONTROL PLANE: 无法规范化编辑目标路径，拒绝执行。")
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
                    return (New-KixDenyJson "CONTROL PLANE: 当前 kixpower agent 禁止修改用户级 Agent/Skill/Prompt/Hook/设置。请退出该 agent 后由用户在普通会话中维护。")
                }
            }
        }

        $projectRoot = $WorkspaceFolder
        if (-not $projectRoot) { $projectRoot = $Cwd }
        if (-not $projectRoot) { $projectRoot = (Get-Location).Path }

        # 工具分类
        $isTerminal = $toolCanonical -in @('run_in_terminal','create_and_run_task','powershell','bash')
        $isGitHubWrite = $toolName -match '(?i)(mcp_github.*(?:create_or_update_file|delete_file|push_files)|GitHub-(?:create_or_update_file|delete_file|push_files)|create_or_update_file|delete_file|push_files)'
        $isGitHubMutation = $toolName -match '(?i)(mcp_github.*(?:_write|create_|update_|delete_|merge_|add_.*comment|assign_|fork_|push_files|request_|submit_|resolve_|unresolve_)|GitHub-(?:add_issue_comment|create_issue|create_pull_request|create_pull_request_review|create_repository|create_branch|update_issue|update_pull_request_branch|merge_pull_request|fork_repository))'
        $isSqlTool = $toolName -match '(?i)(dbx.*execute|sql.*execute|execute.*sql)'
        $sqlFieldFound = $false
        if ($isSqlTool) {
            foreach ($sqlField in @('sql', 'query', 'statement', 'command')) {
                if ($argsObj.PSObject.Properties.Name -contains $sqlField -and $argsObj.$sqlField) {
                    $cmd = [string]$argsObj.$sqlField
                    $sqlFieldFound = $true
                    break
                }
            }
            if (-not $sqlFieldFound) {
                return (New-KixDenyJson "BLAST RADIUS: SQL mutation 工具未提供可检查的 sql/query/statement 字段，拒绝执行。")
            }
        }
        if (-not ($isTerminal -or $isGitHubWrite -or $isGitHubMutation -or $isSqlTool)) { return $null }

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
                    return (New-KixDenyJson "无法解析 git -C 的目标仓库路径，拒绝执行 Git 写操作。")
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
                return (New-KixDenyJson "CONTROL PLANE: 禁止通过命令改写用户级 Agent/Skill/Prompt/Hook/设置。")
            }
        }

        # === 配置（v5.0：默认值不再锚定论文均值，仅作 DAG 不可用时的冷启动兜底）===
        $commitBudget = 3                      # 冷启动兜底（δ 未知时的保守值，非论文均值）
        $commitHardCap = 10                    # 绝对硬上限（9 Ways 论文防线，真硬约束，不可配）
        $commitWarnThreshold = 10              # 冷启动软警告（plan.md 的 warn_threshold=δ*3+bug_reserve 会覆盖）
        $branchRequired = $true
        $blockForcePush = $true
        $blockDestructiveSql = $true

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

            $planFile = Join-Path $sprintDir.FullName "plan.md"
            if (Test-Path $planFile) {
                try {
                    $planContent = Get-Content $planFile -Raw -ErrorAction Stop
                    if ($planContent -match '(?s)task_sizing:[\s\S]*?derived_commit_budget:\s*(\d+)') {
                        $commitBudgetPlan = [int]$Matches[1]
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

        # 一致性警告：progress.md 和 plan.md 不一致（不 block，只警告）
        if ($commitBudgetPlan -gt 0 -and $commitBudget -ne $commitBudgetPlan -and $commitBudgetSource -eq "progress.md") {
            Write-Output (@{
                systemMessage = "⚠️ BLAST RADIUS: progress.md commit_budget=$commitBudget 与 plan.md task_sizing.derived_commit_budget=$commitBudgetPlan 不一致。`n" +
                                "建议：让 Producer 同步 progress.md 的 blast_radius.commit_budget 与 plan.md 的派生值。"
            } | ConvertTo-Json)
        }

        # === 检查 1: Commit Budget ===
        if ($isGitCommit) {
            $gitDir = Join-Path $operationRoot ".git"
            if (Test-Path $gitDir) {
                try {
                    $recentCommits = git -C $operationRoot reflog --since="1 hour ago" --format="%H" HEAD 2>$null
                    $commitCount = ($recentCommits | Measure-Object).Count

                    if ($commitCount -ge $commitHardCap) {
                        return (New-KixDenyJson ("BLAST RADIUS HARD CAP: 已 commit $commitCount 次（绝对硬上限 $commitHardCap）。立即停止并拆分 Sprint；不得从 plan.md 覆盖硬上限。"))
                    }

                    if ($commitCount -ge $commitBudget) {
                        return (New-KixDenyJson ("BLAST RADIUS: 已 commit $commitCount 次（预算 $commitBudget，来源：$commitBudgetSource）。Producer 必须按 DAG 重算并同步预算；派生值超过 $commitHardCap 时拆分 Sprint。"))
                    }

                    if ($commitCount -ge $commitWarnThreshold -or $commitCount -ge $commitBudget - 1) {
                        Write-Output (@{
                            systemMessage = "⚠️ BLAST RADIUS: 已 commit $commitCount 次（预算 $commitBudget，软警告阈值 $commitWarnThreshold）。`n" +
                                            "建议：① 复查 progress.md 是否有 silent_failure（commit 多但任务没进展）；② 若 task_sizing.warn_threshold 被触发，说明 task 拆分粒度过细。"
                        } | ConvertTo-Json)
                    }
                } catch {}
            }
        }

        # === 检查 2: 危险 SQL ===
        if ($blockDestructiveSql -and $isTerminalSql -and $terminalSqlForInspection -match '(?i)\b(DELETE|UPDATE|DROP|TRUNCATE|ALTER)\b') {
            return (New-KixDenyJson "BLAST RADIUS: 终端数据库客户端中的破坏性 SQL 无法可靠静态解析。请改用结构化 DBX 工具或先在事务/只读副本中验证。")
        }
        if ($blockDestructiveSql -and $isTerminalSql) {
            $sqlRefs = $sqlRefsForInspection
            foreach ($sqlRef in $sqlRefs) {
                if (-not $sqlRef.resolvable) {
                    return (New-KixDenyJson "BLAST RADIUS: SQL 文件路径无法静态解析，拒绝执行。")
                }
                $sqlPath = Get-KixNormalizedPath -Value $sqlRef.path -BasePath $projectRoot
                if (-not $sqlPath -or -not (Test-Path -LiteralPath $sqlPath -PathType Leaf)) {
                    return (New-KixDenyJson "BLAST RADIUS: SQL 文件不存在或无法读取，拒绝执行。")
                }
                try {
                    $fileSql = Get-Content -LiteralPath $sqlPath -Raw -ErrorAction Stop
                } catch {
                    return (New-KixDenyJson "BLAST RADIUS: SQL 文件无法读取，拒绝执行。")
                }
                $normalizedSql = [regex]::Replace($fileSql, "'(?:''|[^'])*'", ' ')
                $normalizedSql = [regex]::Replace($normalizedSql, '"(?:""|[^"])*"', ' ')
                $normalizedSql = [regex]::Replace($normalizedSql, '(?s)/\*.*?\*/', ' ')
                $normalizedSql = [regex]::Replace($normalizedSql, '(?m)(?:--|#).*$', ' ')
                if ($normalizedSql -match '(?i)\b(DROP|TRUNCATE|ALTER)\b') {
                    return (New-KixDenyJson "BLAST RADIUS: SQL 文件包含破坏性 DDL（DROP/TRUNCATE/ALTER）。")
                }
                foreach ($statement in ($normalizedSql -split ';')) {
                    if (($statement -match '(?i)\bDELETE\b[^;]*?\bFROM\b' -or
                         $statement -match '(?i)\bUPDATE\b[^;]*?\bSET\b') -and
                        $statement -notmatch '(?i)\bWHERE\b') {
                        return (New-KixDenyJson "BLAST RADIUS: SQL 文件包含 DELETE/UPDATE without WHERE。")
                    }
                }
            }
        }
        if ($blockDestructiveSql -and $isSqlTool) {
            $sqlToInspect = $cmd
            $sqlToInspect = [regex]::Replace($sqlToInspect, "'(?:''|[^'])*'", "''")
            $sqlToInspect = [regex]::Replace($sqlToInspect, '"(?:""|[^"])*"', '""')
            $sqlToInspect = [regex]::Replace($sqlToInspect, '(?s)/\*.*?\*/', ' ')
            $sqlToInspect = [regex]::Replace($sqlToInspect, '(?m)(?:--|#).*$', ' ')
            $hasDestructiveKeyword = $sqlToInspect -match '(?i)\b(DELETE|UPDATE|DROP|TRUNCATE|ALTER)\b'
            if ($sqlToInspect -match '(?i)\b(DROP|TRUNCATE|ALTER)\b') {
                return (New-KixDenyJson "BLAST RADIUS: 检测到破坏性 DDL（DROP/TRUNCATE/ALTER）。确认目标对象后再操作。")
            }
            foreach ($statement in ($sqlToInspect -split ';')) {
                if (($statement -match '(?i)\bDELETE\b[^;]*?\bFROM\b' -or $statement -match '(?i)\bUPDATE\b[^;]*?\bSET\b') -and
                    $statement -notmatch '(?i)\bWHERE\b') {
                    return (New-KixDenyJson "BLAST RADIUS: 检测到 DELETE/UPDATE without WHERE。加 WHERE，或先在事务中验证并回滚。")
                }
            }
            if ($hasDestructiveKeyword) {
                return (New-KixAskJson "BLAST RADIUS: 检测到破坏性 SQL，且静态无法确定性确认影响范围。请确认目标表、影响行数与回滚方案。")
            }
        }

        # === 检查 3: Force push ===
        if ($blockForcePush -and $isGitPush -and
            ($cmd -match '(?i)(?<![\w-])--force(?:=(?:true|1))?(?![\w-])' -or
             $cmd -match '(?i)(?<!\S)-f(?!\S)' -or
            $cmd -match '(?i)\bpush\b[^;&|]*\s\+\S+' -or
            $cmd -match '(?i)(?<![\w-])--mirror(?![\w-])')) {
            return (New-KixDenyJson "BLAST RADIUS: git push --force 会重写远端历史。需用户明确确认；优先使用 --force-with-lease 或 git revert。")
        }

        # reset/clean/强制删分支等会丢失本地工作，必须由用户逐次确认。
        if ($isGitCommand -and $cmd -match '(?i)\bgit(?:\.exe)?\b(?:(?![;&|]).)*\b(?:reset\s+--hard|clean\b[^;&|]*-[a-z]*f|branch\s+-D|stash\s+(?:drop|clear)|checkout\s+--|restore\b)') {
            return (New-KixAskJson "检测到会丢失本地工作的 Git 操作。请确认目标仓库、分支和待丢弃内容。")
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
                return (New-KixDenyJson "BLAST RADIUS: 禁止直接 push 到 main/master。请推送 feature 分支并通过 PR 合并。")
            }
            return (New-KixAskJson "git push 会写入共享远端。确认远端、源分支和目标分支后再继续。")
        }

        # === 检查 4: 必须在 feature branch ===
        if ($branchRequired -and $isGitCommit) {
            try {
                $branch = git -C $operationRoot rev-parse --abbrev-ref HEAD 2>$null
                if ($branch -eq 'main' -or $branch -eq 'master') {
                    return (New-KixDenyJson "BLAST RADIUS: 禁止在 $branch 分支直接 commit。先创建 feature 分支并通过 PR/MR 合并。")
                }
            } catch {}
        }

        # === 检查 5: MCP GitHub 直接写远端（绕过 git 工作流）===
        if ($isGitHubWrite) {
            $targetBranch = $argsObj.branch
            if (-not $targetBranch) { $targetBranch = $argsObj.target_branch }
            if (-not $targetBranch) { $targetBranch = $argsObj.ref }
            if (-not $targetBranch) {
                return (New-KixDenyJson "BLAST RADIUS: GitHub 远程写入未提供目标 branch，无法确认不是 main/master。请显式提供 feature branch。")
            }
            if ($targetBranch -and ($targetBranch -eq 'main' -or $targetBranch -eq 'master')) {
                return (New-KixDenyJson "BLAST RADIUS: 禁止通过 GitHub 工具直接写 main/master。写入 feature 分支并通过 PR 合并。")
            }
        }

        # GitHub 发布/合并/远程写属于共享系统副作用，即使全局 autoApprove 开启也必须让用户确认。
        if ($isGitHubMutation) {
            return (New-KixAskJson "该 GitHub 操作会写入共享系统。确认目标、内容与分支后再继续。")
        }

        return $null
    } catch {
        # v6.1：崩溃 fail-closed——解析/判定异常绝不静默放行
        return (New-KixDenyJson "BLAST RADIUS: 门禁判定异常（$($_.Exception.Message)），fail-closed 拒绝执行。")
    }
}

# ── 主入口：读 stdin → 归一化 → 逐调用判定 → deny > ask > allow 聚合 ──────────
$inputJson = $Input | Out-String
if ([string]::IsNullOrWhiteSpace($inputJson)) { exit 0 }

$hookInput = $null
try {
    $hookInput = $inputJson | ConvertFrom-Json
} catch {
    [Console]::Error.WriteLine('BLAST RADIUS: hook input 不是有效 JSON，拒绝执行。')
    exit 2
}

$calls = @(Get-KixNormalizedToolCalls -HookInput $hookInput)
if ($calls.Count -eq 0) { exit 0 }

$workspaceFolder = [string]$hookInput.workspaceFolder
$cwd = [string]$hookInput.cwd
if (-not $workspaceFolder) { $workspaceFolder = $cwd }

$denyJson = $null
$askJson = $null
foreach ($call in $calls) {
    $decision = Invoke-KixBlastRadiusCall -ToolName ([string]$call.toolName) -ToolInput $call.toolInput -WorkspaceFolder $workspaceFolder -Cwd $cwd
    if ($null -eq $decision) { continue }
    if ($decision -match '"permissionDecision"\s*:\s*"deny"') {
        $denyJson = $decision
        break   # deny 优先，无需再看其余调用
    }
    if ($null -eq $askJson -and $decision -match '"permissionDecision"\s*:\s*"ask"') {
        $askJson = $decision
    }
}

if ($denyJson) {
    Write-Output $denyJson
    exit 2
}
if ($askJson) {
    Write-Output $askJson
    exit 0
}
exit 0
