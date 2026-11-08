$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node -ErrorAction Stop).Source
$watcher = Join-Path $PSScriptRoot 'watch-private-services.mjs'
if (-not (Test-Path -LiteralPath $watcher)) { throw 'Service supervisor is missing.' }
$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$command = '& ''' + $node.Replace("'", "''") + ''' ''' + $watcher.Replace("'", "''") + '''; exit $LASTEXITCODE'
$encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
$action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand $encoded" -WorkingDirectory $project
$login = New-ScheduledTaskTrigger -AtLogOn -User $user
$retry = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName 'SanjiangRadar-PrivateServices' -Action $action -Trigger @($login, $retry) -Principal $principal -Settings $settings -Description 'Starts the private identity and class assistant services after Windows login; supervises local processes without replaying AI requests.' -Force | Out-Null
Start-ScheduledTask -TaskName 'SanjiangRadar-PrivateServices'
Get-ScheduledTask -TaskName 'SanjiangRadar-PrivateServices' | Select-Object TaskName, State
