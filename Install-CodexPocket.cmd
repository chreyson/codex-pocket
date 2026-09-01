@echo off
setlocal
cd /d "%~dp0"
title Codex Pocket Setup

set "POCKET_POWERSHELL=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%POCKET_POWERSHELL%" (
  echo Windows PowerShell was not found.
  goto :failed
)

set "POCKET_FIREWALL_ARGUMENT=-SkipFirewall"
"%POCKET_POWERSHELL%" -NoProfile -Command "$identity = [Security.Principal.WindowsIdentity]::GetCurrent(); $principal = New-Object Security.Principal.WindowsPrincipal($identity); if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { exit 0 }; exit 1" >nul 2>nul
if not errorlevel 1 (
  set "POCKET_FIREWALL_ARGUMENT="
  echo Administrator mode: outbound Cloudflare rules will be configured.
) else (
  echo Standard mode: no firewall settings will be changed.
)
echo.

"%POCKET_POWERSHELL%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0Setup-CodexPocket.ps1" %POCKET_FIREWALL_ARGUMENT% -Start
if errorlevel 1 goto :failed

echo.
echo Setup completed. Codex Pocket is starting.
exit /b 0

:failed
echo.
echo Setup failed. Review the error above or .data\setup-result.json.
if not defined CODEX_POCKET_NO_PAUSE pause
exit /b 1
