#!/usr/bin/env python3
"""由 assets/logo.png 生成桌面应用的全部图标：白色方形底铺满整个画布（无圆角、无透明边）+ 黑色线稿标志。

- 所有尺寸都是同一个黑色线稿标志，占画布约 94%。
- 128 px 以下先按尺寸加粗线条再缩小，64 px 以下再提高对比度，任务栏 / 标题栏的小图标线条也是黑的、不发灰。
白底铺满，在浅色与深色桌面、任务栏上都清楚。

输出：src-tauri/icons 下的 icon.ico（编进 Primus.exe：窗口 / 任务栏 / 桌面快捷方式 / 开始菜单 / 安装程序）、
各尺寸 PNG、icon.icns、app-icon.png，以及 src/app/icon.png（浏览器预览的标签页图标）。
用法（仓库根目录）：python3 scripts/render-app-icon.py
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
ICONS = ROOT / "apps/desktop/src-tauri/icons"
BG = (255, 255, 255, 255)
FG = (0, 0, 0, 255)
STROKE = 520  # 线条加粗系数：MaxFilter 核约为 STROKE / 目标尺寸（像素，原图 1024 px 上）
ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256]


def load_mark() -> Image.Image:
    """标志的线条蒙版（裁成正方形）"""
    alpha = Image.open(ROOT / "assets/logo.png").convert("RGBA").split()[3]
    alpha = alpha.point(lambda v: 255 if v > 100 else 0)
    x0, y0, x1, y1 = alpha.getbbox()
    side = max(x1 - x0, y1 - y0) + 16
    cx, cy = (x0 + x1) // 2, (y0 + y1) // 2
    return alpha.crop((cx - side // 2, cy - side // 2, cx + side // 2, cy + side // 2))


def base(size: int) -> tuple[Image.Image, ImageDraw.ImageDraw]:
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, size - 1, size - 1], fill=BG)
    return img, d


def paste_glyph(img: Image.Image, mask: Image.Image) -> None:
    glyph = Image.new("RGBA", mask.size, FG)
    glyph.putalpha(mask)
    img.alpha_composite(glyph, ((img.width - mask.width) // 2, (img.height - mask.height) // 2))


def odd(n: float) -> int:
    k = max(1, int(n))
    return k if k % 2 else k + 1


def line_art(mark: Image.Image, n: int) -> Image.Image:
    """各尺寸统一的黑色线稿；128 px 以下按尺寸加粗线条，缩小后线条仍清楚"""
    ss = 4
    img, _ = base(n * ss)
    m = int(n * ss * 0.94)
    src = mark.filter(ImageFilter.MaxFilter(odd(STROKE / n))) if n < 128 else mark
    paste_glyph(img, src.resize((m, m), Image.LANCZOS))
    out = img.resize((n, n), Image.LANCZOS)
    if n < 64:
        # 小尺寸提高对比度：半灰的抗锯齿像素压向黑或白，线条不发灰
        r, g, b, a = out.split()
        r = g = b = r.point(lambda v: max(0, min(255, int((v - 128) * 1.8 + 128))))
        out = Image.merge("RGBA", (r, g, b, a))
    return out




def main() -> None:
    mark = load_mark()
    cache: dict[int, Image.Image] = {}

    def icon(n: int) -> Image.Image:
        if n not in cache:
            cache[n] = line_art(mark, n)
        return cache[n]

    pngs = {
        "32x32.png": 32,
        "64x64.png": 64,
        "128x128.png": 128,
        "128x128@2x.png": 256,
        "icon.png": 512,
        "app-icon.png": 1024,
        "StoreLogo.png": 50,
        "Square30x30Logo.png": 30,
        "Square44x44Logo.png": 44,
        "Square71x71Logo.png": 71,
        "Square89x89Logo.png": 89,
        "Square107x107Logo.png": 107,
        "Square142x142Logo.png": 142,
        "Square150x150Logo.png": 150,
        "Square284x284Logo.png": 284,
        "Square310x310Logo.png": 310,
    }
    for name, n in pngs.items():
        icon(n).save(ICONS / name, optimize=True)
    icon(256).save(ROOT / "apps/desktop/src/app/icon.png", optimize=True)

    # ICO 的每个尺寸都单独绘制（不让 Windows 从 256 px 缩小），小尺寸才清楚
    largest = icon(ICO_SIZES[-1])
    largest.save(
        ICONS / "icon.ico",
        format="ICO",
        sizes=[(n, n) for n in ICO_SIZES],
        append_images=[icon(n) for n in ICO_SIZES[:-1]],
    )
    icon(1024).save(ICONS / "icon.icns", format="ICNS")


if __name__ == "__main__":
    main()
