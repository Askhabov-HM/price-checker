$ErrorActionPreference = 'Stop'
$taskName = 'PriceChecker-Lamoda-Desktop'
$wrapper = (Resolve-Path (Join-Path $PSScriptRoot 'run-agent.vbs')).Path
$agent = (Resolve-Path (Join-Path $PSScriptRoot 'agent.js')).Path
$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if (-not $task) { Write-Output "Task $taskName is not installed."; exit 0 }
if ($task.Actions[0].Arguments -notlike "*$wrapper*") { throw "Task $taskName does not belong to this collector." }
Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "name = 'node.exe'" | Where-Object { $_.CommandLine -like "*$agent*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
Write-Output "Removed $taskName."
