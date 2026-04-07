@echo off
title Navio Browser
cd /d "%~dp0"

REM Clear Electron V8 code cache so every launch picks up the latest JS source files.
REM This folder stores compiled bytecode — when stale it silently runs old code.
REM Settings, API keys, and all user data in other folders are left untouched.
set "NAVIO_CACHE=%APPDATA%\navio-browser\Code Cache"
if exist "%NAVIO_CACHE%" (
  rmdir /s /q "%NAVIO_CACHE%" 2>nul
)

start "" npm start
