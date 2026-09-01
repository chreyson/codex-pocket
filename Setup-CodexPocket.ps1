[CmdletBinding()]
param(
    [switch]$Start,
    [switch]$SkipFirewall,
    [string]$PythonPath,
    [string]$NodePath,
    [string]$CodexPath
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$dataDirectory = Join-Path $projectRoot '.data'
$resultPath = Join-Path $dataDirectory 'setup-result.json'
$requirementsPath = Join-Path $projectRoot 'requirements-desktop.txt'
$launcherPath = Join-Path $projectRoot 'CodexPocket.cmd'
$startScriptPath = Join-Path $projectRoot 'Start-CodexPocket.ps1'
$runtimeHelpersPath = Join-Path $projectRoot 'CodexPocket.Runtime.ps1'
$runtimeConfigPath = Join-Path $dataDirectory 'runtime.json'

Set-Location -LiteralPath $projectRoot
New-Item -ItemType Directory -Force -Path $dataDirectory | Out-Null

$setupResult = [ordered]@{
    Ok = $false
    UpdatedAt = $null
    ProjectRoot = $projectRoot
    Python = $null
    Node = $null
    Codex = $null
    Cloudflared = $null
    WebView2 = $null
    Firewall = [ordered]@{
        Skipped = [bool]$SkipFirewall
        InboundRulesCreated = $false
        Rules = @()
    }
    Started = $false
    Error = $null
}

function Write-SetupResult {
    $setupResult.UpdatedAt = (Get-Date).ToString('o')
    $json = $setupResult | ConvertTo-Json -Depth 6
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($resultPath, $json, $utf8)
}

function Test-IsAdministrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Invoke-PocketPython {
    param([Parameter(Mandatory = $true)][string[]]$Arguments)

    $command = $script:pocketPython.Command
    $allArguments = @($script:pocketPython.Prefix) + $Arguments
    & $command @allArguments
    if ($LASTEXITCODE -ne 0) {
        throw "Python command failed with exit code $LASTEXITCODE."
    }
}

function Find-WebView2Runtime {
    $roots = @()
    $baseDirectories = @(
        ${env:ProgramFiles(x86)},
        $env:ProgramFiles,
        [Environment]::GetFolderPath('LocalApplicationData')
    ) | Where-Object { $_ }
    foreach ($baseDirectory in $baseDirectories) {
        $roots += Join-Path $baseDirectory 'Microsoft\EdgeWebView\Application'
    }

    foreach ($root in $roots) {
        if (-not (Test-Path -LiteralPath $root -PathType Container)) {
            continue
        }
        $runtime = Get-ChildItem -LiteralPath $root -Directory |
            Sort-Object Name -Descending |
            ForEach-Object { Join-Path $_.FullName 'msedgewebview2.exe' } |
            Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } |
            Select-Object -First 1
        if ($runtime) {
            return $runtime
        }
    }

    return $null
}

function Set-PocketFirewallRules {
    param([Parameter(Mandatory = $true)][string]$Program)

    $specs = @(
        @{ Name = 'Codex Pocket - Cloudflare Tunnel UDP 7844'; Protocol = 'UDP'; RemotePort = 7844 },
        @{ Name = 'Codex Pocket - Cloudflare Tunnel TCP 7844'; Protocol = 'TCP'; RemotePort = 7844 },
        @{ Name = 'Codex Pocket - Cloudflare HTTPS TCP 443'; Protocol = 'TCP'; RemotePort = 443 }
    )

    foreach ($spec in $specs) {
        $rules = @(Get-NetFirewallRule -DisplayName $spec.Name -ErrorAction SilentlyContinue)
        if ($rules.Count -gt 0) {
            $rules | Set-NetFirewallRule -Enabled True -Direction Outbound -Action Allow -Profile Any
            $rules | Get-NetFirewallApplicationFilter |
                Set-NetFirewallApplicationFilter -Program $Program
            $rules | Get-NetFirewallPortFilter |
                Set-NetFirewallPortFilter -Protocol $spec.Protocol -LocalPort Any -RemotePort $spec.RemotePort
        } else {
            New-NetFirewallRule `
                -DisplayName $spec.Name `
                -Group 'Codex Pocket' `
                -Description 'Allows the Codex Pocket Cloudflare tunnel to make outbound connections only.' `
                -Direction Outbound `
                -Action Allow `
                -Program $Program `
                -Protocol $spec.Protocol `
                -RemotePort $spec.RemotePort `
                -Profile Any | Out-Null
        }
    }

    $ruleResults = foreach ($spec in $specs) {
        $rule = Get-NetFirewallRule -DisplayName $spec.Name | Select-Object -First 1
        $port = $rule | Get-NetFirewallPortFilter
        $application = $rule | Get-NetFirewallApplicationFilter
        [pscustomobject]@{
            Name = $rule.DisplayName
            Enabled = [string]$rule.Enabled
            Direction = [string]$rule.Direction
            Action = [string]$rule.Action
            Protocol = [string]$port.Protocol
            RemotePort = [string]$port.RemotePort
            Program = [string]$application.Program
        }
    }

    return @($ruleResults)
}

try {
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
        throw 'This deployment script supports Windows only.'
    }
    if (-not $SkipFirewall -and -not (Test-IsAdministrator)) {
        throw 'Run PowerShell as Administrator, or pass -SkipFirewall when outbound traffic is already allowed.'
    }
    if (-not (Test-Path -LiteralPath $requirementsPath -PathType Leaf)) {
        throw "Missing dependency file: $requirementsPath"
    }
    if (-not (Test-Path -LiteralPath $launcherPath -PathType Leaf)) {
        throw "Missing launcher: $launcherPath"
    }
    if (-not (Test-Path -LiteralPath $startScriptPath -PathType Leaf)) {
        throw "Missing launcher script: $startScriptPath"
    }
    if (-not (Test-Path -LiteralPath $runtimeHelpersPath -PathType Leaf)) {
        throw "Missing runtime helper: $runtimeHelpersPath"
    }

    . $runtimeHelpersPath
    $runtimeConfig = Read-PocketRuntimeConfig $runtimeConfigPath
    $configuredPython = $PythonPath
    if ([string]::IsNullOrWhiteSpace($configuredPython)) {
        $configuredPython = Get-PocketRuntimePath $runtimeConfig 'Python'
    }
    $configuredNode = $NodePath
    if ([string]::IsNullOrWhiteSpace($configuredNode)) {
        $configuredNode = Get-PocketRuntimePath $runtimeConfig 'Node'
    }
    $configuredCodex = $CodexPath
    if ([string]::IsNullOrWhiteSpace($configuredCodex)) {
        $configuredCodex = Get-PocketRuntimePath $runtimeConfig 'Codex'
    }

    Write-Host 'Checking Python, Node.js, Codex, and WebView2...'
    $script:pocketPython = Resolve-PocketPython $configuredPython
    $node = Resolve-PocketNode $configuredNode
    $codexPath = Resolve-PocketCodex $configuredCodex
    $webView2Path = Find-WebView2Runtime
    if (-not $webView2Path) {
        throw 'Microsoft Edge WebView2 Runtime was not found. Install the Evergreen Runtime, then retry.'
    }

    $setupResult.Python = [ordered]@{
        Command = $script:pocketPython.Display
        Path = $script:pocketPython.Command
        Version = $script:pocketPython.Version
    }
    $setupResult.Node = [ordered]@{
        Path = $node.Path
        Version = $node.Version
    }
    $setupResult.Codex = [ordered]@{
        Path = $codexPath
    }
    $setupResult.WebView2 = [ordered]@{
        Path = $webView2Path
    }

    Write-Host 'Installing desktop Python dependencies...'
    Invoke-PocketPython -Arguments @(
        '-m',
        'pip',
        'install',
        '--disable-pip-version-check',
        '-r',
        $requirementsPath
    )

    Write-Host 'Preparing cloudflared...'
    $cloudflaredCode = 'from codex_pocket import ensure_cloudflared; print(ensure_cloudflared(lambda message: print(message, flush=True)))'
    $cloudflaredOutput = @(
        Invoke-PocketPython -Arguments @('-c', $cloudflaredCode) |
            ForEach-Object {
                Write-Host $_
                $_
            }
    )
    $cloudflaredPath = [string]($cloudflaredOutput |
        Where-Object { [string]$_ -and ([string]$_).Trim() } |
        Select-Object -Last 1)
    $cloudflaredPath = $cloudflaredPath.Trim()
    if (-not (Test-Path -LiteralPath $cloudflaredPath -PathType Leaf)) {
        throw "cloudflared was prepared but its executable was not found: $cloudflaredPath"
    }
    $cloudflaredPath = (Resolve-Path -LiteralPath $cloudflaredPath).Path
    $cloudflaredVersion = [string](& $cloudflaredPath --version)
    if ($LASTEXITCODE -ne 0) {
        throw 'cloudflared version verification failed.'
    }
    $setupResult.Cloudflared = [ordered]@{
        Path = $cloudflaredPath
        Version = $cloudflaredVersion.Trim()
    }

    if (-not $SkipFirewall) {
        Write-Host 'Configuring outbound Cloudflare Tunnel firewall rules...'
        $setupResult.Firewall.Rules = @(Set-PocketFirewallRules -Program $cloudflaredPath)
    } else {
        Write-Host 'Skipping firewall changes because -SkipFirewall was supplied.'
    }

    Write-PocketRuntimeConfig `
        -Path $runtimeConfigPath `
        -Python $script:pocketPython `
        -Node $node `
        -Codex $codexPath

    if ($Start) {
        Write-Host 'Starting Codex Pocket...'
        Start-Process `
            -FilePath $env:ComSpec `
            -ArgumentList @('/d', '/c', ('"{0}"' -f $launcherPath)) `
            -WorkingDirectory $projectRoot `
            -WindowStyle Hidden
        $setupResult.Started = $true
    }

    $setupResult.Ok = $true
    Write-SetupResult
    Write-Host "Setup completed. Result: $resultPath"
} catch {
    $setupResult.Error = $_.Exception.Message
    Write-SetupResult
    Write-Error $_
    exit 1
}
