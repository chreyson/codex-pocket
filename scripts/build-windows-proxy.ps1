param([Parameter(Mandatory=$true)][string]$OutputPath)
$ErrorActionPreference = 'Stop'
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) {
    $compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe'
}
if (-not (Test-Path -LiteralPath $compiler)) { throw '.NET Framework 4 compiler is unavailable.' }
& $compiler /nologo /target:winexe /reference:System.Web.Extensions.dll ("/out:" + $OutputPath) (Join-Path $PSScriptRoot 'windows-desktop-proxy.cs')
if ($LASTEXITCODE -ne 0) { throw 'Unable to build the native Codex desktop proxy.' }
