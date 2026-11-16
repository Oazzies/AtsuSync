$ErrorActionPreference = 'Stop'

$cmdScript = Join-Path $PSScriptRoot 'start-server.cmd'

if (-not (Test-Path $cmdScript)) {
  throw "Could not find $cmdScript"
}

$baseKey = 'HKCU:\Software\Classes\atsusync'
$iconKey = Join-Path $baseKey 'DefaultIcon'
$cmdKey = Join-Path $baseKey 'shell\open\command'

New-Item -Path $baseKey -Force | Out-Null
Set-ItemProperty -Path $baseKey -Name '(Default)' -Value 'URL:AtsuSync Protocol'
Set-ItemProperty -Path $baseKey -Name 'URL Protocol' -Value ''

New-Item -Path $iconKey -Force | Out-Null
Set-ItemProperty -Path $iconKey -Name '(Default)' -Value 'cmd.exe,0'

New-Item -Path $cmdKey -Force | Out-Null
$commandValue = "cmd.exe /c start `"AtsuSync Server`" cmd.exe /c `"`"$cmdScript`"`""
Set-ItemProperty -Path $cmdKey -Name '(Default)' -Value $commandValue

Write-Host "Registered atsusync:// protocol handler -> $cmdScript"
