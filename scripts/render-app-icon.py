#!/usr/bin/env python3
"""由 assets/logo.png 生成桌面应用的全部图标：白色满版圆角底 + 黑色标志，图形铺满画布。

- 48 px 及以上：黑色线稿标志占画布约 94%（铺满整个图标），
  48 / 64 px 先加粗线条再缩小，细线不至于糊掉。
- 20–40 px：黑色实心轮廓 + 加粗的白色内部线条（线稿在这个尺寸只剩灰点）。
- 16 px：按像素对齐画的简化立方体（六边形 + Y 形棱线），任务栏 / 标题栏小图标也清楚。
白底满版（不留透明边），黑色标志放到最大，在浅色与深色桌面、任务栏上都清楚（以前的透明底黑线稿在深色桌面上看不见）。

输出：src-tauri/icons 下的 icon.ico（编进 Primus.exe：窗口 / 任务栏 / 桌面快捷方式 / 开始菜单 / 安装程序）、
各尺寸 PNG、icon.icns、app-icon.png，以及 src/app/icon.png（浏览器预览的标签页图标）。
用法（仓库根目录）：python3 scripts/render-app-icon.py
"""
import math
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
ICONS = ROOT / "apps/desktop/src-tauri/icons"
BG = (255, 255, 255, 255)
FG = (0, 0, 0, 255)
RADIUS = 0.225  # 圆角半径占边长的比例（与 Windows 11 应用图标的圆角接近）
ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256]


def load_mark() -> tuple[Image.Image, Image.Image]:
    """标志的线条蒙版（裁成正方形）与实心轮廓蒙版"""
    alpha = Image.open(ROOT / "assets/logo.png").convert("RGBA").split()[3]
    alpha = alpha.point(lambda v: 255 if v > 100 else 0)
    x0, y0, x1, y1 = alpha.getbbox()
    side = max(x1 - x0, y1 - y0) + 16
    cx, cy = (x0 + x1) // 2, (y0 + y1) // 2
    mark = alpha.crop((cx - side // 2, cy - side // 2, cx + side // 2, cy + side // 2))
    # 实心轮廓：从外侧泛洪填充，剩下的都算标志内部
    padded = Image.new("L", (mark.width + 2, mark.height + 2), 0)
    padded.paste(mark, (1, 1))
    ImageDraw.floodfill(padded, (0, 0), 128)
    silhouette = padded.crop((1, 1, mark.width + 1, mark.height + 1)).point(
        lambda v: 0 if v == 128 else 255
    )
    return mark, silhouette


def base(size: int) -> tuple[Image.Image, ImageDraw.ImageDraw]:
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=int(size * RADIUS), fill=BG)
    return img, d


def paste_glyph(img: Image.Image, mask: Image.Image) -> None:
    glyph = Image.new("RGBA", mask.size, FG)
    glyph.putalpha(mask)
    img.alpha_composite(glyph, ((img.width - mask.width) // 2, (img.height - mask.height) // 2))


def odd(n: float) -> int:
    k = max(1, int(n))
    return k if k % 2 else k + 1


def line_art(mark: Image.Image, n: int) -> Image.Image:
    """48 px 及以上：黑色线稿"""
    ss = 4
    img, _ = base(n * ss)
    m = int(n * ss * 0.94)
    src = mark.filter(ImageFilter.MaxFilter(odd(330 / n))) if n < 128 else mark
    paste_glyph(img, src.resize((m, m), Image.LANCZOS))
    return img.resize((n, n), Image.LANCZOS)


def solid(mark: Image.Image, silhouette: Image.Image, n: int) -> Image.Image:
    """20–40 px：黑色实心轮廓，内部线条加粗后挖成白色"""
    ss = 8
    img, _ = base(n * ss)
    m = int(n * 0.94) * ss
    sil = silhouette.resize((m, m), Image.LANCZOS)
    strokes = mark.filter(ImageFilter.MaxFilter(odd(740 / n))).resize((m, m), Image.LANCZOS)
    inner = silhouette.filter(ImageFilter.MinFilter(odd(mark.width * 0.07)))
    lines = ImageChops.multiply(strokes, inner.resize((m, m), Image.LANCZOS))
    paste_glyph(img, ImageChops.subtract(sil, lines))
    return img.resize((n, n), Image.LANCZOS)


def cube(n: int) -> Image.Image:
    """16 px：像素对齐的简化立方体（六边形 + Y 形棱线）"""
    ss = 16
    size = n * ss
    img, d = base(size)
    cx, cy, r = size / 2 - ss / 2, size / 2, size * 0.48
    pts = [
        (cx + r * math.cos(math.radians(a)), cy + r * math.sin(math.radians(a)))
        for a in (-90, -30, 30, 90, 150, 210)
    ]
    # 上下两个顶点落在像素边界上，竖直棱线正好占一列像素
    for i in (0, 3):
        pts[i] = (round(pts[i][0] / ss) * ss, round(pts[i][1] / ss) * ss)
    d.polygon(pts, fill=FG)
    col = int(cx // ss) * ss
    d.rectangle([col, cy, col + ss - 1, pts[3][1]], fill=BG)
    for p in (pts[1], pts[5]):
        d.line([(col + ss / 2, cy), p], fill=BG, width=int(ss * 1.1))
    return img.resize((n, n), Image.LANCZOS)


def render(mark: Image.Image, silhouette: Image.Image, n: int) -> Image.Image:
    if n <= 16:
        return cube(n)
    if n <= 40:
        return solid(mark, silhouette, n)
    return line_art(mark, n)


def main() -> None:
    mark, silhouette = load_mark()
    cache: dict[int, Image.Image] = {}

    def icon(n: int) -> Image.Image:
        if n not in cache:
            cache[n] = render(mark, silhouette, n)
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
