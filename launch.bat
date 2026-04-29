@echo off
title Navio Browser
cd /d "%~dp0"

REM Kill any stale Electron process from this project that might hold the profile lock.
REM This only kills processes whose path contains this project folder.
taskkill /F /FI "IMAGENAME eq electron.exe" /FI "WINDOWTITLE eq Navio Browser" >nul 2>&1
timeout /t 1 /nobreak >nul

REM Clear Electron V8 code cache so every launch picks up the latest JS source files.
REM This folder stores compiled bytecode — when stale it silently runs old code.
REM Settings, API keys, browsing history, and all other user data are left untouched.
set "NAVIO_CACHE=%APPDATA%\navio-browser\Code Cache"
if exist "%NAVIO_CACHE%" (
  rmdir /s /q "%NAVIO_CACHE%" 2>nul
)

start "" npm start
