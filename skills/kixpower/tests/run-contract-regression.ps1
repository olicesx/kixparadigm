param(
    [string]$ProjectRoot = (Get-Location).Path
)

$ErrorActionPreference = 'Stop'
if (Get-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue) {
    $PSNativeCommandUseErrorActionPreference = $false
}
$kixRoot = Split-Path $PSScriptRoot -Parent
$contract = Join-Path $kixRoot 'scripts/kixpower-contract.ps1'
. (Resolve-Path $contract)

function Assert-True {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw "FAIL: $Message" }
    Write-Output "PASS: $Message"
}

function Write-Utf8Json {
    param([string]$Path, [object]$Value)
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, ($Value | ConvertTo-Json -Compress -Depth 8), $utf8)
}

function Invoke-Hook {
    param([string]$Hook, [string]$InputFile)
    $raw = cmd /c "pwsh -NoProfile -File `"$Hook`" < `"$InputFile`"" 2>&1
    [pscustomobject]@{
        exitCode = $LASTEXITCODE
        output   = ($raw | Out-String).Trim()
    }
}

function New-TempGitRepo {
    $root = Join-Path $env:TEMP ('kix-contract-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path (Join-Path $root 'docs/sprint-1') -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $root '.kixpower/memory/repo') -Force | Out-Null
    git -C $root init -q
    git -C $root config user.email test@example.invalid
    git -C $root config user.name KixContractTest
    Set-Content -LiteralPath (Join-Path $root 'README.md') -Value '# fixture' -Encoding utf8
    Set-Content -LiteralPath (Join-Path $root '.kixpower/memory/repo/harness-backlog.md') -Value '# Harness Backlog' -Encoding utf8
    git -C $root add .
    git -C $root commit -qm init
    return $root
}

$hookTestRoot = New-TempGitRepo
$inputDir = Join-Path $env:TEMP ('kix-contract-inputs-' + [guid]::NewGuid().ToString('N'))
$reviewWorktree = $null
New-Item -ItemType Directory -Path $inputDir -Force | Out-Null
try {
    $plan = @'
## Task DAG
```yaml
task_dag:
  nodes:
    - id: T1
      desc: fixture
      depends_on: []
```

## Verifiable gates
```yaml
verifiable_gates:
  - id: gate_a
    type: local_gate
    cmd: git diff --check
    expect: exit 0
    required: true
  - id: gate_b
    type: local_gate
    cmd: git status --short
    expect: exit 0
    required: true
```
'@
    $planFile = Join-Path $hookTestRoot 'docs/sprint-1/plan.md'
    Set-Content -LiteralPath $planFile -Value $plan -Encoding utf8
    $sha = (git -C $hookTestRoot rev-parse HEAD).Trim()
    $gates = @(Get-KixRequiredLocalGates -PlanText $plan)
    $manifestSha = Get-KixSha256 -Text (Get-KixGateManifestJson -Gates $gates)
    $progress = @"
---
sprint: 1
status: in-progress
completed_tasks: 1
total_tasks: 1
blocked_tasks: 0
l2_verification_passed:
  - gate_a
  - gate_b
l2_verified_sha: $sha
l2_gate_manifest_sha256: $manifestSha
l2_stash_refs: []
---
"@
    Set-Content -LiteralPath (Join-Path $hookTestRoot 'docs/sprint-1/progress.md') -Value $progress -Encoding utf8
    Set-Content -LiteralPath (Join-Path $hookTestRoot 'docs/.kixpower-current-sprint') -Value 1 -NoNewline -Encoding utf8

    $handoffHook = Join-Path $kixRoot 'hooks/validate-handoff.ps1'
    $validPrompt = "current_sprint: 1`nqa_started_sha: $sha`nl2_gate_manifest_sha256: $manifestSha"
    $validInput = [ordered]@{
        tool_name = 'runSubagent'
        tool_input = @{ agentName = 'kixpower-qa'; prompt = $validPrompt }
        cwd = ($hookTestRoot -replace '\\', '/')
        hook_event_name = 'PreToolUse'
    }
    $validFile = Join-Path $inputDir 'handoff-valid.json'
    Write-Utf8Json -Path $validFile -Value $validInput
    $validResult = Invoke-Hook -Hook $handoffHook -InputFile $validFile
    Assert-True ($validResult.exitCode -eq 0 -and $validResult.output -eq '') 'valid QA handoff passes'

    $missingInput = $validInput | ConvertTo-Json -Depth 8 | ConvertFrom-Json
    $missingInput.tool_input.prompt = "current_sprint: 1`nl2_gate_manifest_sha256: $manifestSha"
    $missingFile = Join-Path $inputDir 'handoff-missing-sha.json'
    Write-Utf8Json -Path $missingFile -Value $missingInput
    $missingResult = Invoke-Hook -Hook $handoffHook -InputFile $missingFile
    Assert-True ($missingResult.exitCode -eq 2 -and $missingResult.output -match 'qa_started_sha') 'QA handoff without startup SHA is denied'

    $partialInput = $validInput | ConvertTo-Json -Depth 8 | ConvertFrom-Json
    $partialInput.tool_input.prompt = $validPrompt
    $partialProgress = $progress -replace '(?ms)l2_verification_passed:\s*\r?\n\s*- gate_a\s*\r?\n\s*- gate_b', "l2_verification_passed:`n  - gate_a"
    Set-Content -LiteralPath (Join-Path $hookTestRoot 'docs/sprint-1/progress.md') -Value $partialProgress -Encoding utf8
    $partialFile = Join-Path $inputDir 'handoff-partial.json'
    Write-Utf8Json -Path $partialFile -Value $partialInput
    $partialResult = Invoke-Hook -Hook $handoffHook -InputFile $partialFile
    Assert-True ($partialResult.exitCode -eq 2 -and $partialResult.output -match 'gate_b') 'incomplete L2 gate set is denied'
    Set-Content -LiteralPath (Join-Path $hookTestRoot 'docs/sprint-1/progress.md') -Value $progress -Encoding utf8
    $restoredHandoffResult = Invoke-Hook -Hook $handoffHook -InputFile $validFile
    Assert-True ($restoredHandoffResult.exitCode -eq 0 -and $restoredHandoffResult.output -eq '') 'restored complete L2 handoff creates QA session'

    $emptyDagPlan = $plan -replace '(?ms)nodes:\s*- id: T1\s+desc: fixture\s+depends_on: \[\]', 'nodes: []'
    Set-Content -LiteralPath $planFile -Value $emptyDagPlan -Encoding utf8
    $emptyDagResult = Invoke-Hook -Hook $handoffHook -InputFile $validFile
    Assert-True ($emptyDagResult.exitCode -eq 2 -and $emptyDagResult.output -match '空骨架|task DAG') 'empty task DAG is denied'
    Set-Content -LiteralPath $planFile -Value $plan -Encoding utf8

    Remove-Item -LiteralPath (Join-Path $hookTestRoot 'docs/.kixpower-qa-session.json') -Force -ErrorAction SilentlyContinue
    $nullStashProgress = $progress -replace 'l2_stash_refs: \[\]', 'l2_stash_refs: null'
    Set-Content -LiteralPath (Join-Path $hookTestRoot 'docs/sprint-1/progress.md') -Value $nullStashProgress -Encoding utf8
    $nullStashResult = Invoke-Hook -Hook $handoffHook -InputFile $validFile
    Assert-True ($nullStashResult.exitCode -eq 2 -and $nullStashResult.output -match 'l2_stash_refs') 'null L2 stash baseline is denied'
    Set-Content -LiteralPath (Join-Path $hookTestRoot 'docs/sprint-1/progress.md') -Value $progress -Encoding utf8

    Remove-Item -LiteralPath (Join-Path $hookTestRoot 'docs/.kixpower-qa-session.json') -Force -ErrorAction SilentlyContinue
    Add-Content -LiteralPath (Join-Path $hookTestRoot 'README.md') -Value "post-l2 test change" -Encoding utf8
    git -C $hookTestRoot stash push -q -m 'post-l2 fixture' -- README.md
    $stashDeltaResult = Invoke-Hook -Hook $handoffHook -InputFile $validFile
    Assert-True ($stashDeltaResult.exitCode -eq 2 -and $stashDeltaResult.output -match 'stash') 'L2 post-verification stash delta is denied'
    git -C $hookTestRoot stash pop -q
    git -C $hookTestRoot checkout -q -- README.md

    Add-Content -LiteralPath (Join-Path $hookTestRoot '.kixpower/memory/repo/harness-backlog.md') -Value "coordination note" -Encoding utf8
    $memoryChangeResult = Invoke-Hook -Hook $handoffHook -InputFile $validFile
    Assert-True ($memoryChangeResult.exitCode -eq 0 -and $memoryChangeResult.output -eq '') 'canonical Memory document change is allowed'
    Remove-Item -LiteralPath (Join-Path $hookTestRoot 'docs/.kixpower-qa-session.json') -Force -ErrorAction SilentlyContinue
    git -C $hookTestRoot checkout -q -- .kixpower/memory/repo/harness-backlog.md

    $subagentNameInput = [ordered]@{
        tool_name = 'runSubagent'
        tool_input = @{ subagentName = 'kixpower-qa'; prompt = $validPrompt }
        cwd = ($hookTestRoot -replace '\\', '/')
        hook_event_name = 'PreToolUse'
    }
    $subagentNameFile = Join-Path $inputDir 'handoff-subagent-name.json'
    Write-Utf8Json -Path $subagentNameFile -Value $subagentNameInput
    $subagentNameResult = Invoke-Hook -Hook $handoffHook -InputFile $subagentNameFile
    Assert-True ($subagentNameResult.exitCode -eq 0 -and $subagentNameResult.output -eq '') 'subagentName target is supported'

    New-Item -ItemType Directory -Path (Join-Path $hookTestRoot 'docs/qa') -Force | Out-Null
    $qaFile = Join-Path $hookTestRoot 'docs/qa/qa-signoff-1.md'
    $qaText = @"
---
sprint: 1
status: PASS
qa_started_sha: $sha
qa_verified_sha: $sha
l2_verified_sha: $sha
l2_gate_manifest_sha256: $manifestSha
qa_gate_manifest_sha256: $manifestSha
qa_test_changes: []
ci_pending: false
---
# QA
"@
    Set-Content -LiteralPath $qaFile -Value $qaText -Encoding utf8
    $closeoutHook = Join-Path $kixRoot 'hooks/validate-qa-signoff.ps1'
    $closeoutInput = [ordered]@{
        tool_name = 'runSubagent'
        tool_input = @{ agentName = 'kixpower-producer'; prompt = "stage: producer_closeout`ncurrent_sprint: 1" }
        cwd = ($hookTestRoot -replace '\\', '/')
        hook_event_name = 'PreToolUse'
    }
    $closeoutFile = Join-Path $inputDir 'closeout-valid.json'
    Write-Utf8Json -Path $closeoutFile -Value $closeoutInput
    $closeoutResult = Invoke-Hook -Hook $closeoutHook -InputFile $closeoutFile
    Assert-True ($closeoutResult.exitCode -eq 0 -and $closeoutResult.output -eq '') 'fresh QA signoff allows closeout'

    Add-Content -LiteralPath (Join-Path $hookTestRoot 'README.md') -Value "qa-window stash change" -Encoding utf8
    git -C $hookTestRoot stash push -q -m 'qa-window fixture' -- README.md
    $closeoutStashResult = Invoke-Hook -Hook $closeoutHook -InputFile $closeoutFile
    Assert-True ($closeoutStashResult.exitCode -eq 2 -and $closeoutStashResult.output -match 'stash') 'stash drift during QA blocks closeout'
    git -C $hookTestRoot stash pop -q
    git -C $hookTestRoot checkout -q -- README.md

    $qaTestFile = Join-Path $hookTestRoot 'tests/qa-added.test.ts'
    New-Item -ItemType Directory -Path (Split-Path $qaTestFile -Parent) -Force | Out-Null
    Set-Content -LiteralPath $qaTestFile -Value 'test("fixture", () => {})' -Encoding utf8
    $freshnessHook = Join-Path $kixRoot 'hooks/qa-freshness-check.ps1'
    $testEditInput = [ordered]@{
        tool_name = 'create_file'
        tool_input = @{ filePath = 'tests/qa-added.test.ts'; content = 'test("fixture", () => {})' }
        cwd = ($hookTestRoot -replace '\\', '/')
        hook_event_name = 'PostToolUse'
    }
    $testEditFile = Join-Path $inputDir 'qa-test-edit.json'
    Write-Utf8Json -Path $testEditFile -Value $testEditInput
    $freshnessResult = Invoke-Hook -Hook $freshnessHook -InputFile $testEditFile
    Assert-True ($freshnessResult.exitCode -eq 0 -and $freshnessResult.output -match 'REVERIFY_REQUIRED') 'QA test edit creates reverify marker'
    $remoteQaInput = [ordered]@{
        tool_name = 'mcp_github_mcp_se_create_or_update_file'
        tool_input = @{ path = 'tests/remote.test.ts'; content = 'test("remote", () => {})' }
        cwd = ($hookTestRoot -replace '\\', '/')
        hook_event_name = 'PostToolUse'
    }
    $remoteQaFile = Join-Path $inputDir 'qa-remote-test-edit.json'
    Write-Utf8Json -Path $remoteQaFile -Value $remoteQaInput
    $remoteFreshnessResult = Invoke-Hook -Hook $freshnessHook -InputFile $remoteQaFile
    Assert-True ($remoteFreshnessResult.exitCode -eq 0 -and $remoteFreshnessResult.output -match 'REVERIFY_REQUIRED') 'QA remote test edit creates reverify marker'
    $notebookEditInput = [ordered]@{
        tool_name = 'edit_notebook_file'
        tool_input = @{ filePath = 'tests/qa-added.ipynb' }
        cwd = ($hookTestRoot -replace '\\', '/')
        hook_event_name = 'PostToolUse'
    }
    $notebookEditFile = Join-Path $inputDir 'qa-notebook-edit.json'
    Write-Utf8Json -Path $notebookEditFile -Value $notebookEditInput
    $notebookFreshnessResult = Invoke-Hook -Hook $freshnessHook -InputFile $notebookEditFile
    Assert-True ($notebookFreshnessResult.exitCode -eq 0 -and $notebookFreshnessResult.output -match 'REVERIFY_REQUIRED') 'QA notebook test edit creates reverify marker'
    $markerCloseoutResult = Invoke-Hook -Hook $closeoutHook -InputFile $closeoutFile
    Assert-True ($markerCloseoutResult.exitCode -eq 2 -and $markerCloseoutResult.output -match '"permissionDecision"\s*:\s*"deny"') 'QA test edit blocks closeout'

    $qaCommitHook = Join-Path $kixRoot 'hooks/block-source-edit-qa.ps1'
    $qaCommitInput = [ordered]@{
        tool_name = 'run_in_terminal'
        tool_input = @{ command = 'git commit -m "qa test"' }
        cwd = ($hookTestRoot -replace '\\', '/')
        hook_event_name = 'PreToolUse'
    }
    $qaCommitFile = Join-Path $inputDir 'qa-commit.json'
    Write-Utf8Json -Path $qaCommitFile -Value $qaCommitInput
    $qaCommitResult = Invoke-Hook -Hook $qaCommitHook -InputFile $qaCommitFile
    Assert-True ($qaCommitResult.exitCode -eq 2 -and $qaCommitResult.output -match '"permissionDecision"\s*:\s*"deny"') 'QA commit is denied'
    foreach ($destructiveQaCommand in @('git stash', 'rm docs/.kixpower-qa-reverify.json', 'rmdir docs', 'cmd /c "del /q docs/.kixpower-qa-reverify.json"', 'cmd /c "rm -rf docs"')) {
        $destructiveInput = [ordered]@{
            tool_name = 'run_in_terminal'
            tool_input = @{ command = $destructiveQaCommand }
            cwd = ($hookTestRoot -replace '\\', '/')
            hook_event_name = 'PreToolUse'
        }
        $destructiveFile = Join-Path $inputDir (('qa-' + ($destructiveQaCommand -replace '[^a-z]+', '-') + '.json'))
        Write-Utf8Json -Path $destructiveFile -Value $destructiveInput
        $destructiveResult = Invoke-Hook -Hook $qaCommitHook -InputFile $destructiveFile
        Assert-True ($destructiveResult.exitCode -eq 2) "QA destructive command '$destructiveQaCommand' is denied"
    }
    Remove-Item -LiteralPath $qaTestFile -Force
    Remove-Item -LiteralPath (Join-Path $hookTestRoot 'docs/.kixpower-qa-reverify.json') -Force -ErrorAction SilentlyContinue

    Set-Content -LiteralPath $qaFile -Value ($qaText -replace "qa_verified_sha: $sha", ('qa_verified_sha: ' + ('0' * 40))) -Encoding utf8
    $staleResult = Invoke-Hook -Hook $closeoutHook -InputFile $closeoutFile
    Assert-True ($staleResult.exitCode -eq 2 -and $staleResult.output -match 'qa_verified_sha') 'stale QA signoff blocks closeout'

    $sessionMarker = Join-Path $hookTestRoot 'docs/.kixpower-qa-session.json'
    $sessionContent = @{ schema_version = 1; sprint = 1; l2_verified_sha = $sha; stash_refs = @() } | ConvertTo-Json -Compress
    Set-Content -LiteralPath $sessionMarker -Value $sessionContent -Encoding utf8
    Set-Content -LiteralPath $qaFile -Value $qaText -Encoding utf8
    $cleanupHook = Join-Path $kixRoot 'hooks/cleanup-qa-session.ps1'
    $cleanupFile = Join-Path $inputDir 'cleanup-session.json'
    Write-Utf8Json -Path $cleanupFile -Value $closeoutInput
    $cleanupResult = Invoke-Hook -Hook $cleanupHook -InputFile $cleanupFile
    Assert-True ($cleanupResult.exitCode -eq 0 -and -not (Test-Path $sessionMarker)) 'successful closeout cleans QA session marker'

    $blastHook = Join-Path $kixRoot 'hooks/blast-radius-check.ps1'
    $safeSql = Join-Path $inputDir 'drop-named-safe.sql'
    $dangerSql = Join-Path $inputDir 'migration.sql'
    Set-Content -LiteralPath $safeSql -Value 'SELECT 1;' -Encoding utf8
    Set-Content -LiteralPath $dangerSql -Value 'DROP TABLE users;' -Encoding utf8
    $blastCases = @(
        @{ name = 'indirect-control-plane'; tool = 'run_in_terminal'; command = '$p=Join-Path $HOME ''.copilot''; Set-Content -Path $p x'; deny = $true },
        @{ name = 'file-uri-control-plane'; tool = 'create_file'; filePath = ('file:///' + ($HOME -replace '\\', '/') + '/.copilot/agents/x.agent.md'); deny = $true },
        @{ name = 'sql-file-danger'; tool = 'run_in_terminal'; command = "psql -f `"$dangerSql`""; deny = $true },
        @{ name = 'sql-file-safe'; tool = 'run_in_terminal'; command = "psql -f `"$safeSql`""; deny = $false },
        @{ name = 'github-no-branch'; tool = 'mcp_github_create_or_update_file'; command = 'remote write without branch'; deny = $true },
        @{ name = 'normal-command'; tool = 'run_in_terminal'; command = 'git diff --check'; deny = $false }
    )
    foreach ($case in $blastCases) {
        $toolInput = @{ command = $case.command }
        if ($case.filePath) { $toolInput = @{ filePath = $case.filePath; content = 'x' } }
        $input = [ordered]@{
            tool_name = $case.tool
            tool_input = $toolInput
            cwd = ($hookTestRoot -replace '\\', '/')
            hook_event_name = 'PreToolUse'
        }
        $file = Join-Path $inputDir ($case.name + '.json')
        Write-Utf8Json -Path $file -Value $input
        $result = Invoke-Hook -Hook $blastHook -InputFile $file
        $denied = $result.output -match '"permissionDecision"\s*:\s*"deny"'
        Assert-True ($denied -eq $case.deny) "$($case.name) decision"
    }
    $commentInput = [ordered]@{
        tool_name = 'mcp_github_mcp_se_add_issue_comment'
        tool_input = @{ body = 'fixture comment' }
        cwd = ($hookTestRoot -replace '\\', '/')
        hook_event_name = 'PreToolUse'
    }
    $commentFile = Join-Path $inputDir 'github-add-issue-comment.json'
    Write-Utf8Json -Path $commentFile -Value $commentInput
    $commentResult = Invoke-Hook -Hook $blastHook -InputFile $commentFile
    Assert-True ($commentResult.exitCode -eq 0 -and $commentResult.output -match '"permissionDecision"\s*:\s*"ask"') 'GitHub issue comment requires confirmation'
        $snippetInput = [ordered]@{
            tool_name = 'mcp_pylance_mcp_s_pylanceRunCodeSnippet'
            tool_input = @{ code = "open('src/main.rs', 'w').write('x')" }
            cwd = ($hookTestRoot -replace '\\', '/')
            hook_event_name = 'PreToolUse'
        }
        $snippetFile = Join-Path $inputDir 'unknown-code-snippet.json'
        Write-Utf8Json -Path $snippetFile -Value $snippetInput
        $devAuthorityHook = Join-Path $kixRoot 'hooks/block-dev-authority-edit.ps1'
        foreach ($securityHook in @(
                (Join-Path $kixRoot 'hooks/block-source-edit.ps1'),
                (Join-Path $kixRoot 'hooks/block-source-edit-qa.ps1'),
                (Join-Path $kixRoot 'hooks/block-dev-authority-edit.ps1'),
                $blastHook)) {
            $snippetResult = Invoke-Hook -Hook $securityHook -InputFile $snippetFile
            Assert-True ($snippetResult.exitCode -eq 2 -and $snippetResult.output -match 'permissionDecision.*deny|permissionDecisionReason') "unknown code execution tool is denied by $(Split-Path $securityHook -Leaf)"
        }
        $debugInput = $snippetInput | ConvertTo-Json -Depth 8 | ConvertFrom-Json
        $debugInput.tool_name = 'mcp_pylance_mcp_s_pylancePythonDebug'
        $debugFile = Join-Path $inputDir 'unknown-python-debug.json'
        Write-Utf8Json -Path $debugFile -Value $debugInput
        $debugResult = Invoke-Hook -Hook $devAuthorityHook -InputFile $debugFile
        Assert-True ($debugResult.exitCode -eq 2 -and $debugResult.output -match 'permissionDecision.*deny|permissionDecisionReason') 'unknown Python debug tool is denied'
        $extensionInput = $snippetInput | ConvertTo-Json -Depth 8 | ConvertFrom-Json
        $extensionInput.tool_name = 'install_extension'
        $extensionFile = Join-Path $inputDir 'extension-install.json'
        Write-Utf8Json -Path $extensionFile -Value $extensionInput
        $extensionResult = Invoke-Hook -Hook $devAuthorityHook -InputFile $extensionFile
        Assert-True ($extensionResult.exitCode -eq 2 -and $extensionResult.output -match 'permissionDecision.*deny|permissionDecisionReason') 'Dev extension install is denied'
        foreach ($dangerousGitCommand in @(
                'git reflog expire --expire=now --all',
                'git reflog delete HEAD@{0}',
                'git config alias.evil "!Write-Output evil"',
                'git config core.hooksPath docs/evil',
                'git config core.editor "evil --wait"',
                'git config gc.reflogExpire now',
                'git config gc.reflogExpireUnreachable now',
                'git config credential.helper "!evil"',
                'git gc --prune=now',
                'git prune --expire=now',
                'git -c core.hooksPath=docs/evil commit -m x',
                'git -c gc.reflogExpire=now gc',
                'git -ccore.hooksPath=docs/evil commit -m x',
                'git -cgc.reflogExpire=now gc',
                'git --config-env=core.hooksPath=EVIL commit -m x',
                'git config diff.external "evil --cmd"',
                'git -c diff.external=evil diff',
                'git config core.gitProxy "evil"',
                'git config difftool.evil.cmd "evil"',
                'git config filter.x.clean "evil"',
                'git config sequence.editor "evil"',
                'git config core.fsmonitor "evil"',
                'git update-ref refs/heads/main abc1234',
                'git commit-tree HEAD^{tree} -m x',
                'git symbolic-ref HEAD refs/heads/main',
                'git hash-object -w src/main.rs',
                'git replace refs/heads/main abc1234',
                'git fast-import --quiet')) {
            $dangerousGitInput = $snippetInput | ConvertTo-Json -Depth 8 | ConvertFrom-Json
            $dangerousGitInput.tool_name = 'run_in_terminal'
            $dangerousGitInput.tool_input = @{ command = $dangerousGitCommand }
            $dangerousGitFile = Join-Path $inputDir (('dangerous-git-' + ($dangerousGitCommand -replace '[^a-z]+', '-') + '.json'))
            Write-Utf8Json -Path $dangerousGitFile -Value $dangerousGitInput
            $dangerousGitResult = Invoke-Hook -Hook $devAuthorityHook -InputFile $dangerousGitFile
            Assert-True ($dangerousGitResult.exitCode -eq 2 -and $dangerousGitResult.output -match 'permissionDecision.*deny|permissionDecisionReason') "dangerous Git command '$dangerousGitCommand' is denied"
        }
        foreach ($safeGitCommand in @(
                'git config --get core.hooksPath',
                'git config --list',
                'git config user.name Test',
                'git -C /tmp/repo diff',
                'git -C/tmp/repo diff',
                'git diff HEAD',
                'git show HEAD',
                'git log --oneline -5')) {
            $safeGitInput = $snippetInput | ConvertTo-Json -Depth 8 | ConvertFrom-Json
            $safeGitInput.tool_name = 'run_in_terminal'
            $safeGitInput.tool_input = @{ command = $safeGitCommand }
            $safeGitFile = Join-Path $inputDir (('safe-git-' + ($safeGitCommand -replace '[^a-z]+', '-') + '.json'))
            Write-Utf8Json -Path $safeGitFile -Value $safeGitInput
            $safeGitResult = Invoke-Hook -Hook $devAuthorityHook -InputFile $safeGitFile
            Assert-True ($safeGitResult.exitCode -eq 0 -and $safeGitResult.output -eq '') "safe Git command '$safeGitCommand' remains allowed"
        }
    $taskPushInput = [ordered]@{
        tool_name = 'create_and_run_task'
        tool_input = @{ task = @{ command = 'git'; args = @('push', '--force') } }
        cwd = ($hookTestRoot -replace '\\', '/')
        hook_event_name = 'PreToolUse'
    }
    $taskPushFile = Join-Path $inputDir 'task-args-force-push.json'
    Write-Utf8Json -Path $taskPushFile -Value $taskPushInput
    $taskPushResult = Invoke-Hook -Hook $blastHook -InputFile $taskPushFile
    Assert-True ($taskPushResult.exitCode -eq 2 -and $taskPushResult.output -match 'permissionDecision.*deny|permissionDecisionReason') 'create_and_run_task args force push is denied'
    $authorCountRepo = New-TempGitRepo
    try {
        Set-Content -LiteralPath (Join-Path $authorCountRepo 'a.txt') -Value 'a' -Encoding utf8
        git -C $authorCountRepo add a.txt
        git -C $authorCountRepo commit -qm 'normal commit'
        Set-Content -LiteralPath (Join-Path $authorCountRepo 'b.txt') -Value 'b' -Encoding utf8
        git -C $authorCountRepo add b.txt
        git -C $authorCountRepo -c user.name=FakeUser -c user.email=fake@example.invalid commit -qm 'fake author commit'
        $authorCountInput = [ordered]@{
            tool_name = 'run_in_terminal'
            tool_input = @{ command = 'git commit -m next' }
            cwd = ($authorCountRepo -replace '\\', '/')
            hook_event_name = 'PreToolUse'
        }
        $authorCountFile = Join-Path $inputDir 'commit-author-filter.json'
        Write-Utf8Json -Path $authorCountFile -Value $authorCountInput
        $authorCountResult = Invoke-Hook -Hook $blastHook -InputFile $authorCountFile
        Assert-True ($authorCountResult.exitCode -eq 2 -and $authorCountResult.output -match 'commit') 'commit budget counts commits regardless of author name'
        $dateInput = $authorCountInput | ConvertTo-Json -Depth 8 | ConvertFrom-Json
        $dateInput.tool_input.command = "`$env:GIT_COMMITTER_DATE='2000-01-01T00:00:00Z'; git commit -m dated"
        $dateFile = Join-Path $inputDir 'commit-date-filter.json'
        Write-Utf8Json -Path $dateFile -Value $dateInput
        $dateResult = Invoke-Hook -Hook $blastHook -InputFile $dateFile
        Assert-True ($dateResult.exitCode -eq 2 -and $dateResult.output -match 'commit') 'commit budget resists fake committer date'
    } finally {
        Remove-Item -LiteralPath $authorCountRepo -Recurse -Force -ErrorAction SilentlyContinue
    }
    foreach ($newlineBlastCommand in @(
            "git diff`ngit push --force origin feature/audit",
            "git log`ngit push origin main",
            "git status`ngit commit -m fixture")) {
        $newlineBlastInput = [ordered]@{
            tool_name = 'run_in_terminal'
            tool_input = @{ command = $newlineBlastCommand }
            cwd = ($hookTestRoot -replace '\\', '/')
            hook_event_name = 'PreToolUse'
        }
        $newlineBlastFile = Join-Path $inputDir (('newline-blast-' + ($newlineBlastCommand -replace '[^a-z]+', '-') + '.json'))
        Write-Utf8Json -Path $newlineBlastFile -Value $newlineBlastInput
        $newlineBlastResult = Invoke-Hook -Hook $blastHook -InputFile $newlineBlastFile
        Assert-True ($newlineBlastResult.exitCode -eq 2 -and $newlineBlastResult.output -match 'permissionDecision.*deny|permissionDecisionReason') "Newline Git write '$newlineBlastCommand' is denied"
    }
    foreach ($mainRefCommand in @('git push origin HEAD', 'git push origin @')) {
        $mainRefInput = [ordered]@{
            tool_name = 'run_in_terminal'
            tool_input = @{ command = $mainRefCommand }
            cwd = ($hookTestRoot -replace '\\', '/')
            hook_event_name = 'PreToolUse'
        }
        $mainRefFile = Join-Path $inputDir (('main-ref-' + ($mainRefCommand -replace '[^a-z]+', '-') + '.json'))
        Write-Utf8Json -Path $mainRefFile -Value $mainRefInput
        $mainRefResult = Invoke-Hook -Hook $blastHook -InputFile $mainRefFile
        Assert-True ($mainRefResult.exitCode -eq 2 -and $mainRefResult.output -match 'permissionDecision.*deny|permissionDecisionReason') "main branch equivalent ref '$mainRefCommand' is denied"
    }
    $malformedFile = Join-Path $inputDir 'malformed.json'
    Set-Content -LiteralPath $malformedFile -Value '{not-json' -Encoding utf8
    $malformedResult = Invoke-Hook -Hook $blastHook -InputFile $malformedFile
    Assert-True ($malformedResult.exitCode -eq 2) 'malformed security hook input is denied'

    $cleanInput = [ordered]@{
        tool_name = 'run_in_terminal'
        tool_input = @{ command = 'git clean -fd docs/.kixpower-qa-reverify.json' }
        cwd = ($hookTestRoot -replace '\\', '/')
        hook_event_name = 'PreToolUse'
    }
    $cleanFile = Join-Path $inputDir 'orchestrator-clean.json'
    Write-Utf8Json -Path $cleanFile -Value $cleanInput
    $cleanResult = cmd /c "pwsh -NoProfile -File `"$($kixRoot)/hooks/block-source-edit.ps1`" -Role orchestrator < `"$cleanFile`"" 2>&1 | Out-String
    Assert-True ($LASTEXITCODE -eq 2) 'orchestrator destructive git clean is denied'

    $unknownAgentInput = [ordered]@{
        tool_name = 'runSubagent'
        tool_input = @{ prompt = 'current_sprint: 1' }
        cwd = ($hookTestRoot -replace '\\', '/')
        hook_event_name = 'PreToolUse'
    }
    $unknownAgentFile = Join-Path $inputDir 'handoff-unknown-agent.json'
    Write-Utf8Json -Path $unknownAgentFile -Value $unknownAgentInput
    $unknownAgentResult = Invoke-Hook -Hook $handoffHook -InputFile $unknownAgentFile
    Assert-True ($unknownAgentResult.exitCode -eq 2 -and $unknownAgentResult.output -match '"permissionDecision"\s*:\s*"deny"') 'unknown runSubagent target is denied'

    $reviewWorktree = Join-Path $env:TEMP ('kix-contract-review-wt-' + [guid]::NewGuid().ToString('N'))
    git -C $hookTestRoot worktree add --detach -q $reviewWorktree $sha | Out-Null
    Assert-True ($LASTEXITCODE -eq 0 -and (Test-Path $reviewWorktree -PathType Container)) 'review fixture worktree is registered'
    $reviewInput = [ordered]@{
        tool_name = 'runSubagent'
        tool_input = @{ agentName = 'kixpower-reviewer'; prompt = "handoff_mode: review`nreview_readonly: true`nreview_origin: kixpower-review`nPR #7`nreview_worktree: $reviewWorktree`nreview_head_sha: $sha" }
        cwd = ($hookTestRoot -replace '\\', '/')
        hook_event_name = 'PreToolUse'
    }
    $reviewFile = Join-Path $inputDir 'handoff-review-valid.json'
    Write-Utf8Json -Path $reviewFile -Value $reviewInput
    $reviewResult = Invoke-Hook -Hook $handoffHook -InputFile $reviewFile
    Assert-True ($reviewResult.exitCode -eq 0 -and $reviewResult.output -eq '') 'explicit PR review handoff bypass is allowed'

    $devReviewInput = $reviewInput | ConvertTo-Json -Depth 8 | ConvertFrom-Json
    $devReviewInput.tool_input.agentName = 'kixpower-dev'
    $devReviewFile = Join-Path $inputDir 'handoff-dev-review-forbidden.json'
    Write-Utf8Json -Path $devReviewFile -Value $devReviewInput
    $devReviewResult = Invoke-Hook -Hook $handoffHook -InputFile $devReviewFile
    Assert-True ($devReviewResult.exitCode -eq 2 -and $devReviewResult.output -match 'current_sprint') 'ordinary Dev cannot use review bypass'

    $markerEditHook = Join-Path $kixRoot 'hooks/block-source-edit.ps1'
    $markerEditInput = [ordered]@{
        tool_name = 'delete_file'
        tool_input = @{ filePath = 'docs/.kixpower-qa-reverify.json' }
        cwd = ($hookTestRoot -replace '\\', '/')
        hook_event_name = 'PreToolUse'
    }
    $markerEditFile = Join-Path $inputDir 'reverify-marker-edit.json'
    Write-Utf8Json -Path $markerEditFile -Value $markerEditInput
    $markerEditResult = cmd /c "pwsh -NoProfile -File `"$markerEditHook`" -Role orchestrator < `"$markerEditFile`"" 2>&1 | Out-String
    Assert-True ($LASTEXITCODE -eq 2 -and $markerEditResult -match 'permissionDecision.*deny|permissionDecisionReason') 'orchestrator cannot edit reverify marker'

    $devAuthorityHook = Join-Path $kixRoot 'hooks/block-dev-authority-edit.ps1'
    $devAuthorityInput = [ordered]@{
        tool_name = 'create_file'
        tool_input = @{ filePath = 'docs/sprint-1/progress.md'; content = "l2_verified_sha: $sha" }
        cwd = ($hookTestRoot -replace '\\', '/')
        hook_event_name = 'PreToolUse'
    }
    $devAuthorityFile = Join-Path $inputDir 'dev-authority-edit.json'
    Write-Utf8Json -Path $devAuthorityFile -Value $devAuthorityInput
    $devAuthorityResult = Invoke-Hook -Hook $devAuthorityHook -InputFile $devAuthorityFile
    Assert-True ($devAuthorityResult.exitCode -eq 2 -and $devAuthorityResult.output -match 'permissionDecision.*deny|permissionDecisionReason') 'Dev/Producer cannot write authoritative L2 fields'

    $devOverwriteInput = $devAuthorityInput | ConvertTo-Json -Depth 8 | ConvertFrom-Json
    $devOverwriteInput.tool_input = @{ filePath = 'docs/sprint-1/progress.md'; content = 'completed_tasks: 2' }
    $devOverwriteFile = Join-Path $inputDir 'dev-progress-overwrite.json'
    Write-Utf8Json -Path $devOverwriteFile -Value $devOverwriteInput
    $devOverwriteResult = Invoke-Hook -Hook $devAuthorityHook -InputFile $devOverwriteFile
    Assert-True ($devOverwriteResult.exitCode -eq 2 -and $devOverwriteResult.output -match 'permissionDecision.*deny|permissionDecisionReason') 'Dev progress overwrite is denied'

    $devValueInput = $devAuthorityInput | ConvertTo-Json -Depth 8 | ConvertFrom-Json
    $devValueInput.tool_name = 'replace_string_in_file'
    $devValueInput.tool_input = @{ filePath = 'docs/sprint-1/progress.md'; oldString = $sha; newString = ('0' * 40) }
    $devValueFile = Join-Path $inputDir 'dev-progress-value-only.json'
    Write-Utf8Json -Path $devValueFile -Value $devValueInput
    $devValueResult = Invoke-Hook -Hook $devAuthorityHook -InputFile $devValueFile
    Assert-True ($devValueResult.exitCode -eq 2 -and $devValueResult.output -match 'permissionDecision.*deny|permissionDecisionReason') 'Dev cannot replace an authoritative SHA value'

    $devProgressInput = $devAuthorityInput | ConvertTo-Json -Depth 8 | ConvertFrom-Json
    $devProgressInput.tool_name = 'replace_string_in_file'
    $devProgressInput.tool_input = @{ filePath = 'docs/sprint-1/progress.md'; oldString = 'completed_tasks: 1'; newString = 'completed_tasks: 2' }
    $devProgressFile = Join-Path $inputDir 'dev-progress-update.json'
    Write-Utf8Json -Path $devProgressFile -Value $devProgressInput
    $devProgressResult = Invoke-Hook -Hook $devAuthorityHook -InputFile $devProgressFile
    Assert-True ($devProgressResult.exitCode -eq 0 -and $devProgressResult.output -eq '') 'Dev task progress update remains allowed'

    $devTerminalInput = $devAuthorityInput | ConvertTo-Json -Depth 8 | ConvertFrom-Json
    $devTerminalInput.tool_name = 'run_in_terminal'
    $devTerminalInput.tool_input = @{ command = 'Set-Content docs/sprint-1/progress.md x' }
    $devTerminalFile = Join-Path $inputDir 'dev-progress-terminal.json'
    Write-Utf8Json -Path $devTerminalFile -Value $devTerminalInput
    $devTerminalResult = Invoke-Hook -Hook $devAuthorityHook -InputFile $devTerminalFile
    Assert-True ($devTerminalResult.exitCode -eq 2 -and $devTerminalResult.output -match 'permissionDecision.*deny|permissionDecisionReason') 'Dev terminal progress write is denied'

    foreach ($downloadCommand in @(
            'Invoke-WebRequest http://example.invalid -OutFile src/main.rs',
            'iwr http://example.invalid -OutFile src/main.rs',
            'curl -o src/main.rs http://example.invalid',
            'curl -osrc/main.rs http://example.invalid',
            'wget http://example.invalid -O src/main.rs',
            'wget http://example.invalid -Osrc/main.rs',
            'wget http://example.invalid --output-document=src/main.rs',
            'Export-Csv -Path src/main.rs',
            'Start-BitsTransfer http://example.invalid -Destination src/main.rs',
            'certutil -decode input.b64 src/main.rs',
            'pwsh -File scripts/write.ps1',
            '(New-Object System.Net.WebClient).DownloadFile("http://example.invalid", "src/main.rs")',
            '(New-Object Net.WebClient).DownloadFile("http://example.invalid", "src/main.rs")',
            '[Net.WebClient]::new().DownloadFile("http://example.invalid", "src/main.rs")',
            'scp user@host:file src/main.rs',
            'rsync -av user@host:src/ src/',
            'cargo fix --allow-dirty',
            'cargo clippy --fix --allow-dirty',
            'rustfmt src/main.rs',
            'git merge feature/test',
            'git rebase main',
            'git pull')) {
        $downloadInput = $devAuthorityInput | ConvertTo-Json -Depth 8 | ConvertFrom-Json
        $downloadInput.tool_name = 'run_in_terminal'
        $downloadInput.tool_input = @{ command = $downloadCommand }
        $downloadFile = Join-Path $inputDir (('dev-download-' + ($downloadCommand -replace '[^a-z]+', '-') + '.json'))
        Write-Utf8Json -Path $downloadFile -Value $downloadInput
        $downloadResult = Invoke-Hook -Hook $devAuthorityHook -InputFile $downloadFile
        Assert-True ($downloadResult.exitCode -eq 2 -and $downloadResult.output -match 'permissionDecision.*deny|permissionDecisionReason') "Dev download/export write '$downloadCommand' is denied"
    }

    $devFmtInput = $devAuthorityInput | ConvertTo-Json -Depth 8 | ConvertFrom-Json
    $devFmtInput.tool_name = 'run_in_terminal'
    $devFmtInput.tool_input = @{ command = 'cargo fmt --all' }
    $devFmtFile = Join-Path $inputDir 'dev-cargo-fmt.json'
    Write-Utf8Json -Path $devFmtFile -Value $devFmtInput
    $devFmtResult = Invoke-Hook -Hook $devAuthorityHook -InputFile $devFmtFile
    Assert-True ($devFmtResult.exitCode -eq 0 -and $devFmtResult.output -eq '') 'Dev cargo fmt write remains allowed'
    $producerFmtResult = cmd /c "pwsh -NoProfile -File `"$($kixRoot)/hooks/block-source-edit.ps1`" -Role producer < `"$devFmtFile`"" 2>&1 | Out-String
    Assert-True ($LASTEXITCODE -eq 2) 'Producer cargo fmt write is denied'
    $qaFmtResult = Invoke-Hook -Hook (Join-Path $kixRoot 'hooks/block-source-edit-qa.ps1') -InputFile $devFmtFile
    Assert-True ($qaFmtResult.exitCode -eq 2) 'QA cargo fmt write is denied'
    $fmtCheckInput = $devFmtInput | ConvertTo-Json -Depth 8 | ConvertFrom-Json
    $fmtCheckInput.tool_input = @{ command = 'cargo fmt --all -- --check' }
    $fmtCheckFile = Join-Path $inputDir 'cargo-fmt-check.json'
    Write-Utf8Json -Path $fmtCheckFile -Value $fmtCheckInput
    $producerFmtCheckResult = cmd /c "pwsh -NoProfile -File `"$($kixRoot)/hooks/block-source-edit.ps1`" -Role producer < `"$fmtCheckFile`"" 2>&1 | Out-String
    Assert-True ($LASTEXITCODE -eq 0 -and [string]::IsNullOrWhiteSpace($producerFmtCheckResult)) 'Producer cargo fmt check remains allowed'
    $qaFmtCheckResult = Invoke-Hook -Hook (Join-Path $kixRoot 'hooks/block-source-edit-qa.ps1') -InputFile $fmtCheckFile
    Assert-True ($qaFmtCheckResult.exitCode -eq 0 -and [string]::IsNullOrWhiteSpace($qaFmtCheckResult.output)) 'QA cargo fmt check remains allowed'
    $orchestratorFmtCheckResult = cmd /c "pwsh -NoProfile -File `"$($kixRoot)/hooks/block-source-edit.ps1`" -Role orchestrator < `"$fmtCheckFile`"" 2>&1 | Out-String
    Assert-True ($LASTEXITCODE -eq 0 -and [string]::IsNullOrWhiteSpace($orchestratorFmtCheckResult)) 'Orchestrator cargo fmt check remains allowed'
    $devReadOnlyInput = $devAuthorityInput | ConvertTo-Json -Depth 8 | ConvertFrom-Json
    $devReadOnlyInput.tool_name = 'run_in_terminal'
    $devReadOnlyInput.tool_input = @{ command = 'Get-Content CHANGELOG.md' }
    $devReadOnlyFile = Join-Path $inputDir 'dev-readonly-markdown.json'
    Write-Utf8Json -Path $devReadOnlyFile -Value $devReadOnlyInput
    $devReadOnlyResult = Invoke-Hook -Hook $devAuthorityHook -InputFile $devReadOnlyFile
    Assert-True ($devReadOnlyResult.exitCode -eq 0 -and $devReadOnlyResult.output -eq '') 'Dev markdown read remains allowed'
    $notebookRunInput = [ordered]@{
        tool_name = 'run_notebook_cell'
        tool_input = @{ code = 'print(1)' }
        cwd = ($hookTestRoot -replace '\\', '/')
        hook_event_name = 'PreToolUse'
    }
    $notebookRunFile = Join-Path $inputDir 'dev-notebook-run.json'
    Write-Utf8Json -Path $notebookRunFile -Value $notebookRunInput
    $notebookRunResult = Invoke-Hook -Hook $devAuthorityHook -InputFile $notebookRunFile
    Assert-True ($notebookRunResult.exitCode -eq 0 -and $notebookRunResult.output -eq '') 'Dev notebook execution remains allowed'
    $notebookAuthorityInput = $notebookRunInput | ConvertTo-Json -Depth 8 | ConvertFrom-Json
    $notebookAuthorityInput.tool_input = @{ code = "open('docs/sprint-1/progress.md', 'w').write('l2_verified_sha: x')" }
    $notebookAuthorityFile = Join-Path $inputDir 'dev-notebook-authority.json'
    Write-Utf8Json -Path $notebookAuthorityFile -Value $notebookAuthorityInput
    $notebookAuthorityResult = Invoke-Hook -Hook $devAuthorityHook -InputFile $notebookAuthorityFile
    Assert-True ($notebookAuthorityResult.exitCode -eq 2 -and $notebookAuthorityResult.output -match 'permissionDecision.*deny|permissionDecisionReason') 'Dev notebook authority write is denied'
    $notebookActualInput = $notebookRunInput | ConvertTo-Json -Depth 8 | ConvertFrom-Json
    $notebookActualInput.tool_input = @{ filePath = 'tests/qa-added.ipynb'; cellId = 'cell-1' }
    $notebookActualFile = Join-Path $inputDir 'dev-notebook-actual-shape.json'
    Write-Utf8Json -Path $notebookActualFile -Value $notebookActualInput
    $notebookActualResult = Invoke-Hook -Hook $devAuthorityHook -InputFile $notebookActualFile
    Assert-True ($notebookActualResult.exitCode -eq 2 -and $notebookActualResult.output -match 'permissionDecision.*deny|permissionDecisionReason') 'Dev notebook actual tool shape is denied'

    foreach ($readOnlyGitCommand in @(
            'git fetch origin pull/42/head:refs/kixpower/review/42',
            'git show stash@{0}',
            'git diff stash@{0}',
            'git log --grep=reset',
            'git stash list',
            'git stash show -p',
            'git apply --check fixture.patch',
            'git clean -n')) {
        $readOnlyGitInput = $devAuthorityInput | ConvertTo-Json -Depth 8 | ConvertFrom-Json
        $readOnlyGitInput.tool_name = 'run_in_terminal'
        $readOnlyGitInput.tool_input = @{ command = $readOnlyGitCommand }
        $readOnlyGitFile = Join-Path $inputDir (('readonly-git-' + ($readOnlyGitCommand -replace '[^a-z]+', '-') + '.json'))
        Write-Utf8Json -Path $readOnlyGitFile -Value $readOnlyGitInput
        $readOnlyGitResult = Invoke-Hook -Hook $devAuthorityHook -InputFile $readOnlyGitFile
        Assert-True ($readOnlyGitResult.exitCode -eq 0 -and $readOnlyGitResult.output -eq '') "Dev read-only Git command '$readOnlyGitCommand' remains allowed"
    }
    $qaReadOnlyGitInput = $devAuthorityInput | ConvertTo-Json -Depth 8 | ConvertFrom-Json
    $qaReadOnlyGitInput.tool_name = 'run_in_terminal'
    $qaReadOnlyGitInput.tool_input = @{ command = 'git show stash@{0}' }
    $qaReadOnlyGitFile = Join-Path $inputDir 'qa-readonly-git-show-stash.json'
    Write-Utf8Json -Path $qaReadOnlyGitFile -Value $qaReadOnlyGitInput
    $qaReadOnlyGitResult = Invoke-Hook -Hook (Join-Path $kixRoot 'hooks/block-source-edit-qa.ps1') -InputFile $qaReadOnlyGitFile
    Assert-True ($qaReadOnlyGitResult.exitCode -eq 0 -and $qaReadOnlyGitResult.output -eq '') 'QA read-only Git object inspection remains allowed'

    foreach ($compoundGitCommand in @(
            'git apply --check fixture.patch && git apply fixture.patch',
            'git stash list && git stash push -m fixture',
            'git stash list && git stash pop',
            'git apply --check fixture.patch && git checkout src/main.rs',
            "git status`ngit stash push -m fixture",
            "git diff`ngit checkout src/main.rs")) {
        $compoundInput = $devAuthorityInput | ConvertTo-Json -Depth 8 | ConvertFrom-Json
        $compoundInput.tool_name = 'run_in_terminal'
        $compoundInput.tool_input = @{ command = $compoundGitCommand }
        $compoundFile = Join-Path $inputDir (('compound-git-' + ($compoundGitCommand -replace '[^a-z]+', '-') + '.json'))
        Write-Utf8Json -Path $compoundFile -Value $compoundInput
        $compoundResult = Invoke-Hook -Hook $devAuthorityHook -InputFile $compoundFile
        Assert-True ($compoundResult.exitCode -eq 2 -and $compoundResult.output -match 'permissionDecision.*deny|permissionDecisionReason') "Composite Git write '$compoundGitCommand' is denied"
    }
    $pathOnlyInput = $devAuthorityInput | ConvertTo-Json -Depth 8 | ConvertFrom-Json
    $pathOnlyInput.tool_name = 'run_in_terminal'
    $pathOnlyInput.tool_input = @{ command = 'Get-Content src/scp/config.rs' }
    $pathOnlyFile = Join-Path $inputDir 'readonly-scp-path.json'
    Write-Utf8Json -Path $pathOnlyFile -Value $pathOnlyInput
    $pathOnlyResult = Invoke-Hook -Hook $devAuthorityHook -InputFile $pathOnlyFile
    Assert-True ($pathOnlyResult.exitCode -eq 0 -and $pathOnlyResult.output -eq '') 'Path containing scp remains readable'

    foreach ($syntaxWriteCommand in @(
            'node --eval "require(''fs'').writeFileSync(''src/main.rs'',''x'')"',
            'node --print "require(''fs'').writeFileSync(''src/main.rs'',''x'')"',
            'iwr http://example.invalid -Of src/main.rs',
            'iwr http://example.invalid -Out src/main.rs',
            'Export-Csv -Pa src/main.rs')) {
        $syntaxInput = $devAuthorityInput | ConvertTo-Json -Depth 8 | ConvertFrom-Json
        $syntaxInput.tool_name = 'run_in_terminal'
        $syntaxInput.tool_input = @{ command = $syntaxWriteCommand }
        $syntaxFile = Join-Path $inputDir (('syntax-write-' + ($syntaxWriteCommand -replace '[^a-z]+', '-') + '.json'))
        Write-Utf8Json -Path $syntaxFile -Value $syntaxInput
        $syntaxResult = Invoke-Hook -Hook $devAuthorityHook -InputFile $syntaxFile
        Assert-True ($syntaxResult.exitCode -eq 2 -and $syntaxResult.output -match 'permissionDecision.*deny|permissionDecisionReason') "Syntax write '$syntaxWriteCommand' is denied"
    }

    foreach ($aliasCommand in @('sc docs/sprint-1/progress.md x', 'cp backup.md docs/sprint-1/progress.md', 'git rm docs/sprint-1/progress.md')) {
        $aliasInput = $devAuthorityInput | ConvertTo-Json -Depth 8 | ConvertFrom-Json
        $aliasInput.tool_name = 'run_in_terminal'
        $aliasInput.tool_input = @{ command = $aliasCommand }
        $aliasFile = Join-Path $inputDir (('dev-alias-' + ($aliasCommand -replace '[^a-z]+', '-') + '.json'))
        Write-Utf8Json -Path $aliasFile -Value $aliasInput
        $aliasResult = Invoke-Hook -Hook $devAuthorityHook -InputFile $aliasFile
        Assert-True ($aliasResult.exitCode -eq 2 -and $aliasResult.output -match 'permissionDecision.*deny|permissionDecisionReason') "Dev terminal write alias '$aliasCommand' is denied"
    }

    $devTaskArgsInput = $devAuthorityInput | ConvertTo-Json -Depth 8 | ConvertFrom-Json
    $devTaskArgsInput.tool_name = 'create_and_run_task'
    $devTaskArgsInput.tool_input = @{ task = @{ command = 'pwsh'; args = @('-NoProfile', '-c', 'Set-Content docs/sprint-1/progress.md x') } }
    $devTaskArgsFile = Join-Path $inputDir 'dev-task-args-write.json'
    Write-Utf8Json -Path $devTaskArgsFile -Value $devTaskArgsInput
    $devTaskArgsResult = Invoke-Hook -Hook $devAuthorityHook -InputFile $devTaskArgsFile
    Assert-True ($devTaskArgsResult.exitCode -eq 2 -and $devTaskArgsResult.output -match 'permissionDecision.*deny|permissionDecisionReason') 'Dev task args progress write is denied'

    $devGlobInput = $devAuthorityInput | ConvertTo-Json -Depth 8 | ConvertFrom-Json
    $devGlobInput.tool_name = 'run_in_terminal'
    $devGlobInput.tool_input = @{ command = 'Set-Content docs/sprint-1/progress*.md x' }
    $devGlobFile = Join-Path $inputDir 'dev-progress-glob-terminal.json'
    Write-Utf8Json -Path $devGlobFile -Value $devGlobInput
    $devGlobResult = Invoke-Hook -Hook $devAuthorityHook -InputFile $devGlobFile
    Assert-True ($devGlobResult.exitCode -eq 2 -and $devGlobResult.output -match 'permissionDecision.*deny|permissionDecisionReason') 'Dev glob progress write is denied'

    $devSplitInput = $devAuthorityInput | ConvertTo-Json -Depth 8 | ConvertFrom-Json
    $devSplitInput.tool_name = 'run_in_terminal'
    $devSplitInput.tool_input = @{ command = '$p = ''docs/sprint-1/progre'' + ''ss.md''; Set-Content $p x' }
    $devSplitFile = Join-Path $inputDir 'dev-progress-split-terminal.json'
    Write-Utf8Json -Path $devSplitFile -Value $devSplitInput
    $devSplitResult = Invoke-Hook -Hook $devAuthorityHook -InputFile $devSplitFile
    Assert-True ($devSplitResult.exitCode -eq 2 -and $devSplitResult.output -match 'permissionDecision.*deny|permissionDecisionReason') 'Dev split-path progress write is denied'

    $devNewlineInput = $devAuthorityInput | ConvertTo-Json -Depth 8 | ConvertFrom-Json
    $devNewlineInput.tool_name = 'replace_string_in_file'
    $devNewlineInput.tool_input = @{ filePath = 'docs/sprint-1/progress.md'; oldString = 'completed_tasks: 1'; newString = "completed_tasks: 2`nl2_verified_sha: $sha" }
    $devNewlineFile = Join-Path $inputDir 'dev-progress-newline-authority.json'
    Write-Utf8Json -Path $devNewlineFile -Value $devNewlineInput
    $devNewlineResult = Invoke-Hook -Hook $devAuthorityHook -InputFile $devNewlineFile
    Assert-True ($devNewlineResult.exitCode -eq 2 -and $devNewlineResult.output -match 'permissionDecision.*deny|permissionDecisionReason') 'Dev newline authority injection is denied'

    $devRemoteInput = [ordered]@{
        tool_name = 'mcp_github_mcp_se_create_or_update_file'
        tool_input = @{ path = 'docs/sprint-1/progress.md'; content = 'completed_tasks: 2' }
        cwd = ($hookTestRoot -replace '\\', '/')
        hook_event_name = 'PreToolUse'
    }
    $devRemoteFile = Join-Path $inputDir 'dev-remote-progress-edit.json'
    Write-Utf8Json -Path $devRemoteFile -Value $devRemoteInput
    $devRemoteResult = Invoke-Hook -Hook $devAuthorityHook -InputFile $devRemoteFile
    Assert-True ($devRemoteResult.exitCode -eq 2 -and $devRemoteResult.output -match 'permissionDecision.*deny|permissionDecisionReason') 'Dev remote progress write is denied'

    $sourceBoundaryHook = Join-Path $kixRoot 'hooks/block-source-edit.ps1'
    $sourceAliasInput = $devAuthorityInput | ConvertTo-Json -Depth 8 | ConvertFrom-Json
    $sourceAliasInput.tool_name = 'run_in_terminal'
    $sourceAliasInput.tool_input = @{ command = 'cp backup.md src/main.rs' }
    $sourceAliasFile = Join-Path $inputDir 'producer-source-alias.json'
    Write-Utf8Json -Path $sourceAliasFile -Value $sourceAliasInput
    $sourceAliasResult = Invoke-Hook -Hook $sourceBoundaryHook -InputFile $sourceAliasFile
    Assert-True ($sourceAliasResult.exitCode -eq 2 -and $sourceAliasResult.output -match 'permissionDecision.*deny|permissionDecisionReason') 'Producer source write alias is denied'

    $qaBoundaryHook = Join-Path $kixRoot 'hooks/block-source-edit-qa.ps1'
    $qaAliasInput = $sourceAliasInput | ConvertTo-Json -Depth 8 | ConvertFrom-Json
    $qaAliasInput.tool_input = @{ command = 'sc src/main.rs x' }
    $qaAliasFile = Join-Path $inputDir 'qa-source-alias.json'
    Write-Utf8Json -Path $qaAliasFile -Value $qaAliasInput
    $qaAliasResult = Invoke-Hook -Hook $qaBoundaryHook -InputFile $qaAliasFile
    Assert-True ($qaAliasResult.exitCode -eq 2 -and $qaAliasResult.output -match 'permissionDecision.*deny|permissionDecisionReason') 'QA source write alias is denied'

    $devCompoundInput = $devAuthorityInput | ConvertTo-Json -Depth 8 | ConvertFrom-Json
    $devCompoundInput.tool_name = 'run_in_terminal'
    $devCompoundInput.tool_input = @{ command = 'Get-Content docs/sprint-1/progress.md; Set-Content docs/sprint-1/progress.md x' }
    $devCompoundFile = Join-Path $inputDir 'dev-progress-compound-terminal.json'
    Write-Utf8Json -Path $devCompoundFile -Value $devCompoundInput
    $devCompoundResult = Invoke-Hook -Hook $devAuthorityHook -InputFile $devCompoundFile
    Assert-True ($devCompoundResult.exitCode -eq 2 -and $devCompoundResult.output -match 'permissionDecision.*deny|permissionDecisionReason') 'Dev compound progress write is denied'

    foreach ($gitInternalPath in @('.git/config', '.git/logs/HEAD', '.git/refs/stash', '.git')) {
        $gitInternalInput = $devAuthorityInput | ConvertTo-Json -Depth 8 | ConvertFrom-Json
        $gitInternalInput.tool_name = 'replace_string_in_file'
        $gitInternalInput.tool_input = @{ filePath = "$hookTestRoot/$gitInternalPath"; oldString = 'x'; newString = 'y' }
        $gitInternalFile = Join-Path $inputDir (('dev-git-internal-' + ($gitInternalPath -replace '[^a-z]+', '-') + '.json'))
        Write-Utf8Json -Path $gitInternalFile -Value $gitInternalInput
        $gitInternalResult = Invoke-Hook -Hook $devAuthorityHook -InputFile $gitInternalFile
        Assert-True ($gitInternalResult.exitCode -eq 2 -and $gitInternalResult.output -match 'permissionDecision.*deny|permissionDecisionReason') "Dev .git internal edit '$gitInternalPath' is denied"
    }

        $inlinePlan = 'target_rules: { globs: [src/account.rs], modules: [account] }'
        Assert-True ((Get-KixInlineYamlList -Text $inlinePlan -Key 'globs') -contains 'src/account.rs') 'inline target_rules glob is parsed'
        Assert-True ((Get-KixInlineYamlList -Text $inlinePlan -Key 'modules') -contains 'account') 'inline target_rules module is parsed'
        $flowPlan = "target_rules: {`n  globs: [src/api/{payment,gateway}.rs]`n  modules: [api/payment]`n}"
        Assert-True ((Get-KixInlineYamlList -Text $flowPlan -Key 'globs') -contains 'src/api/{payment,gateway}.rs') 'multiline flow target_rules glob is parsed'
        Assert-True ((Get-KixInlineYamlList -Text $flowPlan -Key 'modules') -contains 'api/payment') 'multiline flow target_rules module is parsed'

        $memoryValidator = Join-Path $kixRoot 'scripts/validate-memory-backlog.ps1'
        Set-Content -LiteralPath (Join-Path $hookTestRoot '.kixpower/memory/repo/harness-backlog.md') -Value @'
- id: invalid
    type: dev-workflow
    status: validated
    problem: invalid
    improvement: invalid
    source: test
    evidence:
        - task: test
            kind: origin
            result: observed
    eval:
        trigger: test
'@ -Encoding utf8
        & pwsh -NoProfile -File $memoryValidator -ProjectRoot $hookTestRoot *> $null
        Assert-True ($LASTEXITCODE -eq 2) 'validated memory record without trial is denied'
        Set-Content -LiteralPath (Join-Path $hookTestRoot '.kixpower/memory/repo/harness-backlog.md') -Value '# Harness Backlog' -Encoding utf8
} finally {
    if ($reviewWorktree -and (Test-Path $reviewWorktree)) {
        git -C $hookTestRoot worktree remove --force $reviewWorktree 2>$null | Out-Null
        Remove-Item -LiteralPath $reviewWorktree -Recurse -Force -ErrorAction SilentlyContinue
    }
    Remove-Item -LiteralPath $hookTestRoot -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $inputDir -Recurse -Force -ErrorAction SilentlyContinue
}

# fidelity 测试需要独立 fixture：fidelity 在无源变更时提前退出（跳过累积度量块），
# 所以 fixture 必须是 git 仓库且 baseline 之后有源文件变更
$fidelityRoot = Join-Path $env:TEMP ('kix-fidelity-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path (Join-Path $fidelityRoot 'docs/sprint-12') -Force | Out-Null
git -C $fidelityRoot init -q
git -C $fidelityRoot config user.email t@e.invalid
git -C $fidelityRoot config user.name KixFidelityTest
Set-Content -LiteralPath (Join-Path $fidelityRoot 'src.txt') -Value 'v1' -Encoding utf8
git -C $fidelityRoot add .
git -C $fidelityRoot commit -qm baseline
$fidelityBaseline = (git -C $fidelityRoot rev-parse HEAD).Trim()
Add-Content -LiteralPath (Join-Path $fidelityRoot 'src.txt') -Value 'v2' -Encoding utf8
Set-Content -LiteralPath (Join-Path $fidelityRoot 'docs/sprint-12/plan.md') -Value @"
---
sprint: 12
baseline_commit: $fidelityBaseline
---
"@ -Encoding utf8
$fidelity = Join-Path $kixRoot 'scripts/verification-fidelity-check.ps1'
$fidelityOutput = & pwsh -NoProfile -File $fidelity -ProjectRoot $fidelityRoot -PrevSprint 12 | Out-String
Assert-True ($fidelityOutput -match 'Verification Fidelity Check v5\.7' -and $fidelityOutput -match 'baseline_source: plan\.baseline_commit') 'fidelity reports SHA baseline source'
Remove-Item -LiteralPath $fidelityRoot -Recurse -Force -ErrorAction SilentlyContinue

$script:passed = $true
Write-Output 'All contract regression cases passed.'
