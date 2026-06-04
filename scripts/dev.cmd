@echo off
setlocal

set "REPO_ROOT=%~dp0.."
set "DEV_TOOLS=%REPO_ROOT%\.dev-tools"
set "RUSTUP_HOME=%DEV_TOOLS%\rustup"
set "CARGO_HOME=%DEV_TOOLS%\cargo"
set "BUN_WINGET=%LocalAppData%\Microsoft\WinGet\Packages\Oven-sh.Bun_Microsoft.Winget.Source_8wekyb3d8bbwe\bun-windows-x64"
set "BUN_HOME=%UserProfile%\.bun\bin"

set "PATH=%ProgramFiles%\Git\cmd;%LocalAppData%\Programs\Git\cmd;%DEV_TOOLS%\node;%CARGO_HOME%\bin;%BUN_HOME%;%BUN_WINGET%;%PATH%"

set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if exist "%VSWHERE%" (
  for /f "usebackq tokens=*" %%i in (`"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do (
    set "VS_INSTALL=%%i"
  )
)
if defined VS_INSTALL if exist "%VS_INSTALL%\Common7\Tools\VsDevCmd.bat" (
  call "%VS_INSTALL%\Common7\Tools\VsDevCmd.bat" -arch=x64 -host_arch=x64 >nul
)

if "%~1"=="" goto :usage

%*
exit /b %ERRORLEVEL%

:usage
call git --version
call node --version
call npm --version
call cargo --version
echo.
echo Usage: .\scripts\dev.cmd ^<command^> [args...]
echo Examples:
echo   .\scripts\dev.cmd npm test
echo   .\scripts\dev.cmd npm run build
echo   .\scripts\dev.cmd npm run tauri-dev
echo   .\scripts\dev.cmd scripts\audio-to-midi.cmd status
exit /b 0
