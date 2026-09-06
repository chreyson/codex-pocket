param([switch]$Cli, [string]$ConfiguredPath)
$ErrorActionPreference = 'Stop'
. (Join-Path (Split-Path -Parent $PSScriptRoot) 'CodexPocket.Runtime.ps1')
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
if ($Cli) { Resolve-PocketCodex $ConfiguredPath } else { Find-PocketDesktop }
