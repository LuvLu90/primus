# windows

- `Primus.wxs`：WiX 7 安装包定义（第 3.3 节；只发 MSI，ADR 0007）。`UpgradeCode` 固定为 `5B4199DD-C352-459A-AEB0-7119A884608F`，**永不改变**（MajorUpgrade 靠它识别旧版本）；`data` 目录组件的 GUID 同样固定。
- `remove-nsis.ps1`：从旧 NSIS 版迁移时由 `Primus.wxs` 的 `RemoveNsis`（SYSTEM、`CheckInstallDir` 之前）运行：确认 NSIS 卸载程序与其目录可信后 `/S _?=<目录>` 静默卸载，`data` 保留，再删除 `uninstall.exe` 与 NSIS 记录安装目录的注册表项；MSI 沿用 NSIS 版的安装目录。与 `install-acl.ps1` 一样去掉注释后以 Base64 嵌入（`build-msi.mjs` 生成的 `primus-scripts.wxi`，两段脚本超过命令行长度上限，不能用 `-d`）。
- `webview2/`：WebView2 Evergreen 引导程序 `MicrosoftEdgeWebview2Setup.exe`（约 1.8MB）。不入库：`build-msi.mjs` 缺失时从微软官方地址下载，校验 Authenticode 签名有效且签名者为 Microsoft Corporation 后作为 `Binary` 打进 MSI；安装时注册表中查不到按机器安装的 WebView2（HKLM 32 位视图的 `pv` 为空或 `0.0.0.0`；MSI 面向所有用户，安装者 HKCU 下的按用户运行时不算）才以 SYSTEM 身份静默运行，失败则回滚安装。
- `Privacy.rtf`：安装界面的隐私政策页（MSI 的 `WixUILicenseRtf`），中文以 RTF `\uN\'3f` 转义（Unicode 码点 + `?` 回退字符的十六进制形式，各解析器一致）；改文案时保持 RTF 有效（可用写字板打开另存）。
- `art/`：安装界面图片（24 位 BMP，由 `assets/logo.png` 经 `scripts/render-installer-art.py` 4 倍超采样生成（先 `python3 -m pip install -r scripts/requirements.txt` 安装锁定版本的 Pillow），白底 / 浅灰侧栏 + 标志与“乾元 Primus”字样）：`wix-banner.bmp`（493×58）、`wix-dialog.bmp`（493×312，左 164 像素为侧栏）给 MSI。

构建：仓库根运行 `node scripts/build-msi.mjs --arch x64|arm64`（`tauri build --no-bundle` 与 `cargo build -p primus-update` → 签名（配置了证书时） → `wix build -arch <arch>` → 签名 MSI → SHA-256 → `tauri signer`，输出 `out/Primus_<ver>_<arch>_zh-CN.msi`；同一份 `Primus.wxs` 构建两种架构）。脚本同时编译更新服务 `PrimusUpdate.exe`（`cargo build -p primus-update`，与 `Primus.exe` 同一 target 目录、同一把 updater 公钥）。x64 等价的 WiX 命令（在仓库根执行；`CARGO_TARGET_DIR` 未设置时）：`wix build apps/desktop/src-tauri/windows/Primus.wxs -arch x64 -culture zh-CN -acceptEula wix7 -ext WixToolset.UI.wixext -ext WixToolset.Util.wixext -bindpath app=apps/desktop/src-tauri/target/release -bindpath core=dist/agent-core -bindpath runtime=dist/runtime -d ProductVersion=<主.次.(修订×100+阶段).0，见第 3.3.3 节> -d ShellDir=apps/desktop/src-tauri -d WebView2Setup=<引导程序路径> -o out/Primus_<ver>_x64_zh-CN.msi`

`core`、`runtime` 两个目录由仓库根的 `pnpm build:core` 生成（目录结构见根 README「Core 产物与内置运行时」）：`dist/agent-core/` 整目录收进 `resources\agent-core\`（`manifest.json` 列出每个文件的 SHA-256），`dist/runtime/` 只有官方 `node.exe` 与 `LICENSE`，收进 `resources\runtime\`。打 MSI 前先运行 `pnpm build:extensions`，把 `primus-bundle.js` 写入 `dist/agent-core/extensions/`。`node.exe` 保留 OpenJS 官方签名，不重签。

## 安装包要点（第 3.3.2 节）

| 内容 | 做法 |
|---|---|
| 安装目录可选 | `WixUI_InstallDir`，默认 `C:\Program Files\Primus`；静默安装可传 `INSTALLFOLDER="D:\某目录"` |
| 主程序与资源 | `Primus.exe`、`PrimusUpdate.exe` 在安装目录根；`resources\runtime`、`resources\agent-core` 用 `<Files>` 整目录收集 |
| 安装目录 ACL | MSI 的 `CheckInstallDir` / `ResetProgramAcl` 运行 `windows/install-acl.ps1`：检查祖先路径，用 `SetKernelObjectSecurity` 只锁定目录自身（不传播权限），保持句柄并冻结、检查程序树，拒绝重解析点和多重硬链接，全部检查通过后才修复程序文件 ACL。MSI 的 `InstallDirAcl` 组件另用 `PermissionEx Sddl`（MsiLockPermissionsEx）设置同一受保护 DACL：SYSTEM、Administrators 完全控制，Users 与应用包读取和执行；`data` 不参与程序文件修复 |
| `data` 目录 | `CreateFolder` + `util:PermissionEx` 给本地化的 Users 组（`util:QueryWindowsWellKnownSIDs` 查出的 `[WIX_ACCOUNT_USERS]`）授予“修改”(M)，继承到子项；组件 `Permanent`，卸载与升级保留 |
| 升级 | `MajorUpgrade` + 固定 `UpgradeCode`；降级给出中文提示。安装目录写入 `HKLM\Software\Primus\InstallDir`，重大升级时（未显式传 `INSTALLFOLDER`）由 `AppSearch` 读回并沿用，装在其他盘的实例升级后仍在原目录、复用原 `data` |
| WebView2 | 注册表检测，缺失时运行内嵌引导程序 |
| 更新服务（ADR 0007） | `ServiceInstall`：`PrimusUpdate`，LocalSystem、按需启动、参数 `--service`；服务 DACL 只给交互用户查询与启动；`ServiceControl` 升级与卸载时先停止，卸载时删除。`HKLM\Software\Primus\Version` 记已安装的 SemVer（服务据此拒绝降级）。暂存目录 `%ProgramData%\Primus\Update`：`PermissionEx` 设为所有者 SYSTEM、只有 SYSTEM 与 Administrators 可写的受保护 DACL；完全卸载时 `util:RemoveFolderEx` 删除整个 `%ProgramData%\Primus`（升级时保留） |
| 从 NSIS 版迁移 | `AppSearch` 读到 NSIS 版的卸载信息与安装目录、且没有 MSI 记下的安装目录时，装回 NSIS 版的目录，并在 `CheckInstallDir` 之前以 `remove-nsis.ps1` 静默卸载 NSIS 版（`data` 保留） |
| 完成页 | “立即启动 乾元 Primus”勾选框（默认勾选，仅全新安装 / 升级显示），`WixShellExec` 以安装者身份启动 |
| 快捷方式 | 公共开始菜单与公共桌面“乾元 Primus”，`System.AppUserModel.ID = com.primus.desktop`（通知归属） |
| 卸载信息 | `ARPPRODUCTICON`；`ARPNOMODIFY`（由 WixUI_InstallDir 提供；安装目录装后不可改，修复 / 卸载可用） |

CI（`.github/workflows/ci.yml` Windows 作业）构建 MSI 后用 `scripts/msi-smoke.ps1` 静默安装，检查布局、`data` 的 ACL（`BUILTIN\Users` 显式 Modify 且继承，显式与继承的 Users 授权都没有更改权限 / 取得所有权）、以中完整性级别（去掉管理员权限）实际写入 `data` 且写不进安装目录根、开始菜单快捷方式与 WebView2 处理、更新服务的安装与暂存目录 ACL，再卸载并确认 `data` 与其中文件仍在、服务与 `%ProgramData%\Primus` 已删除；随后 `scripts/update-service-smoke.ps1` 用 `scripts/build-upgrade-test-msi.mjs` 生成的两个更高版本的 MSI，以中完整性级别经命名管道验证静默升级、拒绝错签与降级、程序运行中时放弃安装。

共享句柄不撤销安装前已取得的 `WRITE_DAC`：不可信非空安装目录或程序对象不再就地修复，安装直接拒绝。
空的不可信根目录仅非递归删除后原子创建新的受保护目录；旧句柄不会授权访问新对象，创建竞争则失败。
父目录必须已存在且可信。`data` 不删除、不迁移；正常受保护安装目录可升级，历史上被放宽权限的安装应选择新目录。

`install-acl.ps1` 的 `Add-Type` 用已加载框架程序集的绝对路径作引用，工作目录里有同名原生 `System.dll` 时也不会被编译器误读。
拒绝用例同时校验退出码和对应的 ACL 拒绝原因，不能仅凭通用中止码判定通过。
