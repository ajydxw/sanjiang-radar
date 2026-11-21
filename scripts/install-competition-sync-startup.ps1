$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node -ErrorAction Stop).Source
$runner = Join-Path $PSScriptRoot 'sync-pu-to-pages.mjs'
if (-not (Test-Path -LiteralPath $runner)) { throw 'Competition sync runner is missing.' }
$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$command = '& ''' + $node.Replace("'", "''") + ''' ''' + $runner.Replace("'", "''") + ''' --competitions; exit $LASTEXITCODE'
$encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
$action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand $encoded" -WorkingDirectory $project
$now = Get-Date
$triggers = foreach ($hour in @(9, 17)) {
    $at = $now.Date.AddHours($hour).AddMinutes(20)
    if ($at -le $now) { $at = $at.AddDays(1) }
    New-ScheduledTaskTrigger -Daily -At $at
}
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 25) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$task = 'SanjiangRadar-Competition-AutoPublish'
Register-ScheduledTask -TaskName $task -Action $action -Trigger $triggers -Principal $principal -Settings $settings -Description 'Refresh public Tianchi competition notices for Sanjiang Radar.' -Force | Out-Null
Get-ScheduledTask -TaskName $task | Select-Object TaskName, State
