# Stop superelf on Windows · 停止
#
#   powershell -ExecutionPolicy Bypass -File .\stop.ps1
#
# Order matters, and it is the same scar stop.sh records: kill the SUPERVISORS FIRST, or they
# restart the node processes you are about to kill and the machine looks possessed. Only once no
# supervisor is left do the node processes get stopped.
#
# Windows has no real SIGTERM. Node's SIGTERM handler in web.mjs (which closes the listener and
# drains in-flight requests) does NOT run here - the process is terminated outright. That is
# tolerable only because every write in the app is tmp+rename atomic: a stop mid-write leaves
# either the old file or the new one, never half of either. Do not weaken that invariant.
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

function Stop-Procs($procs, [string]$label) {
  $list = @($procs)
  if (-not $list -or $list.Count -eq 0) { Write-Host "${label}: none running"; return }
  foreach ($p in $list) {
    # /T kills the whole tree: node spawns claude, which spawns its own children.
    & taskkill /PID $p.ProcessId /T /F *> $null
  }
  Write-Host "${label}: stopped $($list.Count)"
}

# Stop the TASK first, or Task Scheduler restarts what we are about to kill - the same ordering
# scar as killing supervisors before their children.
try { if (Get-ScheduledTask -TaskName 'superelf-web' -ErrorAction Stop) { Stop-ScheduledTask -TaskName 'superelf-web' -ErrorAction SilentlyContinue; Write-Host 'task superelf-web: stopped' } }
catch { }   # no such task (installed with -NoService): nothing to stop, and that is not an error

# LEGACY bot cleanup. The Telegram bot was removed (docs/adr/0006), but a node installed before
# that may still have the superelf-bot task. A run.ps1 loop it started before the update keeps
# restarting the deleted bot.mjs every 2 s; after the update the task still fires at every logon,
# and the new run.ps1 refuses `bot` at once. Stop it, then UNREGISTER it so it never comes back.
# Idempotent: with no such task this does nothing. The run.ps1 match below has no target, so it
# also ends a leftover `run.ps1 bot` loop, and the node match still includes bot.mjs.
# TODO(legacy-bot): delete this block, and `|bot` in $nodeRe, once ADR 0006's one-time cleanup is
# confirmed on every node. Not sooner: the Windows update (git pull, then install.ps1) never runs
# stop.ps1, so a node that skipped the cleanup still has the task.
$botTask = 'superelf-bot'
$legacyTask = $null
try { $legacyTask = Get-ScheduledTask -TaskName $botTask -ErrorAction Stop } catch { }   # not registered: the normal case, nothing to clean
if ($legacyTask) {
  Stop-ScheduledTask -TaskName $botTask -ErrorAction SilentlyContinue
  try {
    Unregister-ScheduledTask -TaskName $botTask -Confirm:$false -ErrorAction Stop
    Write-Host "task $botTask (legacy): stopped and unregistered"
  } catch {
    Write-Host "task $botTask (legacy): could not unregister it ($($_.Exception.Message)) - delete it in Task Scheduler" -ForegroundColor Yellow
  }
}
$nodeRe = '(web|bot)\.mjs'

Stop-Procs (Get-CimInstance Win32_Process -Filter "Name='pwsh.exe' OR Name='powershell.exe'" |
  Where-Object { $_.CommandLine -match 'run\.ps1' }) 'supervisors'

Stop-Procs (Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match $nodeRe }) 'node'

Start-Sleep -Seconds 1
$left = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match $nodeRe })
if ($left.Count -gt 0) { Write-Host "web: STILL-RUNNING ($($left.Count))" } else { Write-Host 'web: stopped' }
