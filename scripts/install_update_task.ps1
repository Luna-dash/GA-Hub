param(
    [Parameter(Mandatory=$true)][string]$Helper,
    [string]$AdminData = (Join-Path $env:USERPROFILE '.genericagent-admin')
)
$ErrorActionPreference = 'Stop'
$AdminData = [IO.Path]::GetFullPath($AdminData)
$source = (Resolve-Path -LiteralPath $Helper).Path
$bin = Join-Path $AdminData 'updates\bin'
New-Item -ItemType Directory -Force -Path $bin | Out-Null
$installed = Join-Path $bin 'ga-hub-update.exe'
if ($source -ne $installed) { Copy-Item -LiteralPath $source -Destination $installed -Force }
$sha = [Security.Cryptography.SHA256]::Create()
try {
    $bytes = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($AdminData.ToLowerInvariant()))
    $suffix = ([BitConverter]::ToString($bytes)).Replace('-','').ToLowerInvariant().Substring(0,12)
} finally { $sha.Dispose() }
$name = 'GAHub-Update-' + $suffix
$action = New-ScheduledTaskAction -Execute $installed -Argument ('--admin-data "' + $AdminData + '" worker') -WorkingDirectory $bin
$principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
# No time trigger: only an explicit request may wake this fixed worker.
Register-ScheduledTask -TaskName $name -Action $action -Principal $principal -Settings $settings -Force | Out-Null
$task = Get-ScheduledTask -TaskName $name
if ($task.Actions.Execute -ne $installed -or $task.Triggers) { throw 'Fixed worker registration mismatch' }
Write-Output ('Installed ' + $name + ' -> ' + $installed)
