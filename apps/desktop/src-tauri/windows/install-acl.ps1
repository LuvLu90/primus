# 乾元 Primus 安装目录 ACL 处理：Primus.wxs 的 CheckInstallDir / ResetProgramAcl 与 nsis/hooks.nsh 的
# NSIS_HOOK_PREINSTALL 共用这一份逻辑（技术方案第 3.3.2 节、第 4 章；约束 C2：可装到其他盘）。
#
# 背景：安装目录可能由普通用户预先建好（D:\primus 这类自选目录继承盘根 ACL，非系统盘根默认给 Authenticated Users
# 修改权限），里面可能有同名的 Primus.exe、resources，所有者是该用户（隐含 WRITE_DAC），也可能放了联接或符号链接。
# icacls 默认跟随重解析点，所以改权限之前先确认安装目录及其每一级祖先、直接子项都不是重解析点；
# 祖先目录还必须是普通用户改不动的：所有者为 SYSTEM、Administrators 或 TrustedInstaller，其他主体没有
# 删除（盘根除外）、删除子项、更改权限、取得所有权，否则普通用户可在检查之后把安装目录或某一级祖先改名，
# 在原路径放上联接。安装目录本身锁好之后再确认一遍（不是重解析点、已锁好）：锁好之前若被换成联接，
# 带 /L 的 icacls 改的是联接本身，复查即失败；复查通过后普通用户不能再改名或替换安装目录及其祖先。
# 程序文件自上而下处理：先把目录锁好（所有者 Administrators、清掉显式授权、改为从已锁好的上级继承），
# 普通用户就不能再往里新建项，再检查并处理其子项，检查与修改之间不会被插入联接；有多个硬链接的文件
# 拒绝处理（改它的所有者与 ACL 会改到安装目录之外的同一文件）。
#
# 调用：命令行中带标记 #|<模式>|<安装目录>|，从 [Environment]::CommandLine 读取，不经 cmd.exe，
# 路径中的 % $ 引号等都按字面处理：
#   MSI：powershell.exe -Command "& ([ScriptBlock]::Create(<本脚本 Base64>)) #|lock|[INSTALLFOLDER]|"
#        （build-msi.mjs 去掉整行注释与空行后按 UTF-16LE 编码，-d InstallAclScript 传给 wix）
#   NSIS：powershell.exe -File <本脚本> "#|nsis|$INSTDIR|"
# 模式：
#   lock   检查安装路径，建目录，把安装目录设为受保护 DACL（与 Primus.wxs InstallDirAcl 一致），再检查并确认已锁好
#          （MSI CreateFolders 之前）
#   reset  检查安装路径并确认安装目录已锁好，自上而下处理已存在的 Primus.exe、uninstall.exe、resources 树
#          （MSI 设好受保护 DACL 之后、安装文件之前）
#   nsis   lock 后 reset
# 检查安装路径：安装目录及每一级祖先不是重解析点，已存在的祖先普通用户改不动，目录已存在时直接子项不是重解析点。
# data 不动：其中 users\<SID> 是受保护的，归各用户所有。任何失败退出码 1，安装回滚或中止，已改的 ACL 不还原：
# 被改的只是安装目录本身与其中同名的程序文件，保持锁定比还原成普通用户可改的状态更安全。
# 只用 Windows PowerShell 5.1 与 .NET Framework 自带功能；代码中只用 ASCII 引号（PowerShell 把弯引号也当引号）。
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2
# 错误写到标准输出：WixQuietExec 把它记进 MSI 日志，nsExec::ExecToLog 记进 NSIS 详细信息
trap { [Console]::Out.WriteLine("primus-install-acl: error: $_"); exit 1 }

$marks = [regex]::Matches([Environment]::CommandLine, '#\|(lock|reset|nsis)\|([^|"]+)\|')
if ($marks.Count -eq 0) { throw 'no #|mode|dir| marker on the command line' }
$mode = $marks[$marks.Count - 1].Groups[1].Value
$raw = $marks[$marks.Count - 1].Groups[2].Value.TrimEnd('\')
# 只接受本地盘符下的绝对路径（不含盘根本身），且已是规范形式（不含 . .. 、结尾的点与空格等）
if ($raw -notmatch '^[A-Za-z]:\\[^\\]') { throw "install dir must be an absolute path on a local drive: $raw" }
$dir = [IO.Path]::GetFullPath($raw)
if ($dir -cne $raw) { throw "install dir is not in canonical form: $raw (canonical: $dir)" }

$Admins = 'S-1-5-32-544'
$Trusted = @('S-1-5-18', $Admins)
# 祖先目录的所有者还可以是 TrustedInstaller（C:\、C:\Program Files）；OWNER RIGHTS 随所有者（已确认可信），
# CREATOR OWNER 只用于继承
$AncestorTrusted = $Trusted + @('S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464', 'S-1-3-0', 'S-1-3-4')
# 祖先目录上其他主体不能有：删除 0x10000、更改权限 0x40000、取得所有权 0x80000、删除子项 0x40、通用全部 0x10000000
$AncestorDenyMask = 0x10000 -bor 0x40000 -bor 0x80000 -bor 0x40 -bor 0x10000000
# 其他主体只允许读取与执行（0x1200a9）及通用读、通用执行
$ReadOnlyMask = [int]0x1200a9 -bor [int]0x20000000 -bor [int]::MinValue
$Icacls = Join-Path ([Environment]::SystemDirectory) 'icacls.exe'
$Fsutil = Join-Path ([Environment]::SystemDirectory) 'fsutil.exe'
$script:fixed = 0

function Test-Exists([string] $Path) { [IO.Directory]::Exists($Path) -or [IO.File]::Exists($Path) }

# 不跟随重解析点：GetAttributes 读的是联接 / 符号链接本身（目标不存在时也能读到）
function Test-Link([string] $Path) { ([IO.File]::GetAttributes($Path) -band [IO.FileAttributes]::ReparsePoint) -ne 0 }

# 普通用户改不动的祖先目录：既不能改名、删除（盘根本来就不能），也不能删除其中的子项或改它的权限、所有者。
# 只看作用于该目录本身的允许项（不含仅继承项）；拒绝项不计，偏保守
function Assert-SafeAncestor([string] $Path) {
  $sec = [IO.Directory]::GetAccessControl($Path)
  $owner = $sec.GetOwner([Security.Principal.SecurityIdentifier]).Value
  if ($AncestorTrusted -notcontains $owner) { throw "parent directory is not owned by SYSTEM, Administrators or TrustedInstaller ($owner): $Path" }
  $mask = $AncestorDenyMask
  if (-not [IO.Path]::GetDirectoryName($Path)) { $mask = $mask -band -bnot 0x10000 }
  foreach ($rule in $sec.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
    if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) { continue }
    if (($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0) { continue }
    if ($AncestorTrusted -contains $rule.IdentityReference.Value) { continue }
    if (([int]$rule.FileSystemRights -band $mask) -ne 0) {
      throw "parent directory can be renamed or changed by $($rule.IdentityReference.Value) (rights 0x$(([int]$rule.FileSystemRights).ToString('x'))): $Path"
    }
  }
}

function Assert-InstallPath {
  $p = $dir
  while ($p) {
    if ((Test-Exists $p) -and (Test-Link $p)) { throw "install dir or one of its parents is a junction or symbolic link: $p" }
    $p = [IO.Path]::GetDirectoryName($p)
  }
  if ([IO.File]::Exists($dir)) { throw "install dir is a file: $dir" }
  $p = [IO.Path]::GetDirectoryName($dir)
  while ($p) {
    if (Test-Exists $p) { Assert-SafeAncestor $p }
    $p = [IO.Path]::GetDirectoryName($p)
  }
  if ([IO.Directory]::Exists($dir)) {
    foreach ($child in [IO.Directory]::GetFileSystemEntries($dir)) {
      if (Test-Link $child) { throw "install dir contains a junction or symbolic link: $child" }
    }
  }
}

function Invoke-Icacls([string[]] $IcaclsArgs) {
  $null = & $Icacls @IcaclsArgs
  if ($LASTEXITCODE -ne 0) { throw "icacls $($IcaclsArgs -join ' ') exited with $LASTEXITCODE" }
}

# 已锁好：所有者为 SYSTEM 或 Administrators，没有显式授权（安装目录本身是受保护的显式授权，$AllowExplicit），
# 其他主体只有读取与执行
function Test-Locked([string] $Path, [bool] $IsDir, [bool] $AllowExplicit = $false) {
  try {
    if ($IsDir) { $sec = [IO.Directory]::GetAccessControl($Path) } else { $sec = [IO.File]::GetAccessControl($Path) }
    if ($Trusted -notcontains $sec.GetOwner([Security.Principal.SecurityIdentifier]).Value) { return $false }
    foreach ($rule in $sec.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
      if (-not ($rule.IsInherited -or $AllowExplicit)) { return $false }
      if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) { continue }
      if ($Trusted -contains $rule.IdentityReference.Value) { continue }
      if (([int]$rule.FileSystemRights -band -bnot $ReadOnlyMask) -ne 0) { return $false }
    }
    return $true
  } catch {
    return $false
  }
}

# 硬链接数（每个链接一行）；目录不会有多个硬链接
function Get-LinkCount([string] $Path) {
  $names = @(& $Fsutil hardlink list $Path)
  if ($LASTEXITCODE -ne 0) { throw "fsutil hardlink list $Path exited with $LASTEXITCODE" }
  @($names | Where-Object { $_ -and $_.Trim() }).Count
}

# 自上而下：先锁好一项再看它的子项（显式栈，避免深层目录超出 PowerShell 调用深度）。
# 上级已锁好，普通用户不能在其中新建或替换项，检查之后路径指向的仍是同一文件
function Repair-ProgramFiles {
  $stack = New-Object 'System.Collections.Generic.Stack[string]'
  foreach ($name in 'Primus.exe', 'uninstall.exe', 'resources') {
    $item = Join-Path $dir $name
    if (Test-Exists $item) { $stack.Push($item) }
  }
  while ($stack.Count -gt 0) {
    $item = $stack.Pop()
    if (Test-Link $item) { throw "program files contain a junction or symbolic link: $item" }
    $isDir = [IO.Directory]::Exists($item)
    if (-not $isDir -and (Get-LinkCount $item) -gt 1) { throw "program file has more than one hard link: $item" }
    if (-not (Test-Locked $item $isDir)) {
      Invoke-Icacls @($item, '/setowner', "*$Admins", '/L', '/Q')
      Invoke-Icacls @($item, '/reset', '/L', '/Q')
      $script:fixed++
    }
    if ($isDir) {
      foreach ($child in [IO.Directory]::GetFileSystemEntries($item)) { $stack.Push($child) }
    }
  }
}

# 与 Primus.wxs InstallDirAcl 的 O:BAD:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;BU)(A;OICI;0x1200a9;;;AC) 一致。
# 不加 /T：升级安装时 data\users\<SID> 是受保护的，不能改写
function Lock-InstallDir {
  Invoke-Icacls @($dir, '/setowner', "*$Admins", '/L', '/Q')
  Invoke-Icacls @($dir, '/reset', '/L', '/Q')
  Invoke-Icacls @($dir, '/inheritance:r', '/grant:r', '*S-1-5-18:(OI)(CI)F', "*${Admins}:(OI)(CI)F", '*S-1-5-32-545:(OI)(CI)RX', '*S-1-15-2-1:(OI)(CI)RX', '/L', '/Q')
}

Assert-InstallPath
if ($mode -ne 'reset') {
  if (-not (Test-Exists $dir)) { $null = [IO.Directory]::CreateDirectory($dir) }
  Assert-InstallPath
  Lock-InstallDir
}
Assert-InstallPath
if (-not (Test-Locked $dir $true $true)) { throw "install dir is not locked (owner SYSTEM or Administrators, others read and execute only): $dir" }
if ($mode -ne 'lock') { Repair-ProgramFiles }
[Console]::Out.WriteLine("primus-install-acl: $mode $dir ok (reset $($script:fixed) items)")
exit 0
