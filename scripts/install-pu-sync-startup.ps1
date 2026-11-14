$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node -ErrorAction Stop).Source
$runner = Join-Path $PSScriptRoot 'sync-pu-to-pages.mjs'
if (-not (Test-Path -LiteralPath $runner)) { throw 'PU sync runner is missing.' }
$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$command = '& ''' + $node.Replace("'", "''") + ''' ''' + $runner.Replace("'", "''") + '''; exit $LASTEXITCODE'
$encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
$action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand $encoded" -WorkingDirectory $project
$nextRun = (Get-Date).Date.AddHours(9)
if ($nextRun -le (Get-Date)) { $nextRun = $nextRun.AddDays(1) }
$daily = New-ScheduledTaskTrigger -Daily -At $nextRun
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 40) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName 'SanjiangRadar-PU-AutoPublish' -Action $action -Trigger $daily -Principal $principal -Settings $settings -Description 'Collect PU with the local signed-in profile and publish validated public activity data to GitHub Pages daily at 09:00 local time.' -Force | Out-Null
Get-ScheduledTask -TaskName 'SanjiangRadar-PU-AutoPublish' | Select-Object TaskName, State
