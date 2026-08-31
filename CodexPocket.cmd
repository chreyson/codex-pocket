@echo off
setlocal
cd /d "%~dp0"

set "POCKET_PYTHON=python"
set "POCKET_PYTHONW="
where py >nul 2>nul
if not errorlevel 1 (
  set "POCKET_PYTHON=py -3"
  where pyw >nul 2>nul
  if not errorlevel 1 set "POCKET_PYTHONW=pyw -3"
) else (
  where python >nul 2>nul
  if errorlevel 1 goto :missing_python
  where pythonw >nul 2>nul
  if not errorlevel 1 set "POCKET_PYTHONW=pythonw"
)

%POCKET_PYTHON% -c "import webview" >nul 2>nul
if errorlevel 1 (
  echo Codex Pocket is preparing the WebView2 desktop interface...
  %POCKET_PYTHON% -m pip install --disable-pip-version-check -r requirements-desktop.txt
  if errorlevel 1 (
    echo.
    echo Unable to install the WebView2 desktop dependency.
    echo Run: %POCKET_PYTHON% -m pip install -r requirements-desktop.txt
    pause
    exit /b 1
  )
)

if defined POCKET_PYTHONW (
  start "" %POCKET_PYTHONW% "%~dp0desktop_host.py"
  exit /b 0
)

%POCKET_PYTHON% "%~dp0desktop_host.py"
exit /b %errorlevel%

:missing_python
echo Python 3 is required.
pause
exit /b 1
