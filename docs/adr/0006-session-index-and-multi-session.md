# 0006 会话索引与多会话的实现方式

- 状态：已接受
- 日期：2026-11-03

## 背景
技术方案第 10.2 节要求薄壳的 `session_index` 扫描会话目录、写入 `index.db` 并建立 FTS5 全文索引，`fs_watch` 监听会话目录增量更新，列表分页（每页 50 条），1 万个会话时首屏 300ms 内完成；第 16.2 节要求左栏列出会话、可搜索，前端可同时打开多个会话（每个运行中的标签页一个 Core 进程，上限 4）。落地时有几处技术方案没有写死的取舍：

1. 薄壳拉起 Core 时设置了 `PRIMUS_CODING_AGENT_SESSION_DIR`（第 4.4 节），Core 因此把所有会话文件平铺在 `core/sessions/` 下（文件名 `<时间戳>_<会话 ID>.jsonl`），不再按工作区分子目录；会话属于哪个工作区只能从文件头 `SessionHeader.cwd` 得知。
2. Core 的会话文件只追加；新会话在第一条用户消息之前不落盘。
3. 会话内容以中文为主，FTS5 默认的 `unicode61` 分词器不切分中文。
4. 前端要知道索引变了，但 `Platform` 接口里的每个方法都对应一条薄壳命令（`COMMANDS` 覆盖检查），不能凭空加一个事件订阅。
5. 删除要进 Windows 回收站，属于平台差异（约束 C3）。

## 决策

### 索引（`session_index`，rusqlite bundled）
- 数据库：`users/<SID>/app/index.db`，`PRAGMA journal_mode=WAL`、`synchronous=NORMAL`；`meta` 表记 `schema_version`（当前 3），版本不符时重建派生表（索引可以随时从会话文件重建，不做迁移）。
- `sessions` 表：`path`（主键，会话文件绝对路径）、`id`、`workspace`（文件头 `cwd` 原样）、`workspace_key`（比较用的规范化路径）、`name`（最新 `session_info.name`，空串视为清除）、`first_message`（首条用户消息文本，截取 200 字）、`created_at`、`updated_at`（文件头时间与最后一条带时间的 user/assistant 消息时间中较晚者，毫秒；没有带时间的消息时为文件头时间）、`message_count`、`parent_path`、`file_size`、`file_mtime`、`parsed_offset`、`fingerprint`（完整已解析部分 `[0, parsed_offset)` 的 FNV-1a 哈希）。列表索引 `(updated_at DESC, path DESC)`、`(workspace_key, updated_at DESC, path DESC)`。归档标记单独放在 `archived(path)` 表。
- 增量解析：文件只追加，所以记住已解析到的字节偏移（只算到最后一个 `\n` 为止，半行留到下次）。每次检查都把已解析部分完整读一遍算指纹（顺序读、64KB 一块）：文件变大且指纹与文件头 ID 不变时从偏移处继续读，新的指纹接着记录的哈希状态对新增的完整行累加，不再重复读；文件变小、文件头或指纹变了（已解析部分任何位置被改写，包括超过 8KB 的文件只改中间段）或记录缺失时整份重新解析。大小与修改时间都没变时也核对指纹，所以同尺寸、同修改时间的改写也不会被漏掉；代价是每次检查读一遍已解析部分，会话文件从页缓存顺序读，对桌面端可以接受。指纹算法变化时 `schema_version` 加一，旧库按版本不符重建（`archived` 保留）。逐行按 `\n` 切分并去掉 `\r`，与第 5.4 节的分帧规则一致；解析不了的行跳过（与 Core 的容错一致）。
- 全文索引：单独一张 FTS5 虚表 `session_text`（`path UNINDEXED, body`），分词器 `trigram`（SQLite 3.34 起内置，可做中文子串匹配）。每次增量解析把新增的 user/assistant 文本作为一行追加，整份重解析时先删后插。搜索词不足 3 个字符时 trigram 无法匹配，改为对 `name` 与 `first_message` 做 `LIKE` 子串查询；`LIKE` 的 `%`、`_`、`\` 转义。搜索结果按 `updated_at` 倒序，最多 50 条。
- 分页：键集分页，游标为上一页最后一条的 `updated_at` 与 `path`（编码为 `<毫秒>:<路径>` 的字符串，前端只原样传回）；每页 50 条。
- 工作区：`session_list` / `session_search` 的 `workspace` 为 `null` 时返回全部工作区的会话（左栏默认如此，每行显示所属工作区）；为字符串时按 `workspace_key` 过滤，空串表示“未选工作区”的默认目录 `users/<SID>/chat`（与 `session_open` 一致）。`workspace_key` 的规范化（Windows 上统一分隔符为 `\`、去掉末尾分隔符、转小写）放在 `platform` 模块。
- 启动：主窗口创建后在后台线程全量扫描一次（递归读取 `core/sessions/` 下的 `.jsonl`，与监听范围一致，不跟随符号链接；大小、修改时间与指纹未变的文件跳过；目录读取出错时整次扫描失败、索引保持原状，不把没读到的会话当作已删除），扫描期间列表命令照常返回已有索引；库中有而磁盘上没有的条目删除。

### 监听（`fs_watch`，notify）
- 监听 `core/sessions/`（递归，以兼容 Core 未设会话目录时的子目录布局），事件按路径去抖 250ms 后交给索引增量更新；`.jsonl` 之外的文件忽略；监听器出错或丢事件（`Rescan`）时做一次全量扫描；重命名（含目录重命名）与目录删除也做全量扫描（notify 对这类事件只报告目录本身）。
- 薄壳只推“索引变了”这一个信号，不推内容：新命令 `session_watch(onEvent: Channel)` 注册一个 Channel，注册后立即推送一次（覆盖注册前、前端首次拉取之后的变化），之后索引每次有变化（含全量扫描结束）推送 `{ "seq": n }`，序号在锁内分配、严格递增；再次调用替换旧的 Channel。前端收到后重新拉取当前页。这样前端的事件订阅与其他命令一样经 `Platform` 接口与 `COMMANDS` 表，`pnpm dev:web` 的 mock 也能模拟。
- 技术方案第 5.2 节写的“监听工作区文件变化”留给文件树（第 15.2 节）接入时再加，模块按监听目标扩展。

### 删除与归档
- `session_delete(sessionPath)`：只接受 `core/sessions/` 下的 `.jsonl` 文件（规范化后比较，拒绝 `..` 与符号链接逃逸）；会话在打开中（会话表里有使用该文件或该会话 ID 的条目；文件按身份比较，解析符号链接、`.` 段与短名）时拒绝，返回 `{ code: "sessionOpen" }`。占用检查通过时在同一次加锁内把文件登记为“删除中”，移到回收站在锁外进行（可能弹出系统确认框），期间打开同一文件被拒绝。`session_open` 恢复已有会话文件时同样按文件身份比较，并读文件头的会话 ID 与打开中的新会话比较，同一文件只有一个 Core 写入。通过 `platform::move_to_trash` 移入回收站（Windows：`SHFileOperationW` + `FOF_ALLOWUNDO | FOF_WANTNUKEWARNING | FOF_NO_UI`，卷上没有回收站时先警告、用户取消则不删除索引；其他平台第 P3 阶段再实现，目前返回不支持），成功后删除索引条目。检查点（第 15.4 节）接入后在这里一并删除。
- `session_archive(sessionPath, archived)`：只改 `archived` 表，列表默认隐藏已归档会话，搜索结果带上归档标记。因 `schema_version` 变化而重建时只删派生表，`archived` 表保留；会话从索引中删除（文件被删）时一并删除其归档标记；数据库损坏、打不开时删掉重建（仍打不开则本次运行用内存库），归档标记随之丢失（会话本身不受影响）。

### 多会话（前端）
- 每个打开的会话是一个“标签”：`features/sessions` 的 zustand store 记录标签列表（`tabId`、会话文件路径或空、标题）与当前标签；中央区为每个标签挂一个 `ChatPanel`，非当前标签隐藏（`hidden`）而不卸载，Core 进程与时间线状态都保留，切回时不重放。同时挂载的标签不超过 8 个，超出时关闭最早打开且不在运行中的标签，都关不掉时不新建标签；进程数仍由薄壳的上限（4）与空闲淘汰控制，被淘汰的标签切回时按已有的“内核已停止 → 重启”路径恢复。
- 打开历史会话：`ChatPanel` 带上会话文件路径挂载，立即 `sessionOpen(workspace, path)`，随后用已有的重建流程（`get_messages` + `get_state`）渲染历史；打开或重建失败时不标记已加载，下一次发送前先重试。
- 新会话：已有尚未打开的空标签时切到它，否则新建；首次发送时打开（沿用现有逻辑）。正在打开（`sessionOpen` 未返回）的标签不算空标签。`session_open` 返回薄壳定好的 `sessionId`，前端据此把索引中的条目与打开中的标签对上（打开会话文件的标签只按路径匹配，复制出的会话文件头 ID 相同也不混淆），避免同一会话被打开两次；薄壳侧也拒绝打开已被打开中的会话使用的会话文件。
- 卸载标签时推迟到下一个任务再关闭会话：React 开发模式会立即卸载再挂载，重新挂载时取消关闭，不会对同一会话文件重复打开。
- 左栏：新会话按钮、搜索框（输入 200ms 去抖，非空时显示搜索结果）、会话列表（`@tanstack/react-virtual` 虚拟滚动，滚到底加载下一页）、每行悬停菜单提供“关闭会话”“归档 / 取消归档”“删除”（删除前确认；打开中的会话不能删除）。暂不做标签栏，打开中的会话在列表中高亮、经菜单关闭。
- 本次不做：重命名（需要经 Core 的 `set_session_name`，与自动生成标题一起做）、置顶、按工作区分组的折叠视图、会话树与分叉（第 10.3 节其余操作）。

## 后果
- 索引是会话文件的派生数据，可以随时删掉 `index.db` 重建（只丢归档标记）。
- trigram 索引大约是正文的 3 倍体积；对桌面端可以接受。少于 3 个字的搜索只匹配标题与首条消息。
- 新增依赖 `rusqlite`（bundled）与 `notify`，版本已在技术方案第 2.4 节基线中。
- 新增薄壳命令 `session_watch`，`session_archive` 增加 `archived` 参数，`session_list` / `session_search` 的 `workspace` 可为 `null`；附录 B 与 `Platform` 接口同步更新。
