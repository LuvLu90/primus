# 乾元 Primus：从旧 NSIS 版迁移到 MSI 时静默卸载 NSIS 版（ADR 0007）。由 Primus.wxs 的 RemoveNsis 以 SYSTEM 身份运行，
# 排在 CheckInstallDir 之前；MSI 已把 INSTALLFOLDER 设为 NSIS 版的安装目录，卸载后在原目录安装、继续使用原来的 data。
#
# 调用：powershell.exe -Command "& ([ScriptBlock]::Create(<本脚本 Base64>)) #|<NSIS 安装目录>|"
#      （build-msi.mjs 与 install-acl.ps1 同样去掉整行注释与空行后按 UTF-16LE 编码，写进 primus-scripts.wxi 的 RemoveNsisScript 交给 wix）
#
# - NSIS 卸载程序以 /S（静默）与 _?=<目录>（就地运行并等待结束）运行；静默时不勾选“删除应用数据”，data 保留
#   （hooks.nsh 的卸载只删自己安装的文件）。就地运行的卸载程序删不掉自身，结束后由本脚本删除 uninstall.exe。
# - 以 SYSTEM 身份运行目录里的 exe 之前先确认它是可信的：卸载程序与其所在目录都不是重解析点，所有者为 SYSTEM 或
#   Administrators，SYSTEM、Administrators、TrustedInstaller 以外的主体没有写入、删除、改权限、取得所有权的权限
#   （NSIS 版安装时 hooks.nsh 已按 install-acl.ps1 锁好安装目录）。不可信就失败（安装回滚），不运行它：
#   否则普通用户可在自选目录里放一个 uninstall.exe，借安装程序以 SYSTEM 身份运行。
# - 卸载成功后删除 NSIS 版记在 HKLM\Software\乾元 Primus\Primus 的安装目录（MSI 用它定位旧版），父键为空时一并删除。
# 任何失败退出码 1：MSI 回滚（NSIS 版若已卸载则不会恢复，data 不受影响，重新运行安装包即可）。
# 只用 Windows PowerShell 5.1 自带功能；代码中只用 ASCII 引号。
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2
trap { [Console]::Out.WriteLine("primus-remove-nsis: error: $_"); exit 1 }

$marks = [regex]::Matches([Environment]::CommandLine, '#\|([^|"]+)\|')
if ($marks.Count -eq 0) { throw 'no #|dir| marker on the command line' }
$raw = $marks[$marks.Count - 1].Groups[1].Value.TrimEnd('\')
if ($raw -notmatch '^[A-Za-z]:\\[^\\]') { throw "NSIS install dir must be an absolute path on a local drive: $raw" }
$dir = [IO.Path]::GetFullPath($raw)
if ($dir -cne $raw) { throw "NSIS install dir is not in canonical form: $raw" }
$uninstaller = Join-Path $dir 'uninstall.exe'
if (-not [IO.File]::Exists($uninstaller)) {
  [Console]::Out.WriteLine("primus-remove-nsis: no uninstaller in $dir, nothing to do")
  exit 0
}

# SYSTEM、Administrators、TrustedInstaller
$Trusted = @('S-1-5-18', 'S-1-5-32-544', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
# 写入数据 0x2、追加 0x4、写扩展属性 0x10、删除子项 0x40、写属性 0x100、删除 0x10000、改权限 0x40000、
# 取得所有权 0x80000、通用全部 0x10000000、通用写 0x40000000
$WriteMask = 0x2 -bor 0x4 -bor 0x10 -bor 0x40 -bor 0x100 -bor 0x10000 -bor 0x40000 -bor 0x80000 -bor 0x10000000 -bor 0x40000000
function Assert-Trusted([string] $Path) {
  $item = Get-Item -LiteralPath $Path -Force
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "not removing NSIS install: $Path is a reparse point" }
  $acl = Get-Acl -LiteralPath $Path
  $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
  if ($owner -notin $Trusted) { throw "not removing NSIS install: $Path is owned by $owner" }
  foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
    if ($rule.AccessControlType -ne 'Allow') { continue }
    if ($rule.IdentityReference.Value -in $Trusted) { continue }
    # CREATOR OWNER 只用于继承，不作用于对象本身
    if ($rule.IdentityReference.Value -eq 'S-1-3-0') { continue }
    if (([int64]$rule.FileSystemRights -band $WriteMask) -ne 0) {
      throw "not removing NSIS install: $($rule.IdentityReference.Value) can modify $Path"
    }
  }
}
Assert-Trusted $dir
Assert-Trusted $uninstaller

[Console]::Out.WriteLine("primus-remove-nsis: uninstalling NSIS version in $dir")
$p = Start-Process -FilePath $uninstaller -ArgumentList @('/S', "_?=$dir") -Wait -PassThru -WindowStyle Hidden
if ($p.ExitCode -ne 0) { throw "NSIS uninstaller exited with $($p.ExitCode)" }
Remove-Item -LiteralPath $uninstaller -Force

$key = 'HKLM:\Software\乾元 Primus'
if (Test-Path -LiteralPath "$key\Primus") { Remove-Item -LiteralPath "$key\Primus" -Recurse -Force }
if (Test-Path -LiteralPath $key) {
  $parent = Get-Item -LiteralPath $key
  if ($parent.SubKeyCount -eq 0 -and $parent.ValueCount -eq 0) { Remove-Item -LiteralPath $key -Force }
}
[Console]::Out.WriteLine("primus-remove-nsis: NSIS version removed, data kept in $dir\data")
