param(
    [Parameter(Mandatory=$true)][string]$ProjectRoot,
    [int]$PrevSprint = 0,
    [string]$SinceDate,
    [switch]$UseRules
)

# Kixpower — Verification Fidelity Check v5.7
# 来源：EvoClaw (arxiv 2603.13428) + 示例项目 Sprint 1 实测 97.1% 未门禁
# v3.3 升级：支持 target_rules（glob + modules + languages + mechanical_links）
#           代替 v3.1 的扁平 target_files 清单
# v5.7：解析全部 target_rules 块、block/inline modules，并优先使用 SHA baseline。

$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$contractScript = Join-Path $PSScriptRoot 'kixpower-contract.ps1'
if (Test-Path $contractScript) { . (Resolve-Path $contractScript) }

if ($PrevSprint -le 0) {
    Write-Output '=== Verification Fidelity Check v5.7 ==='
    Write-Output 'verification_fidelity: baseline'
    Write-Output 'baseline_source: no_previous_sprint'
    exit 0
}

function Convert-GlobToRegex {
    param([string]$glob)
    # 占位符法避免 * ? . 转义相互污染
    $STARSTAR_SLASH = "<<SSS>>"   # **/
    $STARSTAR = "<<SS>>"          # **
    $STAR = "<<S>>"               # *
    $QMARK = "<<Q>>"              # ?
    $regex = $glob
    # 1. 花括号展开
    while ($regex -match '\{([^}]+)\}') {
        $alts = $Matches[1] -split ','
        $altsRegex = ($alts | ForEach-Object { [regex]::Escape($_.Trim()) }) -join '|'
        $regex = $regex -replace [regex]::Escape($Matches[0]), "($altsRegex)"
    }
    # 2. 占位符替换（顺序：长前短）
    $regex = $regex.Replace('**/', $STARSTAR_SLASH)
    $regex = $regex.Replace('**', $STARSTAR)
    $regex = $regex.Replace('*', $STAR)
    $regex = $regex.Replace('?', $QMARK)
    # 3. 转义剩余 .
    $regex = $regex -replace '\.', '\.'
    # 4. 占位符 → regex
    $regex = $regex.Replace($STARSTAR_SLASH, '(.*/)?')
    $regex = $regex.Replace($STARSTAR, '.*')
    $regex = $regex.Replace($STAR, '[^/]*')
    $regex = $regex.Replace($QMARK, '[^/]')
    return "^$regex$"
}

function Test-GlobMatch {
    param([string]$path, [string[]]$globs)
    foreach ($g in $globs) {
        $pattern = Convert-GlobToRegex $g
        try { if ($path -match $pattern) { return $true } } catch {}
    }
    return $false
}

function Get-ModulePrefixes {
    param([string]$module, [string]$root)
    # v5.0 反过拟合改造（H6 根治）：不再硬编码 src/frontend/app/lib 等布局前缀
    # （那是 Rust/前端起源的偏见，dae 等 Go 项目的 component/control 不匹配 → 假阴性）。
    # 改为扫描仓库实际目录结构，动态发现名为 $module 的目录，语言无关。
    $prefixes = @()
    $normalizedModule = ($module -replace '\\','/').Trim('/')
    $moduleParts = @($normalizedModule -split '/')
    $moduleLeaf = $moduleParts[-1]
    $moduleParent = if ($moduleParts.Count -gt 1) { $moduleParts[0..($moduleParts.Count - 2)] -join '/' } else { '' }
    try {
        $dirs = Get-ChildItem -Path $root -Recurse -Directory -ErrorAction SilentlyContinue |
            Where-Object {
                $relative = $_.FullName.Substring($root.Length).TrimStart('\','/') -replace '\\','/'
                $_.Name -eq $normalizedModule -or
                $relative -eq $normalizedModule -or
                $relative.EndsWith("/$normalizedModule", [System.StringComparison]::OrdinalIgnoreCase)
            } |
            Where-Object { $_.FullName -notmatch '(\\|/)(node_modules|vendor|\.git|target|build|dist|\.next)(\\|/|$)' }
        foreach ($d in $dirs) {
            $rel = $d.FullName.Substring($root.Length).TrimStart('\','/') -replace '\\','/'
            $prefixes += "$rel/**"
            $prefixes += $rel
        }
        $files = Get-ChildItem -Path $root -Recurse -File -ErrorAction SilentlyContinue |
            Where-Object {
                $_.FullName -notmatch '(\\|/)(node_modules|vendor|\.git|target|build|dist|\.next)(\\|/|$)'
            }
        foreach ($file in $files) {
            $rel = $file.FullName.Substring($root.Length).TrimStart('\','/') -replace '\\','/'
            $withoutExtension = $rel -replace '\.[^/.]+$',''
            if (-not $withoutExtension) { continue }
            $directory = Split-Path $withoutExtension -Parent
            if ($directory) { $directory = $directory -replace '\\','/' }
            $fileLeaf = Split-Path $withoutExtension -Leaf
            $parentMatches = -not $moduleParent -or
                $directory -eq $moduleParent -or
                $directory.EndsWith("/$moduleParent", [System.StringComparison]::OrdinalIgnoreCase)
            $leafMatches = $fileLeaf -eq $moduleLeaf -or
                $fileLeaf.StartsWith("${moduleLeaf}_", [System.StringComparison]::OrdinalIgnoreCase) -or
                $fileLeaf.StartsWith("${moduleLeaf}-", [System.StringComparison]::OrdinalIgnoreCase)
            $tokenMatches = $true
            foreach ($token in ($normalizedModule -split '[/_-]' | Where-Object { $_ })) {
                if ($rel -notmatch [regex]::Escape($token)) { $tokenMatches = $false; break }
            }
            if (($parentMatches -and $leafMatches) -or
                $rel -eq $normalizedModule -or
                $withoutExtension -eq $normalizedModule -or
                $rel.EndsWith("/$normalizedModule", [System.StringComparison]::OrdinalIgnoreCase) -or
                $withoutExtension.EndsWith("/$normalizedModule", [System.StringComparison]::OrdinalIgnoreCase) -or
                $tokenMatches -and $moduleParts.Count -gt 1) {
                $prefixes += $rel
            }
        }
    } catch {}
    if ($prefixes.Count -eq 0) { $script:UnresolvedModules += $module }
    return $prefixes
}

$projectRootPath = (Resolve-Path $ProjectRoot).Path
$planFile = if ($PrevSprint -gt 0) { Join-Path $projectRootPath "docs/sprint-$PrevSprint/plan.md" } else { $null }
$progressFile = if ($PrevSprint -gt 0) { Join-Path $projectRootPath "docs/sprint-$PrevSprint/progress.md" } else { $null }
$planContent = if ($planFile -and (Test-Path $planFile)) { Get-Content $planFile -Raw } else { '' }
$progressContent = if ($progressFile -and (Test-Path $progressFile)) { Get-Content $progressFile -Raw } else { '' }

$baselineSha = $null
$baselineSource = 'none'
if ($progressContent) {
    $progressFm = Get-KixFrontmatter -Text $progressContent
    $candidate = Get-KixYamlScalar -Text $progressFm -Key 'sprint_baseline_sha'
    if (Test-KixSha $candidate) { $baselineSha = $candidate; $baselineSource = 'progress.sprint_baseline_sha' }
}
if (-not $baselineSha -and $planContent) {
    $planFm = Get-KixFrontmatter -Text $planContent
    $candidate = Get-KixYamlScalar -Text $planFm -Key 'baseline_commit'
    if (Test-KixSha $candidate) { $baselineSha = $candidate; $baselineSource = 'plan.baseline_commit' }
}
if (-not $baselineSha -and $PrevSprint -gt 0) {
    $doneFile = Join-Path $projectRootPath "docs/sprint-$PrevSprint/done.md"
    if (Test-Path $doneFile) {
        $doneFm = Get-KixFrontmatter -Text (Get-Content $doneFile -Raw)
        $candidate = Get-KixYamlScalar -Text $doneFm -Key 'baseline_commit'
        if (Test-KixSha $candidate) { $baselineSha = $candidate; $baselineSource = 'done.baseline_commit' }
    }
}
if (-not $SinceDate -and $progressContent -match 'last_updated:\s*(\d{4}-\d{2}-\d{2})') { $SinceDate = $Matches[1] }
if (-not $SinceDate) { $SinceDate = (Get-Date).AddDays(-30).ToString('yyyy-MM-dd') }

Write-Output "=== Verification Fidelity Check v5.7 ==="
Write-Output "Sprint: $PrevSprint | Since: $SinceDate | Rules: $UseRules"
Write-Output "Baseline: $baselineSha ($baselineSource)"
Write-Output ""

$changedFiles = @()
if ($baselineSha) {
    $changedFiles += git -c core.quotepath=false -C $projectRootPath diff --name-only $baselineSha HEAD 2>$null
    $changedFiles += git -c core.quotepath=false -C $projectRootPath diff --name-only 2>$null
    $changedFiles += git -c core.quotepath=false -C $projectRootPath diff --name-only --cached 2>$null
    $changedFiles += git -c core.quotepath=false -C $projectRootPath status --porcelain 2>$null |
        ForEach-Object { if ($_.Length -ge 4) { $_.Substring(3).Trim('"') } }
} else {
    $changedFiles += git -c core.quotepath=false -C $projectRootPath log --since=$SinceDate --name-only --format="" 2>$null
}
$changedFiles = @($changedFiles | Where-Object { $_ -and $_ -notmatch '^(docs/|\.github/|README|CHANGELOG|LICENSE)' } | Sort-Object -Unique)

if (-not $changedFiles) {
    Write-Output "PASS no_source_changes"
    exit 0
}

$allGlobs = @(); $allModules = @(); $mechanicalAnchors = @(); $legacyTargetFiles = @()

if ($planContent) {
    foreach ($ruleBlock in (Get-KixIndentedBlocks -Text $planContent -Header 'target_rules')) {
        $allGlobs += Get-KixYamlList -Text $ruleBlock -Key 'globs'
        $allModules += Get-KixYamlList -Text $ruleBlock -Key 'modules'
        $mechanicalAnchors += Get-KixYamlList -Text $ruleBlock -Key 'of'
        $allGlobs += Get-KixInlineYamlList -Text $ruleBlock -Key 'globs'
        $allModules += Get-KixInlineYamlList -Text $ruleBlock -Key 'modules'
        $mechanicalAnchors += Get-KixInlineYamlList -Text $ruleBlock -Key 'of'
    }
    $inlineRuleMatches = [System.Collections.Generic.List[object]]::new()
    foreach ($inlineRule in [regex]::Matches($planContent, '(?m)target_rules:\s*\{(?<body>[^}\r\n]*(?:\{[^}\r\n]*\}[^}\r\n]*)*)\}')) {
        $inlineRuleMatches.Add($inlineRule)
    }
    foreach ($flowRule in [regex]::Matches($planContent, '(?ms)target_rules:\s*\{(?<body>(?:(?!\r?\n[ \t]*\}).)*?)\r?\n[ \t]*\}')) {
        $inlineRuleMatches.Add($flowRule)
    }
    foreach ($inlineRule in $inlineRuleMatches) {
        $inlineBody = $inlineRule.Groups['body'].Value
        $allGlobs += Get-KixInlineYamlList -Text $inlineBody -Key 'globs'
        $allModules += Get-KixInlineYamlList -Text $inlineBody -Key 'modules'
        $mechanicalAnchors += Get-KixInlineYamlList -Text $inlineBody -Key 'of'
    }

    $legacyMatches = [regex]::Matches($planContent, 'target_files:\s*\n((?:\s*-\s*.+\n?)+)')
    foreach ($m in $legacyMatches) {
        $lines = $m.Groups[1].Value -split "`n" | ForEach-Object {
            if ($_ -match '^\s*-\s*(.+)') { ($Matches[1].Trim() -replace '"','') }
        }
        $legacyTargetFiles += $lines
    }

    # 兼容历史 inline YAML 数组格式 target_files: [a, b, c]。
    $inlineMatches = [regex]::Matches($planContent, 'target_files:\s*\[([^\]]+)\]')
    foreach ($m in $inlineMatches) {
        $items = $m.Groups[1].Value -split ','
        foreach ($it in $items) {
            $cleaned = $it.Trim().Trim('"').Trim("'").Trim()
            if ($cleaned) { $legacyTargetFiles += $cleaned }
        }
    }
}

$script:UnresolvedModules = @()
$moduleGlobs = @()
foreach ($mod in $allModules) { $moduleGlobs += Get-ModulePrefixes -module $mod -root $ProjectRoot }
$scopeGlobs = @($allGlobs + $moduleGlobs + $legacyTargetFiles | Sort-Object -Unique)

$whitelistGlobs = @(
    "tests/**", "**/*_test.{rs,go,py}", "**/*.spec.{ts,tsx,js}", "**/*.test.{ts,tsx,js}",
    "docs/**", "**/{README,CHANGELOG,LICENSE}*", "**/*.lock",
    "{target,node_modules,dist,build}/**", ".github/**", ".vscode/**",
    "benches/**",
    "**/*.md",
    "**/package-lock.json", "**/pnpm-lock.yaml", "**/Cargo.lock", "**/go.sum"
)
# v5.0 注（U5 反过拟合）：旧版末项 `**/*.{toml,yml,yaml,json,md}` 过宽——把 Cargo.toml /
# tsconfig.json 等实质源码配置全白名单，造成 fidelity 假阴性。v5.0 收窄：仅 *.md 白名单，
# 锁文件按名白名单；其余 toml/yml/json 配置须受 target_rules 门禁（配置改动是实质变更）。

$inScope = @(); $whitelisted = @(); $ungated = @()
foreach ($f in $changedFiles) {
    $covered = $false
    if (Test-GlobMatch -path $f -globs $scopeGlobs) { $covered = $true }
    if (-not $covered -and (Test-GlobMatch -path $f -globs $whitelistGlobs)) {
        $whitelisted += $f; $covered = $true
    }
    if ($covered) { $inScope += $f } else { $ungated += $f }
}

$ratio = if ($changedFiles.Count -gt 0) { [math]::Round($ungated.Count / $changedFiles.Count * 100, 1) } else { 0 }

Write-Output "[Scope Rules]"
Write-Output "  globs: $($allGlobs.Count)"
Write-Output "  modules: $($allModules.Count) -> $($moduleGlobs.Count) expanded"
Write-Output "  unresolved_modules: $(@($script:UnresolvedModules | Sort-Object -Unique).Count)"
if ($script:UnresolvedModules) {
    $script:UnresolvedModules | Sort-Object -Unique | ForEach-Object { Write-Output "    - $_" }
}
Write-Output "  mechanical_links: $($mechanicalAnchors.Count) -> unresolved_offline: $($mechanicalAnchors.Count)"
Write-Output "  legacy target_files: $($legacyTargetFiles.Count)"
Write-Output "  total scope globs: $($scopeGlobs.Count)"
Write-Output ""
Write-Output "[Verification Fidelity]"
Write-Output "  total changed: $($changedFiles.Count)"
Write-Output "  in_scope (rules): $($inScope.Count - $whitelisted.Count)"
Write-Output "  whitelisted: $($whitelisted.Count)"
Write-Output "  ungated: $($ungated.Count) ($ratio%)"

if ($ungated.Count -eq 0) {
    Write-Output "  PASS"
} elseif ($ratio -le 20) {
    Write-Output "  LOW_RISK"
} else {
    Write-Output "  HIGH_RISK (top 20 ungated):"
    $ungated | Select-Object -First 20 | ForEach-Object { Write-Output "    - $_" }
    if ($ungated.Count -gt 20) { Write-Output "    ... +$($ungated.Count - 20) more" }
}

# === v5.0 方法2-B/C：累积度量 + liveness 维度（反过拟合增强）===
# 来源：EvoClaw 跨 milestone 错误累积。旧版只有单 Sprint ungated_ratio_pct，
# v5.0 增加：①跨 Sprint ungated 趋势（方法2-B）②dead-path/gated-off task 度量（方法2-C）。
# 这把 fidelity 从「单次快照」升级为「跨 Sprint 累积追踪」，能发现 lessons L2/L10 类错误。

# 方法2-C：读 plan.md 的 task liveness 标注（producer v5.0 G1 要求 task 标 liveness: live|gated-off|dead-path）
$deadPathTasks = 0; $gatedOffTasks = 0; $totalLivenessTasks = 0
if (Test-Path $planFile) {
    $taskLiveness = [regex]::Matches($planContent, 'liveness:\s*(live|gated-off|dead-path)')
    $totalLivenessTasks = $taskLiveness.Count
    foreach ($m in $taskLiveness) {
        switch ($m.Groups[1].Value) {
            'dead-path' { $deadPathTasks++ }
            'gated-off' { $gatedOffTasks++ }
        }
    }
}

# 方法2-B：读上一 Sprint drift-check.md 的 ungated_ratio，算趋势 delta
$prevDriftFile = Join-Path $ProjectRoot "docs/sprint-$PrevSprint/drift-check.md"
$prevRatio = $null
if (Test-Path $prevDriftFile) {
    if ((Get-Content $prevDriftFile -Raw -ErrorAction SilentlyContinue) -match 'ungated_ratio_pct:\s*([\d.]+)') {
        $prevRatio = [double]$Matches[1]
    }
}
$ratioDelta = if ($null -ne $prevRatio) { [math]::Round($ratio - $prevRatio, 1) } else { $null }

# v5.0 累积 YAML（machine-readable，供 drift-check.md 跨 Sprint 追踪 + Producer eval 退役判定）
Write-Output ""
Write-Output "[Fidelity v5.7 累积度量]"
Write-Output "fidelity_v5:"
Write-Output "  sprint: $PrevSprint"
Write-Output "  baseline_sha: $baselineSha"
Write-Output "  baseline_source: $baselineSource"
Write-Output "  ungated_ratio_pct: $ratio"
if ($null -ne $ratioDelta) {
    $trend = if ($ratioDelta -lt 0) { "improving" } elseif ($ratioDelta -gt 0) { "regressing" } else { "stable" }
    Write-Output "  ungated_ratio_delta_vs_prev: $ratioDelta  # $trend"
}
Write-Output "  liveness_marked_tasks: $totalLivenessTasks"
Write-Output "  dead_path_tasks: $deadPathTasks"
Write-Output "  gated_off_tasks: $gatedOffTasks"
if ($deadPathTasks -gt 0 -or $gatedOffTasks -gt 0) {
    Write-Output "  warning: 检出 dead-path/gated-off task —— 复查是否优化了生产不启用的代码（lessons L2 死代码 / L10 gate 死路径）"
}
