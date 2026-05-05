@echo off
setlocal EnableExtensions
title Navio — launcher
cd /d "%~dp0"

REM ── Repo path for matching only THIS app’s Electron (avoids killing VS Code, Discord, etc.)
set "NAVIO_ROOT=%~dp0"
if "%NAVIO_ROOT:~-1%"=="\" set "NAVIO_ROOT=%NAVIO_ROOT:~0,-1%"

REM ── Stop a previous Navio dev instance that still holds the profile lock.
REM Uses PowerShell so we match the real command line (window title is "Navio", not "Navio Browser").
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "& { $root = [Environment]::GetEnvironmentVariable('NAVIO_ROOT'); if (-not $root) { return }; $r = $root.ToLowerInvariant(); Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -and $_.CommandLine.ToLowerInvariant().Contains($r) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } }" 2>nul
timeout /t 1 /nobreak >nul

REM ── Clear V8 Code Cache only (fresh JS bytecode). Does NOT delete history, bookmarks, or settings.
set "NAVIO_CACHE=%APPDATA%\navio-browser\Code Cache"
if exist "%NAVIO_CACHE%" (
  rmdir /s /q "%NAVIO_CACHE%" 2>nul
)

REM ── Double-click uses a minimal PATH — verify Node/npm before a silent failure.
where node >nul 2>&1
if errorlevel 1 (
  echo [Navio] "node" was not found in PATH.
  echo Install Node.js from https://nodejs.org/ or add it to your user PATH, then run this again.
  pause
  exit /b 1
)
where npm >nul 2>&1
if errorlevel 1 (
  echo [Navio] "npm" was not found in PATH.
  echo Reinstall Node.js ^(includes npm^) or fix PATH, then run this again.
  pause
  exit /b 1
)

if not exist "%~dp0package.json" (
  echo [Navio] package.json not found next to launch.bat:
  echo   %~dp0
  echo Move launch.bat to the Navio project root ^(same folder as package.json^).
  pause
  exit /b 1
)

echo [Navio] Starting from: %CD%
echo [Navio] This window shows npm/Electron logs. You can minimize it while Navio runs.
echo.

REM Same console as double-click — errors are visible ^(no blank, no instant exit^).
call npm start
if errorlevel 1 (
  echo.
  echo [Navio] npm start failed. See messages above.
  pause
  exit /b 1
)
exit /b 0
