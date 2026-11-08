@echo off
REM Builds dist\PC-HUD.exe: one file, no Python needed on the target PC.
chcp 65001 >nul
cd /d "%~dp0"
set PY=python
if exist ".venv\Scripts\python.exe" set PY=.venv\Scripts\python.exe
"%PY%" -m pip install -r requirements.txt pyinstaller || goto :fail
"%PY%" -m PyInstaller --noconfirm --onefile --windowed --name PC-HUD ^
  --add-data "web;web" ^
  --add-data "config.example.json;." ^
  run_hud.py || goto :fail
echo.
echo Done: dist\PC-HUD.exe
pause
exit /b 0
:fail
echo.
echo Build failed, see the messages above.
pause
exit /b 1
