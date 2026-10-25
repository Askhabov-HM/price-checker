@echo off
setlocal
node "%~dp0collect-once.js"
if errorlevel 1 pause
