# e2e

WebdriverIO + tauri-driver 端到端测试（技术方案第 18 章）。tauri-driver 包装 msedgedriver 驱动 WebView2，因此**只能在 Windows 上运行**。

- 当前：`specs/smoke.e2e.ts` 冒烟——应用启动、标题为“乾元 Primus”、左右栏可隐藏与恢复。CI 的 Windows 作业在编译 `Primus.exe` 后运行。
- `specs/conversation.e2e.ts`：安装矩阵（x64）对安装后的 Primus.exe 完成一次含工具调用的对话。按用户的真实路径配置模型（ADR 0008）：在设置·模型渠道里添加指向 `scripts/install-matrix/faux-serve.mjs` 的渠道（anthropic-messages）并“获取模型”（Faux 服务提供 `GET /v1/models`），保存后在模型选择器里选中 Faux 模型再发送；不直接写 `models.json`。需要 `PRIMUS_E2E_APP` 与 `PRIMUS_E2E_FAUX_URL`，缺少时整组跳过。
- 计划：在 Windows 11 虚拟机上每晚与发布前运行完整用例，模型使用 Core 的 Faux provider（脚本化输出）。覆盖首次引导、对话、停止、插话、确认框、分叉、回滚、压缩、子 Agent、计划模式（第 23 章）。

## 本地运行（Windows）

```powershell
pnpm build                                              # 产出 apps/desktop/src-tauri/target/release/Primus.exe
cargo install tauri-driver --locked --version 2.1.0     # 版本见 scripts/version-baseline.json
# 下载与本机 WebView2 运行时同版本的 msedgedriver.exe，然后：
$env:PRIMUS_NATIVE_DRIVER = "C:\path\to\msedgedriver.exe"
pnpm test:e2e
```

| 环境变量 | 作用 |
|---|---|
| `PRIMUS_E2E_APP` | 被测程序路径，默认 `../apps/desktop/src-tauri/target/release/Primus.exe` |
| `PRIMUS_E2E_FAUX_URL` | Faux 模型服务地址（只有 `conversation.e2e.ts` 用；由安装矩阵的 `matrix-checks.ps1` 设置） |
| `PRIMUS_NATIVE_DRIVER` | 传给 tauri-driver 的 `--native-driver`（msedgedriver 路径）；不设时 tauri-driver 从 PATH 查找 |

`wdio.conf.ts` 在每个会话前启动 `~/.cargo/bin/tauri-driver` 并等待 `127.0.0.1:4444` 就绪，会话结束或进程退出时关闭它。

**必须以非管理员身份运行。** WebView2 运行时 150 起，宿主进程以管理员（高完整性级别）运行时会忽略 msedgedriver 注入的 `--remote-debugging-port`，会话报 `DevToolsActivePort file doesn't exist`（[tauri-apps/wry#1782](https://github.com/tauri-apps/wry/issues/1782)）。普通终端不受影响；CI 的托管运行器以管理员运行，因此用 gsudo（版本与 SHA-256 固定在 `ci.yml`）把整条链降到中完整性级别，并直接调用 `wdio`（pnpm 12 嵌套 `pnpm run` 时会等残留的 msedgedriver 而挂起）。

类型检查（任何平台）：`pnpm --filter @primus/e2e typecheck`。根目录 `pnpm test`（Vitest）不包含 e2e。
