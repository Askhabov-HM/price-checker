@echo off
setlocal
node "%~dp0launch-chrome.js"
if errorlevel 1 pause
