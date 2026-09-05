@echo off
title Nova OS - Daemon
echo ============================================
echo   Nova OS - Starting Daemon
echo ============================================
echo.

cd /d "%~dp0"

:: Build first
echo [1/3] Building TypeScript...
call npm run build
if errorlevel 1 (
    echo [ERROR] Build failed!
    pause
    exit /b 1
)
echo [OK] Build complete.
echo.

:: Kill existing instance if running
echo [2/3] Checking for existing Nova process...
for /f "tokens=2" %%a in ('tasklist /fi "WINDOWTITLE eq Nova OS*" /fo list ^| findstr PID') do (
    echo Stopping existing Nova (PID %%a)...
    taskkill /PID %%a /F >nul 2>&1
)
timeout /t 2 /nobreak >nul

:: Start Nova
echo [3/3] Starting Nova daemon...
echo.
node dist/daemon.js
