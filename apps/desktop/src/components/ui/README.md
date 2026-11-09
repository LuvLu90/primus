# components/ui

按 shadcn/ui 的方式把组件源码放进仓库（技术方案第 16.1 节）。视觉采用 macOS / iOS 27 的 Liquid Glass 风格，底层是 [lore-glass](https://loreglasses.com/)（MIT，© 2026 Simon Gneuß，许可证见 `LICENSE-lore-glass`）。

## 来源与改动

导入版本：github.com/Simonstorms/lore-glass 提交 `39059eb028c6b24c56c14acd5a241410e62753de`（registry `https://loreglasses.com/r/{name}.json`）。

| 文件 | 来源 | 本项目改动 |
|------|------|------------|
| `glass.tsx` | registry `glass` | ① `noUncheckedIndexedAccess` 下补 7 处非空断言（`slotsRef.current[i]!`、`colSlope[col]!`、`key[0]!`）；② `useGlassDark` 订阅前先同步一次 `dark` 类（修复首帧到订阅之间切换主题被漏掉） |
| `glass-webgl.ts` | registry `glass` | 1 处非空断言（`key[0]!`） |
| `glass-motion.ts`、`glass-button.tsx` | registry 同名组件 | 无 |
| `glass-surface.tsx` | registry `glass-surface` | ① `backdrop` 开关（看不见背后画面时关掉 backdrop-filter）；② 尺寸连续变化（展开动画、内容到达）时不逐帧重画折射贴图：沿用旧贴图拉伸，尺寸稳定 160ms 后再生成（`MAP_SETTLE_MS`），首次与缓存命中立即使用 |
| `glass-switch.tsx`、`glass-slider.tsx` | registry 同名组件 | 强调色 `PRIMARY`（及开关焦点描边）由 `#0a84ff` 改为 `#3a3a3c`，与全局黑白灰配色一致 |
| `glass-tabs.tsx`、`glass-tooltip.tsx`、`glass-dialog.tsx`、`glass-popover.tsx` | registry 同名组件 | 无障碍原语由 `@base-ui/react` 改为本项目统一使用的 Radix UI（Tabs / Tooltip / Dialog / DropdownMenu），进出场动画改用 `globals.css` 的 `glass-pop` / `glass-fade`；`GlassTooltip` 自带 Provider |

未引入：`glass-input`（输入框是多行的，直接用 `GlassSurface` 组合）、`glass-dock`（依赖 html2canvas-pro）。`@/lib/utils` 的 `cn` 只做拼接，不引入 clsx / tailwind-merge。

上表中"无改动"的文件和 `glass.tsx`、`glass-webgl.ts` 不经 Biome 检查（见根目录 `biome.json`），以便和上游比对、升级；升级时重新下载 registry JSON，按上表重放改动。

## 使用约定

- 大面积玻璃（侧栏、检查器、设置导航）用 `components/layout/glass-panel.tsx` 的 `GlassPanel`；小控件用 `useGlassStyle()` 取当前外观下的 `tint` / `tintColor`，并加 `glassButtonClass` 描边。
- 着色程度来自外观设置（设置 → 通用 → 玻璃效果）；系统开启"减少透明度"时统一为 1。
- 时间线等长内容放在实色"纸面"上，不要给每条消息套玻璃（`backdrop-filter` 很贵，影响第 16.5 节的 60fps 目标）。
- WebView2 是 Chromium 内核，`GlassSurface` 会走 SVG 位移贴图做真实折射；其他环境自动降级为模糊 + 着色。
