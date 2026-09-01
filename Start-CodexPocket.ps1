[CmdletBinding()]
param([switch]$Check)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$runtimeHelpersPath = Join-Path $projectRoot 'CodexPocket.Runtime.ps1'
$runtimeConfigPath = Join-Path $projectRoot '.data\runtime.json'
$requirementsPath = Join-Path $projectRoot 'requirements-desktop.txt'
$desktopHostPath = Join-Path $projectRoot 'desktop_host.py'

try {
    if (-not (Test-Path -LiteralPath $runtimeHelpersPath -PathType Leaf)) {
        throw "Missing runtime helper: $runtimeHelpersPath"
    }
    . $runtimeHelpersPath

    $config = Read-PocketRuntimeConfig $runtimeConfigPath
    $python = Resolve-PocketPython (Get-PocketRuntimePath $config 'Python')
    $node = Resolve-PocketNode (Get-PocketRuntimePath $config 'Node')
    $codex = Resolve-PocketCodex (Get-PocketRuntimePath $config 'Codex')

    Write-PocketRuntimeConfig `
        -Path $runtimeConfigPath `
        -Python $python `
        -Node $node `
        -Codex $codex

    $env:NODE_BIN = $node.Path
    $env:CODEX_BIN = $codex

    $webviewReady = $false
    try {
        & $python.Command -c 'import webview' 2>$null
        $webviewReady = ($LASTEXITCODE -eq 0)
    } catch {
        $webviewReady = $false
    }
    if (-not $webviewReady) {
        Write-Host 'Codex Pocket is preparing the WebView2 desktop interface...'
        & $python.Command `
            -m pip install `
            --disable-pip-version-check `
            -r $requirementsPath
        if ($LASTEXITCODE -ne 0) {
            throw "Unable to install desktop dependencies with $($python.Command)."
        }
    }

    if ($Check) {
        Write-Host "Python: $($python.Command) ($($python.Version))"
        Write-Host "Node.js: $($node.Path) ($($node.Version))"
        Write-Host "Codex: $codex"
        exit 0
    }

    $pythonw = Get-PocketWindowedPython $python.Command
    if ($pythonw) {
        $argument = '"' + $desktopHostPath + '"'
        Start-Process `
            -FilePath $pythonw `
            -ArgumentList $argument `
            -WorkingDirectory $projectRoot
        exit 0
    }

    & $python.Command $desktopHostPath
    exit $LASTEXITCODE
} catch {
    Write-Error $_
    exit 1
}
