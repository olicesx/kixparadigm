---
name: pwsh-reliable
description: "Run reliable PowerShell commands on Windows, especially when invoking native CLIs, passing complex arguments, handling expected nonzero exits, calling WSL, running parallel shell calls, downloading files, or managing background processes. Use after failures involving quoting, wildcard paths, argument splitting, exit codes, pipelines, process lifetime, or cleanup."
---

# Reliable PowerShell

Compose commands so that PowerShell parsing, native argument passing, and nested shells have explicit boundaries. Verify the native result and any expected artifact before reporting success.

Network reliability policy (proxy, route, WSL NAT, weak-network, direct-UDP, measurement) is out of scope here; keep such rules in a dedicated network skill when one is installed instead of duplicating them.

## Workflow

1. Resolve the working directory, executable, input paths, and cleanup target explicitly.
2. Keep unrelated operations in separate shell calls so one incidental failure cannot discard useful output.
3. Put native arguments in an array and invoke the executable with the call operator.
4. Capture `$LASTEXITCODE` immediately after every native command, before running another command.
5. Classify expected nonzero statuses before treating them as failures.
6. Validate files, processes, or other side effects independently of command output.
7. Clean up only artifacts and processes whose ownership was established by this task.

## Native Commands

Pass each logical argument as one array element. Do not assemble one command string or use `Invoke-Expression`.

```powershell
$goArgs = @('test', './...', '-run', 'TestHandshake', '-count=1')
& go @goArgs
$exitCode = $LASTEXITCODE
if ($exitCode -ne 0) { exit $exitCode }
```

Keep values containing spaces, dots, or equals in one element when the native program expects one argument:

```powershell
$testArgs = @(
    '-test.run=TestHandshake'
    '-test.cpuprofile=C:\Temp\cpu.pprof'
)
& $testExe @testArgs
$exitCode = $LASTEXITCODE
```

Use `$?` only for PowerShell success semantics. Never use it as a substitute for a native program's exit code. Treat a PowerShell parser error separately: the native executable did not run, so an old `$LASTEXITCODE` is not evidence about the failed command.

## Ripgrep

Use `-g` or `--glob` for file selection. PowerShell does not expand Unix-style wildcard path arguments for native programs.

```powershell
$rgArgs = @('-n', '--glob', '*_test.go', '--', 'pattern', '.')
& rg @rgArgs
$rgExit = $LASTEXITCODE
# This search is optional: no match is a successful workflow outcome.
if ($rgExit -eq 1) { exit 0 }
if ($rgExit -ne 0) { exit $rgExit }
```

Interpret ripgrep exit codes explicitly:

- `0`: at least one match.
- `1`: no match; accept it only when the search is optional.
- `2` or greater: execution or usage error.

Use `-F` for literal text. Put `--` before positional patterns or paths that could begin with `-`. Use explicit paths instead of wildcard path arguments.

## Quoting And WSL

Treat each parser boundary independently: orchestrator, PowerShell, native executable, then WSL shell. Prefer single-quoted PowerShell strings for literal values and double quotes only when PowerShell interpolation is intended.

Do not pipe a raw multiline here-string directly to `wsl.exe` for a compound Bash script. The Windows bridge can rewrite line endings and can drop positional arguments. Encode the UTF-8 script and pass one safe `bash -lc` command argument:

```powershell
$script = @'
set -euo pipefail
pids="$(jobs -p)"
printf '%s\n' "$pids"
'@
$encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($script))
$launcher = "set -euo pipefail; printf '%s' '$encoded' | base64 -d | bash -s --"
$wslArgs = @('--', 'bash', '-lc', $launcher)
& wsl.exe @wslArgs
$wslExit = $LASTEXITCODE
if ($wslExit -ne 0) { exit $wslExit }
```

For script arguments, encode a separate payload or use a validated temporary file. Do not assume that arguments appended after `--` survive every Windows/WSL bridge.

Do not repair nested quoting by adding escapes blindly. Reduce the number of parser layers, then inspect the argument array with secrets redacted.

## Output And Parallel Calls

Capture native output before piping it to PowerShell cmdlets, and save the native status first:

```powershell
$lines = & $exe @args 2>&1
$exitCode = $LASTEXITCODE
$matches = $lines | Select-String -Pattern 'ready'
```

Pipe arrays into `Select-String`; do not pass an array through `-InputObject` when line-by-line matching is required.

When JavaScript orchestrates independent shell calls, use `Promise.allSettled` if one expected failure must not reject the batch. Otherwise normalize expected statuses inside each shell call before using `Promise.all`. Never combine an optional search, repository check, and unrelated operation merely to reduce tool calls.

## Downloads And Artifacts

Choose an explicit output path. Prefer PowerShell's structured command for ordinary downloads:

```powershell
Invoke-WebRequest -Uri $uri -OutFile $destination -ErrorAction Stop
$file = Get-Item -LiteralPath $destination -ErrorAction Stop
if ($file.Length -eq 0) { throw "Downloaded file is empty: $destination" }
```

When using a native downloader, capture `$LASTEXITCODE` and then perform the same file validation. Validate an expected hash or format when one is available. Use `New-TemporaryFile` for one artifact or a task-specific temporary directory for several artifacts; never put profiles, test binaries, or downloads in the repository by default.

## Processes And Cleanup

Start background Windows helpers with `Start-Process -PassThru -WindowStyle Hidden` and retain the returned process object. Stop only its exact process ID after confirming it is still the process started by this task.

After a timeout, assume child processes may have survived. Inspect exact PIDs, parentage, and command lines before cleanup. For WSL processes, record and validate the Linux PID inside the target distribution; do not substitute a Windows `wsl.exe` PID.

Do not use broad process-name termination when exact ownership can be established. Do not remove package-manager lock files until no owning package-manager process remains.

Use `try`/`finally` for temporary resources. Delete known files individually. If recursive deletion is unavoidable, resolve the target first and verify that it remains inside the task-specific temporary directory. Use `-LiteralPath`, not a wildcard. Run `git -C <repo> status --short` only for a confirmed repository and keep that check separate from unrelated work.

## Completion Check

Before reporting success, confirm all applicable facts:

- The native exit code has the intended meaning.
- Expected output or artifacts exist and are valid.
- Independent command results were preserved.
- No owned background process or temporary artifact remains.
- Repository state was checked only when the task operated in a repository.

## Feedback And Evolution

When a task exposes a decision that this skill does not cover:

1. Record the symptom, attempted command, root cause, and successful pattern.
2. Reproduce or independently verify the pattern before treating it as a rule.
3. Add it only when it is tool- or platform-general and likely to recur.
4. Exclude repository-specific paths, secrets, one-off choices, and unresolved workarounds.
5. Update this skill after the task fix, then run the repository's consistency checks and one regression check.
6. Keep uncertain observations in the current task context instead of writing them here.
