# First-time setup for MultiClaude on a new PC. Safe to run again.
# Run it from this folder in Windows PowerShell:
#   powershell -ExecutionPolicy Bypass -File .\setup.ps1
# It installs the parts, asks your name, where your projects live and how
# many Claude accounts you have, then signs each account in once.

$ErrorActionPreference = 'Stop'
$app = $PSScriptRoot
$data = if ($env:MULTICLAUDE_DATA) { $env:MULTICLAUDE_DATA } else { Join-Path $env:USERPROFILE '.multiclaude' }

function Ask($question, $default) {
  $a = Read-Host "$question [$default]"
  if ([string]::IsNullOrWhiteSpace($a)) { return $default } else { return $a.Trim() }
}

Write-Host "`n== MultiClaude setup ==`n" -ForegroundColor Cyan

# 1. Node.js
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host 'Node.js is not installed. Install it first (the LTS version) from https://nodejs.org' -ForegroundColor Yellow
  Write-Host 'or run:  winget install OpenJS.NodeJS.LTS   then open a new PowerShell and run this again.'
  return
}
$major = [int]((node -v).TrimStart('v').Split('.')[0])
if ($major -lt 20) { Write-Host "Node $(node -v) is too old; install version 20 or newer from https://nodejs.org" -ForegroundColor Yellow; return }

# 2. The parts MultiClaude needs
Write-Host 'Installing the parts (npm install)...'
Push-Location $app
try { & npm.cmd install --no-fund --no-audit | Out-Host } finally { Pop-Location }
$claude = Join-Path $app 'node_modules\@anthropic-ai\claude-agent-sdk-win32-x64\claude.exe'
if (-not (Test-Path $claude)) { Write-Host 'npm install did not finish (claude.exe is missing). Fix the error above and run this again.' -ForegroundColor Red; return }

# 3. About you
New-Item -ItemType Directory -Force $data | Out-Null
$cfgFile = Join-Path $data 'config.json'
$cfg = @{}
if (Test-Path $cfgFile) { (Get-Content $cfgFile -Raw | ConvertFrom-Json).psobject.Properties | ForEach-Object { $cfg[$_.Name] = $_.Value } }
$defName = if ($cfg.name) { $cfg.name } else { (Get-Culture).TextInfo.ToTitleCase($env:USERNAME) }
$defRoot = if ($cfg.projectsRoot) { $cfg.projectsRoot } else { 'C:\Projects' }
$name = Ask 'Your first name (Claude calls you this)' $defName
$root = Ask 'The folder your projects live in' $defRoot
New-Item -ItemType Directory -Force $root | Out-Null
@{ name = $name; projectsRoot = $root } | ConvertTo-Json | Set-Content -Encoding UTF8 $cfgFile

# 4. Accounts: each one gets its own folder, so its login never changes
$accFile = Join-Path $data 'accounts.json'
$have = 0
if (Test-Path $accFile) { $have = @(Get-Content $accFile -Raw | ConvertFrom-Json).Count }
$count = [int](Ask 'How many Claude accounts do you have (Pro or Max)' ([Math]::Max($have, 1)))
$accounts = 1..$count | ForEach-Object { [pscustomobject]@{ id = "account-$_"; configDir = (Join-Path $data "account-$_") } }
ConvertTo-Json @($accounts) | Set-Content -Encoding UTF8 $accFile

Write-Host "`nNow sign each account in once. A browser opens each time:" -ForegroundColor Cyan
Write-Host 'sign in with a DIFFERENT Claude account each time, then come back here.'
foreach ($a in $accounts) {
  New-Item -ItemType Directory -Force $a.configDir | Out-Null
  $signedIn = (Get-ChildItem $a.configDir -Force -ErrorAction SilentlyContinue | Where-Object Name -eq '.credentials.json')
  if ($signedIn) {
    $again = Ask "$($a.id) already looks signed in. Sign it in again? (y/n)" 'n'
    if ($again -notmatch '^y') { continue }
  }
  Read-Host "`nPress Enter to sign in $($a.id)"
  $env:CLAUDE_CONFIG_DIR = $a.configDir
  & $claude auth login | Out-Host
  Remove-Item Env:CLAUDE_CONFIG_DIR
}

# 5. Shortcuts
& (Join-Path $app 'launcher\install-shortcuts.ps1')

Write-Host "`nAll set. Open MultiClaude from the desktop shortcut (or the Start menu)." -ForegroundColor Green
Write-Host 'Run this again any time to add an account or change your name or projects folder.'
