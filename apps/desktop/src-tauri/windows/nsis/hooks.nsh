; 乾元 Primus NSIS 安装钩子（tauri.conf.json → bundle.windows.nsis.installerHooks，技术方案第 3.4 节）。
; 文件带 UTF-8 BOM：makensis 按 BOM 识别编码，否则中文按系统代码页解析成乱码。
;
; data 目录与 Primus.wxs 一致（第 3.3.2 节、第 4 章）：安装在 Program Files 时普通用户默认无写权限，
; 这里给 Users 组授予“修改”(M) 并 (OI)(CI) 继承到子目录与文件。用 SID S-1-5-32-545 而不是组名，
; 中文系统上 Users 组名不是 “Users”。卸载时 Tauri 只删除自己安装的文件，安装目录用不带 /r 的 RMDir，
; data 与其中文件保留（与 MSI 的 Permanent 组件一致）。
!include LogicLib.nsh

; 安装目录中预先存在的程序文件（目录由普通用户预先建好并放入同名文件）：覆盖安装时文件沿用原有的安全描述符，
; 所有者仍是该用户，隐含 WRITE_DAC，可改回 DACL 后替换程序。复制文件之前把所有者改为 Administrators，
; 再 /reset 清掉显式授权、改为从安装目录继承（受保护的 DACL，Users 只读和执行）。不存在则跳过（全新安装）。
!macro PRIMUS_RESET_PROGRAM_ITEM ITEM FLAGS
  ${If} ${FileExists} "$INSTDIR\${ITEM}"
    nsExec::ExecToLog '"$SYSDIR\icacls.exe" "$INSTDIR\${ITEM}" /setowner *S-1-5-32-544 ${FLAGS}'
    Pop $0
    ${If} $0 == 0
      nsExec::ExecToLog '"$SYSDIR\icacls.exe" "$INSTDIR\${ITEM}" /reset ${FLAGS}'
      Pop $0
    ${EndIf}
    ${If} $0 != 0
      MessageBox MB_ICONSTOP|MB_OK "无法重置已有程序文件的所有者与权限（icacls 退出码 $0）：$INSTDIR\${ITEM}" /SD IDOK
      SetErrorLevel 2
      Abort
    ${EndIf}
  ${EndIf}
!macroend

; 重解析点检查：dir /a:l 只列出重解析点（联接、符号链接），一个都没有时退出码为 1。
; 其余退出码（找到了、或无法检查）都中止安装：icacls /T 默认跟随重解析点，会改到安装目录之外。
!macro PRIMUS_REJECT_REPARSE_POINTS DIRARGS WHAT
  nsExec::ExecToLog '"$SYSDIR\cmd.exe" /d /c dir /b /a:l ${DIRARGS}'
  Pop $0
  ${If} $0 != 1
    MessageBox MB_ICONSTOP|MB_OK "${WHAT}含有联接或符号链接（或无法检查，退出码 $0），为安全起见中止安装：$INSTDIR" /SD IDOK
    SetErrorLevel 2
    Abort
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREINSTALL
  ; 安装目录本身与 Primus.wxs 的 InstallDirAcl 一致，在复制文件之前设置，已安装的文件从这里继承：
  ; 装到 D:\primus 这类自选目录时会继承盘根的 ACL（非系统盘根默认给 Authenticated Users “修改”），
  ; 目录也可能由普通用户预先建好（所有者保有隐式的更改权限，或带显式授权）。所以依次：
  ; 所有者改为 Administrators → /reset 清掉显式授权 → 去掉继承，改为 SYSTEM、Administrators 完全控制、
  ; Users 与应用包只读和执行，(OI)(CI) 传播到子项。不加 /T：升级安装时 data\users\<SID> 是受保护的，不能改写
  CreateDirectory "$INSTDIR"
  ; 安装目录本身是重解析点就拒绝：下面的 icacls 会顺着它改到别处（fsutil 对非重解析点返回非 0）
  nsExec::ExecToLog '"$SYSDIR\fsutil.exe" reparsepoint query "$INSTDIR"'
  Pop $0
  ${If} $0 == 0
    MessageBox MB_ICONSTOP|MB_OK "安装目录是联接或符号链接，为安全起见中止安装：$INSTDIR" /SD IDOK
    SetErrorLevel 2
    Abort
  ${EndIf}
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
  ; 程序文件逐项处理（data 除外：其中 users\<SID> 是受保护的，归各用户所有）。安装目录此时已是受保护的 DACL，
  ; 普通用户不能再新建项；先确认直接子项与 resources 整棵树里没有重解析点
  !insertmacro PRIMUS_REJECT_REPARSE_POINTS '"$INSTDIR\*"' "安装目录"
  ${If} ${FileExists} "$INSTDIR\resources"
    !insertmacro PRIMUS_REJECT_REPARSE_POINTS '/s "$INSTDIR\resources\*"' "resources 目录"
  ${EndIf}
  !insertmacro PRIMUS_RESET_PROGRAM_ITEM "Primus.exe" ""
  !insertmacro PRIMUS_RESET_PROGRAM_ITEM "uninstall.exe" ""
  !insertmacro PRIMUS_RESET_PROGRAM_ITEM "resources" "/T /Q"
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
