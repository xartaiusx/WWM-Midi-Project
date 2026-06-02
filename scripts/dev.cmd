@echo off
setlocal

set "REPO_ROOT=%~dp0.."
set "DEV_TOOLS=%REPO_ROOT%\.dev-tools"
set "RUSTUP_HOME=%DEV_TOOLS%\rustup"
set "CARGO_HOME=%DEV_TOOLS%\cargo"

set "PATH=%ProgramFiles%\Git\cmd;%LocalAppData%\Programs\Git\cmd;%DEV_TOOLS%\node;%CARGO_HOME%\bin;%PATH%"

if "%~1"=="" (
  git --version
  node --version
  npm --version
  cargo --version
  echo.
  echo Usage: .\scripts\dev.cmd ^<command^> [args...]
  echo Examples:
  echo   .\scripts\dev.cmd npm test
  echo   .\scripts\dev.cmd npm run build
  echo   .\scripts\dev.cmd npm run tauri-dev
  exit /b 0
)

%*
exit /b %ERRORLEVEL%
