@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"
title cosmetics-reg installer

REM ===================================================================
REM  cosmetics-reg one-click installer (Windows)
REM
REM  다른 PC 에서 이 파일 하나만 빈 폴더에 두고 더블클릭하면:
REM    1) 프로그램을 GitHub 에서 자동 다운로드 (git 있으면 clone=자동갱신,
REM       없으면 zip 다운로드)
REM    2) start.bat 실행 -> Node 자동설치 + npm install + build + 서버 +
REM       브라우저 자동 오픈
REM  두 번째 실행부터는 start.bat 만 더블클릭하면 됩니다.
REM
REM  .bat 메시지는 ASCII(영문)로 — Windows cmd 코드페이지 문제 회피.
REM  (한글 메시지는 Node/launch.cjs 가 UTF-8 로 출력함)
REM ===================================================================

set "REPO_HTTPS=https://github.com/tim10000-alt/cosmetics-reg.git"
set "ZIP_URL=https://github.com/tim10000-alt/cosmetics-reg/archive/refs/heads/main.zip"
set "TARGET=%~dp0cosmetics-reg"

echo.
echo ==================================================
echo  cosmetics-reg installer
echo ==================================================
echo.

REM --- Already installed? just launch it ---
if exist "%TARGET%\start.bat" (
    echo Found existing install at:
    echo   %TARGET%
    echo Launching... (to reinstall, delete that folder and run again^)
    goto :launch
)

REM --- Prefer git clone (enables daily auto-update via launch.cjs) ---
where git >nul 2>nul
if not errorlevel 1 (
    echo git detected - cloning ^(enables daily auto-update^)...
    echo.
    git clone --depth 1 "%REPO_HTTPS%" "%TARGET%"
    if exist "%TARGET%\start.bat" goto :installed
    echo.
    echo git clone failed - falling back to zip download...
    echo.
)

REM --- Fallback: download zip (no git needed) ---
echo Downloading cosmetics-reg ^(~60 MB^)...
echo.
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ProgressPreference='SilentlyContinue';" ^
  "try {" ^
  "  Invoke-WebRequest -Uri '%ZIP_URL%' -OutFile 'creg.zip' -UseBasicParsing;" ^
  "  if (Test-Path '_creg_tmp') { Remove-Item -Recurse -Force '_creg_tmp' }" ^
  "  Expand-Archive -Path 'creg.zip' -DestinationPath '_creg_tmp' -Force;" ^
  "  if (Test-Path '%TARGET%') { Remove-Item -Recurse -Force '%TARGET%' }" ^
  "  Move-Item -Path '_creg_tmp\cosmetics-reg-main' -Destination '%TARGET%' -Force;" ^
  "  Remove-Item -Recurse -Force '_creg_tmp';" ^
  "  Remove-Item 'creg.zip' -Force;" ^
  "  Write-Host 'OK'" ^
  "} catch {" ^
  "  Write-Host ('FAIL: ' + $_.Exception.Message)" ^
  "}"

if not exist "%TARGET%\start.bat" (
    echo.
    echo [X] Download/extract failed.
    echo     Causes: no internet, blocked download, or antivirus.
    echo     Manual: download and unzip this, then run start.bat inside:
    echo     %ZIP_URL%
    echo.
    pause
    exit /b 1
)

:installed
echo.
echo Installed to: %TARGET%
echo.

:launch
cd /d "%TARGET%"
call start.bat
endlocal
