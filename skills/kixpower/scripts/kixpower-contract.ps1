# Kixpower contract helpers shared by hooks and scripts.

function Get-KixFrontmatter {
    param([Parameter(Mandatory = $true)][string]$Text)
    $match = [regex]::Match($Text, '(?ms)^---\s*\r?\n(?<body>.*?)\r?\n---(?:\s|$)')
    if ($match.Success) { return $match.Groups['body'].Value }
    return ''
}

function Get-KixYamlScalar {
    param(
        [Parameter(Mandatory = $true)][string]$Text,
        [Parameter(Mandatory = $true)][string]$Key
    )
    $escapedYamlKey = [regex]::Escape($Key)
    $linePattern = '(?m)^[ \t]*{0}:[ \t]*(?<value>[^\r\n]*)' -f $escapedYamlKey
    $scalarMatch = [regex]::Match($Text, $linePattern)
    if (-not $scalarMatch.Success) { return $null }
    return ($scalarMatch.Groups['value'].Value -replace '\s+#.*$', '').Trim().Trim('"').Trim("'")
}

function Convert-KixYamlItem {
    param([string]$Value)
    $clean = ($Value -replace '\s+#.*$', '').Trim().Trim('"').Trim("'").Trim()
    if ($clean) { return $clean }
    return $null
}

function Get-KixYamlList {
    param(
        [Parameter(Mandatory = $true)][string]$Text,
        [Parameter(Mandatory = $true)][string]$Key
    )
    $items = [System.Collections.Generic.List[string]]::new()
    $escapedYamlKey = [regex]::Escape($Key)
    $linePattern = '(?ms)^[ \t]*{0}:[ \t]*(?<inline>\[[^\r\n\]]*\])?(?<block>(?:\r?\n[ \t]+-[^\r\n]*)*)' -f $escapedYamlKey
    $listMatch = [regex]::Match($Text, $linePattern)
    if (-not $listMatch.Success) { return @() }

    $inline = $listMatch.Groups['inline'].Value
    if ($inline) {
        $body = $inline.Trim().TrimStart('[').TrimEnd(']')
        $protectedBody = [regex]::Replace($body, '\{[^{}]*\}', { param($match) $match.Value.Replace(',', '__KIX_COMMA__') })
        foreach ($item in ($protectedBody -split ',')) {
            $item = $item.Replace('__KIX_COMMA__', ',')
            $value = Convert-KixYamlItem $item
            if ($value) { $items.Add($value) }
        }
    }

    foreach ($line in ($listMatch.Groups['block'].Value -split '\r?\n')) {
        $itemMatch = [regex]::Match($line, '^\s*-\s*(?<value>.+)$')
        if ($itemMatch.Success) {
            $value = Convert-KixYamlItem $itemMatch.Groups['value'].Value
            if ($value) { $items.Add($value) }
        }
    }
    return @($items | Select-Object -Unique)
}

function Get-KixInlineYamlList {
    param(
        [Parameter(Mandatory = $true)][string]$Text,
        [Parameter(Mandatory = $true)][string]$Key
    )
    $values = [System.Collections.Generic.List[string]]::new()
    $pattern = '(?i)(?:^|[{,\r\n])\s*' + [regex]::Escape($Key) + '\s*:\s*\[([^\]]*)\]'
    foreach ($match in [regex]::Matches($Text, $pattern)) {
        $protectedBody = [regex]::Replace($match.Groups[1].Value, '\{[^{}]*\}', { param($itemMatch) $itemMatch.Value.Replace(',', '__KIX_COMMA__') })
        foreach ($item in ($protectedBody -split ',')) {
            $item = $item.Replace('__KIX_COMMA__', ',')
            $value = Convert-KixYamlItem $item
            if ($value) { $values.Add($value) }
        }
    }
    return @($values | Select-Object -Unique)
}

function Get-KixIndentedBlocks {
    param(
        [Parameter(Mandatory = $true)][string]$Text,
        [Parameter(Mandatory = $true)][string]$Header
    )
    $lines = $Text -split '\r?\n'
    $blocks = [System.Collections.Generic.List[string]]::new()
    for ($i = 0; $i -lt $lines.Count; $i++) {
        $headerPattern = '^(?<indent>[ \t]*){0}:[ \t]*(?<inline>[^#]*)$' -f [regex]::Escape($Header)
        $headerMatch = [regex]::Match($lines[$i], $headerPattern)
        if (-not $headerMatch.Success) { continue }
        $indent = $headerMatch.Groups['indent'].Value.Length
        $body = [System.Collections.Generic.List[string]]::new()
        $inlineValue = $headerMatch.Groups['inline'].Value.Trim()
        if ($inlineValue) { $body.Add($inlineValue) }
        for ($j = $i + 1; $j -lt $lines.Count; $j++) {
            $line = $lines[$j]
            if ($line -match '\S') {
                $lineIndent = ($line.Length - $line.TrimStart().Length)
                if ($lineIndent -le $indent -and $line -notmatch '^[ \t]*#') { break }
            }
            $body.Add($line)
        }
        $blocks.Add(($body -join "`n"))
    }
    return @($blocks)
}

function Get-KixPlanGateRecords {
    param([Parameter(Mandatory = $true)][string]$PlanText)
    $records = [System.Collections.Generic.List[object]]::new()
    foreach ($block in (Get-KixIndentedBlocks -Text $PlanText -Header 'verifiable_gates')) {
        $gateRows = [regex]::Matches($block, '(?ms)^[ \t]*-\s+id:\s*(?<id>[^\r\n#]+)(?<body>.*?)(?=^[ \t]*-\s+id:|\z)')
        foreach ($gate in $gateRows) {
            $id = (Convert-KixYamlItem $gate.Groups['id'].Value)
            if (-not $id) { continue }
            $body = $gate.Groups['body'].Value
            $type = Get-KixYamlScalar -Text $body -Key 'type'
            $owner = Get-KixYamlScalar -Text $body -Key 'owner'
            $cmd = Get-KixYamlScalar -Text $body -Key 'cmd'
            if (-not $cmd) { $cmd = Get-KixYamlScalar -Text $body -Key 'command' }
            $expect = Get-KixYamlScalar -Text $body -Key 'expect'
            $required = Get-KixYamlScalar -Text $body -Key 'required'
            if (-not $required) { $required = 'true' }
            if (-not $type -and $owner -eq 'L2') { $type = 'local_gate' }
            if (-not $type) { $type = 'legacy' }
            $records.Add([pscustomobject]@{
                    id       = $id
                    type     = $type
                    cmd      = if ($cmd) { $cmd } else { '' }
                    expect   = if ($expect) { $expect } else { '' }
                    required = ($required -notmatch '^(?i:false|no|0)$')
                    owner    = if ($owner) { $owner } else { '' }
                })
        }
    }
    return @($records)
}

function Get-KixTaskDagRecords {
    param([Parameter(Mandatory = $true)][string]$PlanText)
    $records = [System.Collections.Generic.List[object]]::new()
    foreach ($block in (Get-KixIndentedBlocks -Text $PlanText -Header 'task_dag')) {
        foreach ($match in [regex]::Matches($block, '(?m)^[ \t]*-\s+id:\s*(?<id>[^\r\n#]+)')) {
            $id = Convert-KixYamlItem $match.Groups['id'].Value
            if ($id) { $records.Add([pscustomobject]@{ id = $id }) }
        }
    }
    return @($records | Sort-Object id -Unique)
}

function Get-KixRequiredLocalGates {
    param([Parameter(Mandatory = $true)][string]$PlanText)
    return @(Get-KixPlanGateRecords -PlanText $PlanText | Where-Object {
            $_.type -eq 'local_gate' -and $_.required
        } | Sort-Object id -Unique)
}

function Get-KixGateManifestConflicts {
    param([Parameter(Mandatory = $true)][string]$PlanText)
    $records = @(Get-KixPlanGateRecords -PlanText $PlanText)
    foreach ($group in ($records | Group-Object id)) {
        $signatures = @($group.Group | ForEach-Object {
                '{0}|{1}|{2}|{3}' -f $_.type, $_.cmd, $_.expect, $_.required
            } | Sort-Object -Unique)
        if ($signatures.Count -gt 1) {
            [pscustomobject]@{
                id         = [string]$group.Name
                signatures = $signatures
            }
        }
    }
}

function Get-KixGateManifestJson {
    param([Parameter(Mandatory = $true)][object[]]$Gates)
    $manifest = @($Gates | Sort-Object id | ForEach-Object {
            [ordered]@{
                id       = [string]$_.id
                type     = [string]$_.type
                cmd      = [string]$_.cmd
                expect   = [string]$_.expect
                required = [bool]$_.required
            }
        })
    return ($manifest | ConvertTo-Json -Compress -Depth 4)
}

function Get-KixSha256 {
    param([Parameter(Mandatory = $true)][string]$Text)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($Text)
        return (($sha.ComputeHash($bytes) | ForEach-Object { $_.ToString('x2') }) -join '')
    } finally {
        $sha.Dispose()
    }
}

function Test-KixSha {
    param([AllowNull()][string]$Sha)
    return [bool]($Sha -and $Sha -match '^[0-9a-fA-F]{40}$')
}

function Get-KixGitStashRefs {
    param([Parameter(Mandatory = $true)][string]$ProjectRoot)
    $refs = @(git -C $ProjectRoot stash list --format='%H' 2>$null |
            ForEach-Object { ([string]$_).Trim() } |
            Where-Object { $_ -and (Test-KixSha $_) } |
            Sort-Object -Unique)
    return @($refs)
}

function Get-KixNormalizedPath {
    param(
        [Parameter(Mandatory = $true)][string]$Value,
        [string]$BasePath
    )
    try {
        $candidate = $Value.Trim()
        if ($candidate -match '^(?i)file://') {
            $uri = [System.Uri]$candidate
            if (-not $uri.IsFile) { return $null }
            $candidate = $uri.LocalPath
        }
        if ($BasePath -and -not [System.IO.Path]::IsPathRooted($candidate)) {
            $candidate = Join-Path $BasePath $candidate
        }
        return [System.IO.Path]::GetFullPath($candidate).Replace('\', '/')
    } catch {
        return $null
    }
}

function Get-KixPathValues {
    param([Parameter(Mandatory = $true)]$ToolInput)
    $values = [System.Collections.Generic.List[string]]::new()
    foreach ($key in @('filePath', 'file_path', 'dirPath', 'path', 'uri')) {
        if ($ToolInput.PSObject.Properties.Name -contains $key -and $ToolInput.$key) {
            $values.Add([string]$ToolInput.$key)
        }
    }
    if ($ToolInput.PSObject.Properties.Name -contains 'files' -and $ToolInput.files) {
        foreach ($file in @($ToolInput.files)) {
            if ($file.path) { $values.Add([string]$file.path) }
            elseif ($file.filePath) { $values.Add([string]$file.filePath) }
        }
    }
    return @($values)
}

function Test-KixSuspiciousExecutionTool {
    param(
        [Parameter(Mandatory = $true)][string]$ToolName,
        [AllowNull()][string]$Canonical
    )
    $knownSafe = @(
        'run_in_terminal', 'create_and_run_task', 'runSubagent', 'explore_subagent',
        'read', 'search', 'read_file', 'grep_search', 'semantic_search', 'file_search',
        'list_dir', 'view_image', 'get_errors', 'manage_todo_list', 'vscode_askQuestions',
        'run_notebook_cell',
        # v6.1：真实运行时工具名（copilot-agent 1.0.70+，见 kix-vscode-mechanism-audit.md）
        'powershell', 'bash', 'view', 'edit', 'create', 'grep', 'glob', 'ask_user',
        'task', 'web_fetch', 'web_search', 'update_todo', 'read_powershell',
        'stop_powershell', 'sql', 'skill', 'write', 'delete_file'
    )
    $leaf = ($ToolName -split '\.')[-1]
    if ($leaf -in @('install_extension', 'run_vscode_command', 'create_new_workspace', 'create_new_jupyter_notebook')) { return $true }
    if ($knownSafe -contains $ToolName -or $knownSafe -contains $leaf) { return $false }
    # v6.1：Claude 名归一后命中安全名单也放行（Bash/Read/Write/Edit/Grep/Glob/WebFetch/
    # WebSearch/AskUserQuestion/TodoWrite/Agent/Task）
    if ($Canonical -and ($knownSafe -contains $Canonical)) { return $false }
    return [bool]($ToolName -match '(?i)(?:run(?:code|script|snippet|cell)?|exec(?:ute)?|eval|snippet|shell|python|jupyter|pylance|debug(?:ger)?|(?:^|[_-])repl(?:$|[_-])|kernel|interpreter|code[-_]?execution)')
}

function Get-KixTerminalCommand {
    param(
        [Parameter(Mandatory = $true)][string]$ToolLeaf,
        [Parameter(Mandatory = $true)]$ToolInput
    )
    $parts = [System.Collections.Generic.List[string]]::new()
    if ($ToolLeaf -eq 'create_and_run_task') {
        $task = $ToolInput.task
        if ($task -and $task.command) {
            $parts.Add([string]$task.command)
        } elseif ($ToolInput.command) {
            $parts.Add([string]$ToolInput.command)
        }
        if ($task) {
            foreach ($key in @('args', 'arguments')) {
                if ($task.PSObject.Properties.Name -contains $key -and $task.$key) {
                    foreach ($arg in @($task.$key)) {
                        if ($arg -is [string]) { $parts.Add($arg) }
                        else { $parts.Add(($arg | ConvertTo-Json -Compress -Depth 8)) }
                    }
                }
            }
        }
    } elseif ($ToolInput.command) {
        $parts.Add([string]$ToolInput.command)
    }
    return ($parts -join ' ')
}

    function Get-KixGitCommandParts {
        param([Parameter(Mandatory = $true)][string]$Command)
        $gitMatch = [regex]::Match($Command, '(?i)(?<![\w.-])git(?:\.exe)?(?![\w.-])(?<args>[^;&|\r\n]*)')
        if (-not $gitMatch.Success) { return $null }
        $tokenMatches = [regex]::Matches($gitMatch.Groups['args'].Value, '"(?:\\.|[^"])*"|''(?:''''|[^''])*''|[^\s;&|]+')
        $tokens = @($tokenMatches | ForEach-Object { $_.Value.Trim().Trim('"').Trim("'") })
        if ($tokens.Count -eq 0) { return $null }

        $valueOptions = @('-c', '-C', '--config', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--exec-path', '--config-env')
        $flagOptions = @('--no-pager', '--paginate', '--literal-pathspecs', '--glob-pathspecs', '--icase-pathspecs', '--no-replace-objects', '--bare')
        $inlineConfigKeys = [System.Collections.Generic.List[string]]::new()
        $index = 0
        while ($index -lt $tokens.Count) {
            $token = [string]$tokens[$index]
            if ($valueOptions -contains $token) {
                if ($token -in @('-c', '--config') -and $index + 1 -lt $tokens.Count) {
                    $inlineValue = [string]$tokens[$index + 1]
                    if ($inlineValue -match '^[^=]+=') { $inlineConfigKeys.Add((($inlineValue -split '=', 2)[0])) }
                }
                $index += 2
                continue
            }
            if ($token -match '^(?:-c|-C|--config|--git-dir|--work-tree|--namespace|--super-prefix|--exec-path|--config-env)=') {
                if ($token -match '^(?:-c|--config)=(?<key>[^=]+)=') { $inlineConfigKeys.Add($Matches['key']) }
                elseif ($token -match '^--config-env=(?<key>[^=]+)=') { $inlineConfigKeys.Add($Matches['key']) }
                $index++
                continue
            }
            # gitcli stuck short-option: -c<key>=<value> (officially recommended form)
            if ($token -match '^-c(?<key>[^\s=]+)=') {
                $inlineConfigKeys.Add($Matches['key'])
                $index++
                continue
            }
            # -C<path> stuck form (changes repo dir, no config key but must skip)
            if ($token -match '^-C\S') {
                $index++
                continue
            }
            if ($flagOptions -contains $token -or $token -match '^--') {
                $index++
                continue
            }
            break
        }
        if ($index -ge $tokens.Count) { return $null }
        $arguments = @()
        if ($index + 1 -lt $tokens.Count) { $arguments = @($tokens[($index + 1)..($tokens.Count - 1)]) }
        return [pscustomobject]@{
            subcommand       = ([string]$tokens[$index]).ToLowerInvariant()
            arguments        = $arguments
            inlineConfigKeys = @($inlineConfigKeys | Sort-Object -Unique)
        }
    }

    function Get-KixGitCommandPartsAll {
        param([Parameter(Mandatory = $true)][string]$Command)
        $parts = [System.Collections.Generic.List[object]]::new()
        foreach ($match in [regex]::Matches($Command, '(?i)(?<![\w.-])git(?:\.exe)?(?![\w.-])[^;&|\r\n]*')) {
            $part = Get-KixGitCommandParts -Command $match.Value
            if ($part) { $parts.Add($part) }
        }
        return @($parts)
    }

    function Test-KixGitWriteCommand {
        param([Parameter(Mandatory = $true)][string]$Command)
        $parts = @(Get-KixGitCommandPartsAll -Command $Command)
        if ($parts.Count -eq 0) { return $false }
        $writeCommands = @('apply', 'am', 'checkout', 'restore', 'clean', 'reset', 'stash', 'update-index', 'rm', 'mv', 'merge', 'rebase', 'cherry-pick', 'revert', 'read-tree', 'checkout-index', 'pull', 'reflog', 'gc', 'prune', 'maintenance', 'commit-tree', 'update-ref', 'symbolic-ref', 'hash-object', 'replace', 'fast-import')
        $sensitiveConfigKeys = '(?i)^(?:alias\.|core\.(?:hooksPath|editor|pager|sshCommand|gitProxy)|gc\.reflogExpire(?:Unreachable)?|credential\.helper|diff\.external|difftool\..*\.cmd|filter\..*\.(?:clean|smudge|process)|sequence\.editor|core\.fsmonitor)'
        foreach ($part in $parts) {
            if (@($part.inlineConfigKeys | Where-Object { $_ -match $sensitiveConfigKeys }).Count -gt 0) { return $true }
            if ($part.subcommand -eq 'config') {
                $arguments = @($part.arguments)
                $readsConfig = @($arguments | Where-Object { $_ -match '^(?i)(?:--get(?:-all|-regexp)?|--list|-l|--show-origin|--show-names)$' }).Count -gt 0
                if ($readsConfig) { continue }
                $firstConfigKey = @($arguments | Where-Object { $_ -and -not $_.StartsWith('-') } | Select-Object -First 1)
                if ($firstConfigKey -and [string]$firstConfigKey -match $sensitiveConfigKeys) { return $true }
                continue
            }
            if ($writeCommands -notcontains $part.subcommand) { continue }
            if ($part.subcommand -eq 'apply' -and @($part.arguments) -contains '--check') { continue }
            if ($part.subcommand -eq 'clean' -and (@($part.arguments) | Where-Object { $_ -match '^(?:-\w*n\w*|--dry-run)$' })) { continue }
            if ($part.subcommand -eq 'stash' -and @($part.arguments).Count -gt 0 -and @($part.arguments)[0] -in @('list', 'show', '--list')) { continue }
            if ($part.subcommand -eq 'reflog') {
                $firstReflogArg = @($part.arguments | Where-Object { $_ -and -not $_.StartsWith('-') } | Select-Object -First 1)
                if (-not $firstReflogArg -or $firstReflogArg -in @('show', 'list', 'exists')) { continue }
            }
            return $true
        }
        return $false
    }

    function Test-KixGitCommitCommand {
        param([Parameter(Mandatory = $true)][string]$Command)
        foreach ($part in @(Get-KixGitCommandPartsAll -Command $Command)) {
            if ($part.subcommand -eq 'commit' -or @($part.arguments) -contains '--amend') { return $true }
        }
        return $false
    }

    function Get-KixCommandSegments {
        param([Parameter(Mandatory = $true)][string]$Command)
        $segments = [System.Collections.Generic.List[string]]::new()
        $builder = New-Object System.Text.StringBuilder
        $quote = [char]0
        $escaped = $false
        for ($i = 0; $i -lt $Command.Length; $i++) {
            $character = $Command[$i]
            if ($escaped) {
                [void]$builder.Append($character)
                $escaped = $false
                continue
            }
            if ($character -eq '`') {
                [void]$builder.Append($character)
                $escaped = $true
                continue
            }
            if ($quote -ne [char]0) {
                [void]$builder.Append($character)
                if ($character -eq $quote) { $quote = [char]0 }
                continue
            }
            if ($character -eq '''' -or $character -eq '"') {
                $quote = $character
                [void]$builder.Append($character)
                continue
            }
            if ($character -eq ';' -or $character -eq '&' -or $character -eq '|' -or $character -eq "`r" -or $character -eq "`n") {
                $segment = $builder.ToString().Trim()
                if ($segment) { $segments.Add($segment) }
                [void]$builder.Clear()
                continue
            }
            [void]$builder.Append($character)
        }
        $lastSegment = $builder.ToString().Trim()
        if ($lastSegment) { $segments.Add($lastSegment) }
        return @($segments)
    }

function Test-KixTerminalWriteCommand {
    param(
        [Parameter(Mandatory = $true)][string]$Command,
        [switch]$AllowFormatting
    )
    $segments = @(Get-KixCommandSegments -Command $Command)
    if ($segments.Count -gt 1) {
        foreach ($segment in $segments) {
            if (Test-KixTerminalWriteCommand -Command $segment -AllowFormatting:$AllowFormatting) { return $true }
        }
        return $false
    }
    # 终端写入统一拒绝：别名也属于同一 PowerShell cmdlet，且 token 边界排除 .md 等文件后缀误匹配。
    $token = '(?<![\w.-])'
    $writePattern = "(?i)(?:$token(?:Set-Content|sc|Add-Content|ac|Out-File|Clear-Content|clc|Copy-Item|cpi|cp|copy|Move-Item|mi|mv|move|Remove-Item|ri|rm|del|erase|rmdir|rd|New-Item|ni|md|mkdir|Tee-Object|tee|touch|truncate)(?![\w.-])|$token(?:sed\s+-i|perl\s+-pi)(?![\w.-])|\[(?:System\.)?IO\.(?:File|StreamWriter|FileStream)\]|::(?:WriteAllText|WriteAllBytes|AppendAllText)|$token(?:pwsh|powershell|cmd|bash|sh|zsh|python|python3|node|ruby|perl)(?![\w.-])[^;&|\r\n]*(?:\s(?:--?|/)(?:c|k|Command|EncodedCommand|enc|e|eval|print|pe|p|File|f)(?=\s|=|$))|$token(?:gofmt\s+-w|prettier\b[^;&|\r\n]*--write|ruff\b[^;&|\r\n]*--fix)(?![\w.-])|$token(?:Invoke-Expression|iex|Set-Alias|New-Alias|Remove-Alias)(?![\w.-])|>{1,2}\s*(?!\$null\b|/dev/null\b|&\d\b)[^|;\s]+)"
    if ($Command -match $writePattern) { return $true }

    $webClientPattern = '(?i)(?:(?:System\.)?Net\.WebClient|New-Object\s+(?:-TypeName\s+)?["'']?(?:System\.)?Net\.WebClient)'
    if ($Command -match $webClientPattern) { return $true }

    $downloadPattern = "(?i)$token(?:Invoke-WebRequest|iwr|wget|Invoke-RestMethod|irm)(?![\w.-])[^;&|\r\n]*\s-(?:O|Of|Ou|Out|OutF|OutFi|OutFil|OutFile|OutputFile|Literal|LiteralP|LiteralPath|Path)(?=\s|=|$)"
    if ($Command -match $downloadPattern) { return $true }
    $curlPattern = "(?i)$token(?:curl|curl\.exe)(?![\w.-])[^;&|\r\n]*(?:\s(?:-o|--output|--remote-name|--remote-name-all)(?:\s|=|(?=[^\s;&|]))|\s-O(?:\s|$))"
    if ($Command -match $curlPattern) { return $true }
    $wgetPattern = "(?i)$token(?:wget|wget\.exe)(?![\w.-])[^;&|\r\n]*(?:\s(?:-O|--output-document|--directory-prefix|-P)(?:\s|=|(?=[^\s;&|])))"
    if ($Command -match $wgetPattern) { return $true }
    $exportPattern = "(?i)$token(?:Export-Csv|Export-Clixml|Export-Pssession)(?![\w.-])[^;&|\r\n]*\s-(?:P|Pa|Pat|Path|Literal|LiteralP|LiteralPath|Destination)(?=\s|=|$)"
    if ($Command -match $exportPattern) { return $true }
    $transferPattern = "(?i)$token(?:Start-BitsTransfer|bitsadmin)(?![\w.-])[^;&|\r\n]*(?:\s-(?:D|De|Des|Dest|Desti|Destin|Destina|Destination|S|So|Sou|Sour|Source)|\s/transfer\b)"
    if ($Command -match $transferPattern) { return $true }
    $certutilPattern = "(?i)${token}certutil(?![\w.-])[^;&|]*\s-(?:decode|decodehex|encode)\b"
    if ($Command -match $certutilPattern) { return $true }
    $fsutilPattern = "(?i)${token}fsutil(?![\w.-])[^;&|]*\bfile\s+createnew\b"
    if ($Command -match $fsutilPattern) { return $true }
    $remoteTransferPattern = '(?i)(?:^|[;&|\r\n])\s*(?:sudo\s+)?(?:scp|rsync)(?:\.exe)?(?=\s|$)'
    if ($Command -match $remoteTransferPattern) { return $true }

    if (Test-KixGitWriteCommand -Command $Command) { return $true }

    $rustFixPattern = "(?i)(?:${token}cargo(?:\.exe)?(?![\w.-])\s+(?:fix\b|clippy\b[^;&|\r\n]*(?<![\w-])--fix(?![\w-]))|${token}rustfmt(?:\.exe)?(?![\w.-]))"
    if ($Command -match $rustFixPattern -and $Command -notmatch '(?i)(?<![\w-])--check(?![\w-])') {
        return $true
    }
    if ($Command -match "(?i)${token}cargo(?:\.exe)?(?![\w.-])\s+fmt\b[^;&|\r\n]*") {
        if (-not $AllowFormatting -and $Command -notmatch '(?i)(?<![\w-])--check(?![\w-])') { return $true }
    }
    return $false
}

function Get-KixSqlFileReferences {
    param([Parameter(Mandatory = $true)][string]$Command)
    $references = [System.Collections.Generic.List[object]]::new()
    $patterns = @(
        '(?i)(?:^|[\s;&|])<\s*(?:"(?<quoted>[^"]+)"|''(?<single>[^'']+)''|(?<bare>[^\s;&|]+))',
        '(?i)(?:^|[\s;&|])(?:-f|--file|--queries-file|-InputFile)(?:=|\s+)(?:"(?<quoted>[^"]+)"|''(?<single>[^'']+)''|(?<bare>[^\s;&|]+))',
        '(?i)(?:^|[\s;&|])(?:source|\\i|\.read)\s+(?:"(?<quoted>[^"]+)"|''(?<single>[^'']+)''|(?<bare>[^\s;&|]+))',
        '(?i)\b(?:Get-Content|cat|type)\s+(?:-Raw\s+)?(?:"(?<quoted>[^"]+)"|''(?<single>[^'']+)''|(?<bare>[^\s;&|]+))'
    )
    foreach ($pattern in $patterns) {
        foreach ($match in [regex]::Matches($Command, $pattern)) {
            $value = @($match.Groups['quoted'].Value, $match.Groups['single'].Value, $match.Groups['bare'].Value) |
                Where-Object { $_ } | Select-Object -First 1
            if ($value) {
                $references.Add([pscustomobject]@{
                        path       = [string]$value
                        resolvable = ([string]$value -notmatch '^(?:\$|%|\(|`|\{)')
                    })
            }
        }
    }
    return @($references | Sort-Object path -Unique)
}
