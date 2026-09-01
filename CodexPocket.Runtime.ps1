function Resolve-PocketCommandPath {
    param([string]$Value)

    if ([string]::IsNullOrWhiteSpace($Value)) {
        return $null
    }

    if (Test-Path -LiteralPath $Value -PathType Leaf) {
        return (Resolve-Path -LiteralPath $Value).Path
    }

    $command = Get-Command $Value -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $command) {
        return $null
    }
    if ($command.Source -and (Test-Path -LiteralPath $command.Source -PathType Leaf)) {
        return (Resolve-Path -LiteralPath $command.Source).Path
    }
    return $null
}

function Get-PocketPathEntries {
    $values = @(
        $env:Path,
        [Environment]::GetEnvironmentVariable('Path', 'User'),
        [Environment]::GetEnvironmentVariable('Path', 'Machine')
    )
    $seen = @{}
    foreach ($value in $values) {
        if ([string]::IsNullOrWhiteSpace($value)) {
            continue
        }
        foreach ($entry in $value.Split([IO.Path]::PathSeparator)) {
            $entry = [Environment]::ExpandEnvironmentVariables($entry.Trim().Trim('"'))
            if ([string]::IsNullOrWhiteSpace($entry)) {
                continue
            }
            $key = $entry.ToLowerInvariant()
            if (-not $seen.ContainsKey($key)) {
                $seen[$key] = $true
                $entry
            }
        }
    }
}

function Resolve-PocketPython {
    param([string]$ConfiguredPath)

    $candidates = @()
    foreach ($value in @($ConfiguredPath, $env:POCKET_PYTHON)) {
        $path = Resolve-PocketCommandPath $value
        if ($path) {
            $candidates += [pscustomobject]@{ Command = $path; Prefix = @() }
        }
    }

    foreach ($spec in @(
        @{ Name = 'py.exe'; Prefix = @('-3') },
        @{ Name = 'python.exe'; Prefix = @() },
        @{ Name = 'python3.exe'; Prefix = @() }
    )) {
        $path = Resolve-PocketCommandPath $spec.Name
        if ($path) {
            $candidates += [pscustomobject]@{
                Command = $path
                Prefix = @($spec.Prefix)
            }
        }
    }
    foreach ($directory in Get-PocketPathEntries) {
        foreach ($name in @('py.exe', 'python.exe', 'python3.exe')) {
            $path = Join-Path $directory $name
            if (Test-Path -LiteralPath $path -PathType Leaf) {
                $prefix = @()
                if ($name -ieq 'py.exe') {
                    $prefix = @('-3')
                }
                $candidates += [pscustomobject]@{
                    Command = $path
                    Prefix = $prefix
                }
            }
        }
    }

    $seen = @{}
    $probe = 'import sys; print(sys.executable); print(*sys.version_info[:3])'
    foreach ($candidate in $candidates) {
        $key = ([string]$candidate.Command).ToLowerInvariant() + '|' +
            [string]::Join(' ', @($candidate.Prefix))
        if ($seen.ContainsKey($key)) {
            continue
        }
        $seen[$key] = $true

        $arguments = @($candidate.Prefix) + @('-c', $probe)
        try {
            $output = @(& $candidate.Command @arguments 2>$null)
            $exitCode = $LASTEXITCODE
        } catch {
            continue
        }
        if ($exitCode -ne 0) {
            continue
        }

        $lines = @($output | ForEach-Object { ([string]$_).Trim() } | Where-Object { $_ })
        if ($lines.Count -lt 2) {
            continue
        }
        $executable = $lines[$lines.Count - 2]
        $versionParts = @($lines[$lines.Count - 1] -split '\s+')
        if ($versionParts.Count -ne 3) {
            continue
        }

        try {
            $version = [Version]([string]::Join('.', $versionParts))
        } catch {
            continue
        }
        if ($version -lt [Version]'3.8') {
            continue
        }
        if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) {
            continue
        }

        $executable = (Resolve-Path -LiteralPath $executable).Path
        return [pscustomobject]@{
            Command = $executable
            Prefix = @()
            Display = $executable
            Version = $version.ToString()
        }
    }

    throw 'Python 3.8 or newer was not found. Install Python, then run setup again.'
}

function Resolve-PocketNode {
    param([string]$ConfiguredPath)

    $candidateValues = @($ConfiguredPath, $env:NODE_BIN)
    $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($nodeCommand) {
        $candidateValues += $nodeCommand.Source
    }
    foreach ($directory in Get-PocketPathEntries) {
        $candidateValues += Join-Path $directory 'node.exe'
    }
    if ($env:NVM_SYMLINK) {
        $candidateValues += Join-Path $env:NVM_SYMLINK 'node.exe'
    }
    if ($env:ProgramFiles) {
        $candidateValues += Join-Path $env:ProgramFiles 'nodejs\node.exe'
    }
    $localAppData = [Environment]::GetFolderPath('LocalApplicationData')
    if ($localAppData) {
        $candidateValues += Join-Path $localAppData 'Programs\nodejs\node.exe'
        $candidateValues += Join-Path $localAppData 'Volta\bin\node.exe'
        $candidateValues += Join-Path $localAppData 'Microsoft\WinGet\Links\node.exe'
    }
    $profileDirectory = [Environment]::GetFolderPath('UserProfile')
    if ($profileDirectory) {
        $candidateValues += Join-Path $profileDirectory '.volta\bin\node.exe'
        $candidateValues += Join-Path $profileDirectory 'scoop\apps\nodejs\current\node.exe'
    }

    $seen = @{}
    foreach ($value in $candidateValues) {
        $path = Resolve-PocketCommandPath $value
        if (-not $path) {
            continue
        }
        $key = $path.ToLowerInvariant()
        if ($seen.ContainsKey($key)) {
            continue
        }
        $seen[$key] = $true

        try {
            $versionText = [string](& $path --version 2>$null)
            $exitCode = $LASTEXITCODE
            $version = [Version]$versionText.Trim().TrimStart('v')
        } catch {
            continue
        }
        if ($exitCode -ne 0 -or $version.Major -lt 20) {
            continue
        }
        return [pscustomobject]@{
            Path = $path
            Version = $version.ToString()
        }
    }

    throw 'Node.js 20 or newer was not found. Install Node.js, then run setup again.'
}

function Resolve-PocketCodex {
    param([string]$ConfiguredPath)

    $candidateValues = @($ConfiguredPath, $env:CODEX_BIN)
    foreach ($name in @('codex.cmd', 'codex.exe', 'codex')) {
        $command = Get-Command $name -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($command) {
            $candidateValues += $command.Source
        }
    }
    foreach ($directory in Get-PocketPathEntries) {
        foreach ($name in @('codex.cmd', 'codex.exe', 'codex')) {
            $candidateValues += Join-Path $directory $name
        }
    }

    $appData = [Environment]::GetFolderPath('ApplicationData')
    if ($appData) {
        $candidateValues += Join-Path $appData 'npm\codex.cmd'
    }

    $seen = @{}
    foreach ($value in $candidateValues) {
        $path = Resolve-PocketCommandPath $value
        if (-not $path) {
            continue
        }

        $extension = [IO.Path]::GetExtension($path)
        if ($extension -ieq '.ps1' -or [string]::IsNullOrWhiteSpace($extension)) {
            $replacement = $null
            foreach ($candidateExtension in @('.cmd', '.exe')) {
                $sibling = [IO.Path]::ChangeExtension($path, $candidateExtension)
                if (Test-Path -LiteralPath $sibling -PathType Leaf) {
                    $replacement = (Resolve-Path -LiteralPath $sibling).Path
                    break
                }
            }
            if (-not $replacement) {
                continue
            }
            $path = $replacement
        }

        $key = $path.ToLowerInvariant()
        if (-not $seen.ContainsKey($key)) {
            $seen[$key] = $true
            return $path
        }
    }

    $localAppData = [Environment]::GetFolderPath('LocalApplicationData')
    if ($localAppData) {
        $codexDirectory = Join-Path $localAppData 'OpenAI\Codex\bin'
        if (Test-Path -LiteralPath $codexDirectory -PathType Container) {
            $bundled = Get-ChildItem -LiteralPath $codexDirectory -Filter codex.exe -File -Recurse |
                Sort-Object LastWriteTime -Descending |
                Select-Object -First 1
            if ($bundled) {
                return $bundled.FullName
            }
        }
    }

    throw 'Codex CLI or the Codex App runtime was not found. Install or open Codex, then retry.'
}

function Get-PocketWindowedPython {
    param([Parameter(Mandatory = $true)][string]$PythonPath)

    $directory = Split-Path -Parent $PythonPath
    $baseName = [IO.Path]::GetFileNameWithoutExtension($PythonPath)
    foreach ($name in @($baseName + 'w.exe', 'pythonw.exe')) {
        $candidate = Join-Path $directory $name
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            return (Resolve-Path -LiteralPath $candidate).Path
        }
    }
    return $null
}

function Read-PocketRuntimeConfig {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return $null
    }
    try {
        $json = [IO.File]::ReadAllText($Path, [Text.Encoding]::UTF8)
        return $json | ConvertFrom-Json
    } catch {
        return $null
    }
}

function Get-PocketRuntimePath {
    param(
        [object]$Config,
        [Parameter(Mandatory = $true)][string]$Component
    )

    if ($null -eq $Config) {
        return $null
    }
    $componentProperty = $Config.PSObject.Properties[$Component]
    if ($null -eq $componentProperty -or $null -eq $componentProperty.Value) {
        return $null
    }
    $pathProperty = $componentProperty.Value.PSObject.Properties['Path']
    if ($null -eq $pathProperty) {
        return $null
    }
    return [string]$pathProperty.Value
}

function Write-PocketRuntimeConfig {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][object]$Python,
        [Parameter(Mandatory = $true)][object]$Node,
        [Parameter(Mandatory = $true)][string]$Codex
    )

    $directory = Split-Path -Parent $Path
    New-Item -ItemType Directory -Force -Path $directory | Out-Null
    $config = [ordered]@{
        SchemaVersion = 1
        UpdatedAt = (Get-Date).ToString('o')
        Python = [ordered]@{
            Path = [string]$Python.Command
            Version = [string]$Python.Version
        }
        Node = [ordered]@{
            Path = [string]$Node.Path
            Version = [string]$Node.Version
        }
        Codex = [ordered]@{
            Path = $Codex
        }
    }

    $json = $config | ConvertTo-Json -Depth 5
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    $temporaryPath = $Path + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
    try {
        [IO.File]::WriteAllText($temporaryPath, $json, $utf8)
        Move-Item -LiteralPath $temporaryPath -Destination $Path -Force
    } finally {
        Remove-Item -LiteralPath $temporaryPath -Force -ErrorAction SilentlyContinue
    }
}
