# @primus/extensions

第一方 Core 扩展（附录 A）。全部用 TypeScript 编写，esbuild 打成**一个**文件 `primus-bundle.js`，由 Core 以 `-e` 参数加载。只依赖 Core 的公开扩展 API。

| 模块 | Core 挂点 | 功能 | `primus:*` 数据 / 命令 |
|---|---|---|---|
| `guard` | `session_start`、`tool_call`、`tool_result`、`before_agent_start` | 协议白名单、危险操作确认、受保护路径、外部内容标注、权限模式 | `primus:mode`；`/primus-mode <模式>` |
| `checkpoint` | `turn_start`、`tool_call`（write/edit） | 影子仓库快照、回滚、变更清单 | `primus:changes`；`/primus-restore`、`/primus-revert-file` |
| `subagent` | 自定义工具 `subagent` | 子 Agent 进程管理与结果汇总 | `primus:subagents` |
| `plan` | `setActiveTools`、自定义工具 `todo` | 计划模式、待办 | `primus:plan`、`primus:todo`；`/primus-plan` |
| `shell` | `tool_call`（bash/powershell） | Windows 编码修正、环境变量清理 | — |

数据格式：`{ "v": 1, "type": "<主题>", "data": { ... } }`，通过 `ctx.ui.setWidget("primus:<主题>", [JSON])` 发送。
