@echo off
rem Starts IG Unsend. Installs what it needs the first time.
cd /d "%~dp0"
if not exist node_modules (
  echo Installing, this happens only once...
  call npm install --silent || exit /b 1
)
node bin\ig-unsend.mjs
