@echo off
chcp 65001 >nul
cd /d "%~dp0"
title cosmetics-reg

REM --- If already installed, relaunch hidden so no CMD window shows.
REM     First install stays visible (shows download/build progress).
REM     cwd is inherited by the hidden cmd, so no path is passed as an
REM     argument (works with non-ASCII / spaced folder paths).
if /i not "%~1"=="hidden" (
    if exist "out\index.html" if exist "node_modules" (
        powershell -NoProfile -Command "Start-Process cmd -ArgumentList '/c start.bat hidden' -WindowStyle Hidden"
        exit /b
    )
)

REM .bat file uses ASCII-only to avoid Windows cmd codepage issues.
REM Korean messages are emitted by Node (launch.cjs), which speaks UTF-8.
REM
REM First-run on fresh PC:
REM   1. Auto-download portable Node.js v22 (~28 MB) if not installed
REM   2. npm install (auto, ~1-2 min, ~300 MB)
REM   3. npm run build (auto, ~30 sec)
REM   4. Start localhost:3010 + open browser
REM Subsequent runs: skip 1-3, go straight to step 4.

REM Step 1: Use system Node if installed
where node >nul 2>nul
if not errorlevel 1 (
    goto :launch
)

REM Step 2: Use already-downloaded portable Node
if exist "%~dp0node-portable\node.exe" (
    set "PATH=%~dp0node-portable;%PATH%"
    goto :launch
)

REM Step 3: Download portable Node.js (no admin rights needed)
echo.
echo ==================================================
echo  First run: Node.js auto-install (~28 MB)
echo ==================================================
echo.
echo Downloading portable Node.js v22.13.1 ...
echo.

set "NODE_VERSION=v22.13.1"
set "NODE_DIST=node-%NODE_VERSION%-win-x64"
set "NODE_URL=https://nodejs.org/dist/%NODE_VERSION%/%NODE_DIST%.zip"

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "$ProgressPreference='SilentlyContinue';" ^
    "try {" ^
    "  Invoke-WebRequest -Uri '%NODE_URL%' -OutFile 'node-portable.zip' -UseBasicParsing;" ^
    "  Expand-Archive -Path 'node-portable.zip' -DestinationPath '.' -Force;" ^
    "  if (Test-Path 'node-portable') { Remove-Item -Recurse -Force 'node-portable' }" ^
    "  Move-Item -Path '%NODE_DIST%' -Destination 'node-portable' -Force;" ^
    "  Remove-Item 'node-portable.zip' -Force;" ^
    "  Write-Host 'OK'" ^
    "} catch {" ^
    "  Write-Host ('FAIL: ' + $_.Exception.Message)" ^
    "}"

if not exist "%~dp0node-portable\node.exe" (
    echo.
    echo [X] Failed to install portable Node.js automatically.
    echo     Possible causes: no internet, blocked download, antivirus.
    echo.
    echo     Manual fix: install Node.js LTS from https://nodejs.org
    echo     then run start.bat again.
    echo.
    pause
    exit /b 1
)

set "PATH=%~dp0node-portable;%PATH%"
echo.
echo Portable Node.js installed in node-portable\ folder.
echo.

:launch
node scripts\launch.cjs

REM Hidden mode: exit silently when server stops (no leftover hidden window).
if /i "%~1"=="hidden" exit /b

echo.
echo (Server stopped. Press any key to close this window.)
pause >nul
