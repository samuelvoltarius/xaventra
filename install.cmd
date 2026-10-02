@echo off
rem Xaventra: installation per Doppelklick (Windows). Keine Adminrechte, keine
rem Systemeinstellungen, kein Dienst, keine Firewall-Regel, kein Modell-Download.
rem Gleicher Weg wie install.ps1 / install.sh: scripts\setup.mjs, hier mit Desktop-App.
setlocal
where node >nul 2>nul
if errorlevel 1 (
  echo Bitte zuerst Node.js 22 oder neuer von https://nodejs.org installieren und dann erneut doppelklicken.
  pause
  exit /b 1
)
node "%~dp0scripts\setup.mjs" --desktop %*
if errorlevel 1 (
  echo.
  echo Die Installation ist nicht fertig geworden. Die Meldung oben sagt, woran es liegt.
  pause
  exit /b 1
)
echo.
echo Fertig. Zum Starten start.cmd doppelklicken. Beim ersten Start richtet sich Xaventra selbst ein.
pause
