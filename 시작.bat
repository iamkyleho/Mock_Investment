@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required. Install it from https://nodejs.org
  pause
  exit /b 1
)
echo Open http://localhost:4173 in your browser.
node scripts/serve.mjs
pause
