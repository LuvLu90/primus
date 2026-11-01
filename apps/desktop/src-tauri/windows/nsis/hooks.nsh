; 乾元 Primus NSIS 安装钩子（tauri.conf.json → bundle.windows.nsis.installerHooks，技术方案第 3.4 节）。
; 文件带 UTF-8 BOM：makensis 按 BOM 识别编码，否则中文按系统代码页解析成乱码。
;
; data 目录与 Primus.wxs 一致（第 3.3.2 节、第 4 章）：安装在 Program Files 时普通用户默认无写权限，
; 这里给 Users 组授予“修改”(M) 并 (OI)(CI) 继承到子目录与文件。用 SID S-1-5-32-545 而不是组名，
; 中文系统上 Users 组名不是 “Users”。卸载时 Tauri 只删除自己安装的文件，安装目录用不带 /r 的 RMDir，
; data 与其中文件保留（与 MSI 的 Permanent 组件一致）。
!include LogicLib.nsh

!macro NSIS_HOOK_POSTINSTALL
  ; 安装目录本身与 Primus.wxs 的 InstallDirAcl 一致：装到 D:\primus 这类自选目录时会继承盘根的 ACL
  ; （非系统盘根默认给 Authenticated Users “修改”），这里去掉继承，改为 SYSTEM、Administrators 完全控制、
  ; Users 只读和执行，(OI)(CI) 传播到已安装的文件与子目录（data\users\<SID> 自身受保护，不受影响）
  nsExec::ExecToLog '"$SYSDIR\icacls.exe" "$INSTDIR" /inheritance:r /grant:r *S-1-5-18:(OI)(CI)F *S-1-5-32-544:(OI)(CI)F *S-1-5-32-545:(OI)(CI)RX *S-1-15-2-1:(OI)(CI)RX'
  Pop $0
  ${If} $0 != 0
    MessageBox MB_ICONSTOP|MB_OK "无法设置安装目录权限（icacls 退出码 $0）：$INSTDIR" /SD IDOK
    SetErrorLevel 2
    Abort
  ${EndIf}
  CreateDirectory "$INSTDIR\data"
  nsExec::ExecToLog '"$SYSDIR\icacls.exe" "$INSTDIR\data" /grant *S-1-5-32-545:(OI)(CI)M'
  Pop $0
  ${If} $0 != 0
    MessageBox MB_ICONSTOP|MB_OK "无法为数据目录授予写入权限（icacls 退出码 $0）：$INSTDIR\data" /SD IDOK
    SetErrorLevel 2
    Abort
  ${EndIf}
!macroend
