@echo off
chcp 65001 >nul
title cosmetics-reg stop
REM localhost:3010 (cosmetics-reg 서버)을 점유한 프로세스를 종료.
REM run-quiet.vbs 로 창 없이 띄운 서버를 깔끔히 내릴 때 사용.
set "FOUND="
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3010" ^| findstr LISTENING') do (
    taskkill /F /PID %%a >nul 2>nul
    set "FOUND=1"
)
if defined FOUND (
    echo cosmetics-reg 서버를 종료했습니다.
) else (
    echo 실행 중인 cosmetics-reg 서버가 없습니다.
)
timeout /t 2 >nul
