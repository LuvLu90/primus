# windows

- `Primus.wxs`：WiX 7 安装包定义（第 3.3 节）。`UpgradeCode` 固定为 `5B4199DD-C352-459A-AEB0-7119A884608F`，**永不改变**（MajorUpgrade 靠它识别旧版本）；`data` 目录组件的 GUID 同样固定。
- `webview2/`：WebView2 Evergreen 引导程序 `MicrosoftEdgeWebview2Setup.exe`（约 1.8MB）。不入库：`build-msi.mjs` 缺失时从微软官方地址下载，校验 Authenticode 签名有效且签名者为 Microsoft Corporation 后作为 `Binary` 打进 MSI；安装时注册表中查不到按机器安装的 WebView2（HKLM 32 位视图的 `pv` 为空或 `0.0.0.0`；MSI 面向所有用户，安装者 HKCU 下的按用户运行时不算）才以 SYSTEM 身份静默运行，失败则回滚安装。
- `Privacy.rtf`：安装界面的隐私政策页（MSI 的 `WixUILicenseRtf`，NSIS 的 `bundle.licenseFile`，两者同一份），中文以 RTF `\uN\'3f` 转义（Unicode 码点 + `?` 回退字符的十六进制形式，各解析器一致）；改文案时保持 RTF 有效（可用写字板打开另存）。
- `art/`：安装界面图片（24 位 BMP，由 `icons/icon.png` 生成）：`wix-banner.bmp`（493×58）、`wix-dialog.bmp`（493×312，左 164 像素为侧栏）给 MSI，`nsis-header.bmp`（150×57）、`nsis-sidebar.bmp`（164×314）给 NSIS，两套安装界面风格一致。
- `nsis/hooks.nsh`：NSIS 安装程序（第 3.4 节，Tauri `tauri bundle --bundles nsis` 生成，设置在 `tauri.conf.json` 的 `bundle.windows.nsis`）的安装钩子：安装后创建 `data` 并用 `icacls` 给 Users 组（SID `S-1-5-32-545`）授予“修改”(M)、`(OI)(CI)` 继承，与 MSI 一致；卸载时 Tauri 不递归删除安装目录，`data` 保留。文件带 UTF-8 BOM（makensis 据此按 UTF-8 读中文）。

构建：仓库根运行 `node scripts/build-msi.mjs --arch x64|arm64`（`tauri build --no-bundle` → 签名 → `wix build -arch <arch>` → 签名 MSI → SHA-256 → `tauri signer`，输出 `out/Primus_<ver>_<arch>_zh-CN.msi`；同一份 `Primus.wxs` 构建两种架构），再运行 `node scripts/build-nsis.mjs --arch <同一架构>` 输出 `out/Primus_<ver>_<arch>-setup.exe`。x64 等价的 WiX 命令（在仓库根执行；`CARGO_TARGET_DIR` 未设置时）：`wix build apps/desktop/src-tauri/windows/Primus.wxs -arch x64 -culture zh-CN -acceptEula wix7 -ext WixToolset.UI.wixext -ext WixToolset.Util.wixext -bindpath app=apps/desktop/src-tauri/target/release -bindpath core=dist/agent-core -bindpath runtime=dist/runtime -d ProductVersion=<主.次.(修订×100+阶段).0，见第 3.3.3 节> -d ShellDir=apps/desktop/src-tauri -d WebView2Setup=<引导程序路径> -o out/Primus_<ver>_x64_zh-CN.msi`

`core`、`runtime` 两个目录由仓库根的 `pnpm build:core` 生成（目录结构见根 README「Core 产物与内置运行时」）：`dist/agent-core/` 整目录收进 `resources\agent-core\`（`manifest.json` 列出每个文件的 SHA-256），`dist/runtime/` 只有官方 `node.exe` 与 `LICENSE`，收进 `resources\runtime\`。打 MSI 前先运行 `pnpm build:extensions`，把 `primus-bundle.js` 写入 `dist/agent-core/extensions/`。`node.exe` 保留 OpenJS 官方签名，不重签。

## 安装包要点（第 3.3.2 节）

| 内容 | 做法 |
|---|---|
| 安装目录可选 | `WixUI_InstallDir`，默认 `C:\Program Files\Primus`；静默安装可传 `INSTALLFOLDER="D:\某目录"` |
| 主程序与资源 | `Primus.exe` 在安装目录根；`resources\runtime`、`resources\agent-core` 用 `<Files>` 整目录收集 |
| 安装目录 ACL | MSI 的 `CheckInstallDir` / `ResetProgramAcl` 与 NSIS 预安装钩子共用 `windows/install-acl.ps1`：检查祖先路径，用 `SetKernelObjectSecurity` 只锁定目录自身（不传播权限），保持句柄并冻结、检查程序树，拒绝重解析点和多重硬链接，全部检查通过后才修复程序文件 ACL。MSI 的 `InstallDirAcl` 组件另用 `PermissionEx Sddl`（MsiLockPermissionsEx）设置同一受保护 DACL：SYSTEM、Administrators 完全控制，Users 与应用包读取和执行；`data` 不参与程序文件修复 |
| `data` 目录 | `CreateFolder` + `util:PermissionEx` 给本地化的 Users 组（`util:QueryWindowsWellKnownSIDs` 查出的 `[WIX_ACCOUNT_USERS]`）授予“修改”(M)，继承到子项；组件 `Permanent`，卸载与升级保留 |
| 升级 | `MajorUpgrade` + 固定 `UpgradeCode`；降级给出中文提示。安装目录写入 `HKLM\Software\Primus\InstallDir`，重大升级时（未显式传 `INSTALLFOLDER`）由 `AppSearch` 读回并沿用，装在其他盘的实例升级后仍在原目录、复用原 `data` |
| WebView2 | 注册表检测，缺失时运行内嵌引导程序 |
| 完成页 | “立即启动 乾元 Primus”勾选框（默认勾选，仅全新安装 / 升级显示），`WixShellExec` 以安装者身份启动；NSIS 完成页由 Tauri 模板提供同样的勾选框 |
| 快捷方式 | 公共开始菜单“乾元 Primus”，`System.AppUserModel.ID = com.primus.desktop`（通知归属） |
| 卸载信息 | `ARPPRODUCTICON`；`ARPNOMODIFY`（由 WixUI_InstallDir 提供；安装目录装后不可改，修复 / 卸载可用） |

CI（`.github/workflows/ci.yml` Windows 作业）构建 MSI 后用 `scripts/msi-smoke.ps1` 静默安装，检查布局、`data` 的 ACL（`BUILTIN\Users` 显式 Modify 且继承，显式与继承的 Users 授权都没有更改权限 / 取得所有权）、以中完整性级别（去掉管理员权限）实际写入 `data` 且写不进安装目录根、开始菜单快捷方式与 WebView2 处理，再卸载并确认 `data` 与其中文件仍在。

共享句柄不撤销安装前已取得的 `WRITE_DAC`：不可信非空安装目录或程序对象不再就地修复，安装直接拒绝。
空的不可信根目录仅非递归删除后原子创建新的受保护目录；旧句柄不会授权访问新对象，创建竞争则失败。
父目录必须已存在且可信。`data` 不删除、不迁移；正常受保护安装目录可升级，历史上被放宽权限的安装应选择新目录。

NSIS 的插件目录包含原生 `System.dll`，`install-acl.ps1` 的 `Add-Type` 必须用已加载框架程序集的绝对路径作引用，避免编译器误读插件。
预安装钩子把脚本输出保留在安装详情中，并在父进程提供 stdout 时输出 UTF-16 诊断；
`nsis-smoke.ps1` 将其保存到仓库 `.dev-data/nsis-smoke/` 并打印到 CI 日志。
拒绝用例同时校验退出码 2 和对应的 ACL 拒绝原因，不能仅凭通用中止码判定通过。
