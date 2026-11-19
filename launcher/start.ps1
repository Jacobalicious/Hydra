# Opens Hydra. If it is not running yet, starts it quietly in the
# background first (no window to keep open), waits until it answers, then
# opens the page. Run by the Hydra shortcut and by Hydra.cmd.
# -Quiet: only make sure it is running, don't open the page (used at sign-in).
# Windows PowerShell 5.1.

param([switch]$Quiet)
$ErrorActionPreference = 'Stop'
$port = if ($env:HYDRA_PORT) { [int]$env:HYDRA_PORT } else { 4517 }
$url = "http://127.0.0.1:$port"
$app = Split-Path -Parent $PSScriptRoot
$data = if ($env:HYDRA_DATA) { $env:HYDRA_DATA } elseif (-not (Test-Path (Join-Path $env:USERPROFILE '.hydra')) -and (Test-Path (Join-Path $env:USERPROFILE '.multiclaude'))) { Join-Path $env:USERPROFILE '.multiclaude' } else { Join-Path $env:USERPROFILE '.hydra' }
$log = Join-Path $data 'server.log'
$errLog = Join-Path $data 'server-errors.log'

function Test-Up {
  try { Invoke-WebRequest "$url/manifest.json" -UseBasicParsing -TimeoutSec 2 | Out-Null; return $true } catch { return $false }
}
function Show-Problem($text) {
  (New-Object -ComObject WScript.Shell).Popup($text, 0, 'Hydra', 48) | Out-Null
}

if (Test-Up) { if (-not $Quiet) { Start-Process $url }; return }

# Only one launcher starts the server at a time. Starting takes a few silent
# seconds, so a second click in that gap used to start its own copy and open
# a second tab. Now the second one waits for the first and leaves the page to it.
$stamp = Join-Path $data 'last-open.txt'
function Open-Page { Set-Content $stamp (Get-Date).Ticks -ErrorAction SilentlyContinue; Start-Process $url }
$lock = New-Object System.Threading.Mutex($false, 'Local\HydraLauncher')
$began = (Get-Date).Ticks
if (-not $lock.WaitOne(0)) {
  try { $null = $lock.WaitOne(45000) } catch [System.Threading.AbandonedMutexException] {}
  if ($Quiet -or -not (Test-Up)) { return }
  $last = 0; try { $last = [long](Get-Content $stamp -ErrorAction Stop) } catch {}
  if ($last -lt $began) { Open-Page }   # the other launcher was the quiet sign-in one
  return
}
if (Test-Up) { if (-not $Quiet) { Open-Page }; return }   # came up while we were checking

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { Show-Problem "Hydra needs Node.js, and it isn't installed (or isn't on the PATH).`n`nInstall it from nodejs.org, then try again."; return }
if (-not (Test-Path (Join-Path $app 'node_modules'))) { Show-Problem "Hydra isn't set up yet.`n`nOpen a terminal in`n$app`nand run:  npm.cmd install"; return }

New-Item -ItemType Directory -Force $data | Out-Null
Start-Process -FilePath $node -ArgumentList 'server.mjs', '--no-open' -WorkingDirectory $app `
  -WindowStyle Hidden -RedirectStandardOutput $log -RedirectStandardError $errLog

# Give it up to 30 seconds to come up.
for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Milliseconds 500
  if (Test-Up) { if (-not $Quiet) { Open-Page }; return }
}

$why = ''
try { $why = (Get-Content $errLog -Tail 8 -ErrorAction Stop) -join "`n" } catch {}
Show-Problem "Hydra didn't start.`n`n$why`n`nThe full log is in $data"
