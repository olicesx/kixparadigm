param(
    [Parameter(Mandatory = $true)]
    [string]$ProjectRoot
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path $ProjectRoot).Path
$contractScript = Join-Path $PSScriptRoot 'kixpower-contract.ps1'
if (-not (Test-Path $contractScript)) {
    Write-Output 'memory_backlog: missing contract helper'
    exit 2
}
. (Resolve-Path $contractScript)
$backlog = Join-Path $root '.kixpower/memory/repo/harness-backlog.md'
if (-not (Test-Path $backlog)) {
    Write-Output 'memory_backlog: missing'
    exit 2
}

$text = Get-Content -LiteralPath $backlog -Raw
$lines = $text -split '\r?\n'
$records = [System.Collections.Generic.List[object]]::new()
for ($i = 0; $i -lt $lines.Count; $i++) {
    $recordHeader = [regex]::Match($lines[$i], '^\s*-\s+id:\s*(?<id>\S+)')
    if (-not $recordHeader.Success) { continue }
    $recordId = $recordHeader.Groups['id'].Value
    $start = $i
    $end = $lines.Count
    for ($j = $i + 1; $j -lt $lines.Count; $j++) {
        if ($lines[$j] -match '^\s*-\s+id:\s*\S+' -or $lines[$j] -match '^##\s+') {
            $end = $j
            break
        }
    }
    $records.Add([pscustomobject]@{ id = $recordId; text = ($lines[$start..($end - 1)] -join "`n") })
    $i = $end - 1
}

$errors = [System.Collections.Generic.List[string]]::new()
$seen = @{}
$improvementHashes = @{}
foreach ($record in $records) {
    $id = [string]$record.id
    if ($seen.ContainsKey($id)) { $errors.Add("duplicate id: $id"); continue }
    $seen[$id] = $true
    $body = $record.text
    $improvementMatch = [regex]::Match($body, '(?ms)^\s*improvement:\s*(?<value>.*?)(?=^\s*[A-Za-z_][\w-]*:|\z)')
    if ($improvementMatch.Success) {
        $improvementValue = ($improvementMatch.Groups['value'].Value -replace '\s+', ' ').Trim().Trim('"').Trim("'")
        if ($improvementValue) {
            $improvementHash = Get-KixSha256 -Text $improvementValue
            if ($improvementHashes.ContainsKey($improvementHash)) {
                $errors.Add(('{0}: duplicate improvement semantics with {1}' -f $id, $improvementHashes[$improvementHash]))
            } else {
                $improvementHashes[$improvementHash] = $id
            }
        }
    }
    $statusResult = [regex]::Match($body, '(?m)^\s*status:\s*(?<value>candidate|validated|archived)\s*$')
    if (-not $statusResult.Success) {
        $errors.Add(('{0}: missing or invalid status' -f $id))
        continue
    }
    $status = $statusResult.Groups['value'].Value
    foreach ($field in @('type', 'problem', 'improvement', 'source', 'evidence', 'eval')) {
        $fieldPattern = '(?m)^\s*{0}:\s*' -f [regex]::Escape($field)
        if ($body -notmatch $fieldPattern) { $errors.Add(('{0}: missing {1}' -f $id, $field)) }
    }
    if ($status -eq 'archived' -and $body -notmatch '(?m)^\s*archive_reason:\s*(rejected|superseded|stale)\s*$') {
        $errors.Add(('{0}: archived record needs archive_reason' -f $id))
    }
    if ($status -eq 'validated' -and
        ($body -notmatch '(?m)kind:\s*trial' -or $body -notmatch '(?m)result:\s*pass')) {
        $errors.Add(('{0}: validated record needs a trial/pass evidence' -f $id))
    }
    if ($status -eq 'candidate' -and $body -notmatch '(?m)kind:\s*origin') {
        $errors.Add(('{0}: candidate record needs origin evidence' -f $id))
    }
}

Write-Output 'memory_backlog: valid'
Write-Output "record_count: $($records.Count)"
Write-Output "legacy_unstructured_records: $([regex]::Matches($text, '(?m)^\s*-\s+\[[^]]+\]').Count)"
if ($errors.Count -gt 0) {
    Write-Output 'errors:'
    $errors | ForEach-Object { Write-Output "  - $_" }
    exit 2
}
exit 0
