# 0007 自动更新：更新源、公钥注入、只发 MSI、更新服务静默安装、待装包与非提权重启

- 状态：已接受
- 日期：2026-11-05（2026-11-10 修订：只发 MSI，新增更新服务 PrimusUpdate 静默安装，去掉 CI 自签名）

## 背景
技术方案第 3.6 节只写了“用 `tauri-plugin-updater` + 自建静态 JSON、Windows 上用 msiexec 被动升级、两个通道、有运行中的 Agent 先确认”。产品要求是：设置中“自动更新”默认勾选；打开 Primus 后自动检查并下载最新版；下载完成并校验签名后提示“重启客户端以更新 Primus”；用户也可以不立即重启，下次打开 Primus 时直接安装新版本。落地时有几处技术方案没有写死、又与本项目已有约束（C2 数据目录、按用户 ACL、MSI 由 WiX 7 构建而非 Tauri bundler、安装器需要提权）相互影响的取舍。

第一版每次更新都经 UAC 拉起安装器，标准用户还要输入管理员账号，体验接近手动安装。2026-11-10 的修订目标是“全机安装 + 静默升级”：继续按机器安装在 Program Files（程序文件只有管理员可改，数据仍在 `<安装目录>\data`），但更新不再打扰用户。调研比较过三条路：A 保持现状只优化时机（仍每次 UAC）；B 改为按用户安装（无需提权，但每个用户各装一份、程序文件可被本用户改写，与 C2 的数据目录与 ACL 加固冲突）；C 随 MSI 安装一个以 LocalSystem 运行的小服务代为安装。C 的攻击面与开发量最大，但唯一能同时满足“按机器安装”与“无 UAC”，经确认采用 C，并按下文的威胁模型收紧。

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
- 清单由 `scripts/gen-update-manifest.mjs` 生成：`platforms` 只含 `windows-x86_64-msi`、`windows-aarch64-msi`（只发 MSI，见下），`url` 指向本次版本 Release 的附件，`signature` 为同名 `.sig` 的内容（`.sig` 由构建作业经 workflow artifact 交给发布作业，不作为 Release 附件），`notes` 取 Release 说明。正式版同时写 `stable.json` 与 `beta.json`，预发布只写 `beta.json`；现有清单版本更高的通道不覆盖（重建旧标签不回退，Beta 用户在正式版更高时也收到正式版），同一版本允许覆盖（清单尚未指向该标签时重跑发布）。发布作业先下载现有清单再比较，用 `--clobber` 上传。
- 清单已指向某标签的安装包时，发布工作流拒绝原地重建该标签：`--clobber` 换掉安装包后、清单更新前（或中途失败后），客户端会用旧清单里的签名校验新安装包而拒绝更新。需要重新出包时升版本号发布新标签。
- `build-msi.mjs` 在 `Primus.exe.build.json` 里记录编译时 `TAURI_SIGNING_PUBLIC_KEY` 的指纹；`--skip-tauri` 复用 exe 时，若这次要签 `.sig`，内置公钥必须与签名公钥一致（未内置、不一致或旧记录无法确认都拒绝复用），避免出现带签名却装上后无法更新的安装包。
- `endpoints(channel)` 返回地址列表，插件按顺序尝试；暂不做国内镜像，以后在列表里追加即可。调试构建可用 `PRIMUS_UPDATE_ENDPOINT` 覆盖为本地地址。

### 只发 MSI
- 每个架构只发一个 MSI（WiX 7，perMachine，默认 `C:\Program Files\Primus`，可选其他盘），停发 NSIS 安装程序：两种安装方式并存时更新、迁移、测试矩阵都要翻倍，而 MSI 才能用 `ServiceInstall` 可靠地安装与卸载服务。薄壳不再判断安装方式，固定用 `.target("windows-<x86_64|aarch64>-msi")` 指定清单条目；待装包扩展名须为 `.msi`。
- 旧 NSIS 版只认 `windows-<arch>-nsis`，收不到之后的更新：已装 NSIS 版的电脑手动运行一次新版本 MSI。MSI 在 `AppSearch` 读到 NSIS 版的卸载信息（`HKLM\…\Uninstall\Primus`）与安装目录（`HKLM\Software\乾元 Primus\Primus`）、且没有 MSI 记下的安装目录时，装回 NSIS 版的目录（沿用原来的 `data`），并在 `CheckInstallDir` 之前以 SYSTEM 身份运行 `windows/remove-nsis.ps1`：先确认 `uninstall.exe` 与其目录不是重解析点、所有者为 SYSTEM / Administrators、其他主体没有写入类权限（否则普通用户可放一个假 `uninstall.exe` 借安装程序以 SYSTEM 运行），再 `/S _?=<目录>` 静默卸载（不删 `data`），删除 `uninstall.exe` 与上述注册表项。任何一步失败都让安装回滚；若 NSIS 版已卸载则不会恢复，`data` 不受影响，重新运行 MSI 即可。
- 不做 Authenticode 代码签名（项目不购买证书）：CI 与发布都不再生成临时自签名证书；`build-msi.mjs` 保留可选的 signtool 签名（配置 `PRIMUS_SIGN_CERT_SHA1` 等时生效），以后有正式证书时直接启用。安装包的完整性与来源由 updater 的 minisign 签名保证（应用内更新）与 Release 正文的 SHA-256（手动下载）。

### 设置与待装包的位置（C2）
- 设置：`data/users/<SID>/app/update.json`（`autoUpdate` 默认 `true`，`channel` 默认 `stable`）；文件缺失或损坏时用默认值。
- 待装包：`data/users/<SID>/updates/`。`users/<SID>` 的 DACL 只有当前用户与 SYSTEM，普通用户可写的共享目录（如 `data` 根、`shared`）里的安装包可能被其他本地用户替换，再由受害者点击 UAC 以管理员身份运行，形成提权；放在用户目录下避免这一点。另给 `updates` 目录追加 Administrators **只读**（可继承），供标准用户“过肩”输入管理员账号提权时，以该管理员账号运行的安装器能读到安装包；写权限仍只有当前用户与 SYSTEM。追加失败时不发布待装包（报下载失败），避免提示“已就绪”而过肩提权后安装器读不到自身。
- 下载完成后先写安装包（临时文件 + 改名），再原子写 `pending.json`：`version`、`notes`、`kind`、`file`（只是文件名，读取时再校验只含 `[A-Za-z0-9._-]` 且扩展名与安装方式一致）、`sha256`、`signature`、`attempts`。新包与新描述都提交后才删除旧包；写入失败时旧的待装包仍然可用。

### 安装前二次校验
- “立即重启更新”与“下次启动时安装”共用一个函数：从磁盘重新读安装包，核对版本严格大于当前（SemVer，含预发布）、安装方式一致、SHA-256 与下载时一致，再用**编译进 exe 的公钥**重新校验 minisign 签名，规则与插件相同（`minisign-verify` 0.3.0，与插件依赖树中的版本一致；`allow_legacy = true`；trusted comment 的 `version:` 须与待装版本按 SemVer 相等）。任一项不通过即删除待装包并记日志。
- Windows 上校验时以只共享读的方式打开安装包（拒绝写入、改名与删除）。拉起安装器后把这个句柄的可继承副本交给下面等待安装器结束的 PowerShell，Primus 退出后它仍持有到安装器结束：从验签到 msiexec 读取完毕，同一用户的非提权进程都无法替换安装包。无法启动该 PowerShell 时只能由 Primus 持有到提示框关闭（极少见的降级）。

### 更新服务 PrimusUpdate（静默安装）
- 新 crate `apps/desktop/src-tauri/update-service`（与薄壳同一 Cargo 工作区）：库 `primus_update` 放协议、验签、版本比较、路径校验、msiexec 参数与 Windows 管道客户端，薄壳与服务共用（`verify_signature` / `is_newer` 从薄壳移到这里，规则不变）；二进制 `PrimusUpdate.exe` 是服务本体。`build-msi.mjs` 用同一个 `TAURI_SIGNING_PUBLIC_KEY` 编译两个 exe，服务没有内置公钥时拒绝一切请求。
- MSI 以 `ServiceInstall` 安装：LocalSystem、按需启动（`--service`）、空闲 60 秒自行停止；服务对象的 DACL 只给交互用户（IU）查询与启动（`CCLCSWLORPRC`），不能停止、改配置或删除。`ServiceControl` 在升级与卸载时先停止服务，卸载时删除。MSI 另写 `HKLM\Software\Primus\Version`（SemVer；MSI 的四段 ProductVersion 表达不了预发布）。
- 通信：命名管道 `\\.\pipe\PrimusUpdate`，消息模式、单实例（服务运行期间复用同一个实例，不留可被抢注的空档）、`PIPE_REJECT_REMOTE_CLIENTS`，管道 DACL 拒绝网络登录、只给交互用户读写。请求只有一种（`InstallRequest`，JSON，拒绝未知字段，≤ 16 KiB）：协议版本、安装包路径、版本、签名、是否重开、`--data-dir`。路径只接受普通的本地绝对路径（`X:\…`），拒绝 UNC、设备路径、相对段、备用数据流与保留设备名；服务不执行请求里的任何命令或参数。读写都有超时（应答后等客户端读完并断开也限时，不用没有超时的 `FlushFileBuffers`），客户端连上不发数据或不读应答都卡不住服务。协议版本不同的请求按“服务不可用”应答（薄壳回退到 UAC、保留待装包），其他格式错误按“请求无效”应答。
- 客户端（薄壳）先经 SCM 启动服务并取得服务进程 ID，连上管道后用 `GetNamedPipeServerProcessId` 核对：服务没运行时任何人都能抢先建同名管道，核对不一致就当作服务不可用，不把请求（以及允许对方模拟的身份）交给冒充者。
- 服务处理一个请求：
  1. 其他 Windows 会话里有映像在安装目录下的进程（另一个用户开着 Primus）时直接应答“忙”：现在装只会等待后放弃，而“立即重启更新”与启动时安装还会重新打开 Primus、再次请求，形成循环。薄壳保留待装包照常运行，下次退出或启动时再试。
  2. 以客户端身份（`ImpersonateNamedPipeClient`）打开安装包：请求者只能让服务读到他自己能读的文件；需要重开时同时取得请求者的令牌（复制为主令牌；提权的完整令牌换成关联的受限令牌）。随即恢复为 SYSTEM，恢复失败直接终止进程。
  3. 读入安装包（≤ 512 MB），用编译进服务的公钥按与插件相同的规则验签（含签名绑定的版本），版本须严格高于 `HKLM\Software\Primus\Version`（拒绝降级与重装）。
  4. 暂存目录 `%ProgramData%\Primus\Update`：MSI 用 `PermissionEx` 设为所有者 SYSTEM、受保护的 DACL（只有 SYSTEM 与 Administrators 完全控制），目录若由普通用户预先建好，所有者与 DACL 都会被替换；服务每次使用前仍以不跟随重解析点的方式打开并复查（不是联接、所有者可信、没有其他主体可写），不安全就拒绝（不去修它）。服务把**已经验签的字节**以 `CREATE_NEW` 写成 `package.msi`（不打开任何已存在的文件或硬链接），再以只共享读的方式重新打开：从验签到 msiexec 读完，安装包不可能被替换（防 TOCTOU；薄壳那边的副本此后与安装无关）。
  5. 把自身复制为暂存目录里的 `PrimusUpdateWorker.exe` 并启动（只继承暂存安装包、请求者进程与令牌三个句柄），应答 `accepted`。安装进程不在安装目录里运行：msiexec 停止并替换服务、删除安装目录里的文件都不影响它。
- 安装进程：等请求者退出（最多 2 分钟，否则放弃）→ 等安装目录下的进程全部结束（不算拉起它的服务进程；最多 30 秒，Core 还没退干净或期间有人又打开了 Primus 时放弃本次安装，下次再试）→ `msiexec /i package.msi /quiet /norestart REBOOT=ReallySuppress MSIRESTARTMANAGERCONTROL=Disable /l*v msiexec.log`（另一个安装正在进行（1618）时稍后重试）→ 删除暂存安装包 → 需要重开时以请求者令牌在其会话的默认桌面上打开新的 `Primus.exe`（用户自己的环境变量；安装失败也打开，回到旧版本）。全过程记在 `%ProgramData%\Primus\Update\service.log`（超过 1 MB 重写），完全卸载时整个 `%ProgramData%\Primus` 删除（升级时保留）。
- 威胁模型：服务以 SYSTEM 运行，本机任何交互用户都能请求它。它能做的只有“安装一个由发布方私钥签名、版本更高的 Primus MSI”——这正是发布方本来就会让每台机器装上的东西，所以普通用户能达到的最坏结果是**提前**装上一个正式发布过的新版本，或让服务白跑一趟。拿不到私钥就无法让服务安装任何其他内容；降级（用旧版本的合法包配高版本号）被签名绑定的版本与注册表版本双重拒绝；请求者能控制的只有自己可读的文件路径与“装完是否以他自己的身份重开”。剩下的风险集中在服务本身的实现缺陷，所以服务保持很小、只做一件事，并由 CI 的 `update-service-smoke.ps1` 以普通用户身份覆盖拒绝路径。安装目录里的 `PrimusUpdate.exe` 与 `Primus.exe` 一样由 `install-acl.ps1` 纳入程序文件检查（预先建好的目录里放的同名文件不能保留普通用户的写权限，否则就是本地提权）。

### 何时安装、能否回退到 UAC
- 三个时机共用 `prepare_install`（重读、核对 SHA-256、验签、加锁）与 `updater::launch`：
  - “立即重启更新”与启动时发现待装包：交给服务，**装完重新打开**；服务不可用（旧版 MSI 没有服务、服务被停用、管道核对失败、路径不便交给服务等）时回退到原来的 UAC 流程（`ShellExecuteExW runas` 拉起 `msiexec /i … /passive /norestart`，见下）。
  - 用户退出 Primus（`RunEvent::Exit`）：自动更新开启、有待装包、没有运行中的 Agent 时，结束 Core 后交给服务静默安装，**不重新打开**；服务不可用时什么都不做（退出时不弹 UAC），留到下次启动。有 Agent 在跑就留到下次。
- 服务拒绝（签名、版本、格式）时删除待装包；服务正在安装上一个包时返回“稍后再试”，待装包保留。服务接手记一次 `attempts`，3 次后版本仍未变化按原规则放弃该版本。

### 回退：经 UAC 启动安装器与非提权重启
- 通过校验后用 `ShellExecuteExW`（`runas`、`SEE_MASK_NOCLOSEPROCESS`）启动 `%SystemRoot%\System32\msiexec.exe /i "<file>" /passive /norestart`（安装目录由 `Primus.wxs` 的 `PREVIOUS_INSTALLFOLDER` 沿用，`data` 不受影响）。msiexec 与 PowerShell 的路径取自 `GetSystemDirectoryW`，不经 PATH。
- 拿到安装器进程句柄后，复制一个只有 `SYNCHRONIZE` 权限的可继承句柄，以当前（非提权）身份拉起隐藏的 PowerShell：按句柄等待安装器结束后 `Start-Process` 新的 `Primus.exe`，然后 Primus 退出。按句柄而不是按 PID 等待：非提权进程不一定能按 PID 打开提权的安装器进程，PID 也可能被复用。这样更新后的 App 以普通权限运行，而不是由提权的 msiexec 直接启动。PowerShell 优先 `CREATE_BREAKAWAY_FROM_JOB`，所在作业不允许脱离时退回普通创建；仍无法安排重新打开时，退出前弹窗提示用户安装完成后手动打开。`--data-dir` 指定的数据目录（绝对路径）原样传给重新打开的进程。
- 安装器已运行（或服务已接手）后才 `Supervisor::shutdown()` 结束全部 Core（含工具子进程；安装器要替换 `resources` 下的 `node.exe` 与 Core 文件）并退出。
- 用户取消 UAC 或启动失败：待装包保留，Core 没有被停掉，App 与会话照常运行，前端再次显示提示；启动时的安装路径则照常启动。
- 成功交出安装记一次 `attempts`；同一待装版本 3 次后版本仍未变化（安装失败），启动时删除待装包并把该版本记入 `updates/abandoned.json`，自动检查不再下载它；更高的版本照常更新，用户在设置页手动检查时清除记录重新下载。

### 自动流程
- 主窗口创建后约 10 秒，若 `autoUpdate` 开启则检查；之后每 24 小时一次。清单版本严格大于当前、且不是已下载待装的同一版本时下载（已下载的同一版本先重新核对 SHA-256 与签名，损坏或缺失则重新下载；插件验签；连接 30 秒、读取停滞 60 秒、总时长 2 小时超时，安装包超过 512 MB 即中止，下载进度经 `update_watch` 推送，最多每 250ms 一次），存为待装包后推送带 `pending` 的状态，前端显示非阻塞提示“Primus x.y.z 已下载并校验，重启即可更新”，按钮“立即重启更新”“下次启动时更新”。自动检查失败只写 `updates/updater.log`（当前用户私有，超过 1MB 重写），不打扰用户；设置页显示上次失败原因。
- 退出时：见上文“何时安装”。
- 下次启动：`lib.rs` 的 `setup` 一开始（数据目录就绪、单实例插件已确认是主实例之后，写模型配置、打开会话索引、创建窗口和拉起 Core 之前）处理待装包：版本更高 → 走同一安装函数，拉起成功即退出；版本不大于当前（已装过）或安装方式不符 → 清理。
- `update_install` 在有运行中的 Agent（任一会话 `agent_start` 之后未 `agent_settled`、有未响应的 prompt，或正在打开 / 重启）时返回 `busy`，前端确认后带 `force` 再调。忙碌检查与“安装中”标记在会话表的同一把锁内完成，之后新的 prompt、会话打开与重启被拒绝，直到安装取消或失败，不会有新的一轮夹在检查与停掉 Core 之间。
- 发布工作流中所有标签的发布作业共用一个并发组，`update-feed` 清单的读取、比较与上传串行执行，较旧版本不会覆盖较新版本的清单。

### 前端
- `features/update/update-store.ts` 统一订阅一次 `update_watch`（薄壳只保留一个订阅，与 `session_watch` 相同的模式，ADR 0006），根布局中的 `UpdatePrompt` 与设置页“更新”分组都读它。设置页：当前版本、“自动更新”开关（默认开）、通道（稳定版 / Beta 版）、“立即检查”，有待装版本时也可从这里立即重启更新。静默安装不新增任何选项或说明文字：“自动更新”开关同时决定是否在退出时安装。`update_status` 不再返回 `installKind`。

## 与技术方案原文的差异
- 第 3.6 节写“下载新版 MSI（`latest.json`）”：改为按通道的 `stable.json` / `beta.json`。
- 第 3.4 节的 NSIS 备选安装程序停发（2026-11-10），只发 MSI；第 3.3.4 节的代码签名不做（不购买证书）。
- 第 3.6 节“msiexec 被动升级”：改为由更新服务 `msiexec /quiet` 静默升级，UAC 被动安装只作回退。
- 新增命令 `update_status`、`update_watch`、`update_settings_set`；`update_install` 增加 `force` 参数。
- 待装包放在 `users/<SID>/updates/`（第 4.2 节目录布局新增）。

## 后果
- 每次发布都依赖三个 updater Secret；私钥丢失后已安装的版本无法再自动更新（只能手动安装带新公钥的版本）。
- `update-feed` Release 由发布工作流维护，不能手动删除；删除后客户端检查失败（只记日志），下次发布会重新创建。
- 早于本功能的标签不能再用发布工作流重建（缺 setup.exe 的 `.sig` 与清单脚本）。
- 多了一个 LocalSystem 服务：服务代码的任何缺陷都是潜在的本地提权，改动需格外谨慎（协议变化须加 `PROTOCOL_VERSION`，服务对不认识的版本返回错误，薄壳随即回退到 UAC）。
- 从没有服务的版本（≤ 0.0.8）升级到带服务的版本时仍走一次 UAC；之后的更新静默完成。NSIS 版用户需要手动安装一次 MSI。
- 安装包与程序没有 Authenticode 签名：手动安装时 SmartScreen 提示未知发布者；应用内更新的安全性只依赖 updater 私钥。
- CI 用 `scripts/update-service-smoke.ps1` 在 x64 与 ARM64 上以普通用户身份覆盖服务的静默升级、错签、降级、程序运行中 / 已退出与卸载清理；仍需在 Windows 虚拟机上验证：真实 App 的“立即重启更新”与退出时安装、以请求者身份重新打开（交互会话）、多用户同时运行、服务停用时回退到 UAC、从 NSIS 版迁移、标准用户全程无 UAC。
