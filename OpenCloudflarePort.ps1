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
        throw "cloudflared.exe was not found at $program"
    }

    $specs = @(
        @{ Name = 'Codex Pocket - Cloudflare Tunnel TCP 7844'; Protocol = 'TCP' },
        @{ Name = 'Codex Pocket - Cloudflare Tunnel UDP 7844'; Protocol = 'UDP' }
    )

    foreach ($spec in $specs) {
        $rule = Get-NetFirewallRule -DisplayName $spec.Name -ErrorAction SilentlyContinue
        if ($rule) {
            $rule | Set-NetFirewallRule -Enabled True -Direction Outbound -Action Allow -Profile Any
            $rule | Get-NetFirewallApplicationFilter | Set-NetFirewallApplicationFilter -Program $program
            $rule | Get-NetFirewallPortFilter | Set-NetFirewallPortFilter -Protocol $spec.Protocol -LocalPort Any -RemotePort 7844
        } else {
            New-NetFirewallRule `
                -DisplayName $spec.Name `
                -Group 'Codex Pocket' `
                -Direction Outbound `
                -Action Allow `
                -Program $program `
                -Protocol $spec.Protocol `
                -RemotePort 7844 `
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
