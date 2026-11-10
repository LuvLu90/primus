# @primus/protocol

前端、薄壳与第一方扩展共用的 RPC 记录与 `primus:*` 数据的 TS 类型（技术方案第 7 章、附录 A）。
类型与锁定版本的 Agent Core 逐项对照，来源是 `agent-core/packages/coding-agent/docs/` 下的文档与 Core 导出的类型。

| 文件 | 内容 | Core 文档 |
|---|---|---|
| `src/commands.ts` | 33 条 stdin 命令（`RpcCommand`）与清单 `RPC_COMMAND_TYPES` | rpc-commands.md |
| `src/responses.ts` | 每条命令的成功响应 `data`（`RpcResponseDataMap`）、失败响应、`RpcResponseFor<C>` | rpc-commands.md、rpc.md「Errors」 |
| `src/events.ts` | 23 种会话事件（`SessionEvent`）、`message_update` 的 12 种增量事件、RPC 独有的 `extension_error` | json.md |
| `src/extension-ui.ts` | 9 种扩展 UI 请求（4 种对话框 + 5 种即发即弃）与 3 种响应 | rpc-extension-ui.md |
| `src/content.ts` | 内容块、`Usage`、8 种消息角色（`AgentMessage`） | message-types.md |
| `src/session.ts` | 11 种会话条目（`SessionEntry`）与 `SessionTreeNode` | session-format.md |
| `src/model.ts` | 模型对象（`api` 只允许两协议，C1） | rpc-commands.md「Model object」 |
| `src/file-tag.ts` | 附件的 `<file name="路径">` 引用（Core 命令行 `@file` 的原生格式）：写入 `appendFileTags`、解析 `splitFileTags`、内联上限；前端与 `primus-attach` 共用 | coding-agent/src/cli/file-processor.ts（`file-tag.test.ts` 核对写法与上限） |
| `src/primus-data.ts` | 扩展 → 前端的 `primus:*` 数据：`primus:context-stats`；`primus:preview` 与预览工具 `preview` 的结果（`PreviewStatus`、`PreviewKind`、`PreviewToolDetails`、按扩展名分类 `previewKindOf`、与薄壳一致的预览上限）；前端与第一方扩展共用 | 技术方案第 6.6 节、附录 A（`primus-data.test.ts` 核对分类与上限） |
| `src/index.ts` | `CoreRecord`、`StdinRecord`、薄壳批次 `CoreBatch`、`PrimusData` | 技术方案第 7.3 节、第 6.6 节 |

## 对照方式

- **名称覆盖**（`src/coverage.test.ts`，随 `pnpm test` 运行）：从 Core 文档和源码（`rpc-types.ts`、`rpc-mode.ts`、
  `agent-session.ts`、`AgentEvent`、`AssistantMessageEvent`、`session-manager.ts`）提取命令、响应、事件、增量事件、
  扩展 UI 方法与响应形状、消息角色、会话条目的名称，与本包清单做集合比较。Core 升级后多出或少了任何一项都会失败。
- **字段形状**（`src/contract.typecheck.ts`，随 `pnpm --filter @primus/protocol typecheck` 运行）：Core 文档中的
  JSON 示例逐条用本包类型标注，多字段、缺必填字段、取值不符都会编译失败；同时校验各清单与联合类型完全一致。

## 线上格式约定

- Core 侧值为 `undefined` 的字段在 JSON 中直接缺省，因此写成可选字段（如 `BashResult.exitCode`、
  `SetStatusRequest.statusText`、`SessionInfoChangedEvent.name`、被取消时的 `fork` 响应没有 `text`）。
- `message_update` 是线上格式：没有累积的 `message` 与 `partial` 快照，`toolcall_start` 额外带 `id`、`toolName`。
- `AgentMessage`、`CoreRecord` 是封闭联合，只列出锁定版本中的已知成员，不能通过声明合并扩展。
  运行时仍可能出现新增的消息角色或记录类型（Core 内部扩展、Core 升级），消费方按 `role` / `type` 分派，
  在 default 分支忽略不认识的值（`isKnownAgentMessage` 可用于判断消息）。
- 工具执行结果（`ToolResult`）的形状由各工具决定，Core 侧类型为 `any`；内置与扩展工具遵循 `{ content, details }`。
