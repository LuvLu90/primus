<p align="center"><img src="assets/logo.png" alt="乾元 Primus logo" width="160" /></p>

# 乾元（Primus）

面向所有人的桌面 Agent 应用。用户选择一个项目目录，用自然语言让 Agent 读代码、改代码、跑命令、查问题。

- Agent 的全部能力来自 **Agent Core**（上游开源 Agent 内核源码，位于 `agent-core/`）
- 桌面端负责界面、进程管理、配置与打包
- 首发平台：**Windows 11 x64**，随后 macOS、Linux
- 交付形态：一个 **MSI** 安装包（WiX 7，x64 / ARM64），按机器安装；附带按需启动的更新服务，应用内静默升级（ADR 0007）

> 完整设计见 [docs/技术方案-V5.3.md](docs/技术方案-V5.3.md)。参与开发（包括 AI 编码 Agent）前请先读 [AGENTS.md](AGENTS.md)。

## 架构

```
前端 WebView2（Next.js + React）
    │  Tauri invoke / Channel（16ms 合批）
    ▼
薄壳 Primus.exe（Tauri 2 / Rust）—— 进程监管 · 数据目录 · 凭证 · 文件监听 · 更新
    │  stdin / stdout JSONL（每个运行中的会话一个 Core 进程，默认上限 4）
    ▼
node.exe agent-core/rpc-entry.js + 第一方扩展 primus-bundle.js
```

| 组件 | 技术 | 职责 |
|---|---|---|
| 前端 | Next.js 16（静态导出）、React 19.3、TypeScript 7、Tailwind 4、Radix UI、zustand 5 | 全部界面；用户操作 → RPC 命令；RPC 事件 → 时间线 |
| 薄壳 | Tauri 2.12、Rust 1.99.1、tokio、rusqlite、windows-rs | 进程监管、JSONL 转发、数据目录、凭证（DPAPI）、文件监听、托盘、更新 |
| Agent Core | `agent-core/` 源码构建的 JS 产物 + 内置 Node.js 24 LTS | Agent 循环、模型调用、工具、会话、压缩、技能、MCP |
| 第一方扩展 | TypeScript，打包为 `primus-bundle.js` | 守卫、检查点、子 Agent、计划模式等 |


## 目录结构

```
primus/
├─ apps/desktop/
│  ├─ src/                 前端（Next.js 静态导出）
│  │  ├─ app/              App Router 页面（全部客户端组件）
│  │  ├─ stores/           zustand 全局 store 与会话 store
│  │  ├─ lib/platform/     平台接口：tauri/ 与 mock/ 两套实现
│  │  ├─ features/         chat、sessions、context、changes、files、plan、settings、capabilities、usage
│  │  ├─ rpc/              RPC 客户端、事件归并、流式消息重建
│  │  ├─ components/       通用组件
│  │  └─ workers/          Shiki、Markdown
│  └─ src-tauri/           薄壳（Rust）
│     ├─ src/              supervisor、rpc_bridge、job、paths、core_config、vault、
│     │                    session_index、fs_watch、git、shell_detect、tray、updater、platform
│     ├─ update-service/   更新服务 PrimusUpdate（LocalSystem，静默安装已验签的新版 MSI）
│     ├─ windows/          Primus.wxs（WiX 7）、WebView2 引导程序、安装目录 ACL 与 NSIS 迁移脚本
│     ├─ icons/            应用与安装包图标（由 assets/logo.png 生成，见 assets/README.md）
│     ├─ capabilities/     Tauri 权限声明
│     └─ tauri.conf.json
├─ packages/
│  ├─ extensions/          第一方 Core 扩展 → primus-bundle.js
│  ├─ protocol/            RPC 与 primus:* 数据的 TS 类型
│  └─ ui/                  共享 UI 组件
├─ agent-core/             Agent Core 完整源码（git subtree 引入，当前 v1.4.0；改动见 agent-core/PATCHES.md）
├─ e2e/                    WebdriverIO + tauri-driver
├─ assets/                项目 logo 源图（logo.png，1024×1024 透明 PNG）
├─ scripts/                build-core.mjs、检查脚本、MSI 构建脚本
└─ docs/                   技术方案、ADR、用户手册
```

## 开发环境

| 工具 | 版本 |
|---|---|
| Node.js | 24.22.1 LTS（见 `.node-version`） |
| pnpm | 12.15.0 |
| Rust | 1.99.1（见 `rust-toolchain.toml`） |
| WiX Toolset | 7.0.0（仅 Windows，打包 MSI 时需要） |
| 系统 | Windows 11 x64 + MSVC 生成工具 + WebView2 |

所有依赖锁定精确版本，只用最新**稳定版**；Renovate 每月提交一次升级 PR。

## 常用命令

```bash
pnpm install --frozen-lockfile   # 安装依赖
pnpm dev:web                     # 浏览器预览前端（mock 平台 + 假 Core 事件流，无需 Rust/Windows）
pnpm dev                         # Tauri 开发模式（数据目录为仓库下 .dev-data/）
pnpm build:core                  # 构建 Agent Core（npm ci + 锁定模型目录 + 离线构建），组装 dist/agent-core 与 dist/runtime
pnpm smoke:core                  # Agent Core RPC 冒烟：发送 get_state 应收到 response
pnpm smoke:core:dist             # 同上，跑组装好的 dist/（先按 manifest 校验；Windows 上用 dist/runtime/node.exe）
pnpm build:extensions            # 构建第一方扩展 → dist/agent-core/extensions/primus-bundle.js
pnpm build                       # 完整构建 Primus.exe（不打包）
pnpm lint                        # Biome
pnpm test                        # Vitest
cargo nextest run                # Rust 单测（在 apps/desktop/src-tauri 下）
```

## CI 与依赖升级

- GitHub Actions（`.github/workflows/ci.yml`）：每次推送 `dev` / `main` 与每个指向 `main` 的 PR，先在 Linux 上做版本基线检查、lint、单测、前端构建，并构建 Core、组装 `dist/` 后用当前 node 冒烟；再在 Windows（MSVC、Rust 1.99.1、Node 24 LTS、pnpm 12、WiX 7）上分 x64（`windows-2025`）与 ARM64（`windows-11-arm`）两个作业，各自用 `build-msi.mjs --arch` 编译 `Primus.exe` 与 `PrimusUpdate.exe` 并构建 MSI（上传为制品 `primus-installers-windows-x64` / `-arm64`），`scripts/check-installers.ps1` 核对文件名、大小、MSI 平台、更新服务与 exe 架构，再用 `scripts/msi-smoke.ps1` 静默安装、检查布局并卸载，用 `scripts/update-service-smoke.ps1` 以普通用户身份经更新服务静默升级到两个更高版本的测试 MSI，并用 `dist/runtime/node.exe` 冒烟 `dist/agent-core`、检查 `node.exe` 官方签名。Windows 作业依赖 Linux 检查通过后才启动；`pnpm check:forbidden-sdk` 检查依赖图、导入图（从前端、扩展与 Core 入口实际遍历）与 CycloneDX SBOM（`pnpm build:sbom`）中的被禁 SDK，构建后以 `--strict` 再查一遍并做负向自检（规则在 `scripts/forbidden-sdk.json`，第 6.2 节）。
- 发布（`.github/workflows/release.yml`）：推送 `v*` 标签时在 Windows x64 与 ARM64 运行器上分别构建该标签的 MSI（先校验标签与 `tauri.conf.json` 版本一致；SBOM、被禁 SDK 检查、安装包检查与静默安装 / 卸载冒烟照常运行），两个架构都成功后发布到 GitHub Releases。附件只有 2 个安装包：`Primus_<ver>_<x64|arm64>_zh-CN.msi`，SHA-256 写在正文的「校验」表。只有含预发布标识（含 `-`）的版本标为预发布，正式版设为 Latest。Release 不存在则创建（正文为自动生成的变更说明加已知限制、安装包说明与校验表）；已存在则覆盖同名附件（失败回滚）、删除不在清单中的旧附件、更新正文校验表并按上述规则更正预发布 / Latest。也可手动触发（`workflow_dispatch`，输入已有标签，例如 `v0.0.1`；标签中须已有多架构打包脚本）。Node/pnpm、Rust、WiX 与依赖安装与 CI 的 Windows 作业共用 composite action `.github/actions/setup-windows-build`；发布构建不使用缓存，第三方 action 固定到提交 SHA。
- Renovate（`renovate.json`）：每月 1 日把纳入 Renovate 的稳定版升级合成一个 PR 提到 `dev`，锁定精确版本；`agent-core/` 不在升级范围内（随上游版本手动同步）；需要在 GitHub 上为本仓库安装 Renovate 应用。

### Core 产物与内置运行时（dist/）

`pnpm build:core` 在构建 Core 之后组装两个目录（不入库，`dist/` 已在 `.gitignore` 中），分别对应 MSI 的 `-bindpath core=dist/agent-core`、`runtime=dist/runtime`：

```
dist/
├─ agent-core/                 → <安装目录>\resources\agent-core\
│  ├─ rpc-entry.js / cli.js    转发入口（薄壳启动 rpc-entry.js）
│  ├─ package.json             Core 运行时读取的名称、版本与品牌配置（已去掉构建期字段）
│  ├─ manifest.json            每个文件的大小与 SHA-256、Core 与外部模块上游版本、内置运行时信息
│  ├─ LICENSE                  Core 上游 MIT 许可（agent-core/LICENSE 原样复制，计入 manifest）
│  ├─ dist/bundle/             esbuild 打包产物（沿用 Core 包内目录结构，Core 据此定位资源）
│  ├─ dist/core/export-html/   会话导出模板
│  ├─ node_modules/            仅运行时必需的外部模块文件：photon-node、jiti、quickjs-wasi
│  └─ extensions/              pnpm build:extensions 写入（不计入 manifest）
└─ runtime/                    → <安装目录>\resources\runtime\
   ├─ node.exe                 Node.js LTS 官方 win-x64 / win-arm64 运行时（按 --platform，保留 OpenJS 签名）
   └─ LICENSE
```

- 运行时版本与哈希锁定在 `scripts/node-runtime.json`（版本须与基线一致，`check-versions.mjs` 校验）：下载 nodejs.org 官方 zip，先与官方 `SHASUMS256.txt` 交叉核对、再校验仓库里固化的 zip 哈希，只解出 `node.exe` 与 `LICENSE` 并逐个校验哈希；npm、文档、示例不打包。下载缓存在 `node_modules/.cache/primus-runtime/`。
- `--skip-build` 只用已有构建产物重新组装；`--platform current` 不下载运行时（非 Windows 本地调试用，冒烟改用当前 node）。例：`pnpm build:core --skip-build --platform current`。
- `node.exe` 的 Authenticode 签名在 Windows CI 上用 `Get-AuthenticodeSignature` 检查；CI 会上传 `dist/` 产物（保留 7 天），可拿到干净的 Windows 上直接 `runtime\node.exe agent-core\rpc-entry.js` 验收。

安装包：`node scripts/build-core.mjs --platform win-<arch> && pnpm build:extensions && node scripts/build-msi.mjs --arch <arch>`（`<arch>` 为 `x64` 或 `arm64`，默认 x64；仅 Windows，需 WiX 7 .NET 工具与 UI、Util 扩展），输出 `out/Primus_<ver>_<arch>_zh-CN.msi`，流程见 `scripts/build-msi.mjs` 与技术方案第 3.3 节；`scripts/msi-smoke.ps1` 做静默安装 / 卸载冒烟，`scripts/update-service-smoke.ps1` 做更新服务静默升级冒烟（ADR 0007）。

## 路线图

| 阶段 | 周期 | 内容 | 验收 |
|---|---|---|---|
| P0 打通 | 第 1–4 周 | 工程骨架、Core 引入与构建、RPC 进程监管、单会话对话、数据目录、MSI 可安装 | 干净 Windows 11 上 MSI 安装并完成一次真实对话，数据全部在 `<安装目录>\data` |
| P1 核心 | 第 5–12 周 | 多会话与索引、工具卡片、确认框、账号登录与模型配置下发、Vault、上下文条与压缩（Core 内置）、primus-guard、检查点回滚、变更视图、设置、Shell 检测 | 10 个真实项目试用；危险操作都会触发确认 |
| P2 完善 | 第 13–18 周 | 子 Agent、计划模式与待办、能力中心、会话树、用量统计、自动更新、诊断包、性能达标 | 内部发布 1.0（Windows） |
| P3 跨平台 | 第 19–24 周 | macOS、Linux 打包与适配 | 三平台发布 |

## 许可

作者保留所有权力。
