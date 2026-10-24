@echo off
setlocal
powershell.exe -NoProfile -File "%~dp0uninstall-autostart.ps1"
if errorlevel 1 pause
