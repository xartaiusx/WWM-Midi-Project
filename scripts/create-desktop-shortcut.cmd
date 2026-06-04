@echo off
setlocal

set "REPO_ROOT=%~dp0.."
powershell -NoProfile -ExecutionPolicy Bypass -File "%REPO_ROOT%\scripts\create-desktop-shortcut.ps1" %*
exit /b %ERRORLEVEL%
