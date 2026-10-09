param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$taskRoot = $PSScriptRoot
$appUrl = 'http://127.0.0.1:8000'
$dataDirectory = Join-Path $taskRoot '.data'
New-Item -ItemType Directory -Path $dataDirectory -Force | Out-Null

function Test-Tracker {
    try {
        $response = Invoke-RestMethod -Uri "$appUrl/api/status" -TimeoutSec 2
        return $response.timezone -eq 'Europe/Moscow' -and $null -ne $response.schedule
    } catch { return $false }
}

if (-not (Test-Tracker)) {
    $pythonCommand = Get-Command python.exe -ErrorAction Stop
    $scriptPath = Join-Path $taskRoot 'run.py'
    $arguments = @('-X', 'utf8', '-u', ('"' + $scriptPath + '"'), '--no-browser')
    $process = Start-Process -FilePath $pythonCommand.Source -ArgumentList $arguments -WorkingDirectory $taskRoot -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $dataDirectory 'server.log') -RedirectStandardError (Join-Path $dataDirectory 'server-error.log') -PassThru
    Set-Content -LiteralPath (Join-Path $dataDirectory 'server.pid') -Value $process.Id
    $ready = $false
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        if (Test-Tracker) { $ready = $true; break }
        if ($process.HasExited) { break }
        Start-Sleep -Milliseconds 200
        $process.Refresh()
    }
    if (-not $ready) { throw 'Application did not start. Check .data/server-error.log or whether port 8000 is occupied.' }
}
if (-not $NoBrowser) { Start-Process $appUrl }
Write-Output "Price Checker: $appUrl"
