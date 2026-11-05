# 项目 logo

- `logo.png`：乾元 Primus 项目 logo 源图，1024×1024、RGBA 透明背景（由 4096×4096 原图缩放并无损压缩，避免仓库膨胀）。
- README 顶部、桌面应用图标、安装包图标都由这张图派生。

## 重新生成图标

换 logo 时先替换本目录的 `logo.png`，再在仓库根目录执行（Tauri CLI 版本与 `apps/desktop/package.json` 锁定的一致）：

```sh
pnpm --filter @primus/desktop exec tauri icon ../../assets/logo.png -o src-tauri/icons
rm -rf apps/desktop/src-tauri/icons/android apps/desktop/src-tauri/icons/ios
python3 scripts/render-app-icon.py   # icon.ico 改为白色圆角底 + 黑色线稿（桌面快捷方式在深色桌面上也看得清）
cp assets/logo.png apps/desktop/src-tauri/icons/app-icon.png
cp apps/desktop/src-tauri/icons/128x128@2x.png apps/desktop/src/app/icon.png
```

- `apps/desktop/src-tauri/icons/`：`icon.ico`（白色圆角底，由 `scripts/render-app-icon.py` 生成；其余图标为透明底线稿）编进 `Primus.exe`，同时是 MSI（`Primus.wxs` 的 `ARPPRODUCTICON`，“应用和功能”里的图标）与 NSIS 安装程序（`installerIcon`）的图标；其余 PNG / `icon.icns` 供 Tauri 打包与后续 macOS 使用。目前只发 Windows，不保留 Android / iOS 图标。
- `apps/desktop/src/app/icon.png`：Next.js 图标约定文件，静态导出时生成 `<link rel="icon">`（浏览器预览 `pnpm dev:web` 的标签页图标）。
