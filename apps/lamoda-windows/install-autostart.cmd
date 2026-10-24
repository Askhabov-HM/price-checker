@echo off
setlocal
powershell.exe -NoProfile -File "%~dp0install-autostart.ps1"
if errorlevel 1 pause
