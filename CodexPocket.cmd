@echo off
setlocal
cd /d "%~dp0"

set "POCKET_POWERSHELL=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%POCKET_POWERSHELL%" (
  echo Windows PowerShell was not found.
  if not defined CODEX_POCKET_NO_PAUSE pause
  exit /b 1
)

"%POCKET_POWERSHELL%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start-CodexPocket.ps1" %*
set "POCKET_EXIT_CODE=%errorlevel%"
if "%POCKET_EXIT_CODE%"=="0" exit /b 0

echo.
echo Codex Pocket failed to start. Run Setup-CodexPocket.ps1 again for diagnostics.
if not defined CODEX_POCKET_NO_PAUSE pause
exit /b %POCKET_EXIT_CODE%
