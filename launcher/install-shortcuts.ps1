# Puts "Hydra" on the desktop and in the Start menu, and "Stop
# Hydra" in the Start menu. Safe to run again (it just redoes them).
#   -AtLogin  also starts Hydra quietly when you sign in to Windows
#   -NoLogin  removes that again
# Windows PowerShell 5.1.

param([switch]$AtLogin, [switch]$NoLogin)

$app = Split-Path -Parent $PSScriptRoot
$ico = Join-Path $PSScriptRoot 'hydra.ico'
$ps = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
$shell = New-Object -ComObject WScript.Shell

# Windows wants an .ico for shortcuts; build one from the app icon once.
if (-not (Test-Path $ico)) {
  Add-Type -AssemblyName System.Drawing
  $src = [System.Drawing.Image]::FromFile((Join-Path $app 'icon-512.png'))
  $pngs = foreach ($s in 256, 64, 48, 32, 16) {
    $bmp = New-Object System.Drawing.Bitmap $s, $s
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = 'HighQualityBicubic'; $g.SmoothingMode = 'HighQuality'; $g.PixelOffsetMode = 'HighQuality'
    $g.DrawImage($src, 0, 0, $s, $s); $g.Dispose()
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
    , @($s, $ms.ToArray())
  }
  $src.Dispose()
  $out = New-Object System.IO.MemoryStream
  $w = New-Object System.IO.BinaryWriter $out
  $w.Write([uint16]0); $w.Write([uint16]1); $w.Write([uint16]$pngs.Count)
  $offset = 6 + 16 * $pngs.Count
  foreach ($p in $pngs) {
    $dim = if ($p[0] -ge 256) { 0 } else { $p[0] }
    $w.Write([byte]$dim); $w.Write([byte]$dim); $w.Write([byte]0); $w.Write([byte]0)
    $w.Write([uint16]1); $w.Write([uint16]32); $w.Write([uint32]$p[1].Length); $w.Write([uint32]$offset)
    $offset += $p[1].Length
  }
  foreach ($p in $pngs) { $w.Write([byte[]]$p[1]) }
  $w.Flush(); [System.IO.File]::WriteAllBytes($ico, $out.ToArray()); $w.Dispose()
}

function New-Shortcut($path, $script, $description) {
  $s = $shell.CreateShortcut($path)
  $s.TargetPath = $ps
  $s.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$(Join-Path $PSScriptRoot $script)`""
  $s.WorkingDirectory = $app
  $s.IconLocation = "$ico,0"
  $s.WindowStyle = 7   # minimized, so no window flashes up
  $s.Description = $description
  $s.Save()
}

$desktop = [Environment]::GetFolderPath('Desktop')
$menu = Join-Path ([Environment]::GetFolderPath('Programs')) 'Hydra'
# Shortcuts from when this was called MultiClaude (starting at sign-in carries over).
if (Test-Path (Join-Path ([Environment]::GetFolderPath('Startup')) 'MultiClaude.lnk')) { $AtLogin = $true }
foreach ($old in (Join-Path $desktop 'MultiClaude.lnk'), (Join-Path ([Environment]::GetFolderPath('Programs')) 'MultiClaude'), (Join-Path ([Environment]::GetFolderPath('Startup')) 'MultiClaude.lnk')) {
  if (Test-Path $old) { Remove-Item -Recurse -Force $old }
}
New-Item -ItemType Directory -Force $menu | Out-Null
New-Shortcut (Join-Path $desktop 'Hydra.lnk') 'start.ps1' 'Open Hydra'
New-Shortcut (Join-Path $menu 'Hydra.lnk') 'start.ps1' 'Open Hydra'
New-Shortcut (Join-Path $menu 'Stop Hydra.lnk') 'stop.ps1' 'Turn Hydra off'

# Start with Windows: a shortcut in the Startup folder that only starts the
# server (no page pops up at sign-in).
$startup = Join-Path ([Environment]::GetFolderPath('Startup')) 'Hydra.lnk'
if ($AtLogin) {
  New-Shortcut $startup 'start.ps1' 'Start Hydra in the background'
  $s = $shell.CreateShortcut($startup); $s.Arguments += ' -Quiet'; $s.Save()
}
if ($NoLogin -and (Test-Path $startup)) { Remove-Item $startup }

"Shortcuts are on the desktop and in the Start menu."
if (Test-Path $startup) { "Hydra also starts when you sign in to Windows." }
