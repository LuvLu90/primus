# 项目 logo

- `logo.png`：乾元 Primus 项目 logo 源图，1024×1024、RGBA 透明背景（由 4096×4096 原图缩放并无损压缩，避免仓库膨胀）。
- README 顶部、桌面应用图标、安装包图标都由这张图派生。

## 重新生成图标

换 logo 时先替换本目录的 `logo.png`，再在仓库根目录执行（Pillow 版本锁定在 `scripts/requirements.txt`）：

```sh
python3 -m pip install -r scripts/requirements.txt   # Pillow==13.0.0
python3 scripts/render-app-icon.py   # 生成全部图标：白色方形底铺满 + 黑色线稿标志（小尺寸加粗线条）
```

- `apps/desktop/src-tauri/icons/`：全部由 `scripts/render-app-icon.py` 生成（白色方形底铺满整个画布、无圆角无透明边，各尺寸都是黑色线稿标志，小尺寸加粗线条）。`icon.ico`（16–256 px 各尺寸单独绘制）编进 `Primus.exe`，同时是 MSI（`Primus.wxs` 的 `ARPPRODUCTICON`，“应用和功能”里的图标）的图标；其余 PNG / `icon.icns` 供 Tauri 打包与后续 macOS 使用。目前只发 Windows，不保留 Android / iOS 图标。
- `apps/desktop/src/app/icon.png`：Next.js 图标约定文件，静态导出时生成 `<link rel="icon">`（浏览器预览 `pnpm dev:web` 的标签页图标）。
