@echo off
rem ASCII-only on purpose. cmd.exe mis-seeks byte offsets in UTF-8 batch files
rem under code page 65001, which corrupts Chinese text and splits lines. All
rem logic and Chinese messages live in tools\start-check.ps1 (UTF-8 with BOM).
rem Call powershell by absolute path: it is a fixed OS location, and a broken
rem PATH must not turn the one-click launcher into a "command not found".
set "ELECTRON_RUN_AS_NODE="
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\start-check.ps1"
exit /b %ERRORLEVEL%
