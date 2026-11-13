@echo off
setlocal
REM Production launcher: daemon-only mode, no packaged exe, no tools-dev.
REM Mirrors deploy/Dockerfile CMD: node apps/daemon/dist/cli.js (auto-opens browser).
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [error] node not found in PATH. Install Node 24 first.
  pause
  exit /b 1
)

if not exist "apps\daemon\dist\cli.js" (
  echo [build] daemon dist missing, building...
  call pnpm --filter @open-design/daemon build
  if errorlevel 1 (
    echo [error] daemon build failed.
    pause
    exit /b 1
  )
)

if not exist "apps\web\out\index.html" (
  echo [build] web static export missing, building...
  call pnpm --filter @open-design/web build
  if errorlevel 1 (
    echo [error] web build failed.
    pause
    exit /b 1
  )
)

echo [run] starting daemon at http://127.0.0.1:7456 (browser opens automatically)
node apps\daemon\dist\cli.js
echo [exit] daemon stopped.
pause
