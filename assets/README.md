# 项目 logo

- `logo.png`：乾元 Primus 项目 logo 源图，1024×1024、RGBA 透明背景（由 4096×4096 原图缩放并无损压缩，避免仓库膨胀）。
- `logo-white.png`：白色线稿版（外加一圈淡淡的深色描边，浅色背景上也看得清），**桌面应用图标、安装包图标**由它派生；README 顶部与安装界面图片仍用黑色的 `logo.png`。

## 重新生成图标

换 logo 时先替换本目录的 `logo.png`，再在仓库根目录执行（Tauri CLI 版本与 `apps/desktop/package.json` 锁定的一致）：

```sh
pnpm --filter @primus/desktop exec tauri icon ../../assets/logo-white.png -o src-tauri/icons
rm -rf apps/desktop/src-tauri/icons/android apps/desktop/src-tauri/icons/ios
cp assets/logo-white.png apps/desktop/src-tauri/icons/app-icon.png
```

- `apps/desktop/src-tauri/icons/`：`icon.ico` 编进 `Primus.exe`，同时是 MSI（`Primus.wxs` 的 `ARPPRODUCTICON`，“应用和功能”里的图标）与 NSIS 安装程序（`installerIcon`）的图标；其余 PNG / `icon.icns` 供 Tauri 打包与后续 macOS 使用。目前只发 Windows，不保留 Android / iOS 图标。
- `apps/desktop/src/app/icon.png`：Next.js 图标约定文件（浏览器标签页在浅色底上，保留黑色线稿，不随应用图标改为白色），静态导出时生成 `<link rel="icon">`（浏览器预览 `pnpm dev:web` 的标签页图标）。
