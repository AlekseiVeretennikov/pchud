@echo off
REM Сборка одного .exe. Требует установленного Python и зависимостей.
pip install -r requirements.txt pyinstaller
pyinstaller --noconfirm --onefile --windowed --name PC-HUD ^
  --add-data "web;web" ^
  --add-data "config.example.json;." ^
  backend\main.py
echo.
echo Готово: dist\PC-HUD.exe
pause
