# Start superelf on Windows · 启动
#
#   powershell -ExecutionPolicy Bypass -File .\start.ps1
#
# Ownership model（进程归属）— ONE owner per process, mirroring start.sh:
#   web.mjs — owned by a run.ps1 supervisor (the stand-in for launchd KeepAlive on macOS).
#             It restarts on ANY exit, which is what the Restart button in Settings needs:
#             /api/admin/restart exits 0, and a crash-only supervisor would call that a
#             deliberate stop and leave the node down.
# Windows has no launchctl, so autostart is a Scheduled Task named superelf-web that runs run.ps1
# (the restart loop) at logon and at startup; install.ps1 registers it with Register-ScheduledTask.
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

function Get-Supervisor([string]$target) {
  Get-CimInstance Win32_Process -Filter "Name='pwsh.exe' OR Name='powershell.exe'" |
    Where-Object { $_.CommandLine -match 'run\.ps1' -and $_.CommandLine -match "\b$target\b" }
}
# The shell the supervisor runs under: pwsh (PowerShell 7) if present, else Windows PowerShell.
$shell = if (Get-Command pwsh -ErrorAction SilentlyContinue) { 'pwsh' } else { 'powershell' }

# Prefer the SCHEDULED TASK, because the OS then owns the detachment. A Start-Process child dies
# with the console or job that spawned it - which is what killed the node seconds after install
# reported it up. The task is also the exact path the machine uses at logon, so starting it here
# tests the real thing instead of a second, weaker mechanism.
function Start-Supervisor([string]$target) {
  if (Get-Supervisor $target) { Write-Host "${target}: supervisor already running"; return }
  $taskName = "superelf-$target"
  $task = $null
  try { $task = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop } catch { }
  if ($task) {
    try {
      Start-ScheduledTask -TaskName $taskName
      Write-Host "${target}: started (scheduled task $taskName)"
      return
    } catch { Write-Host "${target}: could not start $taskName ($($_.Exception.Message)); falling back" -ForegroundColor Yellow }
  }
  # No task (installed with -NoService, or registration failed): detach as best we can. This is
  # the weaker path and it is the one that can be torn down with its parent console.
  Start-Process -FilePath $shell `
    -ArgumentList '-ExecutionPolicy', 'Bypass', '-NoProfile', '-File', (Join-Path $PSScriptRoot 'run.ps1'), $target `
    -WorkingDirectory $PSScriptRoot -WindowStyle Hidden | Out-Null
  Write-Host "${target}: started (detached run.ps1 - no scheduled task registered)"
}

if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'config.json'))) {
  Write-Host 'config.json not found - run: node setup.mjs'
  exit 1
}

Start-Supervisor 'web'

# "up" means SERVING, not "a node.exe exists". Checking only for a process was a lie that cost a
# real debugging session: run.ps1 restarts web.mjs on every exit, so a crash LOOP presents as a
# node.exe that is always there — start.ps1 reported "web: up" while nothing ever listened, and
# the first place anyone looked was the firewall. Poll the port, then say what actually happened.
$port = 8787
try {
  $cfgP = Join-Path $PSScriptRoot 'config.json'
  if (Test-Path -LiteralPath $cfgP) {
    $wp = (Get-Content -LiteralPath $cfgP -Raw | ConvertFrom-Json).web_port
    if ($wp) { $port = [int]$wp }
  }
} catch { }

function Test-Listening([int]$p) {
  if (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue) {
    return $null -ne (Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue)
  }
  # No Get-NetTCPConnection: try an actual connection rather than assuming the best.
  try { $c = [Net.Sockets.TcpClient]::new(); $c.Connect('127.0.0.1', $p); $c.Close(); return $true }
  catch { return $false }
}

$web = 'down'
foreach ($i in 1..15) {             # up to ~15s: a cold first start reads config and the shelf
  if (Test-Listening $port) { $web = 'up'; break }
  Start-Sleep -Seconds 1
}
Write-Host "web: $web"
if ($web -ne 'up') {
  # Do not make someone go hunting. The reason is already in the log the supervisor writes.
  Write-Host "`nweb.mjs is NOT serving on port $port." -ForegroundColor Red
  $log = Join-Path $PSScriptRoot 'web.log'
  if (Test-Path -LiteralPath $log) {
    Write-Host "Last lines of web.log — the reason is almost certainly here:`n" -ForegroundColor Yellow
    Get-Content -LiteralPath $log -Tail 25 | ForEach-Object { Write-Host "  $_" }
  } else {
    Write-Host "No web.log yet, which means node never started. Try: node web.mjs" -ForegroundColor Yellow
  }
  Write-Host "`n(a node.exe may still be visible — run.ps1 restarts it on every exit, so a crash"
  Write-Host " loop looks like a running process. The port is the only honest signal.)"
}
if ($web -eq 'up') {
  $ip = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -notmatch '^(127\.|169\.254\.)' } | Select-Object -First 1).IPAddress
  Write-Host "  http://localhost:$port"
  if ($ip) { Write-Host "  http://${ip}:$port   (from a phone on the same network)" }
}
