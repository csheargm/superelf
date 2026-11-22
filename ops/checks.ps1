# Machine checks, shared by the installer and its --check-only mode
#
# TODO(R4): this file is past the 300-line budget. The seam is clean - split the process
# helpers (New-Result, Invoke-Native, ConvertTo-NativeArg, Update-PathFromRegistry) into
# ops/native.ps1 and leave the Test-* functions here. Do it in a dedicated session (R8).
#
# Dot-sourced by install.ps1. It defines functions and returns objects; it PRINTS nothing and
# EXITS nothing, so the caller decides what to do about each result. One definition of what a
# ready machine looks like (R3) - when the checks lived only inside a separate preflight script,
# the installer had its own weaker copy of the same tests and the two could disagree.
#
# ENCODING: UTF-8 WITH BOM, deliberately. `powershell.exe` is always Windows PowerShell 5.1, which
# reads a BOM-less UTF-8 file as the ANSI codepage and mojibakes every non-ASCII byte. Do not strip it.
#
# QUOTING: never pass a double quote inside a native-command argument. 5.1 does not escape them
# when building the child command line and the callee eats them as delimiters, so
# `node -p 'x.split(".")[0]'` arrives as x.split(.)[0]. Use Invoke-Native with an argument array.

# PASS / WARN / FAIL / UNKNOWN. UNKNOWN is never a pass: a check that turns "I could not tell"
# into a green tick is worse than no check, because you find out after committing to the install.
function New-Result([string]$State, [string]$Name, [string]$Detail, [string]$Fix = '', [string]$Remedy = '') {
  [pscustomobject]@{ State = $State; Name = $Name; Detail = $Detail; Fix = $Fix; Remedy = $Remedy }
}

# Quote one argument the way CommandLineToArgvW will UN-quote it. This is the canonical Windows
# algorithm: only quote when needed, double the backslashes that precede a quote, and escape an
# embedded quote. Kept as a separate pure function so it can be unit-tested without spawning
# anything - which matters, because the path that uses it only runs on Windows PowerShell 5.1.
function ConvertTo-NativeArg([string]$a) {
  if ($null -eq $a) { return '""' }
  if ($a -eq '') { return '""' }
  if ($a -notmatch '[\s"]') { return $a }
  $sb = [Text.StringBuilder]::new(); [void]$sb.Append('"')
  $bs = 0
  foreach ($ch in $a.ToCharArray()) {
    if ($ch -eq '\') { $bs++; continue }
    if ($ch -eq '"') { [void]$sb.Append('\' * ($bs * 2 + 1)); [void]$sb.Append('"'); $bs = 0; continue }
    if ($bs) { [void]$sb.Append('\' * $bs); $bs = 0 }
    [void]$sb.Append($ch)
  }
  [void]$sb.Append('\' * ($bs * 2)); [void]$sb.Append('"')
  return $sb.ToString()
}
function ConvertTo-NativeArgString([string[]]$a) {
  if (-not $a -or $a.Count -eq 0) { return '' }
  return (($a | ForEach-Object { ConvertTo-NativeArg $_ }) -join ' ')
}

# Run a native command, returning stdout, stderr and the exit code SEPARATELY so a caller can tell
# "printed nothing" from "failed". A missing executable returns 127 rather than throwing, or one
# absent binary would take down every sibling probe behind a single .NET exception string.
#
# ArgumentList vs Arguments, and this one cost a first real Windows run: ProcessStartInfo.
# ArgumentList was added in .NET Core 2.1. Windows PowerShell 5.1 runs on .NET FRAMEWORK, where
# the property does not exist at all - so $psi.ArgumentList was $null and .Add() threw "You cannot
# call a method on a null-valued expression" before a single check completed. pwsh 7 on macOS, the
# only engine available to develop against here, is .NET Core and has it, so it worked locally and
# could never have worked on the machine the README sends people to. Use the safe array API where
# it exists; fall back to a properly escaped command string where it does not.
function Invoke-Native([string]$exe, [string[]]$exeArgs, [int]$TimeoutMs = 0) {
  $psi = [Diagnostics.ProcessStartInfo]::new()
  $psi.FileName = $exe; $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true
  $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true
  $hasArgList = $null -ne ($psi | Get-Member -Name ArgumentList -MemberType Property -ErrorAction SilentlyContinue)
  if ($hasArgList -and -not $env:PA_FORCE_ARG_STRING) {
    foreach ($a in $exeArgs) { [void]$psi.ArgumentList.Add($a) }
  } else {
    $psi.Arguments = ConvertTo-NativeArgString $exeArgs
  }
  try { $p = [Diagnostics.Process]::Start($psi) }
  catch { return [pscustomobject]@{ Out = ''; Err = "$exe not found"; Code = 127 } }
  # Async reads FIRST: ReadToEnd blocks until the stream closes, so on a child that hangs we would
  # never reach WaitForExit and the timeout would be decorative.
  $outTask = $p.StandardOutput.ReadToEndAsync()
  $errTask = $p.StandardError.ReadToEndAsync()
  $timedOut = $false
  if ($TimeoutMs -gt 0) {
    if (-not $p.WaitForExit($TimeoutMs)) { $timedOut = $true; try { $p.Kill() } catch { } }
  }
  $p.WaitForExit()
  $out = try { $outTask.GetAwaiter().GetResult() } catch { '' }
  $err = try { $errTask.GetAwaiter().GetResult() } catch { '' }
  return [pscustomobject]@{ Out = $out.Trim(); Err = $err.Trim(); Code = $p.ExitCode; TimedOut = $timedOut }
}

# After winget or npm -g installs something, THIS process still has the old PATH: the installer
# updates the registry and broadcasts a change that only new processes pick up. Without this the
# installer would install Node and then still not find it, and tell you to reopen the terminal -
# which is exactly the un-automatic behaviour this is meant to remove.
function Update-PathFromRegistry {
  try {
    $m = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $u = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = (@($m, $u) | Where-Object { $_ }) -join ';'
    return $true
  } catch { return $false }
}

function Test-Node([string]$Root) {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) {
    return New-Result 'FAIL' 'Node' 'not installed, or not on PATH' 'install Node 22+' 'node'
  }
  $pkgPath = Join-Path $Root 'package.json'
  if (-not (Test-Path -LiteralPath $pkgPath)) {
    return New-Result 'UNKNOWN' 'Node' 'package.json not found; the required version is unknown' 'run this from inside the superelf folder'
  }
  $engines = (Get-Content -LiteralPath $pkgPath -Raw | ConvertFrom-Json).engines.node
  $fm = [regex]::Match([string]$engines, '(\d+)')
  if (-not $fm.Success) { return New-Result 'UNKNOWN' 'Node' "could not read a floor from engines.node ('$engines')" }
  $floor = [int]$fm.Groups[1].Value
  $r = Invoke-Native $node.Source @('-v')     # never `node -p` with quotes; see QUOTING above
  $vm = [regex]::Match($r.Out, 'v(\d+)\.')
  if ($r.Code -ne 0 -or -not $vm.Success) {
    return New-Result 'UNKNOWN' 'Node' "could not read a version (exit $($r.Code), out '$($r.Out)', err '$($r.Err)')"
  }
  if ([int]$vm.Groups[1].Value -lt $floor) {
    return New-Result 'FAIL' 'Node' "$($r.Out) is below the required v$floor" "upgrade Node to $floor+" 'node'
  }
  return New-Result 'PASS' 'Node' "$($r.Out) (needs v$floor+) at $($node.Source)"
}

# Not "is claude on PATH": the app spawns it through lib/wincmd.mjs, which needs a native .exe or
# a .cmd shim whose cli.js it can read. Run the SHIPPED resolver rather than a lookalike, or this
# could pass a machine the app then refuses to run on. pathToFileURL because import() of a bare
# C:\... path is parsed as protocol 'c:' and rejected with ERR_UNSUPPORTED_ESM_URL_SCHEME.
function Test-ClaudeCli([string]$Root) {
  $wincmd = Join-Path $Root 'lib\wincmd.mjs'
  if (-not (Test-Path -LiteralPath $wincmd)) {
    return New-Result 'UNKNOWN' 'Claude Code' 'lib/wincmd.mjs not found; run this from inside the superelf folder'
  }
  $cmdName = 'claude'
  $cfgPath = Join-Path $Root 'config.json'
  if (Test-Path -LiteralPath $cfgPath) {
    $cc = (Get-Content -LiteralPath $cfgPath -Raw | ConvertFrom-Json).claude_cmd
    if ($cc) { $cmdName = [string]$cc }
  }
  $js = 'import(require(''url'').pathToFileURL(process.argv[1]).href).then(m=>console.log(JSON.stringify(m.spawnSpec(process.argv[2]))))'
  $r = Invoke-Native 'node' @('-e', $js, $wincmd, $cmdName)
  $spec = $null
  if ($r.Out) { try { $spec = $r.Out | ConvertFrom-Json } catch { } }
  if (-not $spec) { return New-Result 'UNKNOWN' 'Claude Code' "resolver gave no answer (exit $($r.Code)): $($r.Err)" }
  switch ($spec.how) {
    'exe'  { return New-Result 'PASS' 'Claude Code' "'$cmdName' is a native executable" }
    'shim' { return New-Result 'PASS' 'Claude Code' "'$cmdName' resolves to $($spec.args[0])" }
    'posix' { return New-Result 'UNKNOWN' 'Claude Code' 'not a Windows machine, so this check does not apply' }
    'unresolved' {
      return New-Result 'FAIL' 'Claude Code' "'$cmdName' is not resolvable; the agent would refuse most prompts" `
        'npm i -g @anthropic-ai/claude-code' 'claude'
    }
    default { return New-Result 'UNKNOWN' 'Claude Code' "resolver returned an unexpected kind '$($spec.how)'" }
  }
}

# WARN, not FAIL: superelf RUNS without git. lib/vernotes.mjs and web.mjs's gitHead both catch and
# carry on - the comment in vernotes even names the "deployed tarball" case - so a node unzipped
# from a downloaded ZIP works fine. git is needed to UPDATE (git pull) and for the changelog's
# history, which is worth having but is not a reason to refuse to install.
# Installing the CLI is not the same as having an ACCOUNT on it. `npm i -g` gives you a binary
# with no credentials; until someone runs `claude` once and signs in, every agent turn fails. This
# used to report UNKNOWN on the grounds that sign-in is interactive — but the STATE is not
# interactive to observe, only to create: `claude -p` answers headlessly when signed in and fails
# when not. Reporting UNKNOWN there was giving up on the single most important prerequisite, the
# one whose absence produces a node that starts perfectly and then fails every request.
#
# It costs one tiny model round-trip per run. That is the right price for turning the last UNKNOWN
# into a real answer.
function Test-ClaudeSignIn([string]$Root) {
  $wincmd = Join-Path $Root 'lib\wincmd.mjs'
  if (-not (Test-Path -LiteralPath $wincmd)) { return New-Result 'UNKNOWN' 'Claude sign-in' 'run this from inside the superelf folder' }
  $cmdName = 'claude'
  $cfgPath = Join-Path $Root 'config.json'
  if (Test-Path -LiteralPath $cfgPath) {
    $cc = (Get-Content -LiteralPath $cfgPath -Raw | ConvertFrom-Json).claude_cmd
    if ($cc) { $cmdName = [string]$cc }
  }
  $js = 'import(require(''url'').pathToFileURL(process.argv[1]).href).then(m=>console.log(JSON.stringify(m.spawnSpec(process.argv[2]))))'
  $spec = $null
  $rs = Invoke-Native 'node' @('-e', $js, $wincmd, $cmdName) -TimeoutMs 20000
  if ($rs.Out) { try { $spec = $rs.Out | ConvertFrom-Json } catch { } }
  if (-not $spec -or $spec.how -eq 'unresolved') {
    return New-Result 'UNKNOWN' 'Claude sign-in' 'cannot test: the CLI itself does not resolve yet'
  }
  if ($spec.how -eq 'posix') { return New-Result 'UNKNOWN' 'Claude sign-in' 'not a Windows machine, so this check does not apply' }

  $args = @()
  if ($spec.args) { $args += $spec.args }
  $args += @('-p', 'superelf preflight: reply with exactly ok')
  $r = Invoke-Native $spec.file $args -TimeoutMs 90000
  if ($r.TimedOut) {
    return New-Result 'UNKNOWN' 'Claude sign-in' 'no reply within 90s' 'run `claude` by hand and see what it asks for'
  }
  if ($r.Code -eq 0 -and $r.Out) {
    return New-Result 'PASS' 'Claude sign-in' "signed in and answering ($($r.Out.Substring(0, [Math]::Min(40, $r.Out.Length))))"
  }
  $why = "$($r.Err) $($r.Out)"
  if ($why -match 'login|log in|sign ?in|authenticat|unauthorized|api key|credential') {
    return New-Result 'FAIL' 'Claude sign-in' 'installed, but NOT signed in - every agent turn will fail' `
      'run `claude` in a terminal, complete the sign-in, send it one message, then re-run this'
  }
  return New-Result 'UNKNOWN' 'Claude sign-in' "the CLI did not answer (exit $($r.Code)): $($why.Trim().Substring(0, [Math]::Min(120, $why.Trim().Length)))"
}

function Test-Git {
  $git = Get-Command git -ErrorAction SilentlyContinue
  if (-not $git) {
    return New-Result 'WARN' 'git' 'not installed; superelf will run, but you cannot git pull updates' `
      'the installer can add it' 'git'
  }
  $r = Invoke-Native $git.Source @('--version')
  if ($r.Code -ne 0 -or -not $r.Out) { return New-Result 'UNKNOWN' 'git' "git is on PATH but did not run (exit $($r.Code))" }
  return New-Result 'PASS' 'git' $r.Out
}

# Check the BYTES, not the config knob: .gitattributes pins eol=lf, so autocrlf=true is normally
# harmless. What matters is whether a tracked text file on disk actually has CRLF, because the
# shelf manifests fingerprint those bytes and every app would read as permanently modified.
function Test-LineEndings([string]$Root) {
  $probe = Join-Path $Root 'start.sh'
  if (-not (Test-Path -LiteralPath $probe)) { return $null }
  $bytes = [IO.File]::ReadAllBytes($probe)
  for ($i = 1; $i -lt $bytes.Length; $i++) {
    if ($bytes[$i] -eq 10 -and $bytes[$i - 1] -eq 13) {
      return New-Result 'FAIL' 'Line endings' 'a tracked text file has CRLF on disk; shelf apps will read as modified' `
        'git config core.autocrlf false; git rm --cached -r .; git reset --hard   (does NOT touch config.json or workspaces)'
    }
  }
  return New-Result 'PASS' 'Line endings' 'tracked text files are LF on disk'
}

# Three ways a port is unusable and only the first is obvious: something LISTENing, something
# holding it Bound, or a Windows RESERVED range (Hyper-V/WSL2/Docker) where bind fails with no
# visible owner. The last looks free, passes, and then crash-loops the node.
function Test-Port([string]$Root) {
  $port = 8787
  $cfgPath = Join-Path $Root 'config.json'
  if (Test-Path -LiteralPath $cfgPath) {
    $c = Get-Content -LiteralPath $cfgPath -Raw | ConvertFrom-Json
    if ($c.web_port) { $port = [int]$c.web_port }
  }
  if (-not (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue)) {
    return New-Result 'UNKNOWN' 'Port' 'Get-NetTCPConnection is unavailable on this system'
  }
  $held = @(Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue |
            Where-Object { $_.State -in 'Listen', 'Bound' })
  if ($held.Count) {
    $pidOwner = $held[0].OwningProcess
    $proc = Get-Process -Id $pidOwner -ErrorAction SilentlyContinue
    $isMine = $proc -and $proc.ProcessName -eq 'node' -and $proc.Path -and $proc.Path.StartsWith($Root, 'OrdinalIgnoreCase')
    if ($isMine) {
      return New-Result 'WARN' 'Port' "$port is held by a superelf node already running here (pid $pidOwner)" `
        'fine for a re-run; .\install.ps1 will restart it'
    }
    $name = if ($proc) { $proc.ProcessName } else { 'a process owned by another user' }
    return New-Result 'FAIL' 'Port' "$port is in use by $name (pid $pidOwner), state $($held[0].State)" `
      'stop that process, or set web_port in config.json after installing'
  }
  try {
    $ex = (Invoke-Native 'netsh' @('interface', 'ipv4', 'show', 'excludedportrange', 'protocol=tcp')).Out
    foreach ($line in $ex -split "`n") {
      $m = [regex]::Match($line, '^\s*(\d+)\s+(\d+)\s*$')   # numbers are not localised; the words are
      if ($m.Success -and $port -ge [int]$m.Groups[1].Value -and $port -le [int]$m.Groups[2].Value) {
        return New-Result 'FAIL' 'Port' "$port falls in a Windows RESERVED range (Hyper-V/WSL2/Docker); bind will fail" `
          'set web_port in config.json to a port outside the reserved ranges, or run: net stop winnat'
      }
    }
  } catch { }
  return New-Result 'PASS' 'Port' "$port is free and not in a reserved range"
}

# TWO different things can stop a .ps1 from running, and the first version of this check only
# looked at one of them - so it reported PASS on a real machine where `.\start.ps1` was refused
# with "is not digitally signed". A check that says PASS while the thing it checks is broken is
# worse than no check.
#   1. Group Policy forcing Restricted/AllSigned. -Bypass cannot override that, so the SCHEDULED
#      TASK will not start at logon either: FAIL.
#   2. The effective policy plus Mark-of-the-Web. Files extracted from a downloaded ZIP carry a
#      Zone.Identifier stream, and under RemoteSigned - a very common effective policy - that is
#      enough to refuse them. Everything superelf launches passes -Bypass explicitly, so the node
#      still runs; what breaks is typing `.\start.ps1` by hand. WARN, with a remedy the installer
#      can apply (Unblock-File).
function Test-ExecutionPolicy([string]$Root) {
  $taskShell = if (Get-Command pwsh -ErrorAction SilentlyContinue) { 'pwsh' } else { 'powershell' }
  $r = Invoke-Native $taskShell @('-NoProfile', '-Command', 'Get-ExecutionPolicy -List | ForEach-Object { "$($_.Scope)=$($_.ExecutionPolicy)" }')
  if ($r.Code -ne 0 -or -not $r.Out) { return New-Result 'UNKNOWN' 'Execution policy' "could not query $taskShell" }
  $blocked = $r.Out -split "`n" | Where-Object { $_ -match '^(MachinePolicy|UserPolicy)=(Restricted|AllSigned)' }
  if ($blocked) {
    return New-Result 'FAIL' 'Execution policy' "$taskShell is governed by Group Policy: $($blocked -join ', '); -Bypass cannot override it" `
      'ask whoever manages this machine to allow RemoteSigned, or the task will not start at logon'
  }
  # Mark-of-the-Web on the scripts themselves. Get-Item -Stream exists only on Windows; anywhere
  # else there is no such concept and nothing to report.
  $marked = @()
  if ($Root) {
    foreach ($f in @(Get-ChildItem -LiteralPath $Root -Filter '*.ps1' -File -ErrorAction SilentlyContinue)) {
      try { if (Get-Item -LiteralPath $f.FullName -Stream 'Zone.Identifier' -ErrorAction Stop) { $marked += $f.Name } } catch { }
    }
  }
  $eff = (Invoke-Native $taskShell @('-NoProfile', '-Command', 'Get-ExecutionPolicy')).Out
  if ($marked.Count) {
    return New-Result 'WARN' 'Execution policy' "$eff, and $($marked.Count) script(s) are marked as downloaded from the internet" `
      "running them by hand (.\start.ps1) is refused as unsigned; the installer can clear the mark" 'unblock'
  }
  if ($eff -in 'Restricted', 'AllSigned') {
    return New-Result 'WARN' 'Execution policy' "$eff - scripts cannot be run by hand without -ExecutionPolicy Bypass" `
      'superelf always passes -Bypass, so the node itself is unaffected'
  }
  return New-Result 'PASS' 'Execution policy' "${taskShell}: $eff, scripts are not blocked"
}

# With bind_host "0.0.0.0" (direct LAN use; the default is 127.0.0.1) the node listens on every interface - but Windows Firewall blocks inbound
# connections to a new listener by default, and a service started hidden at logon never gets the
# "allow this app?" prompt an interactive launch would raise. The result is a node that reports
# itself up, answers on localhost, and refuses every connection from a phone or another machine -
# which is the whole point of running it. Checked here so that failure is visible BEFORE someone
# goes looking for it with a browser.
function Test-Firewall([string]$Root) {
  if (-not (Get-Command Get-NetFirewallRule -ErrorAction SilentlyContinue)) {
    return New-Result 'UNKNOWN' 'Firewall' 'Get-NetFirewallRule is unavailable on this system'
  }
  $port = 8787
  $cfgPath = Join-Path $Root 'config.json'
  if (Test-Path -LiteralPath $cfgPath) {
    $c = Get-Content -LiteralPath $cfgPath -Raw | ConvertFrom-Json
    if ($c.web_port) { $port = [int]$c.web_port }
  }
  $rule = Get-NetFirewallRule -DisplayName 'superelf web' -ErrorAction SilentlyContinue |
          Where-Object { $_.Enabled -eq 'True' -and $_.Direction -eq 'Inbound' -and $_.Action -eq 'Allow' }
  if ($rule) { return New-Result 'PASS' 'Firewall' "inbound TCP $port is allowed (rule: superelf web)" }
  return New-Result 'WARN' 'Firewall' "no inbound rule for TCP $port; other devices will get 'refused to connect'" `
    'the installer can add one (needs administrator)' 'firewall'
}

# Both volumes: superelf''s own, and the system drive, because Claude Code, npm and Windows temp
# all live there and a full C: fails every turn while the data drive looks fine.
function Test-Disk([string]$Root) {
  $out = @()
  $sys = if ($env:SystemDrive) { $env:SystemDrive + '\' } else { [IO.Path]::GetPathRoot($Root) }
  foreach ($pair in @(@{ n = 'Disk (superelf)'; p = $Root }, @{ n = 'Disk (system)'; p = $sys })) {
    $gb = $null
    try {
      $full = [IO.Path]::GetFullPath($pair.p)
      if (-not $full.StartsWith('\\')) {                      # UNC has no reliable free space
        $dr = [IO.DriveInfo]::new([IO.Path]::GetPathRoot($full))
        if ($dr.IsReady) { $gb = [math]::Round($dr.AvailableFreeSpace / 1GB, 1) }
      }
    } catch { }
    if ($null -eq $gb) { $out += New-Result 'UNKNOWN' $pair.n "could not read free space for $($pair.p)" }
    elseif ($gb -lt 2)  { $out += New-Result 'FAIL' $pair.n "$gb GB free on $($pair.p)" 'free up space' }
    elseif ($gb -lt 10) { $out += New-Result 'WARN' $pair.n "$gb GB free on $($pair.p); thin for a node that accumulates history" }
    else                { $out += New-Result 'PASS' $pair.n "$gb GB free on $($pair.p)" }
  }
  return $out
}

# Workspace data nests deep. Without long-path support the 260-char ceiling truncates real saves.
# A REG_SZ "1" is NOT honoured by Windows - only a DWORD 1 is - so compare on the real type.
function Test-LongPaths([string]$Root) {
  $prop = $null
  try { $prop = Get-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem' -Name LongPathsEnabled -ErrorAction Stop } catch { }
  if ($null -eq $prop) {
    return New-Result 'UNKNOWN' 'Long paths' 'LongPathsEnabled could not be read' 'keep the folder path short (C:\superelf)'
  }
  $raw = $prop.LongPathsEnabled
  if ($raw -is [int] -and $raw -eq 1) { return New-Result 'PASS' 'Long paths' 'enabled' }
  if ($raw -eq 1) {
    return New-Result 'WARN' 'Long paths' "set to 1 but as $($raw.GetType().Name), which Windows ignores" 'recreate it as a DWORD'
  }
  $depth = $Root.Length
  $state = if ($depth -gt 80) { 'FAIL' } else { 'WARN' }
  return New-Result $state 'Long paths' "disabled, and this folder's path is already $depth chars" `
    'install somewhere short such as C:\superelf' 'longpaths'
}

# Sleep is one of three ways an always-on box goes offline; lid-close and hibernate are commoner
# on a laptop. powercfg's LABELS are localised but its numbers are not, so a failed match reports
# UNKNOWN rather than a cheerful PASS.
function Test-StaysAwake {
  $out = @()
  foreach ($p in @(
    @{ n = 'Sleep on AC';     sub = 'SUB_SLEEP';   set = 'STANDBYIDLE';   remedy = 'standby-timeout-ac' },
    @{ n = 'Hibernate on AC'; sub = 'SUB_SLEEP';   set = 'HIBERNATEIDLE'; remedy = 'hibernate-timeout-ac' },
    @{ n = 'Lid close on AC'; sub = 'SUB_BUTTONS'; set = 'LIDACTION';     remedy = 'lidaction' }
  )) {
    $r = Invoke-Native 'powercfg' @('/query', 'SCHEME_CURRENT', $p.sub, $p.set)
    if ($r.Code -ne 0 -or -not $r.Out) { $out += New-Result 'UNKNOWN' $p.n 'this power setting is not present on this machine'; continue }
    $idx = [regex]::Matches($r.Out, '0x([0-9a-fA-F]{8})')
    if ($idx.Count -lt 2) { $out += New-Result 'UNKNOWN' $p.n 'could not parse the power scheme (localised output)'; continue }
    # ToUInt32, not ToInt32: above 0x7FFFFFFF sign-extends to negative and reads as "0 min".
    $ac = [Convert]::ToUInt32($idx[$idx.Count - 2].Groups[1].Value, 16)
    if ($ac -eq 0) {
      $out += New-Result 'PASS' $p.n $(if ($p.set -eq 'LIDACTION') { 'closing the lid does nothing' } else { 'never, on AC' })
    } else {
      $detail = if ($p.set -eq 'LIDACTION') { 'closing the lid sleeps or hibernates the machine' }
                else { "after $([math]::Round($ac / 60)) min on AC; the node goes offline with it" }
      $out += New-Result 'WARN' $p.n $detail 'the installer can set this to never' $p.remedy
    }
  }
  return $out
}

function Test-ExistingInstall([string]$Root) {
  $found = @()
  if (Test-Path -LiteralPath (Join-Path $Root 'config.json')) { $found += 'config.json' }
  # workspace.example is COMMITTED: counting it would tell every first-time installer they have
  # an existing install.
  $ws = @(Get-ChildItem -LiteralPath $Root -Directory -ErrorAction SilentlyContinue |
          Where-Object { $_.Name -eq 'workspace' -or $_.Name -like 'workspace-*' })
  if ($ws.Count) { $found += "$($ws.Count) workspace folder(s)" }
  $task = $null
  try { $task = Get-ScheduledTask -TaskName 'superelf-web' -ErrorAction Stop } catch { }
  if ($task) { $found += 'scheduled task superelf-web' }
  if (-not $found.Count) { return New-Result 'PASS' 'Existing install' 'clean machine' }
  # Precise about what a re-run does: config and workspaces are kept, but Register-ScheduledTask
  # -Force REPLACES the task definition wholesale.
  $fix = if ($task) { 'a re-run keeps config.json and workspaces, but REPLACES the scheduled task' }
         else { 'a re-run keeps config.json and workspaces' }
  return New-Result 'WARN' 'Existing install' "already present: $($found -join ', ')" $fix
}

# Everything, in the order a person would care about it.
# Each check is ISOLATED. One that throws becomes a single UNKNOWN naming itself and the error,
# never an unhandled exception that kills the run - which is exactly what happened on the first
# real Windows machine: the whole installer died on "You cannot call a method on a null-valued
# expression" with no indication of which check, so there was nothing to act on.
function Invoke-AllChecks([string]$Root) {
  $checks = @(
    @{ n = 'Node';             f = { Test-Node $Root } },
    @{ n = 'Claude Code';      f = { Test-ClaudeCli $Root } },
    @{ n = 'Claude sign-in';   f = { Test-ClaudeSignIn $Root } },
    @{ n = 'git';              f = { Test-Git } },
    @{ n = 'Line endings';     f = { Test-LineEndings $Root } },
    @{ n = 'Port';             f = { Test-Port $Root } },
    @{ n = 'Execution policy'; f = { Test-ExecutionPolicy $Root } },
    @{ n = 'Firewall';         f = { Test-Firewall $Root } },
    @{ n = 'Disk';             f = { Test-Disk $Root } },
    @{ n = 'Long paths';       f = { Test-LongPaths $Root } },
    @{ n = 'Stays awake';      f = { Test-StaysAwake } },
    @{ n = 'Existing install'; f = { Test-ExistingInstall $Root } }
  )
  $r = @()
  foreach ($c in $checks) {
    try { $out = & $c.f; if ($out) { $r += $out } }
    catch { $r += New-Result 'UNKNOWN' $c.n "the check itself failed: $($_.Exception.Message)" 'this is a bug in superelf - please report it with this line' }
  }
  return $r
}
