$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node -ErrorAction Stop).Source
$runner = Join-Path $PSScriptRoot 'sync-pu-to-pages.mjs'
if (-not (Test-Path -LiteralPath $runner)) { throw 'PU sync runner is missing.' }
$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$command = '& ''' + $node.Replace("'", "''") + ''' ''' + $runner.Replace("'", "''") + '''; exit $LASTEXITCODE'
$encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
$action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand $encoded" -WorkingDirectory $project
$login = New-ScheduledTaskTrigger -AtLogOn -User $user
$repeat = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(30) -RepetitionInterval (New-TimeSpan -Minutes 30)
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 40) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName 'SanjiangRadar-PU-AutoPublish' -Action $action -Trigger @($login, $repeat) -Principal $principal -Settings $settings -Description 'Collect PU with the local signed-in profile and publish validated public activity data to GitHub Pages every 30 minutes.' -Force | Out-Null
Start-ScheduledTask -TaskName 'SanjiangRadar-PU-AutoPublish'
Get-ScheduledTask -TaskName 'SanjiangRadar-PU-AutoPublish' | Select-Object TaskName, State
