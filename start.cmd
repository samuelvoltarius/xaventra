@echo off
rem Xaventra starten (Windows, Doppelklick): Core ohne Neubau, danach die Desktop-App.
rem Beim allerersten Start legt der Core selbst eine sichere Grundkonfiguration an;
rem die Desktop-App zeigt dann den Ersten Start (hoechstens drei Fragen).
setlocal
cd /d "%~dp0"
if not exist "dist\daemon.js" (
  echo Xaventra ist noch nicht installiert. Bitte zuerst install.cmd doppelklicken.
  pause
  exit /b 1
)
start "Xaventra Core" /min node dist\daemon.js
if exist "desktop\node_modules\.bin\electron.cmd" (
  start "" "desktop\node_modules\.bin\electron.cmd" "desktop"
) else (
  echo Die Desktop-App fehlt. install.cmd installiert sie mit.
  pause
)
