# @primus/extensions

第一方 Core 扩展（附录 A）。全部用 TypeScript 编写，esbuild 打成**一个**文件 `primus-bundle.js`，由 Core 以 `-e` 参数加载。只依赖 Core 的公开扩展 API。

| 模块 | Core 挂点 | 功能 | `primus:*` 数据 / 命令 |
|---|---|---|---|
| `guard` | `session_start`、`tool_call`、`tool_result`、`before_agent_start` | 权限模式（已实现）：每次询问 / 自动编辑 / 完全访问，按模式对修改文件、命令、联网与工作区外读取弹出确认（允许 / 本会话内始终允许 / 拒绝）；协议白名单、受保护路径、外部内容标注待实现 | `primus:mode`；`/primus-mode <模式>` |
| `auth` | 扩展加载时 `registerProvider` | 不经 shell 直接拉起 `Primus.exe --secret` 取模型令牌，覆盖到 `models.json` 中使用取令牌命令的供应商（技术方案第 9.4 节） | — |
| `checkpoint` | `turn_start`、`tool_call`（write/edit） | 影子仓库快照、回滚、变更清单 | `primus:changes`；`/primus-restore`、`/primus-revert-file` |
| `subagent` | 自定义工具 `subagent` | 子 Agent 进程管理与结果汇总 | `primus:subagents` |
| `plan` | `setActiveTools`、自定义工具 `todo` | 计划模式、待办 | `primus:plan`、`primus:todo`；`/primus-plan` |
| `shell` | `before_agent_start`；`tool_call`（bash/powershell） | 命令工具只有 PowerShell 时往系统提示词追加 PowerShell 写法要点（技术方案第 12.3 节）；Windows 编码修正、环境变量清理 | — |
| `narrate` | `before_agent_start` | 往系统提示词末尾追加“进度说明”：调用工具前、每个阶段结束时用一两句话说明在做什么，最后一条回复写总结（桌面端按“工作过程 + 总结”展示） | — |
| `preview` | 自定义工具 `preview`（只读、不联网，guard 不弹确认） | 在右栏打开文件或文件夹的预览；返回结构化状态 `shown` / `unsupported` / `not_found` / `denied` / `too_large` / `no_ui`（`@primus/protocol` 的 `PreviewToolDetails`） | `primus:preview` |

数据格式：`{ "v": 1, "type": "<主题>", "data": { ... } }`，通过 `ctx.ui.setWidget("primus:<主题>", [JSON])` 发送。
