# Remove the transient QA session marker only after validated Producer closeout.
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$inputJson = $Input | Out-String
if ([string]::IsNullOrWhiteSpace($inputJson)) { exit 0 }
try { $hookInput = $inputJson | ConvertFrom-Json } catch { exit 0 }

$toolName = [string]$hookInput.tool_name
$toolLeaf = ($toolName -split '\.')[-1]
if ($toolLeaf -ne 'runSubagent') { exit 0 }
$argsObj = $hookInput.tool_input
$targetAgent = if ($argsObj) { [string]$argsObj.agentName } else { '' }
if (-not $targetAgent -and $argsObj) { $targetAgent = [string]$argsObj.subagentName }
if (-not $targetAgent -and $argsObj) { $targetAgent = [string]$argsObj.subagent }
if (-not $targetAgent -and $argsObj) { $targetAgent = [string]$argsObj.agent_name }
if (-not $argsObj -or $targetAgent -ne 'kixpower-producer') { exit 0 }
$prompt = ([string]$argsObj.prompt) -replace '\r\n?', "`n"
if ($prompt -notmatch '(?im)^[ \t]*(?:stage|handoff_stage):\s*producer_closeout[ \t]*(?:#.*)?$') { exit 0 }

$projectRoot = $hookInput.workspaceFolder
if (-not $projectRoot) { $projectRoot = $hookInput.cwd }
if (-not $projectRoot) { $projectRoot = (Get-Location).Path }
try { $projectRoot = [System.IO.Path]::GetFullPath([string]$projectRoot) } catch { exit 0 }

$sprint = 0
if ($prompt -match '(?im)^[ \t]*current_sprint:\s*(\d+)[ \t]*(?:#.*)?$') { $sprint = [int]$Matches[1] }
if ($sprint -le 0) { exit 0 }

$signoff = Join-Path $projectRoot "docs/qa/qa-signoff-$sprint.md"
$sessionMarker = Join-Path $projectRoot 'docs/.kixpower-qa-session.json'
if (-not (Test-Path $signoff) -or -not (Test-Path $sessionMarker)) { exit 0 }

$signoffText = Get-Content -LiteralPath $signoff -Raw -ErrorAction SilentlyContinue
if ($signoffText -notmatch '(?m)^status:\s*(?:PASS|CONDITIONAL)\s*$') { exit 0 }
$currentSha = (git -C $projectRoot rev-parse HEAD 2>$null | Select-Object -First 1).Trim()
if (-not $currentSha -or $signoffText -notmatch "(?m)^qa_verified_sha:\s*$currentSha\s*$") { exit 0 }

try { Remove-Item -LiteralPath $sessionMarker -Force -ErrorAction Stop } catch { exit 0 }
exit 0
