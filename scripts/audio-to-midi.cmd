@echo off
setlocal

set "REPO_ROOT=%~dp0.."
call "%REPO_ROOT%\scripts\dev.cmd" node "%REPO_ROOT%\tools\audio-to-wwm-midi\wwm_audio_to_midi.mjs" %*
exit /b %ERRORLEVEL%
