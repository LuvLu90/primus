; 乾元 Primus NSIS 安装钩子（tauri.conf.json → bundle.windows.nsis.installerHooks，技术方案第 3.4 节）。
; 文件带 UTF-8 BOM：makensis 按 BOM 识别编码，否则中文按系统代码页解析成乱码。
;
; data 目录与 Primus.wxs 一致（第 3.3.2 节、第 4 章）：安装在 Program Files 时普通用户默认无写权限，
; 这里给 Users 组授予“修改”(M) 并 (OI)(CI) 继承到子目录与文件。用 SID S-1-5-32-545 而不是组名，
; 中文系统上 Users 组名不是 “Users”。卸载时 Tauri 只删除自己安装的文件，安装目录用不带 /r 的 RMDir，
; data 与其中文件保留（与 MSI 的 Permanent 组件一致）。
!include LogicLib.nsh

!macro NSIS_HOOK_PREINSTALL
  ; 安装目录本身与 Primus.wxs 的 InstallDirAcl 一致，在复制文件之前设置，已安装的文件从这里继承：
  ; 装到 D:\primus 这类自选目录时会继承盘根的 ACL（非系统盘根默认给 Authenticated Users “修改”），
  ; 目录也可能由普通用户预先建好（所有者保有隐式的更改权限，或带显式授权）。所以依次：
  ; 所有者改为 Administrators → /reset 清掉显式授权 → 去掉继承，改为 SYSTEM、Administrators 完全控制、
  ; Users 与应用包只读和执行，(OI)(CI) 传播到子项。不加 /T：升级安装时 data\users\<SID> 是受保护的，不能改写
  CreateDirectory "$INSTDIR"
  nsExec::ExecToLog '"$SYSDIR\icacls.exe" "$INSTDIR" /setowner *S-1-5-32-544'
  Pop $0
  ${If} $0 != 0
    MessageBox MB_ICONSTOP|MB_OK "无法设置安装目录所有者（icacls 退出码 $0）：$INSTDIR" /SD IDOK
    SetErrorLevel 2
    Abort
  ${EndIf}
  nsExec::ExecToLog '"$SYSDIR\icacls.exe" "$INSTDIR" /reset'
  Pop $0
  ${If} $0 == 0
    nsExec::ExecToLog '"$SYSDIR\icacls.exe" "$INSTDIR" /inheritance:r /grant:r *S-1-5-18:(OI)(CI)F *S-1-5-32-544:(OI)(CI)F *S-1-5-32-545:(OI)(CI)RX *S-1-15-2-1:(OI)(CI)RX'
    Pop $0
  ${EndIf}
  ${If} $0 != 0
    MessageBox MB_ICONSTOP|MB_OK "无法设置安装目录权限（icacls 退出码 $0）：$INSTDIR" /SD IDOK
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
