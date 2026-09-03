# Kixpower — Hook: pre-commit language syntax/format check
# 触发：PreToolUse，仅当命令含 git commit / --amend。
# 快路径（本 hook 可机械跑）：rustfmt --check 暂存 .rs / gofmt -l / 有配置才
#   ruff format --check / 仅 node_modules prettier --check。失败 → deny。
# 慢路径（clippy / eslint 全量）：不在本 hook 跑（超时与预存 warning 误报）；
#   DSH kix-discipline 按本回合是否跑过对应命令 remind。
# 工具缺失 / 非 git commit / 解析失败 → 放行（fail-open；lint 是 remind 级，不拦一切工具）。

$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$Env:LC_ALL = "C.UTF-8"
$Env:LANG = "C.UTF-8"

function Write-KixDeny([string]$Reason) {
    $result = @{
        hookSpecificOutput = @{
            hookEventName = "PreToolUse"
            permissionDecision = "deny"
            permissionDecisionReason = $Reason
        }
    }
    Write-Output ($result | ConvertTo-Json -Depth 5)
    exit 2
}

$inputJson = $Input | Out-String
if ([string]::IsNullOrWhiteSpace($inputJson)) { exit 0 }

try {
    $hookInput = $inputJson | ConvertFrom-Json
} catch {
    exit 0
}

$contractScript = Join-Path $PSScriptRoot '..\scripts\kixpower-contract.ps1'
if (Test-Path $contractScript) {
    . (Resolve-Path $contractScript)
}

function Get-KixHookCommands($HookInput) {
    $cmds = New-Object System.Collections.Generic.List[string]
    function Add-Cmd($obj) {
        if ($null -eq $obj) { return }
        foreach ($key in @('command', 'cmd')) {
            if ($obj.PSObject.Properties.Name -contains $key -and $obj.$key) {
                $cmds.Add([string]$obj.$key)
            }
        }
    }
    Add-Cmd $HookInput.tool_input
    Add-Cmd $HookInput.toolInput
    if ($null -ne $HookInput.toolArgs) {
        try { Add-Cmd ($HookInput.toolArgs | ConvertFrom-Json) } catch { }
    }
    if ($HookInput.PSObject.Properties.Name -contains 'toolCalls' -and $HookInput.toolCalls) {
        foreach ($call in @($HookInput.toolCalls)) {
            if ($null -ne $call.args) {
                try { Add-Cmd ($call.args | ConvertFrom-Json) } catch { Add-Cmd $call.args }
            }
            Add-Cmd $call
        }
    }
    return @($cmds)
}

function Test-KixIsGitCommit([string]$Command) {
    if ([string]::IsNullOrWhiteSpace($Command)) { return $false }
    if (Get-Command Test-KixGitCommitCommand -ErrorAction SilentlyContinue) {
        return [bool](Test-KixGitCommitCommand -Command $Command)
    }
    return [bool]($Command -match '(?i)(?:^|[;&|\n]|&&|\|\|)\s*git(?:\.exe)?(?:\s+-C\s+\S+)?(?:\s+\S+)*\s+commit(?![\w-])')
}

$commands = @(Get-KixHookCommands $hookInput)
$isCommit = $false
foreach ($command in $commands) {
    if (Test-KixIsGitCommit $command) { $isCommit = $true; break }
}
if (-not $isCommit) { exit 0 }

$workspace = $null
foreach ($key in @('workspaceFolder', 'cwd', 'workingDirectory')) {
    if ($hookInput.PSObject.Properties.Name -contains $key -and $hookInput.$key) {
        $workspace = [string]$hookInput.$key
        break
    }
}
if (-not $workspace) { $workspace = (Get-Location).Path }

$gitArgs = @()
if ($workspace -and (Test-Path $workspace)) { $gitArgs += @('-C', $workspace) }
$staged = @()
try {
    $staged = @(git @gitArgs diff --cached --name-only --diff-filter=ACMR 2>$null)
} catch {
    exit 0
}
if ($staged.Count -eq 0) { exit 0 }

$failures = New-Object System.Collections.Generic.List[string]
$hints = New-Object System.Collections.Generic.List[string]

$rustFiles = @($staged | Where-Object { $_ -match '\.rs$' })
$goFiles = @($staged | Where-Object { $_ -match '\.go$' })
$pyFiles = @($staged | Where-Object { $_ -match '\.py$' })
$jsFiles = @($staged | Where-Object { $_ -match '\.(?:[cm]?[jt]sx?)$' })

if ($rustFiles.Count -gt 0) {
    $hints.Add('cargo clippy -D warnings')
    $rustfmt = Get-Command rustfmt -ErrorAction SilentlyContinue
    if ($rustfmt) {
        $dirty = @()
        foreach ($f in $rustFiles) {
            $path = if ($workspace) { Join-Path $workspace $f } else { $f }
            if (-not (Test-Path $path)) { continue }
            & rustfmt --check $path 2>$null | Out-Null
            if ($LASTEXITCODE -ne 0) { $dirty += $f }
        }
        if ($dirty.Count -gt 0) {
            $failures.Add("rustfmt --check needed: $($dirty -join ', ')")
        }
    } elseif (Get-Command cargo -ErrorAction SilentlyContinue) {
        $fmt = & cargo fmt --check 2>&1 | Out-String
        if ($LASTEXITCODE -ne 0 -and $fmt -notmatch 'could not find `Cargo\.toml`') {
            $failures.Add("cargo fmt --check failed:`n$fmt")
        }
    }
}

if ($goFiles.Count -gt 0) {
    $hints.Add('gofmt / go vet')
    if (Get-Command gofmt -ErrorAction SilentlyContinue) {
        $dirty = @()
        foreach ($f in $goFiles) {
            $path = if ($workspace) { Join-Path $workspace $f } else { $f }
            if (Test-Path $path) {
                $listed = & gofmt -l $path 2>$null
                if ($listed) { $dirty += $f }
            }
        }
        if ($dirty.Count -gt 0) {
            $failures.Add("gofmt needed: $($dirty -join ', ')")
        }
    }
}

if ($pyFiles.Count -gt 0) {
    $hints.Add('ruff/mypy/black')
    $ruffConfig = $false
    if ($workspace) {
        foreach ($c in @('ruff.toml', '.ruff.toml')) {
            if (Test-Path (Join-Path $workspace $c)) { $ruffConfig = $true }
        }
        $pyproject = Join-Path $workspace 'pyproject.toml'
        if ((Test-Path $pyproject) -and (Select-String -Path $pyproject -Pattern '\[tool\.ruff' -Quiet)) { $ruffConfig = $true }
    }
    $ruff = Get-Command ruff -ErrorAction SilentlyContinue
    if ($ruff -and $ruffConfig) {
        $check = & ruff format --check @pyFiles 2>&1 | Out-String
        if ($LASTEXITCODE -ne 0) {
            $failures.Add("ruff format --check failed:`n$check")
        }
    }
}

if ($jsFiles.Count -gt 0) {
    $hints.Add('eslint/prettier/biome/typecheck')
    $prettierCmd = $null
    $localPrettier = $null
    if ($workspace) {
        $localPrettier = Join-Path $workspace 'node_modules/.bin/prettier'
        if ($IsWindows -or $env:OS -match 'Windows') {
            $cmdCandidate = $localPrettier + '.cmd'
            if (Test-Path $cmdCandidate) { $localPrettier = $cmdCandidate }
        }
    }
    if ($localPrettier -and (Test-Path $localPrettier)) { $prettierCmd = $localPrettier }
    if ($prettierCmd) {
        $check = & $prettierCmd --check @jsFiles 2>&1 | Out-String
        if ($LASTEXITCODE -ne 0) {
            $failures.Add("prettier --check failed:`n$check")
        }
    }
}

if ($failures.Count -gt 0) {
    $reason = "PRE-COMMIT LINT: 暂存文件未过语言格式检查。`n" + ($failures -join "`n")
    if ($hints.Count -gt 0) {
        $reason += "`nAlso run: " + (($hints | Select-Object -Unique) -join ' ; ')
    }
    Write-KixDeny $reason
}

exit 0
