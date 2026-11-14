# money-lab-kit/start.ps1 — 🧪 AutoInjector Money lab: runs inside the Windows Sandbox when it opens.
#
# First time (a few minutes): downloads Node.js and Git for Windows (Claude Code needs Git Bash on Windows) into
# lab-cache, then installs Claude Code, Codex and the browser tool (Playwright MCP) there. lab-cache is a folder on
# your PC, so the next time the lab opens this is skipped. Then it starts runner.js, which waits for the mission.
#
# Everything the AIs make goes in the "workshop" folder on the sandbox desktop (the same folder on your PC).
# Closing the sandbox window wipes everything else inside it.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Base   = Join-Path $env:USERPROFILE 'Desktop'
$Kit    = Join-Path $Base 'lab-kit'
$Cache  = Join-Path $Base 'lab-cache'
$Work   = Join-Path $Base 'workshop'
$Logins = Join-Path $Base 'lab-logins'
$StatusFile = Join-Path $Work 'lab-status.json'

New-Item -ItemType Directory -Force -Path (Join-Path $Work 'logs'), $Cache, $Logins | Out-Null
try { Start-Transcript -Path (Join-Path $Work 'logs\setup.log') -Append | Out-Null } catch { }
try { $Host.UI.RawUI.WindowTitle = 'AutoInjector Money lab' } catch { }

function Write-Status([string]$Phase, [string]$Words) {
  $o = [ordered]@{ phase = $Phase; words = $Words; heartbeat = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); agents = @{}; version = 1 }
  try { [IO.File]::WriteAllText($StatusFile, ($o | ConvertTo-Json -Depth 4)) } catch { }
  Write-Host "[lab] $Words"
}

function Get-File([string]$Url, [string]$OutFile) {
  for ($i = 1; $i -le 3; $i++) {
    try { Invoke-WebRequest -Uri $Url -OutFile $OutFile -UseBasicParsing; return } catch {
      if ($i -eq 3) { throw "Could not download $Url ($($_.Exception.Message))" }
      Start-Sleep -Seconds (5 * $i)
    }
  }
}

try {
  $v = Get-Content (Join-Path $Kit 'versions.json') -Raw | ConvertFrom-Json

  # --- Node.js (portable zip, kept in lab-cache) ---
  $NodeDir = Join-Path $Cache 'node'
  if (-not (Test-Path (Join-Path $NodeDir 'node.exe'))) {
    Write-Status 'setting-up' 'First time: downloading Node.js (a minute or two)'
    $ver = $v.node_fallback
    try {
      $idx = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json' -UseBasicParsing
      $pick = $idx | Where-Object { $_.version -like ("v{0}.*" -f $v.node_major) -and $_.lts } | Select-Object -First 1
      if ($pick) { $ver = $pick.version }
    } catch { Write-Host "[lab] Could not read the Node.js list; using $ver" }
    $zip = Join-Path $env:TEMP 'node.zip'
    Get-File "https://nodejs.org/dist/$ver/node-$ver-win-x64.zip" $zip
    $tmp = Join-Path $Cache 'node-unpack'
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
    Expand-Archive -Path $zip -DestinationPath $tmp -Force
    Remove-Item $NodeDir -Recurse -Force -ErrorAction SilentlyContinue
    Move-Item -Path (Get-ChildItem $tmp -Directory | Select-Object -First 1).FullName -Destination $NodeDir
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
  }

  # --- Git for Windows, portable (Claude Code uses its Git Bash) ---
  $GitDir = Join-Path $Cache 'git'
  if (-not (Test-Path (Join-Path $GitDir 'bin\bash.exe'))) {
    Write-Status 'setting-up' 'First time: downloading Git for Windows (Claude Code needs it)'
    $url = $v.git_fallback_url
    try {
      $rel = Invoke-RestMethod -Uri 'https://api.github.com/repos/git-for-windows/git/releases/latest' -Headers @{ 'User-Agent' = 'AutoInjector-money-lab' } -UseBasicParsing
      $asset = $rel.assets | Where-Object { $_.name -match '^PortableGit-.*-64-bit\.7z\.exe$' } | Select-Object -First 1
      if ($asset) { $url = $asset.browser_download_url }
    } catch { Write-Host '[lab] Could not read the Git release list; using the known version' }
    $exe = Join-Path $env:TEMP 'PortableGit.7z.exe'
    Get-File $url $exe
    $p = Start-Process -FilePath $exe -ArgumentList ('-o"{0}"' -f $GitDir), '-y' -Wait -PassThru
    if (-not (Test-Path (Join-Path $GitDir 'bin\bash.exe'))) { throw "Git did not unpack (exit $($p.ExitCode))" }
  }

  # --- Claude Code, Codex, Playwright MCP (npm, into lab-cache\npm) ---
  $NpmDir = Join-Path $Cache 'npm'
  $env:Path = "$NodeDir;$NpmDir;$(Join-Path $GitDir 'cmd');$Kit;$env:Path"
  $marker = Join-Path $NpmDir 'installed.json'
  $want = ($v.tools -join ' ')
  $have = ''
  if (Test-Path $marker) { $have = (Get-Content $marker -Raw).Trim() }
  if ($have -ne $want) {
    Write-Status 'setting-up' 'First time: installing Claude Code, Codex and the browser tool'
    New-Item -ItemType Directory -Force -Path $NpmDir | Out-Null
    & (Join-Path $NodeDir 'npm.cmd') install -g --prefix "$NpmDir" --no-fund --no-audit @($v.tools)
    if ($LASTEXITCODE -ne 0) { throw "Installing the command-line tools failed (npm exit $LASTEXITCODE)" }
    [IO.File]::WriteAllText($marker, $want)
  }

  $env:LAB_BASE = $Base
  $env:CLAUDE_CONFIG_DIR = Join-Path $Logins 'claude'
  $env:CODEX_HOME = Join-Path $Logins 'codex'
  $env:CLAUDE_CODE_GIT_BASH_PATH = Join-Path $GitDir 'bin\bash.exe'
  New-Item -ItemType Directory -Force -Path $env:CLAUDE_CONFIG_DIR, $env:CODEX_HOME | Out-Null

  Write-Status 'starting' 'Set up. Starting the lab runner'
  & (Join-Path $NodeDir 'node.exe') (Join-Path $Kit 'runner.js')
  Write-Host ''
  Write-Host 'The lab runner has finished. Look around if you like - the work is in the workshop folder on the desktop.'
} catch {
  Write-Status 'error' ("The lab could not start: " + $_.Exception.Message)
  Write-Host ''
  Write-Host 'Something went wrong setting up the lab. The details are in workshop\logs\setup.log.'
}
try { Stop-Transcript | Out-Null } catch { }
Read-Host 'Press Enter to close this window (the sandbox stays open until you close it)'
