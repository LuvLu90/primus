# AGENTS.md

本文件是给 AI 编码 Agent（以及新加入的开发者）的仓库工作守则。动手前先读完；与本文件冲突时，以 [docs/技术方案-V5.3.md](docs/技术方案-V5.3.md) 为准，并提出修改本文件。

## 1. 项目一句话

乾元（Primus）是 Windows 11 优先的桌面 Agent 应用：**Tauri 2 薄壳（Rust）+ Next.js 静态前端 + 内置 Node.js 运行的 Agent Core（`agent-core/` 源码构建）+ 第一方扩展**，用 WiX 7 打成一个 MSI。

## 2. 不可违反的规则

### 2.1 硬约束
- **C1 两协议**：模型端点的 `api` 只允许 `openai-responses` 与 `anthropic-messages`。不得引入任何其他供应商 SDK（Google、AWS Bedrock、Mistral 等），CI 会检查导入图与 SBOM。
- **C2 数据目录**：App 管理的一切数据（Core 配置、会话、临时文件、WebView 缓存、日志）只能写到 `<安装目录>/data`（开发模式为仓库下 `.dev-data/`）。**不得回退到 `%APPDATA%`、`~/.primus` 或用户主目录**。
- **C3 Windows 优先**：新功能先在 Windows 11 x64 上完整实现与验证；平台差异只能写在薄壳的 `platform` 模块。

### 2.2 命名
- 目录、文件、模块、命令、环境变量、界面文案一律使用 **乾元 / Primus / Core** 命名。
- **`agent-core/` 目录之外不得出现上游项目的原始名称**（代码、注释、文档、提交信息都算）。`scripts/check-naming.mjs` 在 CI 中检查。
- 环境变量前缀统一 `PRIMUS_`；扩展命令前缀 `/primus-`；扩展数据主题前缀 `primus:`。

### 2.3 Agent Core 少改
- `agent-core/` 只允许三类改动：**品牌**（名称、目录、环境变量、系统提示）、**两协议裁剪**、**构建入口**。
- 每一处改动都必须登记在 `agent-core/PATCHES.md`（改了什么、为什么、涉及文件）。
- 其他需求一律用 `packages/extensions/` 中的第一方扩展实现。桌面端只使用 Core 公开的 RPC 协议与扩展 API，不依赖其内部实现。
- 不要把 Core 编译成单文件 exe；安装包里是 JS 产物 + 官方 `node.exe`。

### 2.4 版本
- 所有依赖、工具链只用**最新稳定版**，锁定**精确版本**（`pnpm-lock.yaml`、`Cargo.lock`、`rust-toolchain.toml`）。禁止 preview / beta / rc / nightly。
- 版本基线在 `scripts/version-baseline.json`，CI 用 `pnpm check:versions` 核对；改版本时基线、清单文件、技术方案三处同步。
- 新增依赖前先确认已有依赖不能满足；不要随手升级无关依赖（升级由 Renovate 月度 PR 统一处理）。
- TypeScript 7 没有 JS 编译器 API：**不要引入** typescript-eslint、ts-morph 等依赖它的工具。规范用 Biome，打包用 esbuild，测试用 Vitest。
- Tailwind 4 用 CSS 优先配置（`@import "tailwindcss"` + `@theme`），**不要创建 `tailwind.config.js`**。

### 2.5 安全（基础版）
- 密钥绝不明文落盘：走 `vault`（DPAPI）；`models.json` 里只放取密钥的命令（`--secret provider:<渠道 ID>`）。
- 不要在代码、日志、测试快照、提交中写入任何真实密钥或证书。唯一例外：内置渠道（ioply）的密钥，只能放在 `apps/desktop/src-tauri/src/builtin.rs` 的 `BUILTIN_API_KEY` 一处（技术方案第 9.8 节、ADR 0008），不得复制到其他文件、日志、测试快照、提交说明或 PR 描述。
- 用户模型渠道的密钥只进保险库（`provider:<渠道 ID>`）：不写进 `providers.json`、`models.json`、命令行参数、环境变量与日志，返回给 WebView 的只有 `hasKey` 与末 4 位 `keyHint`。
- 危险操作必须经过 `primus-guard` 的确认流程；不要为了测试方便绕过它。

## 3. 仓库地图

| 路径 | 内容 | 关键约束 |
|---|---|---|
| `apps/desktop/src/` | 前端（Next.js 16 App Router，静态导出） | 见第 4 节 |
| `apps/desktop/src/components/ui/` | Liquid Glass 基础组件（lore-glass，MIT；Radix 原语） | 第三方文件的改动登记在该目录 README.md；长列表不套玻璃 |
| `apps/desktop/src-tauri/` | 薄壳（Rust） | 目标 ≤ 约 4000 行；只做 Core 做不了的事 |
| `apps/desktop/src-tauri/update-service/` | 更新服务 PrimusUpdate（LocalSystem，ADR 0007）与薄壳共用的协议 / 验签库 | 只接受“安装已签名、版本更高的 MSI”一种请求；改协议要加 `PROTOCOL_VERSION` |
| `apps/desktop/src-tauri/windows/` | `Primus.wxs`（WiX 7，只发 MSI）、WebView2 引导、安装目录 ACL 与 NSIS 迁移脚本 | `UpgradeCode` 永不改变 |
| `packages/extensions/` | 第一方 Core 扩展 → `primus-bundle.js` | 只依赖 Core 公开扩展 API |
| `packages/protocol/` | RPC 记录与 `primus:*` 数据的 TS 类型 | 与锁定版本的 Core RPC 文档逐项对照 |
| `packages/ui/` | 共享 UI 组件（Radix，shadcn 方式） | |
| `agent-core/` | Agent Core 源码（git subtree） | 第 2.3 节；不在 pnpm 工作区内，用 `npm ci` |
| `e2e/` | WebdriverIO + tauri-driver | 模型用 Faux provider |
| `scripts/` | Core 构建、检查脚本、MSI 构建 | |
| `docs/` | 技术方案、ADR、用户手册 | 重要决策写 ADR |

## 4. 前端规则（Next.js 在桌面端）

Tauri 只加载本地静态文件，没有 Node 服务器：
- `next.config.ts` 保持 `output: "export"`、`trailingSlash: true`、`images.unoptimized: true`。
- **禁止**：Server Actions、Route Handlers（`app/api`）、proxy/middleware、ISR、`next/headers`、`cookies()`、`next/font/google` 等任何在线资源。
- 每个页面根组件标 `"use client"`；布局只放外壳。
- **不用动态路由段 `[id]`**；动态对象用查询参数（`/chat/?s=<sessionKey>`）或 store 状态。
- 路由清单固定：`/`、`/onboarding/`、`/settings/`、`/capabilities/`、`/storage/`（用量是设置中的分组：`/settings/?group=usage`）。新增路由需更新技术方案。
- **只有 `src/lib/platform/tauri/` 可以 import `@tauri-apps/*`**；其余代码通过 `src/lib/platform` 接口调用。新增薄壳命令时同时补 `mock/` 实现，保证 `pnpm dev:web` 可在浏览器中脱离 Rust 运行。
- 访问 `window`、`localStorage`、Tauri API 的代码只放在 `useEffect` 或客户端组件中。
- 流式渲染性能：每批事件一次 `setState`（`requestAnimationFrame` 内）；selector 订阅最小切片；已定稿消息不再更新；列表用虚拟滚动。
- Markdown 用 markdown-it 且**禁用原始 HTML**。
- 界面文案集中管理（首版中文），不要散落硬编码。
- 组件放 `src/components/`，基础交互用 `radix-ui`（按需 `import { Toggle } from "radix-ui"`），配色只用 `globals.css` 中 `@theme` 定义的设计令牌。
- 图标只用 `@/components/icons` 的 `<Icon name="…" size="sm|md|…" />`（Reicon Outline，仓库内收录，**不要引入任何图标库依赖**，`pnpm check:icons` 检查）：尺寸只用 `size` 令牌，颜色只继承文字颜色（`text-muted`、`text-danger` 等令牌加在图标或父元素上），不写 `opacity-*`、`text-fg/75`、`fill`/`stroke` 颜色；缺图标时在 `scripts/vendor-reicon.mjs` 的 `ICONS` 里加映射后重新生成（见 `components/icons/NOTICE.md`）。唯一的多色例外是文件类型图标 `<FileIcon name="typescript" />` / `fileIconHtml`（Material Icon Theme，`scripts/vendor-file-icons.mjs` 生成，颜色是 `--color-file-*` 令牌，不加 `text-*` 颜色类；按文件名选图标用 `fileIconForName`）。
- 字号只用 `globals.css` `@theme` 的字号令牌：`text-2xs` 11 / `text-xs` 12 / `text-sm` 13（界面控件）/ `text-base` 14（阅读正文：用户气泡、助手回复、输入框）/ `text-md` 15 / `text-lg` 16 / `text-xl` 18 / `text-2xl` 24 / `text-3xl` 28（另有 `text-3xs` 9 只给附件角标）。不写 `text-[13px]`、`leading-[22px]`、内联 `fontSize` 这类任意值（`pnpm check:type-scale` 检查）；Markdown 标题、行内代码的字号在 `.md` 样式里按 em 跟随正文。
- 前端单测：`apps/desktop/vitest.config.mts`（jsdom + React Testing Library，`@/` 别名）；测试文件与源码同目录 `*.test.ts(x)`，优先按角色/可访问名称查询元素。

## 5. 薄壳规则（Rust）

- 职责只有：进程监管、JSONL 分帧/合批/转发、数据目录与配置生成、凭证、会话索引、文件监听、Git 只读查询、托盘/单实例/通知/更新。**不理解、不修改 RPC 内容**（只解析路由所需的少量字段），不做业务规则与权限判断（交给扩展）。
- stdout 分帧：**只按 `\n` 切分并去掉行尾 `\r`**；不能用把 `U+2028/U+2029` 当换行的通用行读取器；必须持续读取，前端卡顿时在薄壳侧缓冲（上限 64MB）。
- Core 进程用内置 `node.exe` 的绝对路径拉起，全部放入 Job Object（`KILL_ON_JOB_CLOSE`）；环境变量按技术方案第 4.4 节设置，并清空 `NODE_OPTIONS`。
- 新增 Tauri 命令时同步更新技术方案附录 B 与 `src/lib/platform` 接口。
- 提交前：`cargo fmt`、`cargo clippy -- -D warnings`、`cargo nextest run`。

## 6. 扩展规则

- 所有第一方扩展用 TypeScript，放在 `packages/extensions/src/<模块>/`，由 `src/index.ts` 汇总，esbuild 打成一个 `primus-bundle.js`。
- 扩展 → 前端的结构化数据：`ctx.ui.setWidget("primus:<主题>", [JSON 字符串])`，格式固定 `{ "v": 1, "type": "<主题>", "data": {...} }`。前端遇到未知 `v` 忽略并记日志。
- 前端 → 扩展：发送内容为 `/primus-<命令> <JSON 参数>` 的 `prompt`，扩展注册对应命令，不触发模型调用。
- 新增数据主题或命令时，同步更新 `packages/protocol` 类型与技术方案附录 A。

## 7. 常用命令

```bash
pnpm install --frozen-lockfile
pnpm dev:web            # 浏览器预览（mock 平台）
pnpm dev                # Tauri 开发模式
pnpm build:core         # 构建 Agent Core
pnpm smoke:core         # Agent Core RPC 冒烟（get_state）
pnpm contract:core      # Agent Core RPC 契约测试（真实 Core + Faux 模型服务；--dist 版为 contract:core:dist）
pnpm build:extensions   # 构建 primus-bundle.js
pnpm lint && pnpm test  # Biome + Vitest
pnpm test:e2e           # 端到端冒烟（仅 Windows：先 pnpm build，需 tauri-driver 与匹配 WebView2 的 msedgedriver）
cd apps/desktop/src-tauri && cargo nextest run --all-targets   # Rust 单测（CI 用 --profile ci 输出 JUnit）
pnpm check:versions && pnpm check:tauri-imports && pnpm check:forbidden-sdk && pnpm check:naming && pnpm check:type-scale && pnpm check:icons
```

## 8. 完成一项改动的标准

1. 代码、类型、测试一起提交；改了行为就补或改测试（前端/扩展用 Vitest，Rust 用 cargo-nextest，RPC 用契约测试）。
2. `pnpm lint`、`pnpm test`、三个 `check:*` 脚本、Rust 检查全部通过。
3. 改动涉及协议、目录、命令、依赖或交付形态时，同步更新技术方案相应章节；重要取舍写一份 ADR（`docs/adr/NNNN-标题.md`）。
4. 改了 `agent-core/` 就更新 `agent-core/PATCHES.md`。

## 9. 提交与分支

**合并流程（必须遵守）**：
1. 所有改动只推到 `dev` 分支，**禁止直接推 `main`**。
2. 推送后开（或更新）PR：`dev → main`，等 CodeRabbit 审查完成。
3. CodeRabbit 结论为**低风险**（无未解决的实质性问题）才能合并到 `main`；否则按审查意见继续在 `dev` 上修改并推送，直至低风险。

推送前先本地预审：首次执行 `pnpm hooks:install`，之后 `git push` 会先跑 CodeRabbit CLI 审查已提交改动（`scripts/cr-prereview.mjs`），critical / major 问题修完再推，减少 PR 审查被限流卡住。


- 提交信息用 Conventional Commits：`feat(shell): ...`、`fix(frontend): ...`、`chore(core): ...`。scope 建议：`frontend`、`shell`（薄壳）、`core`、`ext`、`protocol`、`ui`、`installer`、`ci`、`docs`。
- 一个 PR 只做一件事；不要顺手格式化无关文件。
- 不要提交 `dist/`、`out/`、`target/`、`.dev-data/`、安装包与任何密钥。

## 10. 不确定时

- 技术方案没写的、或与本文件冲突的：先停下来说明，不要自行发明架构。
- 宁可在扩展里实现，也不要改 `agent-core/`；宁可让前端多做一点，也不要让薄壳理解业务。
