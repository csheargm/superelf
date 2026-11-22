# Supervisor: keeps web.mjs alive, restarting it if it exits. Usage: .\run.ps1 web
# 进程守护 — the Windows counterpart of run.sh, and the counterpart of launchd KeepAlive on macOS.
#
# It restarts on ANY exit, not only a crash, and that is the whole point. POST /api/admin/restart
# exits with code 0 (web.mjs), so Task Scheduler's "restart on failure" — which fires only on a
# NON-ZERO exit — would read the Restart button in Settings as "it meant to stop" and leave the
# node down until someone walked over to the machine. launchd's KeepAlive has no such distinction,
# so this loop is what keeps the two platforms behaving the same way.
#
# Task Scheduler therefore launches THIS, once, at logon, and never supervises node directly.
param([ValidateSet('web')][string]$Target = 'web')

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

$script = "$Target.mjs"
if (-not (Test-Path -LiteralPath $script)) { Write-Error "no $script"; exit 1 }

# One owner per process. Two supervisors racing for port 8787 is the EADDRINUSE crash loop the
# comments in start.sh describe; the same trap exists here, so refuse rather than duel.
$mine = $PID
$dupe = Get-CimInstance Win32_Process -Filter "Name='pwsh.exe' OR Name='powershell.exe'" |
  Where-Object { $_.ProcessId -ne $mine -and $_.CommandLine -match 'run\.ps1' -and $_.CommandLine -match "\b$Target\b" }
if ($dupe) {
  Write-Host "refusing: a run.ps1 $Target supervisor is already running (PID $($dupe[0].ProcessId))"
  exit 1
}

$log = Join-Path $PSScriptRoot "$Target.log"
Write-Host "[supervisor] watching $script"

# A SERVER WRITING TO STDERR IS NORMAL, NOT FATAL — and this line is why the first Windows node
# died. PowerShell promotes any native command's stderr output to a NativeCommandError, and with
# ErrorActionPreference='Stop' that TERMINATES this supervisor, killing the node it is watching.
# On a checkout with no .git (anyone who installed from a downloaded ZIP) web.mjs's `git rev-parse`
# printed "fatal: not a git repository" on stderr, and superelf bound its port, logged the URL,
# and vanished a second later with nothing in the log to explain it — because the supervisor that
# would have written the explanation was the thing that died.
#
# The git noise is silenced at source too (web.mjs GIT_QUIET), but this is the general guard: a
# supervisor that dies whenever its child says anything on stderr is not a supervisor.
$ErrorActionPreference = 'Continue'
while ($true) {
  # try/catch as well as the Continue above, because NOTHING the child does may end this loop.
  # Continue handles the reported case (5.1 promoting stderr to a NativeCommandError); the catch
  # handles every other shape, including whatever a future PowerShell decides is terminating.
  # A supervisor that can be killed by its child's output is not a supervisor.
  try {
    # Appends the child's own stdout/stderr, matching run.sh's `>> target.log 2>&1`.
    & node $script *>> $log
  } catch {
    "[supervisor] $script raised: $($_.Exception.Message)" | Out-File -FilePath $log -Append -Encoding utf8
  }
  $code = $LASTEXITCODE
  "[supervisor] $script exited ($code) - restarting in 2s $(Get-Date -Format o)" | Out-File -FilePath $log -Append -Encoding utf8
  Start-Sleep -Seconds 2
}
