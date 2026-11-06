@echo off
REM Starts PC HUD from source. Keep this console open while the HUD is running.
chcp 65001 >nul
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  echo Python environment not found: .venv
  echo Create it: python -m venv .venv
  echo Then run: .venv\Scripts\pip install -r requirements.txt
  pause
  exit /b 1
)
".venv\Scripts\python.exe" -m backend.main %*
if errorlevel 1 pause
