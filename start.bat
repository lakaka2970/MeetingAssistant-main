@echo off
rem One-click launcher (developer build): rebuild, then run the app.
rem - Always rebuilds so the app always reflects the latest source (~1-2s).
rem - Clears ELECTRON_RUN_AS_NODE: if that var leaks in, electron.exe runs as
rem   plain Node and crashes with "electron.app is undefined".
cd /d "%~dp0"
set "ELECTRON_RUN_AS_NODE="

if not exist node_modules (
  echo First run: installing dependencies...
  call npm install
  if errorlevel 1 (
    echo npm install failed. See the output above.
    pause
    exit /b 1
  )
)

echo Building...
call npm run build
if errorlevel 1 (
  echo Build failed. See the output above.
  pause
  exit /b 1
)

start "" "%~dp0node_modules\electron\dist\electron.exe" .
