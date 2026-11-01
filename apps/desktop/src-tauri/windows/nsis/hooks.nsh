; 乾元 Primus NSIS 安装钩子（tauri.conf.json → bundle.windows.nsis.installerHooks，技术方案第 3.4 节）。
; 文件带 UTF-8 BOM：makensis 按 BOM 识别编码，否则中文按系统代码页解析成乱码。
;
; data 目录与 Primus.wxs 一致（第 3.3.2 节、第 4 章）：安装在 Program Files 时普通用户默认无写权限，
; 这里给 Users 组授予“修改”(M) 并 (OI)(CI) 继承到子目录与文件。用 SID S-1-5-32-545 而不是组名，
; 中文系统上 Users 组名不是 “Users”。卸载时 Tauri 只删除自己安装的文件，安装目录用不带 /r 的 RMDir，
; data 与其中文件保留（与 MSI 的 Permanent 组件一致）。
!include LogicLib.nsh

!macro NSIS_HOOK_PREINSTALL
  ; 安装目录与 Primus.wxs 的 InstallDirAcl 一致，在复制文件之前设置，已安装的文件从这里继承：
  ; 装到 D:\primus 这类自选目录时会继承盘根的 ACL（非系统盘根默认给 Authenticated Users “修改”），
  ; 目录也可能由普通用户预先建好（所有者保有隐式的更改权限、带显式授权，或放了同名程序文件、联接）。
  ; 逻辑在 windows/install-acl.ps1（与 MSI 的 CheckInstallDir / ResetProgramAcl 共用）的 nsis 模式：
  ; 安装目录及每一级祖先、直接子项都不能是重解析点 → 建目录 → 所有者 Administrators、/reset、去掉继承，
  ; SYSTEM、Administrators 完全控制，Users 与应用包只读和执行 → 再检查 → 自上而下处理已有的
  ; Primus.exe、uninstall.exe、resources 树。data 不动（其中 users\<SID> 是受保护的，归各用户所有）。
  ; 路径经命令行末尾的标记 "#|nsis|<目录>|" 传入，不经 cmd.exe；脚本放在 $PLUGINSDIR（仅管理员可写）。
  InitPluginsDir
  File "/oname=$PLUGINSDIR\primus-install-acl.ps1" "${__FILEDIR__}\..\install-acl.ps1"
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\primus-install-acl.ps1" "#|nsis|$INSTDIR|"'
  Pop $0
  ${If} $0 != 0
    MessageBox MB_ICONSTOP|MB_OK "无法安全地准备安装目录（install-acl.ps1 退出码 $0）：安装目录或其上级可能是联接或符号链接，或无法设置权限。$INSTDIR" /SD IDOK
    SetErrorLevel 2
    Abort
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  CreateDirectory "$INSTDIR\data"
  nsExec::ExecToLog '"$SYSDIR\icacls.exe" "$INSTDIR\data" /grant *S-1-5-32-545:(OI)(CI)M'
  Pop $0
  ${If} $0 != 0
    MessageBox MB_ICONSTOP|MB_OK "无法为数据目录授予写入权限（icacls 退出码 $0）：$INSTDIR\data" /SD IDOK
    SetErrorLevel 2
    Abort
  ${EndIf}
!macroend
