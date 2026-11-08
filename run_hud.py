"""Точка входа для сборки .exe (PyInstaller запускает файл как скрипт, а backend.main
использует относительные импорты внутри пакета)."""

from backend.main import main

if __name__ == "__main__":
    main()
