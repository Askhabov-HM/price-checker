$ErrorActionPreference = 'Stop'
$pidFile = Join-Path $PSScriptRoot '.data/server.pid'
if (-not (Test-Path -LiteralPath $pidFile)) { Write-Output 'Price Checker is not running.'; exit 0 }
$trackerPid = [int](Get-Content -LiteralPath $pidFile)
$trackerProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $trackerPid"
$scriptPath = Join-Path $PSScriptRoot 'run.py'
if ($null -eq $trackerProcess) { Write-Output 'Price Checker is not running.'; exit 0 }
if ($trackerProcess.Name -notin @('python.exe', 'pythonw.exe') -or -not $trackerProcess.CommandLine.Contains('"' + $scriptPath + '"')) {
    throw 'The recorded process does not match this application; no process was stopped.'
}
Stop-Process -Id $trackerPid
Write-Output 'Price Checker stopped. Prices remain in the database.'
