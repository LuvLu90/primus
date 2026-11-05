#!/usr/bin/env python3
"""生成 apps/desktop/src-tauri/icons/icon.ico：黑色线稿标志放在白色圆角底上。

icon.ico 编进 Primus.exe，桌面快捷方式、开始菜单与安装程序都显示它；深色桌面上透明底的黑色线稿看不清，
所以只给它加白色底。其余 PNG / icns 图标仍是 `tauri icon assets/logo.png` 生成的透明底线稿。
用法（仓库根目录，在 tauri icon 之后执行）：python3 scripts/render-app-icon.py
"""
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
SIZES = [16, 24, 32, 48, 64, 256]
S = 4  # 超采样倍数


def tile(src: Image.Image, n: int) -> Image.Image:
    size = n * S
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    pad = max(S, int(size * 0.02))
    # 白色圆角底，外加很淡的灰色描边，白色桌面上也看得出边界
    d.rounded_rectangle(
        [pad, pad, size - 1 - pad, size - 1 - pad],
        radius=int(size * 0.22),
        fill=(255, 255, 255, 255),
        outline=(0, 0, 0, 40),
        width=max(S, int(size * 0.012)),
    )
    mark = int(size * 0.72)
    logo = src.resize((mark, mark), Image.LANCZOS)
    img.alpha_composite(logo, ((size - mark) // 2, (size - mark) // 2))
    return img.resize((n, n), Image.LANCZOS)


def main() -> None:
    src = Image.open(ROOT / "assets/logo.png").convert("RGBA")
    images = [tile(src, n) for n in SIZES]
    images[-1].save(
        ROOT / "apps/desktop/src-tauri/icons/icon.ico",
        format="ICO",
        sizes=[(n, n) for n in SIZES],
        append_images=images[:-1],
    )


if __name__ == "__main__":
    main()
