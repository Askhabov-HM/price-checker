$ErrorActionPreference = 'Stop'
$metadataFile = Join-Path $PSScriptRoot '.data/server.json'
if (-not (Test-Path -LiteralPath $metadataFile)) { Write-Output 'Price Checker is not running.'; exit 0 }
$metadata = Get-Content -LiteralPath $metadataFile -Raw | ConvertFrom-Json
$trackerPid = [int]$metadata.pid
$trackerProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $trackerPid"
$scriptPath = Join-Path $PSScriptRoot 'run.js'
if ($null -eq $trackerProcess) { Write-Output 'Price Checker is not running.'; exit 0 }
if ($trackerProcess.Name -ne 'node.exe' -or -not $trackerProcess.CommandLine.Contains($scriptPath)) {
    throw 'The recorded process does not match this application; no process was stopped.'
}
$appUrl = 'http://127.0.0.1:' + [int]$metadata.port
if ($metadata.control_token) {
    $status = Invoke-RestMethod -Uri "$appUrl/api/health" -TimeoutSec 3
    $shutdownHeaders = @{Authorization = ('Bearer ' + $metadata.control_token)}
} else {
    # Compatibility with an already-running version from before login was introduced.
    $status = Invoke-RestMethod -Uri "$appUrl/api/status" -TimeoutSec 3
    $shutdownHeaders = @{'X-CSRF-Token' = $status.csrf_token}
}
if ($status.runtime -ne 'node.js') { throw 'Unexpected application on the recorded port; nothing was stopped.' }
Invoke-RestMethod -Uri "$appUrl/api/shutdown" -Method Post -ContentType 'application/json' `
    -Headers $shutdownHeaders -Body '{}' -TimeoutSec 5 | Out-Null
for ($attempt = 0; $attempt -lt 50; $attempt++) {
    if ($null -eq (Get-Process -Id $trackerPid -ErrorAction SilentlyContinue)) {
        Write-Output 'Price Checker stopped. Prices remain in the database.'
        exit 0
    }
    Start-Sleep -Milliseconds 100
}
throw 'The application is still shutting down. Check .data/server-error.log.'
