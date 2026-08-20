param(
    [Parameter(Mandatory = $true)]
    [string]$ProjectRoot,

    [Parameter(Mandatory = $true)]
    [int]$SprintNumber,

    [Parameter(Mandatory = $true)]
    [string]$SprintName
)

<#
.SYNOPSIS
    Kixpower Orchestration — 创建新 Sprint 文档骨架
.DESCRIPTION
    生成新的 Sprint 目录和空白的 plan.md / progress.md 骨架。
#>

$ProjectRoot = (Resolve-Path $ProjectRoot).Path
$sprintDir = Join-Path $ProjectRoot "docs" "sprint-$SprintNumber"

if (Test-Path $sprintDir) {
    Write-Error "Sprint $SprintNumber 目录已存在：$sprintDir。为保护规划与历史证据，脚本不会覆盖；请使用显式恢复流程。"
    exit 2
}

  if ($SprintNumber -gt 1) {
    $previousDone = Join-Path $ProjectRoot "docs\sprint-$($SprintNumber - 1)\done.md"
    if (-not (Test-Path $previousDone)) {
      Write-Error "Sprint $SprintNumber 需要前一 Sprint 的最终 done.md：$previousDone"
      exit 2
    }
    $previousText = Get-Content -LiteralPath $previousDone -Raw -ErrorAction SilentlyContinue
    if ($previousText -notmatch '(?ms)^---\s*\r?\n.*?^status:\s*done\s*$.*?\r?\n---') {
      Write-Error "Sprint $SprintNumber 的前一 Sprint done.md 没有 status: done 的最终证据。"
      exit 2
    }
  }

$docsDir = Join-Path $ProjectRoot 'docs'
New-Item -ItemType Directory -Path $docsDir -Force | Out-Null
New-Item -ItemType Directory -Path $sprintDir -Force | Out-Null
$memoryDir = Join-Path $ProjectRoot '.kixpower\memory\repo'
New-Item -ItemType Directory -Path $memoryDir -Force | Out-Null
foreach ($memoryFile in @('harness-backlog.md', 'lessons-learned.md')) {
  $memoryPath = Join-Path $memoryDir $memoryFile
  if (-not (Test-Path $memoryPath)) {
    Set-Content -LiteralPath $memoryPath -Value "# $memoryFile`n" -Encoding utf8
  }
}
$planFile = Join-Path $sprintDir 'plan.md'
$progressFile = Join-Path $sprintDir 'progress.md'
$driftFile = Join-Path $sprintDir 'drift-check.md'
$markerFile = Join-Path $docsDir '.kixpower-current-sprint'
$head = (git -C $ProjectRoot rev-parse HEAD 2>$null | Select-Object -First 1).Trim()
$today = Get-Date -Format 'yyyy-MM-dd'
$baseline = if ($head -match '^[0-9a-fA-F]{40}$') { $head } else { 'null' }

Set-Content -LiteralPath $markerFile -Value $SprintNumber -NoNewline -Encoding utf8
$gitignoreFile = Join-Path $ProjectRoot '.gitignore'
$ignoreEntries = @('docs/.kixpower-current-sprint', 'docs/.kixpower-qa-reverify.json', 'docs/.kixpower-qa-session.json')
if (Test-Path $gitignoreFile) {
  $ignoreText = Get-Content -LiteralPath $gitignoreFile -Raw
  $missingIgnoreEntries = @($ignoreEntries | Where-Object { $ignoreText -notmatch ('(?m)^' + [regex]::Escape($_) + '\s*$') })
  if ($missingIgnoreEntries.Count -gt 0) {
    Add-Content -LiteralPath $gitignoreFile -Value ("`n" + ($missingIgnoreEntries -join "`n")) -Encoding utf8
  }
} else {
  Set-Content -LiteralPath $gitignoreFile -Value ($ignoreEntries -join "`n") -Encoding utf8
}

@"
---
schema_version: 5.7
sprint: $SprintNumber
title: "$SprintName"
status: planning
baseline_commit: $baseline
---

# Sprint $SprintNumber — $SprintName

> Producer 必须在交接前填充任务、DAG、target_rules、task_sizing 和 verifiable_gates。
> 空骨架不能进入 Dev/QA，也不会预生成 done.md。

## Sprint Goal

[一句话描述本次交付]

## Prioritized Task List

<!-- Producer 用唯一 task id 替换此占位内容。 -->

## Task DAG

```yaml
task_dag:
  nodes: []
  properties:
    max_antichain_width: 0
    critical_path_depth: 0
    coupling_density: 0
    recommended_topology: sequential
    layers: []
```

## Task Sizing

```yaml
task_sizing:
  derived_commit_budget: 0
  bug_reserve: 1
  hard_cap: 10
  warn_threshold: 0
  max_parallelism: 0
  source: producer-derived
```

## Verifiable gates

```yaml
verifiable_gates: []
```

## What's NOT in This Sprint

| Feature | Reason |
|---|---|
| [cut feature] | [why] |
"@ | Set-Content -LiteralPath $planFile -Encoding utf8

@"
---
schema_version: 5.7
sprint: $SprintNumber
status: planning
last_updated: $today
completed_tasks: 0
total_tasks: 0
blocked_tasks: 0
open_issues: {P0: 0, P1: 0, P2: 0}
artifacts_changed_since_last_observe: []
observe_fingerprint: null
sprint_baseline_sha: $baseline
dev_self_tests_passed: []
l2_verification_status: pending
l2_verification_passed: []
l2_verified_sha: null
l2_gate_manifest_sha256: null
l2_stash_refs: []
qa_started_sha: null
qa_verified_sha: null
qa_gate_manifest_sha256: null
qa_test_changes: []
ci_pending: false
topology_used: sequential
blast_radius:
  commit_budget: 3
  branch_required: true
  block_force_push: true
  block_destructive_sql: true
---

# Sprint $SprintNumber Progress

## Task Status

<!-- Producer 填充任务；Dev 只更新执行状态。 -->

## Blockers

- 无。

## Trace Log

```yaml
[]
```
"@ | Set-Content -LiteralPath $progressFile -Encoding utf8

@"
# Sprint $SprintNumber Drift Check

```yaml
verification_fidelity: pending
baseline_sha: $baseline
baseline_source: scaffold
```

Producer 在 planning 阶段补充 context drift、error propagation、tech debt 与 verification fidelity。
"@ | Set-Content -LiteralPath $driftFile -Encoding utf8

Write-Host "✅ Sprint $SprintNumber ($SprintName) 文档骨架已创建：" -ForegroundColor Green
Write-Host "   📄 $planFile" -ForegroundColor Cyan
Write-Host "   📄 $progressFile" -ForegroundColor Cyan
Write-Host "   📄 $driftFile" -ForegroundColor Cyan
Write-Host "   📍 active marker: $markerFile" -ForegroundColor Cyan
exit 0
