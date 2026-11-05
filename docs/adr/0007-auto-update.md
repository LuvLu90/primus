# 0007 自动更新：更新源、公钥注入、安装类型判定、待装包与非提权重启

- 状态：已接受
- 日期：2026-11-05

## 背景
技术方案第 3.6 节只写了“用 `tauri-plugin-updater` + 自建静态 JSON、Windows 上用 msiexec 被动升级、两个通道、有运行中的 Agent 先确认”。产品要求是：设置中“自动更新”默认勾选；打开 Primus 后自动检查并下载最新版；下载完成并校验签名后提示“重启客户端以更新 Primus”；用户也可以不立即重启，下次打开 Primus 时直接安装新版本。落地时有几处技术方案没有写死、又与本项目已有约束（C2 数据目录、按用户 ACL、MSI 由 WiX 7 构建而非 Tauri bundler、安装器需要提权）相互影响的取舍。

## 决策

### 插件只在 Rust 侧使用
- 引入 `tauri-plugin-updater`（精确锁定最新稳定版 2.14.1，`default-features = false`，只开 `rustls-tls`、`system-proxy`：Windows 安装包是 MSI / EXE 本身，不需要 `zip`），由薄壳 `updater` 模块调用它的检查与下载（下载时插件按 minisign 验签）。
- `capabilities/default.json` 不授予任何 `updater:*` 权限，WebView 不能直接调用插件；前端只经薄壳命令 `update_status`、`update_watch`、`update_check`、`update_settings_set`、`update_install`（附录 B）。
- 插件的 `Config` 要求 `plugins.updater` 存在且有 `pubkey` 字段，否则插件初始化失败；`tauri.conf.json` 中放 `"pubkey": ""`、`"endpoints": []`，真正的公钥与地址在运行时用 `UpdaterBuilder::pubkey/endpoints/target` 传入。同时打开 `requireSignedVersion`：签名的 trusted comment 必须绑定清单里的版本（构建脚本一直用 `tauri signer sign --app-version` 签名），防止有人用旧版本的合法安装包配上更高的版本号诱导降级。

### 公钥不进仓库，构建时注入
- `build.rs` 声明 `cargo:rerun-if-env-changed=TAURI_SIGNING_PUBLIC_KEY`，`updater.rs` 用 `option_env!("TAURI_SIGNING_PUBLIC_KEY")` 编译进 exe（空串视为没有）。发布工作流在 `tauri build` 时设置它。
- 没有公钥的构建（开发、PR、CI 普通编译）自动更新整体禁用：`update_status.available = false`，不注册检查线程，`update_check` 返回 `unavailable`，设置页说明原因。非 Windows 平台同样禁用。
- 发布必须配置 `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` / `TAURI_SIGNING_PUBLIC_KEY` 三个仓库 Secret，缺一即失败（release.yml 先检查，构建脚本另以 `PRIMUS_REQUIRE_UPDATER_SIGNING=1` 拒绝）。私钥只在 CI 密钥库中，与代码签名证书互相独立。

### 更新源
- 固定的 GitHub Release `update-feed`（标为 prerelease、不设 Latest，不触发 `v*` 发布）存放两个 Tauri 2 静态清单：`stable.json`、`beta.json`；地址 `https://github.com/skaduv/primus/releases/download/update-feed/<通道>.json`。
- 清单由 `scripts/gen-update-manifest.mjs` 生成：`platforms` 含 `windows-x86_64-msi`、`windows-x86_64-nsis`、`windows-aarch64-msi`、`windows-aarch64-nsis`，`url` 指向本次版本 Release 的附件，`signature` 为同名 `.sig` 的内容，`notes` 取 Release 说明。正式版同时写 `stable.json` 与 `beta.json`，预发布只写 `beta.json`；现有清单版本更高的通道不覆盖（重建旧标签不回退，Beta 用户在正式版更高时也收到正式版），同一版本允许覆盖（重跑发布）。发布作业先下载现有清单再比较，用 `--clobber` 上传。
- `endpoints(channel)` 返回地址列表，插件按顺序尝试；暂不做国内镜像，以后在列表里追加即可。调试构建可用 `PRIMUS_UPDATE_ENDPOINT` 覆盖为本地地址。

### 安装类型判定
- MSI 版的 `Primus.exe` 是 `tauri build --no-bundle` 编译的，没有经过 bundler 的 binary patching，插件自己判断不出安装方式；NSIS 版的 exe 虽然被 patch 过，也统一用同一规则：**exe 所在目录有 NSIS 卸载程序 `uninstall.exe` 即 nsis，否则 msi**，再用 `.target("windows-<x86_64|aarch64>-<msi|nsis>")` 显式指定清单条目。这样 MSI 用户只会拿到 MSI、NSIS 用户只会拿到 setup.exe，不会跨安装方式升级。

### 设置与待装包的位置（C2）
- 设置：`data/users/<SID>/app/update.json`（`autoUpdate` 默认 `true`，`channel` 默认 `stable`）；文件缺失或损坏时用默认值。
- 待装包：`data/users/<SID>/updates/`。`users/<SID>` 的 DACL 只有当前用户与 SYSTEM，普通用户可写的共享目录（如 `data` 根、`shared`）里的安装包可能被其他本地用户替换，再由受害者点击 UAC 以管理员身份运行，形成提权；放在用户目录下避免这一点。另给 `updates` 目录追加 Administrators **只读**（可继承），供标准用户“过肩”输入管理员账号提权时，以该管理员账号运行的安装器能读到安装包；写权限仍只有当前用户与 SYSTEM。
- 下载完成后先写安装包（临时文件 + 改名），再原子写 `pending.json`：`version`、`notes`、`kind`、`file`（只是文件名，读取时再校验只含 `[A-Za-z0-9._-]` 且扩展名与安装方式一致）、`sha256`、`signature`、`attempts`。换新包前先删旧描述与旧包。

### 安装前二次校验
- “立即重启更新”与“下次启动时安装”共用一个函数：从磁盘重新读安装包，核对版本严格大于当前（SemVer，含预发布）、安装方式一致、SHA-256 与下载时一致，再用**编译进 exe 的公钥**重新校验 minisign 签名，规则与插件相同（`minisign-verify` 0.3.0，与插件依赖树中的版本一致；`allow_legacy = true`；trusted comment 的 `version:` 须与待装版本按 SemVer 相等）。任一项不通过即删除待装包并记日志。
- Windows 上校验时以只共享读的方式打开安装包，句柄保持到安装器拉起之后，缩小“校验之后、安装器读取之前被替换”的窗口。

### 启动安装器与非提权重启
- 通过校验后先 `Supervisor::shutdown()` 结束全部 Core（含工具子进程；安装器要替换 `resources` 下的 `node.exe` 与 Core 文件），再用 `ShellExecuteExW`（`runas`、`SEE_MASK_NOCLOSEPROCESS`）启动安装器：MSI → `%SystemRoot%\System32\msiexec.exe /i "<file>" /passive /norestart`（安装目录由 `Primus.wxs` 的 `PREVIOUS_INSTALLFOLDER` 沿用，`data` 不受影响）；NSIS → `"<setup.exe>" /P /UPDATE`（不传 `/R`，安装器不自己启动 App）。msiexec 与 PowerShell 的路径取自 `GetSystemDirectoryW`，不经 PATH。
- 拿到安装器进程句柄后，复制一个只有 `SYNCHRONIZE` 权限的可继承句柄，以当前（非提权）身份拉起隐藏的 PowerShell：按句柄等待安装器结束后 `Start-Process` 新的 `Primus.exe`，然后 Primus 退出。按句柄而不是按 PID 等待：非提权进程不一定能按 PID 打开提权的安装器进程，PID 也可能被复用。这样更新后的 App 以普通权限运行，而不是由提权的 msiexec / NSIS 直接启动（否则 WebView、Core 与它们写出的文件都会是管理员身份）。PowerShell 优先 `CREATE_BREAKAWAY_FROM_JOB`，所在作业不允许脱离时退回普通创建。
- 用户取消 UAC 或启动失败：待装包保留，App 照常运行（立即重启路径上 Core 已停，界面按“内核已停止 → 重启”恢复），前端再次显示提示；启动时的安装路径则照常启动。
- 成功拉起安装器记一次 `attempts`；同一待装版本成功拉起 3 次后版本仍未变化（安装失败），启动时删除待装包，不再每次启动都弹 UAC。

### 自动流程
- 主窗口创建后约 10 秒，若 `autoUpdate` 开启则检查；之后每 24 小时一次。清单版本严格大于当前、且不是已下载待装的同一版本时下载（插件验签，下载进度经 `update_watch` 推送，最多每 250ms 一次），存为待装包后推送带 `pending` 的状态，前端显示非阻塞提示“Primus x.y.z 已下载并校验，重启即可更新”，按钮“立即重启更新”“下次启动时更新”。自动检查失败只写 `updates/updater.log`（当前用户私有，超过 1MB 重写），不打扰用户；设置页显示上次失败原因。
- 下次启动：`lib.rs` 的 `setup` 一开始（数据目录就绪、单实例插件已确认是主实例之后，写模型配置、打开会话索引、创建窗口和拉起 Core 之前）处理待装包：版本更高 → 走同一安装函数，拉起成功即退出；版本不大于当前（已装过）或安装方式不符 → 清理。
- `update_install` 在有运行中的 Agent（任一会话 `agent_start` 之后未 `agent_settled`、有未响应的 prompt，或正在打开 / 重启）时返回 `busy`，前端确认后带 `force` 再调。

### 前端
- `features/update/update-store.ts` 统一订阅一次 `update_watch`（薄壳只保留一个订阅，与 `session_watch` 相同的模式，ADR 0006），根布局中的 `UpdatePrompt` 与设置页“更新”分组都读它。设置页：当前版本、“自动更新”开关（默认开）、通道（稳定版 / Beta 版）、“立即检查”，有待装版本时也可从这里立即重启更新。

## 与技术方案原文的差异
- 第 3.6 节写“下载新版 MSI（`latest.json`）”：改为按通道的 `stable.json` / `beta.json`，且 MSI 与 NSIS 两种安装方式都支持（各自升级到同一安装方式）。
- 新增命令 `update_status`、`update_watch`、`update_settings_set`；`update_install` 增加 `force` 参数。
- 待装包放在 `users/<SID>/updates/`（第 4.2 节目录布局新增）。

## 后果
- 每次发布都依赖三个 updater Secret；私钥丢失后已安装的版本无法再自动更新（只能手动安装带新公钥的版本）。
- `update-feed` Release 由发布工作流维护，不能手动删除；删除后客户端检查失败（只记日志），下次发布会重新创建。
- 早于本功能的标签不能再用发布工作流重建（缺 setup.exe 的 `.sig` 与清单脚本）。
- 需要在 Windows 虚拟机上验证：MSI / NSIS × x64 / ARM64 的升级、UAC 取消、非提权重启、`data` 保留、标准用户“过肩”提权读取安装包。
