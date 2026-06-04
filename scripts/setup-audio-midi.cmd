@echo off
setlocal enabledelayedexpansion

set "REPO_ROOT=%~dp0.."
set "DEV_TOOLS=%REPO_ROOT%\.dev-tools"
set "VENV=%DEV_TOOLS%\audio-midi-venv"
set "REQ=%REPO_ROOT%\tools\audio-to-wwm-midi\requirements.txt"

if not exist "%DEV_TOOLS%" mkdir "%DEV_TOOLS%"

set "PYTHON_EXE="
if exist "%LocalAppData%\Programs\Python\Python311\python.exe" set "PYTHON_EXE=%LocalAppData%\Programs\Python\Python311\python.exe"
if not defined PYTHON_EXE (
  for /f "usebackq tokens=*" %%i in (`where python 2^>nul`) do (
    if not defined PYTHON_EXE (
      "%%i" -c "import sys; raise SystemExit(0 if sys.version_info[:2] == (3, 11) else 1)" >nul 2>nul
      if !ERRORLEVEL! EQU 0 set "PYTHON_EXE=%%i"
    )
  )
)

if not defined PYTHON_EXE (
  echo Python 3.11 was not found. Installing Python 3.11 for the current user with winget...
  winget install --id Python.Python.3.11 --exact --source winget --scope user --accept-package-agreements --accept-source-agreements
  if ERRORLEVEL 1 exit /b %ERRORLEVEL%
  if exist "%LocalAppData%\Programs\Python\Python311\python.exe" set "PYTHON_EXE=%LocalAppData%\Programs\Python\Python311\python.exe"
)

if not defined PYTHON_EXE (
  echo Python 3.11 is still not available. Open a new terminal or install Python 3.11 manually.
  exit /b 1
)

echo Using Python: %PYTHON_EXE%

if not exist "%VENV%\Scripts\python.exe" (
  "%PYTHON_EXE%" -m venv "%VENV%"
  if ERRORLEVEL 1 exit /b %ERRORLEVEL%
)

"%VENV%\Scripts\python.exe" -m pip install --upgrade pip
if ERRORLEVEL 1 exit /b %ERRORLEVEL%

"%VENV%\Scripts\python.exe" -m pip install -r "%REQ%"
if ERRORLEVEL 1 exit /b %ERRORLEVEL%

echo.
echo Audio-to-MIDI tools are ready.
"%REPO_ROOT%\scripts\audio-to-midi.cmd" status
