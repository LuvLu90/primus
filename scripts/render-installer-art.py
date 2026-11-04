#!/usr/bin/env python3
"""重新生成安装界面图片（apps/desktop/src-tauri/windows/art/，24 位 BMP）。

由 assets/logo.png（黑色线稿）派生，4 倍超采样后缩小，边缘平滑；文字用 Noto Sans SC 与 Inter（均为 OFL）。
用法：python3 scripts/render-installer-art.py --cjk <NotoSansSC-Medium.otf> --latin <Inter-SemiBold.ttf>
"""
import argparse
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
ART = ROOT / "apps/desktop/src-tauri/windows/art"
S = 4  # 超采样倍数
SIDEBAR_BG = (246, 246, 248)
WHITE = (255, 255, 255)
FG = (29, 29, 31)
MUTED = (110, 110, 115)


def logo(size: int) -> Image.Image:
    src = Image.open(ROOT / "assets/logo.png").convert("RGBA")
    return src.resize((size, size), Image.LANCZOS)


def canvas(w: int, h: int, bg) -> Image.Image:
    return Image.new("RGBA", (w * S, h * S), bg + (255,))


def finish(img: Image.Image, w: int, h: int, name: str) -> None:
    out = img.resize((w, h), Image.LANCZOS).convert("RGB")
    out.save(ART / name, format="BMP")


def sidebar(img: Image.Image, width: int, height: int, fonts) -> None:
    """欢迎 / 完成页左侧栏：浅灰底，标志 + 中文名 + 英文名，居中偏上。"""
    d = ImageDraw.Draw(img)
    mark = logo(76 * S)
    x = (width * S - mark.width) // 2
    y = int(height * S * 0.26)
    img.alpha_composite(mark, (x, y))
    cjk, latin = fonts
    cy = y + mark.height + 18 * S
    for text, font, color, gap in ((("乾元", cjk, FG, 6)), (("Primus", latin, MUTED, 0))):
        box = d.textbbox((0, 0), text, font=font)
        tw = box[2] - box[0]
        d.text(((width * S - tw) // 2 - box[0], cy - box[1]), text, font=font, fill=color)
        cy += (box[3] - box[1]) + gap * S


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--cjk", required=True)
    p.add_argument("--latin", required=True)
    a = p.parse_args()
    fonts = (ImageFont.truetype(a.cjk, 22 * S), ImageFont.truetype(a.latin, 13 * S))

    # NSIS 欢迎 / 完成页侧栏 164×314
    img = canvas(164, 314, SIDEBAR_BG)
    sidebar(img, 164, 314, fonts)
    finish(img, 164, 314, "nsis-sidebar.bmp")

    # MSI 欢迎 / 完成页背景 493×312：左 164 像素为侧栏，其余白色（WixUI 在右侧绘制文字）
    img = canvas(493, 312, WHITE)
    side = canvas(164, 312, SIDEBAR_BG)
    sidebar(side, 164, 312, fonts)
    img.alpha_composite(side, (0, 0))
    finish(img, 493, 312, "wix-dialog.bmp")

    # NSIS 页眉 150×57：白底，标志靠左、垂直居中（页眉文字由 NSIS 绘制在右侧）
    img = canvas(150, 57, WHITE)
    mark = logo(38 * S)
    img.alpha_composite(mark, (14 * S, (57 * S - mark.height) // 2))
    finish(img, 150, 57, "nsis-header.bmp")

    # MSI 页眉 493×58：白底，标志靠右（WixUI 在左侧绘制标题）
    img = canvas(493, 58, WHITE)
    mark = logo(38 * S)
    img.alpha_composite(mark, ((493 - 14) * S - mark.width, (58 * S - mark.height) // 2))
    finish(img, 493, 58, "wix-banner.bmp")


if __name__ == "__main__":
    main()
