# 图标来源与许可（NOTICE）

本目录有两组图标：界面图标（`<Icon>` / `iconHtml`，单色）与彩色文件类型图标（`<FileIcon>` / `fileIconHtml`，见文末“文件类型图标”一节）。

界面图标的图形来自 **Reicon**（https://reicon.dev ，GitHub `dqev/reicon`，作者 Dev Chauhan），以 **MIT 许可**发布，许可证全文见同目录 `LICENSE-reicon`（GitHub 仓库 LICENSE 署名 “Copyright (c) 2025 REICON”，官网许可页署名 “Copyright (c) 2025 Dev Chauhan”）。

- 收录版本：npm 包 `reicon-react` 1.2.6 的 Outline 字重（24px 网格），只取 SVG 图形数据；**没有把 Reicon 作为依赖**。
- 生成方式：`scripts/vendor-reicon.mjs` 读取解压后的 tarball，校验颜色只为 `currentColor` / `none`、线宽 1.5，生成 `icons.generated.ts`（提交生成结果，不提交下载的包）。
- 本项目的改动：去掉整幅 24×24 的 clipPath；`sidebar-right` 为 `Sidebar2` 的水平镜像；`loader` 为 `Loader` 的水平镜像（保留源图形各段的 opacity 渐隐，使顺时针旋转时拖尾在后）；`<Icon>` 在小尺寸下按尺寸给线条加粗，使各尺寸渲染线宽一致（约 1.25px）。
- Reicon 官网于 2026 年 10 月底公告可能在一两个月内停止运营（https://reicon.dev/notice）；已发布的 npm 包仍以 MIT 提供。图形已收录在仓库中，不依赖其网站或 CDN。

## 第三方署名

Reicon 官网许可页说明其基础图形来自：

- **Solar Icons**，480 Design 设计（https://www.figma.com/community/file/1166831539721848736 ），**CC BY 4.0**（https://creativecommons.org/licenses/by/4.0/ ）与 MIT。下表中“Solar 对应”一列是与 Solar 图标集（`@iconify-json/solar`）路径数据逐字一致的图标；这些图形按 CC BY 4.0 要求在此署名，本项目对其的改动见上文。
- **Zappicon**（https://zappicon.com ，适用 Zappicon License）。Reicon 未逐个注明哪些图形源自 Zappicon；下表中“未能对应”的图标无法确定来源。

## 图标清单

| 名称 | Reicon 源图标 | Solar 对应 |
|---|---|---|
| check | Check | 未能对应（Reicon 未注明来源） |
| x | Xmark | 未能对应（Reicon 未注明来源） |
| plus | Plus | 未能对应（Reicon 未注明来源） |
| minus | Minus | 未能对应（Reicon 未注明来源） |
| copy | Copy | Solar `copy-outline` |
| search | Search | Solar `magnifier-outline` |
| trash | Trash2 | Solar `trash-bin-2-outline` |
| pen | Pen | Solar `pen-outline` |
| compose | PenSquare | Solar `pen-new-square-outline` |
| download | Download | Solar `download-outline` |
| more | MoreH | Solar `menu-dots-outline` |
| arrow-up | ArrowUp | Solar `arrow-up-outline` |
| chevron-down | ChevronDown | 未能对应（Reicon 未注明来源） |
| chevron-left | ChevronLeft | 未能对应（Reicon 未注明来源） |
| chevron-right | ChevronRight | 未能对应（Reicon 未注明来源） |
| maximize | Maximize | Solar `maximize-outline` |
| minimize | Minimize | Solar `minimize-outline` |
| stop | Stop（Filled） | Solar `stop-bold` |
| refresh | Refresh | Solar `refresh-outline` |
| retry | Restart | Solar `restart-outline` |
| archive | Archive | 未能对应（Reicon 未注明来源） |
| archive-restore | ArchiveUp | 未能对应（Reicon 未注明来源） |
| pin | Thumbtack | Solar `pin-outline` |
| mic | Microphone | 未能对应（Reicon 未注明来源） |
| link | Link | 未能对应（Reicon 未注明来源） |
| external-link | ArrowUpRightSquare | 未能对应（Reicon 未注明来源） |
| alert-circle | AlertCircle | Solar `danger-circle-outline` |
| check-circle | CheckCircle | Solar `check-circle-outline` |
| x-circle | XCircle | Solar `close-circle-outline` |
| stop-circle | StopCircle | Solar `stop-circle-outline` |
| ban | ForbiddenCircle | Solar `forbidden-circle-outline` |
| activity | Graph | Solar `graph-outline` |
| wifi-off | WifiOff | 未能对应（Reicon 未注明来源） |
| key | Key | Solar `key-outline` |
| gauge | Speedometer | 未能对应（Reicon 未注明来源） |
| server | Server | Solar `server-outline` |
| ask | ChatRoundDots | Solar `chat-round-dots-outline` |
| shield-check | ShieldCheck | Solar `shield-check-outline` |
| shield-alert | ShieldAlert | Solar `shield-warning-outline` |
| shield-user | ShieldUser | Solar `shield-user-outline` |
| sidebar-left | Sidebar2 | Solar `panel-right-outline` |
| sidebar-right | Sidebar2（水平镜像） | Solar `panel-right-outline` |
| settings | Gear | 未能对应（Reicon 未注明来源） |
| tuning | Tuning2 | Solar `tuning-2-outline` |
| user | User | Solar `user-outline` |
| chart | Chart | Solar `chart-outline` |
| puzzle | Puzzle | 未能对应（Reicon 未注明来源） |
| list-check | ListCheck | Solar `list-check-outline` |
| file-tree | DiagramTree | 未能对应（Reicon 未注明来源） |
| diff | PlusMinus | Solar `plus-minus-outline` |
| logs | ClipboardList | Solar `clipboard-list-outline` |
| git-branch | Hierarchy2 | 未能对应（Reicon 未注明来源） |
| terminal | Programming | Solar `programming-outline` |
| tool | Sledgehammer | Solar `sledgehammer-outline` |
| thinking | Sparkles | 未能对应（Reicon 未注明来源） |
| pen-edit | Pen2 | Solar `pen-2-outline` |
| file-text | FileText | Solar `file-text-outline` |
| folder | Folder2 | 未能对应（Reicon 未注明来源） |
| folder-open | FolderOpen | Solar `folder-open-outline` |
| loader | Loader（水平镜像，保留逐段渐隐） | 未能对应（Reicon 未注明来源） |
| window-maximize | Stop3 | 未能对应（Reicon 未注明来源） |
| window-restore | Copy3 | 未能对应（Reicon 未注明来源） |

## 文件类型图标（彩色）

`file-icons.generated.ts` 的图形来自 **Material Icon Theme**（https://github.com/material-extensions/vscode-material-icon-theme ，VS Code 的 Material 文件图标主题），以 **MIT 许可**发布，许可证全文见同目录 `LICENSE-material-icon-theme`（“Copyright (c) 2025 Material Extensions”）。

- 收录版本：npm 包 `material-icon-theme` 5.40.0 的 `icons/*.svg`，只取 SVG 图形数据；**没有把它作为依赖**。
- 生成方式：`scripts/vendor-file-icons.mjs` 读取解压后的 tarball，生成 `file-icons.generated.ts`（提交生成结果，不提交下载的包）。
- 本项目的改动：颜色不写死，换成 `globals.css` 里按 Material 调色板命名的 `--color-file-*` 设计令牌（浅色下加深 `blue-grey-100`，深色下提亮 `light-blue-900`、`vue-navy`）；去掉不可见的占位矩形。
- 这是图标规范里唯一允许多色的一组：`pnpm check:icons` 对这个文件只放行 `var(--color-file-*)`，其余颜色仍按单色规则检查。
- 扩展名到图标的对应在 `features/chat/file-ref.ts`（`fileIconForName`）。

| 名称 | Material Icon Theme 源文件 |
|---|---|
| file / folder | `file.svg` / `folder.svg` |
| typescript / react-ts / javascript / react / json | `typescript.svg` / `react_ts.svg` / `javascript.svg` / `react.svg` / `json.svg` |
| html / css / sass / vue / svelte | `html.svg` / `css.svg` / `sass.svg` / `vue.svg` / `svelte.svg` |
| python / rust / go / java / c / cpp / csharp | 同名 `.svg` |
| swift / php / ruby / lua / dart / scala | 同名 `.svg` |
| console / powershell / xml / yaml / toml / settings | 同名 `.svg` |
| database / graphql / docker / makefile / git / diff / lock | 同名 `.svg` |
| markdown / document / log / readme / license / tex | 同名 `.svg` |
| word / table / powerpoint / pdf | 同名 `.svg` |
| image / svg / video / audio / font / zip / exe | 同名 `.svg` |
