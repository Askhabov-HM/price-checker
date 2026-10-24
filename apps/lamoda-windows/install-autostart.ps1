$ErrorActionPreference = 'Stop'
$taskName = 'PriceChecker-Lamoda-Desktop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$agent = (Resolve-Path (Join-Path $PSScriptRoot 'agent.js')).Path
$wrapper = (Resolve-Path (Join-Path $PSScriptRoot 'run-agent.vbs')).Path
$node = (Get-Command node.exe -ErrorAction Stop).Source
$wscript = Join-Path $env:WINDIR 'System32\wscript.exe'
$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name

$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing -and ($existing.Actions[0].Execute -ne $wscript -or $existing.Actions[0].Arguments -notlike "*$wrapper*")) {
  throw "Task $taskName exists and does not belong to this collector."
}

$arguments = '"{0}" "{1}" "{2}" "{3}"' -f $wrapper,$node,$agent,$root
$action = New-ScheduledTaskAction -Execute $wscript -Argument $arguments -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings `
  -Principal $principal -Description 'Lamoda desktop collector; server controls the collection schedule.' -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
Write-Output "Installed and started $taskName for $user"
