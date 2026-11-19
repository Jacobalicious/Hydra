# Turns Hydra off right away, no questions: stops the server and the
# Claude Code processes it started. Anything Claude was in the middle of is cut off.
# -Force: not even the "not running" message (for scripts).
# Windows PowerShell 5.1.

param([switch]$Force)
$port = if ($env:HYDRA_PORT) { [int]$env:HYDRA_PORT } else { 4517 }
$conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $conn) {
  if (-not $Force) { (New-Object -ComObject WScript.Shell).Popup('Hydra is not running.', 3, 'Hydra', 64) | Out-Null }
  return
}

# /T also ends the Claude Code processes it started.
taskkill.exe /PID $conn.OwningProcess /T /F | Out-Null
