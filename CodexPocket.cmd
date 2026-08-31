@echo off
cd /d "%~dp0"
where pyw >nul 2>nul
if %errorlevel% equ 0 (
  start "" pyw -3 "%~dp0codex_pocket.py"
  exit /b 0
)
where pythonw >nul 2>nul
if %errorlevel% equ 0 (
  start "" pythonw "%~dp0codex_pocket.py"
  exit /b 0
)
echo Python 3 with Tkinter is required.
pause
