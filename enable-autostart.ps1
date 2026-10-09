$ErrorActionPreference = 'Stop'
$taskRoot = $PSScriptRoot
$pythonPath = (Get-Command python.exe -ErrorAction Stop).Source
$pythonWindowless = Join-Path (Split-Path $pythonPath) 'pythonw.exe'
if (-not (Test-Path -LiteralPath $pythonWindowless)) { throw 'pythonw.exe was not found next to python.exe.' }
$userAccount = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$taskName = 'PriceChecker-' + [System.IO.Path]::GetFileName($taskRoot)
$action = New-ScheduledTaskAction -Execute $pythonWindowless -Argument ('-X utf8 "' + (Join-Path $taskRoot 'run.py') + '" --no-browser') -WorkingDirectory $taskRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $userAccount
$principal = New-ScheduledTaskPrincipal -UserId $userAccount -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Local Randewoo price tracker; runs while this user is signed in.' -Force | Out-Null
Write-Output "Autostart enabled: $taskName"
