# Kixpower Orchestration — Hook: Block Source Code Edits (QA variant)
# 从 stdin 读取 JSON，拦截 QA agent 对业务源代码的编辑操作
# 与 block-source-edit.ps1 的区别：放行测试文件（*.test.*、*.spec.*、tests/、e2e/、__tests__/）
# 优化：① 只对编辑类工具检查 ②适配绝对路径与 workspace 相对路径

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
    [Console]::Error.WriteLine('QA SOURCE BOUNDARY: hook input 不是有效 JSON，拒绝编辑。')
    exit 2
}

$contractScript = Join-Path $PSScriptRoot '..\scripts\kixpower-contract.ps1'
if (-not (Test-Path $contractScript)) {
    [Console]::Error.WriteLine('QA SOURCE BOUNDARY: contract helper 缺失，拒绝编辑。')
    exit 2
}
. (Resolve-Path $contractScript)

$toolName = [string]$hookInput.tool_name
$toolLeaf = ($toolName -split '\.')[-1]
$argsObj = $hookInput.tool_input
if (-not $argsObj) { exit 0 }

if (Test-KixSuspiciousExecutionTool -ToolName $toolName) {
    $result = @{ hookSpecificOutput = @{ hookEventName = "PreToolUse"; permissionDecision = "deny"; permissionDecisionReason = "QA 禁止使用未登记的代码执行/脚本工具；请使用受边界检查的终端或测试工具。" } }
    Write-Output ($result | ConvertTo-Json -Depth 3)
    exit 2
}

$blockedExecutionTools = @('create_and_run_task','create_new_workspace','create_new_jupyter_notebook','run_vscode_command','run_notebook_cell','install_extension')
if ($blockedExecutionTools -contains $toolLeaf) {
    $result = @{ hookSpecificOutput = @{ hookEventName = "PreToolUse"; permissionDecision = "deny"; permissionDecisionReason = "QA 禁止使用可绕过测试/文档写边界的执行或脚手架工具。" } }
    Write-Output ($result | ConvertTo-Json -Depth 3)
    exit 2
}

# 终端只用于执行测试，不允许借 shell 写文件绕过编辑 Hook。
if ($toolLeaf -eq 'run_in_terminal') {
    $terminalCommand = Get-KixTerminalCommand -ToolLeaf $toolLeaf -ToolInput $argsObj
    if ((Test-KixGitCommitCommand -Command $terminalCommand) -or
        (Test-KixGitWriteCommand -Command $terminalCommand) -or
        (Test-KixTerminalWriteCommand -Command $terminalCommand)) {
        $result = @{ hookSpecificOutput = @{ hookEventName = "PreToolUse"; permissionDecision = "deny"; permissionDecisionReason = "QA 不提交测试或业务变更；测试变更必须返回 Orchestrator 重新执行 L2/QA。" } }
        Write-Output ($result | ConvertTo-Json -Depth 3)
        exit 2
    }
    exit 0
}

if ($toolLeaf -eq 'vscode_renameSymbol') {
    $result = @{ hookSpecificOutput = @{ hookEventName = "PreToolUse"; permissionDecision = "deny"; permissionDecisionReason = "QA 禁止执行跨文件符号重命名。" } }
    Write-Output ($result | ConvertTo-Json -Depth 3)
    exit 2
}

# 只对编辑类工具检查，避免 read/search 等只读操作也触发路径正则
$editTools = @('apply_patch','replace_string_in_file','insert_edit_into_file','edit_notebook_file','create_file','create_or_update_file','delete_file','push_files')
$isRemoteFileEdit = $toolName -match '(?i)mcp_github.*(?:create_or_update_file|delete_file|push_files)'
if (-not $argsObj -or (($editTools -notcontains $toolLeaf) -and -not $isRemoteFileEdit)) {
    exit 0
}

$targetPaths = [System.Collections.Generic.List[string]]::new()
if ($toolLeaf -eq 'apply_patch' -and $argsObj.input) {
    foreach ($match in [regex]::Matches([string]$argsObj.input, '(?m)^\*\*\* (?:Add|Update|Delete) File:\s*(.+?)(?:\s+->.*)?\s*$')) {
        $targetPaths.Add($match.Groups[1].Value)
    }
} elseif ($argsObj.filePath) {
    $targetPaths.Add([string]$argsObj.filePath)
} elseif ($argsObj.path) {
    $targetPaths.Add([string]$argsObj.path)
} elseif ($argsObj.files) {
    foreach ($file in $argsObj.files) {
        if ($file.path) { $targetPaths.Add([string]$file.path) }
    }
}
if ($targetPaths.Count -eq 0) { exit 0 }

# 提取相对 workspace 根的路径（适配绝对路径输入）
$workspace = $hookInput.workspaceFolder
if (-not $workspace) { $workspace = $hookInput.cwd }
if (-not $workspace) { $workspace = (Get-Location).Path }
$normalizedWorkspace = [System.IO.Path]::GetFullPath([string]$workspace).Replace('\', '/').TrimEnd('/')

# 允许编辑的路径（QA 可写文档 + 测试文件）
$allowedPatterns = @(
    '(^|/)docs/qa/qa-signoff-\d+\.md$',
    '(^|/)\.kixpower/memory/repo/lessons-learned\.md$',
    # 测试文件白名单（先于 blocked 检查，确保 src/ 下的测试文件也放行）
    '__tests__/',
    '(^|/)tests?/',
    '(^|/)e2e/',
    '(^|/)cypress/',
    '_test\.go$',
    '\.test\.',
    '\.spec\.',
    '\.stories\.'
)

# 被阻止的业务源代码路径
# v5.0 注（U2 反过拟合，与 block-source-edit.ps1 同源）：扩展名规则（\.go$/.rs$/.ts$/...）是语言无关的**主判据**，
# 已覆盖 dae 等 Go 项目（component/**/control/** 经 \.go$ 拦截）。
# 下方路径前缀（src/app/api/components...）是 Rust/前端起源的**辅助启发式**，
# 对非 src 布局项目可能漏判无扩展名目录，但扩展名兜底保证主流语言不漏。
$blockedPatterns = @(
    '(^|/)src/',
    '(^|/)app/',
    '(^|/)api/',
    '(^|/)components/',
    '(^|/)lib/',
    '(^|/)utils/',
    '(^|/)hooks/',
    '(^|/)styles/',
    '\.(js|ts|jsx|tsx|mjs|cjs|mts|cts|py|java|go|rs|cpp|c|h|cs|rb|php|kt|kts|scala|swift|dart|lua|ex|exs|erl|hrl|fs|fsx|vb|sh|bash|zsh|fish|ps1|psm1|sql|html|css|scss|sass|less|vue|svelte|xml|proto|ipynb)$',
    'package\.json$',
    'tsconfig\.json$',
    'next\.config\.',
    'vite\.config\.',
    'webpack\.config\.',
    'docker-compose\.yml$',
    'Dockerfile$',
    '\.env'
)

foreach ($targetPath in $targetPaths) {
    try {
        $candidatePath = [string]$targetPath
        if ($workspace -and -not [System.IO.Path]::IsPathRooted($candidatePath)) {
            $candidatePath = Join-Path $workspace $candidatePath
        }
        $candidatePath = [System.IO.Path]::GetFullPath($candidatePath)
    } catch {
        $result = @{ hookSpecificOutput = @{ hookEventName = "PreToolUse"; permissionDecision = "deny"; permissionDecisionReason = "无法规范化目标路径，拒绝编辑。" } }
        Write-Output ($result | ConvertTo-Json -Depth 3)
        exit 2
    }
    $normalizedPath = $candidatePath.Replace('\', '/')
    if (-not ($normalizedPath.Equals($normalizedWorkspace, [System.StringComparison]::OrdinalIgnoreCase) -or
              $normalizedPath.StartsWith("$normalizedWorkspace/", [System.StringComparison]::OrdinalIgnoreCase))) {
        $result = @{ hookSpecificOutput = @{ hookEventName = "PreToolUse"; permissionDecision = "deny"; permissionDecisionReason = "QA 禁止编辑工作区外文件。" } }
        Write-Output ($result | ConvertTo-Json -Depth 3)
        exit 2
    }
    $relPath = $normalizedPath.Substring($normalizedWorkspace.Length).TrimStart('/')

    $isAllowed = $false
    foreach ($pattern in $allowedPatterns) {
        if ($relPath -match $pattern) {
            $isAllowed = $true
            break
        }
    }
    if ($isAllowed) { continue }

    foreach ($pattern in $blockedPatterns) {
        if ($relPath -match $pattern) {
            $result = @{
                hookSpecificOutput = @{
                    hookEventName = "PreToolUse"
                    permissionDecision = "deny"
                    permissionDecisionReason = "QA agent 禁止编辑业务源代码。只允许写测试文件和 QA 文档。发现 Bug 请提 Issue 交 Dev 修复。"
                }
            }
            Write-Output ($result | ConvertTo-Json -Depth 3)
            exit 2
        }
    }

    $result = @{
        hookSpecificOutput = @{
            hookEventName = "PreToolUse"
            permissionDecision = "deny"
            permissionDecisionReason = "QA 只能编辑测试文件和 docs/qa/qa-signoff-N.md。"
        }
    }
    Write-Output ($result | ConvertTo-Json -Depth 3)
    exit 2
}

exit 0
