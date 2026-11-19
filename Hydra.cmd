@echo off
rem Opens Hydra: starts it quietly in the background if it isn't running
rem yet, then opens the page. Same as the Hydra shortcut.
rem To turn it off, use the "Stop Hydra" shortcut in the Start menu.
rem To watch it run in a visible window instead (for fixing problems): node server.mjs
powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0launcher\start.ps1"
