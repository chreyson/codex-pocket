$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $projectRoot
. (Join-Path $projectRoot 'CodexPocket.Runtime.ps1')
$config = Read-PocketRuntimeConfig (Join-Path $projectRoot '.data\runtime.json')
$node = Resolve-PocketNode (Get-PocketRuntimePath $config 'Node')
$env:Path = (Split-Path -Parent $node.Path) + ';' + ((Get-PocketPathEntries) -join ';')
$env:CODEX_BIN = Resolve-PocketCodex (Get-PocketRuntimePath $config 'Codex')
& $node.Path (Join-Path $projectRoot 'scripts/shared-codex.mjs') --open-app
exit $LASTEXITCODE
