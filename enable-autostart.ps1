$ErrorActionPreference = 'Stop'
$taskRoot = $PSScriptRoot
$null = Get-Command node.exe -ErrorAction Stop
$powershellPath = (Get-Command powershell.exe -ErrorAction Stop).Source
$userAccount = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$taskName = 'PriceChecker-' + [System.IO.Path]::GetFileName($taskRoot)
$action = New-ScheduledTaskAction -Execute $powershellPath -Argument ('-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + (Join-Path $taskRoot 'start.ps1') + '" -NoBrowser') -WorkingDirectory $taskRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $userAccount
$principal = New-ScheduledTaskPrincipal -UserId $userAccount -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Local Randewoo price tracker; runs while this user is signed in.' -Force | Out-Null
Write-Output "Autostart enabled: $taskName"
