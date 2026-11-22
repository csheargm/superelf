# Install superelf on Windows
#
#   powershell -ExecutionPolicy Bypass -File .\install.ps1
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 -CheckOnly    # look, change nothing
#
# -ExecutionPolicy Bypass is not optional advice: Windows client defaults to Restricted, which
# refuses to run any .ps1. It applies to this one invocation and changes nothing globally.
#
# It CHECKS THE MACHINE AND THEN FIXES WHAT IT CAN. Missing Node, a missing Claude CLI, missing
# git, a laptop set to sleep - it installs or corrects them rather than telling you to go away and
# come back. Only three things genuinely need a human, and each says exactly why:
#   - signing in to Claude Code, which is interactive by nature;
#   - a port someone else's program is holding, which is not ours to kill;
#   - anything Group Policy forbids, which is your IT department's to change.
#
# Idempotent: re-run it after a `git pull`. It never touches config.json, your workspaces or the
# owner account.
#
# ENCODING: UTF-8 WITH BOM. `powershell.exe` is always Windows PowerShell 5.1, which reads a
# BOM-less UTF-8 file as the ANSI codepage. Do not strip it.
[CmdletBinding()]
param(
  [switch]$CheckOnly,      # report and stop; changes nothing at all
  [switch]$NoService,      # skip the scheduled task and the start
  [switch]$NoInstallDeps   # check but never install a prerequisite for me
)

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$ROOT = $PSScriptRoot
$TASK = 'superelf-web'

. (Join-Path $ROOT 'ops\checks.ps1')

# The port the firewall messages quote. Read once, from config if it exists.
$script:WEB_PORT = 8787
try {
  $cfgP = Join-Path $ROOT 'config.json'
  if (Test-Path -LiteralPath $cfgP) {
    $wp = (Get-Content -LiteralPath $cfgP -Raw | ConvertFrom-Json).web_port
    if ($wp) { $script:WEB_PORT = [int]$wp }
  }
} catch { }

function Say([string]$m) { Write-Host "`n== $m" }
function Die([string]$m) { Write-Host "`n!! $m" -ForegroundColor Red; exit 1 }
$COLOR = @{ PASS = 'Green'; WARN = 'Yellow'; FAIL = 'Red'; UNKNOWN = 'Magenta' }
function Show-Result($r) {
  $c = if ($COLOR.ContainsKey($r.State)) { $COLOR[$r.State] } else { 'White' }
  Write-Host ("  {0,-8}" -f $r.State) -ForegroundColor $c -NoNewline
  Write-Host ("{0,-18} {1}" -f $r.Name, $r.Detail)
  if ($r.Fix) { Write-Host ("           {0}" -f $r.Fix) -ForegroundColor DarkGray }
}

# -- Remediation ---------------------------------------------------------------------------------
# Each returns $true only if it believes it fixed the thing. The caller RE-RUNS the check either
# way and trusts that, not this - "winget said 0" is not the same as "node is now on PATH", and
# only the re-check can tell the difference.
function Repair-Thing([string]$remedy) {
  switch ($remedy) {
    'node' {
      if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        Write-Host '   cannot auto-install: winget is not available on this machine' -ForegroundColor Yellow
        Write-Host '   install Node 22+ from https://nodejs.org and run this again'
        return $false
      }
      Write-Host '   installing Node (winget may raise a UAC prompt - approve it)...'
      $r = Invoke-Native 'winget' @('install', '--id', 'OpenJS.NodeJS.LTS', '-e',
        '--accept-source-agreements', '--accept-package-agreements', '--disable-interactivity')
      if ($r.Code -ne 0) { Write-Host "   winget exited $($r.Code): $($r.Err)" -ForegroundColor Yellow; return $false }
      # winget updated the registry, not THIS process's PATH.
      [void](Update-PathFromRegistry)
      return $true
    }
    'claude' {
      if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
        Write-Host '   cannot auto-install: npm is not on PATH yet (install Node first)' -ForegroundColor Yellow
        return $false
      }
      Write-Host '   installing Claude Code (npm i -g @anthropic-ai/claude-code)...'
      # npm on Windows is npm.cmd, which cannot be spawned without a shell - so go through cmd
      # explicitly with an argument array rather than building a command string.
      $r = Invoke-Native $env:ComSpec @('/c', 'npm', 'i', '-g', '@anthropic-ai/claude-code')
      if ($r.Code -ne 0) { Write-Host "   npm exited $($r.Code): $($r.Err)" -ForegroundColor Yellow; return $false }
      [void](Update-PathFromRegistry)
      return $true
    }
    'git' {
      if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        Write-Host '   cannot auto-install: winget is not available' -ForegroundColor Yellow; return $false
      }
      Write-Host '   installing git...'
      $r = Invoke-Native 'winget' @('install', '--id', 'Git.Git', '-e',
        '--accept-source-agreements', '--accept-package-agreements', '--disable-interactivity')
      if ($r.Code -ne 0) { return $false }
      [void](Update-PathFromRegistry)
      return $true
    }
    'standby-timeout-ac'   { return (Invoke-Native 'powercfg' @('/change', 'standby-timeout-ac', '0')).Code -eq 0 }
    'hibernate-timeout-ac' { return (Invoke-Native 'powercfg' @('/change', 'hibernate-timeout-ac', '0')).Code -eq 0 }
    'lidaction' {
      # Setting it is two calls: change the scheme, then make the change current.
      $a = Invoke-Native 'powercfg' @('/setacvalueindex', 'SCHEME_CURRENT', 'SUB_BUTTONS', 'LIDACTION', '0')
      if ($a.Code -ne 0) { return $false }
      return (Invoke-Native 'powercfg' @('/setactive', 'SCHEME_CURRENT')).Code -eq 0
    }
    'unblock' {
      # Files extracted from a downloaded ZIP carry a Zone.Identifier stream, and under
      # RemoteSigned that alone makes PowerShell refuse them as unsigned. Clearing it is local to
      # this folder and needs no admin. This is what makes `.\start.ps1` work by hand afterwards.
      Write-Host '   clearing the downloaded-from-internet mark on this folder''s scripts...'
      try {
        Get-ChildItem -LiteralPath $ROOT -Filter '*.ps1' -File | Unblock-File
        $opsDir = Join-Path $ROOT 'ops'
        if (Test-Path -LiteralPath $opsDir) { Get-ChildItem -LiteralPath $opsDir -Filter '*.ps1' -File | Unblock-File }
        return $true
      } catch { Write-Host "   could not unblock: $($_.Exception.Message)" -ForegroundColor Yellow; return $false }
    }
    'firewall' {
      # Needs admin. Do NOT silently elevate - say what is needed and what it costs if skipped.
      $me = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
      if (-not $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        Write-Host '   opening the port needs administrator. Skipping.' -ForegroundColor Yellow
        Write-Host '   The node will work on this machine, but phones and other computers will get'
        Write-Host '   "refused to connect". To fix it, run this ONCE in an admin PowerShell:'
        Write-Host "     New-NetFirewallRule -DisplayName 'superelf web' -Direction Inbound -Action Allow -Protocol TCP -LocalPort $script:WEB_PORT -Profile Private"
        return $false
      }
      try {
        New-NetFirewallRule -DisplayName 'superelf web' -Direction Inbound -Action Allow `
          -Protocol TCP -LocalPort $script:WEB_PORT -Profile Private | Out-Null
        Write-Host "   opened inbound TCP $script:WEB_PORT on the Private profile"
        return $true
      } catch { Write-Host "   could not add the rule: $($_.Exception.Message)" -ForegroundColor Yellow; return $false }
    }
    'longpaths' {
      # Needs admin. Offer it rather than failing, and never silently elevate.
      Write-Host '   enabling long paths needs administrator rights.'
      Write-Host '   skipping - installing under a short path such as C:\superelf avoids it entirely.'
      return $false
    }
    default { return $false }
  }
}

Write-Host "`nsuperelf installer  $ROOT"
Say 'Checking this machine'
$results = Invoke-AllChecks $ROOT
$results | ForEach-Object { Show-Result $_ }

if (-not $CheckOnly -and -not $NoInstallDeps) {
  # Anything that FAILED or WARNed and knows how to fix itself.
  $fixable = @($results | Where-Object { $_.Remedy -and $_.State -in 'FAIL', 'WARN' })
  if ($fixable.Count) {
    Say 'Fixing what I can'
    foreach ($f in $fixable) {
      Write-Host "   $($f.Name): $($f.Detail)"
      [void](Repair-Thing $f.Remedy)
    }
    Say 'Re-checking'
    # Trust the RE-CHECK, never the installer's own exit code.
    $results = Invoke-AllChecks $ROOT
    $results | ForEach-Object { Show-Result $_ }
  }
}

$fails = @($results | Where-Object State -eq 'FAIL')
$unk   = @($results | Where-Object State -eq 'UNKNOWN')
Write-Host ("`n  {0} pass | {1} warn | {2} fail | {3} unknown" -f
  @($results | Where-Object State -eq 'PASS').Count,
  @($results | Where-Object State -eq 'WARN').Count, $fails.Count, $unk.Count)

if ($CheckOnly) {
  Write-Host "`n-CheckOnly: nothing was changed. UNKNOWN is not a pass - check those by hand.`n" -ForegroundColor Green
  exit $(if ($fails.Count) { 1 } else { 0 })
}
if ($fails.Count) {
  Die ("cannot continue: " + (($fails | ForEach-Object { $_.Name }) -join ', ') + "`n" +
       "   Everything above that could be fixed automatically already was; what is left needs you.")
}

Say 'Configuration'
if (Test-Path -LiteralPath (Join-Path $ROOT 'config.json')) {
  Write-Host '   config.json already exists - left untouched.'
} else {
  Copy-Item (Join-Path $ROOT 'config.example.json') (Join-Path $ROOT 'config.json')
  Write-Host '   created config.json from the example.'
}

Say 'Owner account'
# setup.mjs refuses on a node that already has an owner, so this is safe to re-run.
& node (Join-Path $ROOT 'setup.mjs')

Say 'Claude Code sign-in'
# The one prerequisite nothing can automate. Say so plainly rather than letting the node come up
# and fail every single turn with no explanation.
Write-Host '   If you have not already: run `claude` once and send it a message.'
Write-Host '   Until that is done the node will start but every AI turn will fail.'

if (-not $NoService) {
  Say 'Autostart'
  # The task runs run.ps1 (see Register-SuperelfTask below), NOT node directly. run.ps1 restarts
  # node on ANY exit - because POST /api/admin/restart exits with code 0, and Task Scheduler's own
  # "restart on failure" fires only on a NON-ZERO exit. Point the task at node and the in-app
  # Restart button becomes a permanent shutdown.
  #
  # AtStartup as well as AtLogOn: an always-on box reboots for Windows Update with nobody signed
  # in, and a logon-only trigger leaves it down until someone walks over to it.
  $shell = if (Get-Command pwsh -ErrorAction SilentlyContinue) { 'pwsh' } else { 'powershell' }

  # THE TASK MUST BE THE LONG-LIVED PROCESS. It used to run start.ps1, which Start-Process'd
  # run.ps1 and then exited - and Task Scheduler treats the action exiting as the task completing,
  # so it tore down the supervisor it had just spawned. The node came up, printed its listen line,
  # and was killed seconds later with no "[supervisor] exited" line to explain it, because the
  # supervisor died too. That broke the logon autostart exactly as badly as the manual start.
  # Point the task straight at run.ps1, which never returns.
  function Register-SuperelfTask([string]$name, [string]$target) {
    $action = New-ScheduledTaskAction -Execute $shell `
      -Argument "-ExecutionPolicy Bypass -NoProfile -File `"$ROOT\run.ps1`" $target" `
      -WorkingDirectory $ROOT
    $triggers = @((New-ScheduledTaskTrigger -AtLogOn), (New-ScheduledTaskTrigger -AtStartup))
    # ExecutionTimeLimit 0 = never kill it; Task Scheduler stops a task after 3 days by default.
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
      -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
    Register-ScheduledTask -TaskName $name -Action $action -Trigger $triggers -Settings $settings -Force | Out-Null
    Write-Host "   registered scheduled task `"$name`" (at logon and at startup)"
  }

  try {
    Register-SuperelfTask $TASK 'web'
  } catch {
    Write-Host "   could not register the scheduled task: $($_.Exception.Message)" -ForegroundColor Yellow
    Write-Host '   superelf still starts with .\start.ps1 - it just will not come back after a reboot.'
  }

  Say 'Starting'
  & powershell -ExecutionPolicy Bypass -NoProfile -File (Join-Path $ROOT 'start.ps1')
}

Write-Host @'

Done. superelf starts at logon and after a reboot from now on.
  .\install.ps1 -CheckOnly   re-check this machine, change nothing
  .\start.ps1 / .\stop.ps1   start and stop by hand
Open it at http://localhost:8787. For phones: tailscale serve (README), or set bind_host in config.json.
'@
