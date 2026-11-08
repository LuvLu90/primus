# 图标来源与许可（NOTICE）

本目录的图标图形来自 **Reicon**（https://reicon.dev ，GitHub `dqev/reicon`，作者 Dev Chauhan），以 **MIT 许可**发布，许可证全文见同目录 `LICENSE-reicon`（GitHub 仓库 LICENSE 署名 “Copyright (c) 2025 REICON”，官网许可页署名 “Copyright (c) 2025 Dev Chauhan”）。

- 收录版本：npm 包 `reicon-react` 1.2.6 的 Outline 字重（24px 网格），只取 SVG 图形数据；**没有把 Reicon 作为依赖**。
- 生成方式：`scripts/vendor-reicon.mjs` 读取解压后的 tarball，校验颜色只为 `currentColor` / `none`、线宽 1.5，生成 `icons.generated.ts`（提交生成结果，不提交下载的包）。
- 本项目的改动：去掉整幅 24×24 的 clipPath；`sidebar-right` 为 `Sidebar2` 的水平镜像；`file-sheet` 在 `File` 上叠加 2×2 表格线；`<Icon>` 在小尺寸下按尺寸给线条加粗，使各尺寸渲染线宽一致（约 1.25px）。
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
| mic | Mic | Solar `microphone-outline` |
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
| hand | Hand | 未能对应（Reicon 未注明来源） |
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
| thinking | Lightbulb | 未能对应（Reicon 未注明来源） |
| pen-edit | Pen2 | Solar `pen-2-outline` |
| file | File | Solar `file-outline` |
| file-text | FileText | Solar `file-text-outline` |
| file-doc | FileContent | 未能对应（Reicon 未注明来源） |
| file-code | CodeFile | Solar `file-code-outline` |
| file-pdf | FilePdf | 未能对应（Reicon 未注明来源） |
| file-zip | FileZip | 未能对应（Reicon 未注明来源） |
| file-image | Gallery | Solar `gallery-outline` |
| file-video | Video | 未能对应（Reicon 未注明来源） |
| file-slides | Presentation | Solar `presentation-graph-outline` |
| file-sheet | File + 表格线 | Solar `file-outline`（表格线为本项目添加） |
| folder | Folder | 未能对应（Reicon 未注明来源） |
| folder-open | FolderOpen | Solar `folder-open-outline` |
| window-maximize | Stop3 | 未能对应（Reicon 未注明来源） |
| window-restore | Copy3 | 未能对应（Reicon 未注明来源） |
