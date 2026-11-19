# Hydra's hands and eyes: takes screenshots and sends mouse/keyboard
# input. screen.mjs keeps one copy running and talks to it one JSON line at a
# time over stdin/stdout. Ends by itself when Hydra closes stdin.
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class MCScreen {
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx, dy, mouseData; public uint dwFlags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Explicit)] struct UNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public UNION u; }
  public struct RECT { public int Left, Top, Right, Bottom; }
  delegate bool EnumProc(IntPtr h, IntPtr l);

  [DllImport("user32.dll")] static extern uint SendInput(uint n, INPUT[] a, int size);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern uint MapVirtualKey(uint code, uint type);
  [DllImport("user32.dll")] public static extern short VkKeyScan(char c);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);

  static void Send(INPUT i) { SendInput(1, new[] { i }, Marshal.SizeOf(typeof(INPUT))); }

  public static void Mouse(uint flags, int dx, int dy, int data) {
    INPUT i = new INPUT(); i.type = 0;
    i.u.mi.dx = dx; i.u.mi.dy = dy; i.u.mi.mouseData = data; i.u.mi.dwFlags = flags;
    Send(i);
  }

  // Sends the scan code too: games (Minecraft included) read the scan code,
  // not the virtual key, so a key with no scan code does nothing there.
  static readonly HashSet<int> Extended = new HashSet<int> { 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2D, 0x2E, 0x5B, 0x5C, 0x5D, 0x6F, 0x90, 0xA3, 0xA5 };
  public static void Key(int vk, bool up) {
    INPUT i = new INPUT(); i.type = 1;
    i.u.ki.wVk = (ushort)vk; i.u.ki.wScan = (ushort)MapVirtualKey((uint)vk, 0);
    i.u.ki.dwFlags = (Extended.Contains(vk) ? 1u : 0u) | (up ? 2u : 0u);
    Send(i);
  }

  public static void Char(char c) {
    foreach (bool up in new[] { false, true }) {
      INPUT i = new INPUT(); i.type = 1;
      i.u.ki.wScan = c; i.u.ki.dwFlags = 4u | (up ? 2u : 0u);
      Send(i);
    }
  }

  static string Title(IntPtr h) {
    int n = GetWindowTextLength(h); if (n == 0) return "";
    StringBuilder s = new StringBuilder(n + 1); GetWindowText(h, s, s.Capacity); return s.ToString();
  }

  public static List<object[]> Windows() {
    List<object[]> list = new List<object[]>();
    IntPtr fg = GetForegroundWindow();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      string t = Title(h); if (t.Length == 0) return true;
      RECT r; GetWindowRect(h, out r);
      if (r.Right - r.Left < 50 || r.Bottom - r.Top < 50) return true;
      list.Add(new object[] { h.ToInt64(), t, r.Left, r.Top, r.Right - r.Left, r.Bottom - r.Top, h == fg, IsIconic(h) });
      return true;
    }, IntPtr.Zero);
    return list;
  }

  public static bool Focus(long handle) {
    IntPtr h = new IntPtr(handle);
    if (IsIconic(h)) ShowWindow(h, 9);
    // Windows only lets the program that sent the last input bring a window
    // forward, so send a mouse nudge of zero first. A tap of Alt also works but
    // opens menus and swallows the next key, so it is only the fallback.
    Mouse(1, 0, 0, 0);
    if (SetForegroundWindow(h) && GetForegroundWindow() == h) return true;
    Key(0x12, false); Key(0x12, true);
    return SetForegroundWindow(h);
  }
}
'@

# Real pixels, not Windows' scaled ones, so clicks land where the screenshot says.
try { [void][MCScreen]::SetProcessDpiAwarenessContext([IntPtr](-4)) } catch { }
[void][MCScreen]::SetProcessDPIAware()
Add-Type -AssemblyName System.Drawing, System.Windows.Forms
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }

# Smaller pictures cost less on every later step; zoom reads small text when needed.
$MaxW = 1024; $MaxH = 640
$script:screenIdx = -1   # screen of the last screenshot; -1 = primary

function Get-Screens { [System.Windows.Forms.Screen]::AllScreens }
function Get-Target($idx) {
  $all = @(Get-Screens)
  if ($null -eq $idx -or $idx -lt 0) { $idx = $script:screenIdx }
  if ($idx -lt 0 -or $idx -ge $all.Count) { $idx = [array]::IndexOf($all, ($all | Where-Object Primary | Select-Object -First 1)) }
  $b = $all[$idx].Bounds
  $scale = [Math]::Min(1.0, [Math]::Min($MaxW / $b.Width, $MaxH / $b.Height))
  @{ idx = $idx; count = $all.Count; b = $b; scale = $scale }
}
# Screenshot coordinates -> real screen coordinates.
function To-Screen($x, $y) {
  $t = Get-Target $null
  @([int]($t.b.X + [double]$x / $t.scale), [int]($t.b.Y + [double]$y / $t.scale))
}

$named = @{
  enter = 0x0D; return = 0x0D; esc = 0x1B; escape = 0x1B; tab = 0x09; space = 0x20; backspace = 0x08
  delete = 0x2E; del = 0x2E; insert = 0x2D; home = 0x24; end = 0x23; pageup = 0x21; pagedown = 0x22
  up = 0x26; down = 0x28; left = 0x25; right = 0x27; shift = 0xA0; ctrl = 0xA2; control = 0xA2
  alt = 0xA4; win = 0x5B; windows = 0x5B; super = 0x5B; cmd = 0x5B; meta = 0x5B; capslock = 0x14
  printscreen = 0x2C; menu = 0x5D; plus = 0xBB; minus = 0xBD
}
1..24 | ForEach-Object { $named["f$_"] = 0x6F + $_ }

# "ctrl+shift+t" -> list of virtual keys (plus shift if a character needs it).
# mouseleft / mouseright are allowed so a mouse button can be held down too.
function Parse-Keys([string]$combo) {
  $out = New-Object System.Collections.ArrayList
  foreach ($part in ($combo -split '\+(?!$)' | ForEach-Object { $_.Trim() } | Where-Object { $_ })) {
    $p = $part.ToLower()
    if ($p -in 'mouseleft', 'mouseright', 'mousemiddle') { [void]$out.Add($p) }
    elseif ($named.ContainsKey($p)) { [void]$out.Add($named[$p]) }
    elseif ($part.Length -eq 1) {
      $s = [MCScreen]::VkKeyScan($part[0])
      if ($s -eq -1) { throw "No key on this keyboard types '$part'; use the type tool for it" }
      if (($s -shr 8) -band 1) { [void]$out.Add(0xA0) }
      [void]$out.Add($s -band 0xFF)
    }
    else { throw "Unknown key '$part'" }
  }
  if ($out.Count -eq 0) { throw 'No keys given' }
  , $out
}
function Press($k, [bool]$up) {
  if ($k -is [string]) {
    $f = @{ mouseleft = @(2, 4); mouseright = @(8, 16); mousemiddle = @(32, 64) }[$k]
    [MCScreen]::Mouse($f[[int]$up], 0, 0, 0)
  } else { [MCScreen]::Key([int]$k, $up) }
}
function Hold($keys, [int]$ms) {
  foreach ($k in $keys) { Press $k $false; Start-Sleep -Milliseconds 15 }
  Start-Sleep -Milliseconds $ms
  for ($i = $keys.Count - 1; $i -ge 0; $i--) { Press $keys[$i] $true; Start-Sleep -Milliseconds 15 }
}
function Mods($list) { if ($list) { , (Parse-Keys ($list -join '+')) } else { , @() } }
function Button($name) { @{ left = @(2, 4); right = @(8, 16); middle = @(32, 64) }[$(if ($name) { $name } else { 'left' })] }

function Run($c) {
  switch ($c.op) {
    'screenshot' {
      $t = Get-Target $c.screen
      $script:screenIdx = $t.idx
      $b = $t.b
      $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
      $g = [System.Drawing.Graphics]::FromImage($bmp)
      $g.CopyFromScreen($b.X, $b.Y, 0, 0, $bmp.Size)
      $w = [int][Math]::Round($b.Width * $t.scale); $h = [int][Math]::Round($b.Height * $t.scale)
      $small = New-Object System.Drawing.Bitmap $w, $h
      $g2 = [System.Drawing.Graphics]::FromImage($small)
      $g2.InterpolationMode = 'HighQualityBicubic'
      $g2.DrawImage($bmp, 0, 0, $w, $h)
      $ms = New-Object System.IO.MemoryStream
      $jpg = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object MimeType -eq 'image/jpeg'
      $ep = New-Object System.Drawing.Imaging.EncoderParameters 1
      $ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), 80L
      $small.Save($ms, $jpg, $ep)
      $g.Dispose(); $g2.Dispose(); $bmp.Dispose(); $small.Dispose()
      return @{ data = [Convert]::ToBase64String($ms.ToArray()); width = $w; height = $h; screen = $t.idx + 1; screens = $t.count; realWidth = $b.Width; realHeight = $b.Height }
    }
    'zoom' {
      # A box from the last screenshot, at real resolution (shrunk only if it is bigger than the cap).
      $p1 = To-Screen ([Math]::Min($c.x1, $c.x2)) ([Math]::Min($c.y1, $c.y2))
      $p2 = To-Screen ([Math]::Max($c.x1, $c.x2)) ([Math]::Max($c.y1, $c.y2))
      $rw = [Math]::Max(8, $p2[0] - $p1[0]); $rh = [Math]::Max(8, $p2[1] - $p1[1])
      $bmp = New-Object System.Drawing.Bitmap $rw, $rh
      $g = [System.Drawing.Graphics]::FromImage($bmp)
      $g.CopyFromScreen($p1[0], $p1[1], 0, 0, $bmp.Size)
      $s = [Math]::Min(1.0, [Math]::Min($MaxW / $rw, $MaxH / $rh))
      $w = [int][Math]::Round($rw * $s); $h = [int][Math]::Round($rh * $s)
      $small = New-Object System.Drawing.Bitmap $w, $h
      $g2 = [System.Drawing.Graphics]::FromImage($small)
      $g2.InterpolationMode = 'HighQualityBicubic'
      $g2.DrawImage($bmp, 0, 0, $w, $h)
      $ms = New-Object System.IO.MemoryStream
      $jpg = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object MimeType -eq 'image/jpeg'
      $ep = New-Object System.Drawing.Imaging.EncoderParameters 1
      $ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), 85L
      $small.Save($ms, $jpg, $ep)
      $g.Dispose(); $g2.Dispose(); $bmp.Dispose(); $small.Dispose()
      return @{ data = [Convert]::ToBase64String($ms.ToArray()); width = $w; height = $h }
    }
    'click' {
      $p = To-Screen $c.x $c.y
      [void][MCScreen]::SetCursorPos($p[0], $p[1]); Start-Sleep -Milliseconds 40
      $f = Button $c.button
      $mods = Mods $c.hold
      foreach ($k in $mods) { Press $k $false }
      for ($n = 0; $n -lt [Math]::Max(1, [int]$c.count); $n++) {
        [MCScreen]::Mouse($f[0], 0, 0, 0); Start-Sleep -Milliseconds 30; [MCScreen]::Mouse($f[1], 0, 0, 0); Start-Sleep -Milliseconds 60
      }
      foreach ($k in $mods) { Press $k $true }
      return @{}
    }
    'move' {
      if ($c.relative) {
        # Small steps, so games that turn the camera from mouse movement follow it.
        $steps = [Math]::Max(1, [int]([Math]::Max([Math]::Abs($c.dx), [Math]::Abs($c.dy)) / 20))
        $sx = 0; $sy = 0
        for ($i = 1; $i -le $steps; $i++) {
          $nx = [int]($c.dx * $i / $steps); $ny = [int]($c.dy * $i / $steps)
          [MCScreen]::Mouse(1, $nx - $sx, $ny - $sy, 0); $sx = $nx; $sy = $ny
          Start-Sleep -Milliseconds 8
        }
      } else { $p = To-Screen $c.x $c.y; [void][MCScreen]::SetCursorPos($p[0], $p[1]) }
      return @{}
    }
    'drag' {
      $a = To-Screen $c.x1 $c.y1; $z = To-Screen $c.x2 $c.y2; $f = Button $c.button
      [void][MCScreen]::SetCursorPos($a[0], $a[1]); Start-Sleep -Milliseconds 50
      [MCScreen]::Mouse($f[0], 0, 0, 0); Start-Sleep -Milliseconds 80
      for ($i = 1; $i -le 20; $i++) {
        [void][MCScreen]::SetCursorPos([int]($a[0] + ($z[0] - $a[0]) * $i / 20), [int]($a[1] + ($z[1] - $a[1]) * $i / 20)); Start-Sleep -Milliseconds 15
      }
      Start-Sleep -Milliseconds 60; [MCScreen]::Mouse($f[1], 0, 0, 0)
      return @{}
    }
    'scroll' {
      if ($null -ne $c.x) { $p = To-Screen $c.x $c.y; [void][MCScreen]::SetCursorPos($p[0], $p[1]); Start-Sleep -Milliseconds 30 }
      $n = [Math]::Max(1, [int]$c.amount)
      for ($i = 0; $i -lt $n; $i++) {
        switch ($c.direction) {
          'up' { [MCScreen]::Mouse(0x800, 0, 0, 120) } 'down' { [MCScreen]::Mouse(0x800, 0, 0, -120) }
          'left' { [MCScreen]::Mouse(0x1000, 0, 0, -120) } 'right' { [MCScreen]::Mouse(0x1000, 0, 0, 120) }
        }
        Start-Sleep -Milliseconds 40
      }
      return @{}
    }
    'type' {
      foreach ($ch in ([string]$c.text).ToCharArray()) {
        if ($ch -eq "`n") { [MCScreen]::Key(0x0D, $false); [MCScreen]::Key(0x0D, $true) }
        elseif ($ch -ne "`r") { [MCScreen]::Char($ch) }
        Start-Sleep -Milliseconds 8
      }
      return @{}
    }
    'key' {
      $keys = Parse-Keys $c.keys
      for ($n = 0; $n -lt [Math]::Max(1, [int]$c.repeat); $n++) { Hold $keys 40; Start-Sleep -Milliseconds 40 }
      return @{}
    }
    'hold' { Hold (Parse-Keys $c.keys) ([int]([double]$c.seconds * 1000)); return @{} }
    'windows' {
      return @{ windows = @([MCScreen]::Windows() | ForEach-Object { @{ id = $_[0]; title = $_[1]; x = $_[2]; y = $_[3]; w = $_[4]; h = $_[5]; active = $_[6]; minimized = $_[7] } }) }
    }
    'focus' { return @{ focused = [MCScreen]::Focus([long]$c.id) } }
    default { throw "Unknown op '$($c.op)'" }
  }
}

while ($null -ne ($line = [Console]::In.ReadLine())) {
  if (-not $line.Trim()) { continue }
  try { $res = Run ($line | ConvertFrom-Json); $res.ok = $true }
  catch { $res = @{ ok = $false; error = $_.Exception.Message } }
  [Console]::Out.WriteLine(($res | ConvertTo-Json -Compress -Depth 5))
  [Console]::Out.Flush()
}
