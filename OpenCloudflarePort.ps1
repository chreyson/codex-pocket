#Requires -RunAsAdministrator
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$program = Join-Path $projectRoot '.tools\cloudflared.exe'
$dataDirectory = Join-Path $projectRoot '.data'
$resultPath = Join-Path $dataDirectory 'firewall-result.json'

New-Item -ItemType Directory -Force -Path $dataDirectory | Out-Null

try {
    if (-not (Test-Path -LiteralPath $program -PathType Leaf)) {
        $installed = Get-Command cloudflared.exe -ErrorAction SilentlyContinue
        if ($installed) {
            $program = $installed.Source
        } else {
            throw "cloudflared.exe was not found at $program or on PATH"
        }
    }
    $program = (Resolve-Path -LiteralPath $program).Path

    $specs = @(
        @{ Name = 'Codex Pocket - Cloudflare Tunnel UDP 7844'; Protocol = 'UDP'; RemotePort = 7844 },
        @{ Name = 'Codex Pocket - Cloudflare Tunnel TCP 7844'; Protocol = 'TCP'; RemotePort = 7844 },
        @{ Name = 'Codex Pocket - Cloudflare HTTPS TCP 443'; Protocol = 'TCP'; RemotePort = 443 }
    )

    foreach ($spec in $specs) {
        $rule = Get-NetFirewallRule -DisplayName $spec.Name -ErrorAction SilentlyContinue
        if ($rule) {
            $rule | Set-NetFirewallRule -Enabled True -Direction Outbound -Action Allow -Profile Any
            $rule | Get-NetFirewallApplicationFilter | Set-NetFirewallApplicationFilter -Program $program
            $rule | Get-NetFirewallPortFilter | Set-NetFirewallPortFilter -Protocol $spec.Protocol -LocalPort Any -RemotePort $spec.RemotePort
        } else {
            New-NetFirewallRule `
                -DisplayName $spec.Name `
                -Group 'Codex Pocket' `
                -Direction Outbound `
                -Action Allow `
                -Program $program `
                -Protocol $spec.Protocol `
                -RemotePort $spec.RemotePort `
                -Profile Any | Out-Null
        }
    }

    $rules = foreach ($spec in $specs) {
        $rule = Get-NetFirewallRule -DisplayName $spec.Name
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

    [pscustomobject]@{
        Ok = $true
        UpdatedAt = (Get-Date).ToString('o')
        Rules = @($rules)
    } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $resultPath -Encoding UTF8
} catch {
    [pscustomobject]@{
        Ok = $false
        UpdatedAt = (Get-Date).ToString('o')
        Error = $_.Exception.Message
    } | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath $resultPath -Encoding UTF8
    throw
}
