"""Режим (тёмный/светлый) и цвет акцента Windows — для темы «Windows 11».

Читаем те же значения, что задаются в «Параметры → Персонализация → Цвета»:
  HKCU\\...\\Themes\\Personalize   AppsUseLightTheme — 1 светлый режим приложений, 0 тёмный;
  HKCU\\...\\Explorer\\Accent      AccentPalette — 8 оттенков акцента (RGBA), от светлого к тёмному;
  HKCU\\Software\\Microsoft\\Windows\\DWM  AccentColor — запасной вариант (0xAABBGGRR).
Windows 11 на тёмном фоне рисует акцент светлым оттенком, на светлом — тёмным; так и отдаём.
"""

from __future__ import annotations

try:
    import winreg
except ImportError:          # не Windows
    winreg = None

PERSONALIZE = r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize"
ACCENT = r"Software\Microsoft\Windows\CurrentVersion\Explorer\Accent"
DWM = r"Software\Microsoft\Windows\DWM"

# синий Windows 11 по умолчанию: оттенок для тёмного и для светлого режима
DEFAULT = {"dark": "#4cc2ff", "light": "#005fb8"}


def _value(path: str, name: str):
    if winreg is None:
        return None
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, path) as key:
            return winreg.QueryValueEx(key, name)[0]
    except OSError:
        return None


def _hex(r: int, g: int, b: int) -> str:
    return f"#{r:02x}{g:02x}{b:02x}"


def system_theme() -> dict:
    """{"light": bool, "accent_dark": "#rrggbb", "accent_light": "#rrggbb"}."""
    light = _value(PERSONALIZE, "AppsUseLightTheme")
    out = {"light": light == 1, "accent_dark": DEFAULT["dark"], "accent_light": DEFAULT["light"]}
    palette = _value(ACCENT, "AccentPalette")
    if isinstance(palette, (bytes, bytearray)) and len(palette) >= 32:
        shades = [_hex(*palette[i * 4:i * 4 + 3]) for i in range(8)]
        # 0–2 светлые, 3 основной, 4–6 тёмные (как в «Параметрах»)
        out["accent_dark"], out["accent_light"] = shades[1], shades[4]
        return out
    color = _value(DWM, "AccentColor")
    if isinstance(color, int):
        r, g, b = color & 0xFF, (color >> 8) & 0xFF, (color >> 16) & 0xFF
        out["accent_dark"] = out["accent_light"] = _hex(r, g, b)
    return out


if __name__ == "__main__":
    print(system_theme())
