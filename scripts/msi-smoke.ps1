#requires -Version 7.2
<#
.SYNOPSIS
  MSI 静默安装 / 卸载冒烟（技术方案第 3.2、3.3、3.5、23 章）。CI 的 Windows 作业与安装测试虚拟机共用。

.DESCRIPTION
  1. msiexec /i 静默安装到指定目录（默认 C:\Program Files\Primus），失败时输出安装日志末尾
  2. 检查安装布局：Primus.exe、resources\runtime\node.exe（官方签名）、resources\agent-core（按 manifest.json
     逐个校验 SHA-256，确认 WiX 的 Files 收集完整）、Core 的 MIT 许可文件 LICENSE、primus-bundle.js、
     卸载信息、HKLM 中的安装目录记录（重大升级沿用原目录）、开始菜单快捷方式
  3. data 目录：ACL 含 BUILTIN\Users（S-1-5-32-545）显式“修改”且继承到子项；有 gsudo 时再以中完整性级别
     （管理员组降为仅拒绝，相当于普通用户）实际写入 data，并确认写不进安装目录根
  4. WebView2：安装前已有运行时则引导程序应被跳过；没有则应运行，装完后注册表中有版本
  5. 用安装目录里的 node.exe 跑 Core RPC 冒烟（scripts/smoke-core-rpc.mjs --entry/--node）
  6. 在 data 中留一个文件后 msiexec /x 静默卸载：程序文件、快捷方式、卸载信息、安装目录记录被移除，data 与其中文件保留
  7. 清理保留的 data（-KeepData 时不清理），便于重复运行

  需要管理员权限（按机器安装）。任何一步不符合预期即抛错，退出码非 0。

.PARAMETER Msi
  MSI 路径。

.PARAMETER InstallDir
  安装目录（传给 INSTALLFOLDER 属性），默认 "$env:ProgramFiles\Primus"。可传含中文与空格的路径。

.PARAMETER Node
  运行 smoke-core-rpc.mjs 的 Node.js（只用来驱动冒烟脚本；Core 本身由安装目录里的 node.exe 运行）。
  默认用安装目录中的 resources\runtime\node.exe（不依赖 PATH）；找不到 smoke-core-rpc.mjs 时冒烟失败。

.PARAMETER Gsudo
  gsudo.exe 路径，用于中完整性级别写入测试。默认取 PATH 中的 gsudo；找不到时只做 ACL 检查。

.PARAMETER ExtraChecks
  安装检查与 Core 冒烟之后、卸载之前调用的附加检查脚本（如 scripts/install-matrix/matrix-checks.ps1），
  以 -InstallDir <安装目录> 及 -ExtraChecksArgs 中的参数调用；抛错即冒烟失败（仍会尝试卸载清理）。

.PARAMETER ExtraChecksArgs
  传给 -ExtraChecks 脚本的其他参数（哈希表，如 @{ Gui = $true }）。

.PARAMETER KeepInstalled
  只安装与检查，不卸载（虚拟机手工测试时使用）。

.PARAMETER KeepData
  卸载后不删除保留下来的 data 目录。

.EXAMPLE
  pwsh -File scripts/msi-smoke.ps1 -Msi out/Primus_0.0.0_x64_zh-CN.msi
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)] [string] $Msi,
  [string] $InstallDir = (Join-Path $env:ProgramFiles 'Primus'),
  [string] $Node,
  [string] $Gsudo,
  [string] $LogDir = (Join-Path ([IO.Path]::GetTempPath()) 'primus-msi-smoke'),
  [string] $ExtraChecks,
  [hashtable] $ExtraChecksArgs = @{},
  [int] $TimeoutSeconds = 300,
  [switch] $KeepInstalled,
  [switch] $KeepData
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$ProductName = '乾元 Primus'
$AppUserModelId = 'com.primus.desktop'
$WebView2Guid = '{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
$RepoRoot = Split-Path -Parent $PSScriptRoot
$Msi = (Resolve-Path -LiteralPath $Msi).Path
$InstallDir = [IO.Path]::GetFullPath($InstallDir.TrimEnd('\'))
$DataDir = Join-Path $InstallDir 'data'
$ShortcutPath = Join-Path ([Environment]::GetFolderPath('CommonPrograms')) "$ProductName.lnk"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Write-Step([string] $Message) { Write-Host "`n==> $Message" -ForegroundColor Cyan }
function Assert-True([bool] $Condition, [string] $Message) {
  if (-not $Condition) { throw "✗ $Message" }
  Write-Host "  ✓ $Message"
}

# Primus.wxs 写入的安装目录记录（64 位注册表视图）；没有时返回 $null
$InstallDirKey = 'HKLM:\SOFTWARE\Primus'
function Get-RecordedInstallDir {
  $item = Get-ItemProperty -LiteralPath $InstallDirKey -Name 'InstallDir' -ErrorAction SilentlyContinue
  if ($null -eq $item) { return $null }
  return [string] $item.InstallDir
}

function Test-Administrator {
  $principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# msiexec 的命令行由它自己解析：带空格的路径与属性值都要加引号；Start-Process 的数组参数不会自动加引号
function Invoke-Msiexec([string] $Action, [string] $LogName, [string[]] $Properties = @()) {
  $log = Join-Path $LogDir $LogName
  $argumentLine = @($Action, "`"$Msi`"") + $Properties + @('/qn', '/norestart', '/l*v', "`"$log`"")
  Write-Host "  msiexec $($argumentLine -join ' ')"
  # 不用 -Wait：它会等整棵进程树；改为限时等待，超时打印安装日志末尾后失败，避免步骤无限挂起（ARM64 曾卡住）
  $process = Start-Process -FilePath 'msiexec.exe' -ArgumentList ($argumentLine -join ' ') -PassThru
  $null = $process.Handle
  if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
    if (Test-Path -LiteralPath $log) {
      Write-Host "---- $log（末尾 120 行）----"
      Get-Content -LiteralPath $log -Tail 120 | ForEach-Object { Write-Host $_ }
    }
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    throw "✗ msiexec $Action 超过 $TimeoutSeconds 秒未结束（日志 $log）"
  }
  # 0 成功；3010 成功但需重启（ERROR_SUCCESS_REBOOT_REQUIRED）
  if ($process.ExitCode -notin 0, 3010) {
    if (Test-Path -LiteralPath $log) {
      Write-Host "---- $log（末尾 120 行）----"
      Get-Content -LiteralPath $log -Tail 120 | ForEach-Object { Write-Host $_ }
    }
    throw "✗ msiexec $Action 失败，退出码 $($process.ExitCode)（日志 $log）"
  }
  Write-Host "  ✓ msiexec $Action 完成（退出码 $($process.ExitCode)）"
  return $log
}

function Get-UninstallEntry {
  $keys = @(
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
  )
  Get-ItemProperty -Path $keys -ErrorAction SilentlyContinue |
    Where-Object { $_.PSObject.Properties['DisplayName'] -and $_.DisplayName -eq $ProductName }
}

# 与 Primus.wxs 的检测一致：EdgeUpdate\Clients\{F3017226-…}\pv，为空或 0.0.0.0 视为未安装
# 与 Primus.wxs 一致：只认按机器安装的运行时（HKCU 的按用户运行时对其他用户无效）
function Get-WebView2Version {
  $key = "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\$WebView2Guid"
  $item = Get-ItemProperty -Path $key -Name pv -ErrorAction SilentlyContinue
  if ($item -and $item.pv -and $item.pv -ne '0.0.0.0') { return $item.pv }
  return $null
}

# 解析快捷方式目标。WScript.Shell 对 Windows Installer 创建的快捷方式可能读不到 TargetPath
# （广告快捷方式只存 Darwin 描述符），依次退到 Shell.Application 与 msi.dll 解析，并打印用的是哪种方式。
Add-Type -Namespace PrimusSmoke -Name Msi -MemberDefinition @'
[DllImport("msi.dll", CharSet = CharSet.Unicode)]
public static extern uint MsiGetShortcutTargetW(string shortcut, System.Text.StringBuilder product, System.Text.StringBuilder feature, System.Text.StringBuilder component);
[DllImport("msi.dll", CharSet = CharSet.Unicode)]
public static extern int MsiGetComponentPathW(string product, string component, System.Text.StringBuilder path, ref uint size);
'@

function Get-ShortcutTarget([string] $Path) {
  $target = (New-Object -ComObject WScript.Shell).CreateShortcut($Path).TargetPath
  if ($target) { Write-Host "  · 快捷方式目标（WScript.Shell）：$target"; return $target }

  $folder = (New-Object -ComObject Shell.Application).Namespace((Split-Path -Parent $Path))
  $item = if ($folder) { $folder.ParseName((Split-Path -Leaf $Path)) } else { $null }
  if ($item -and $item.IsLink) {
    $target = $item.GetLink.Path
    if ($target) { Write-Host "  · 快捷方式目标（Shell.Application）：$target"; return $target }
  }

  $product = [Text.StringBuilder]::new(39)
  $feature = [Text.StringBuilder]::new(39)
  $component = [Text.StringBuilder]::new(39)
  $rc = [PrimusSmoke.Msi]::MsiGetShortcutTargetW($Path, $product, $feature, $component)
  if ($rc -eq 0 -and $component.Length -gt 0) {
    $size = [uint32]1024
    $buffer = [Text.StringBuilder]::new([int]$size)
    $state = [PrimusSmoke.Msi]::MsiGetComponentPathW($product.ToString(), $component.ToString(), $buffer, [ref]$size)
    Write-Host "  · 广告快捷方式：产品 $product，组件 $component，组件状态 $state"
    if ($buffer.Length -gt 0) { return $buffer.ToString() }
  } else {
    Write-Host "  · MsiGetShortcutTarget 返回 $rc（不是广告快捷方式）"
  }
  return ''
}

# 以中完整性级别运行一段 PowerShell（gsudo 降权：管理员组变为仅拒绝），返回退出码
function Invoke-AsMediumIntegrity([string] $Script) {
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($Script))
  # 交给 gsudo 的是命令名（由它在 PATH 中查找），避免 "C:\Program Files\…" 路径在转交时再被拆开
  & $Gsudo --integrity Medium pwsh.exe -NoProfile -NonInteractive -EncodedCommand $encoded | ForEach-Object { Write-Host "    $_" }
  return $LASTEXITCODE
}

function ConvertTo-PsLiteral([string] $Value) { return "'" + ($Value -replace "'", "''") + "'" }

if (-not (Test-Administrator)) { throw '✗ 需要以管理员身份运行（MSI 按机器安装）' }
if (Get-UninstallEntry) { throw "✗ 本机已安装 $ProductName，请先卸载或在干净环境中运行" }
if (Test-Path -LiteralPath $InstallDir) { throw "✗ 安装目录已存在：$InstallDir（上次运行的残留？请先删除）" }

$webView2Before = Get-WebView2Version
Write-Host "WebView2 运行时（安装前）：$(if ($webView2Before) { $webView2Before } else { '未安装' })"

# ---- 0. 安装目录或其上级是联接时拒绝安装（Primus.wxs 的 CheckInstallDir / install-acl.ps1），且不改动联接目标 ----
Write-Step '安装目录或其上级是联接时拒绝安装'
$probeLink = Join-Path $env:SystemDrive 'PrimusJunctionProbe'
$probeTarget = Join-Path $env:SystemDrive 'PrimusJunctionTarget'
foreach ($path in $probeLink, $probeTarget) { if (Test-Path -LiteralPath $path) { throw "✗ 残留：$path（请先删除）" } }
$null = New-Item -ItemType Directory -Path $probeTarget
$null = New-Item -ItemType Junction -Path $probeLink -Target $probeTarget
$targetSddl = (Get-Acl -LiteralPath $probeTarget).Sddl
try {
  foreach ($case in @(
      @{ Name = '安装目录本身是联接'; Dir = $probeLink; Log = 'junction-self.log' },
      @{ Name = '上级目录是联接'; Dir = (Join-Path $probeLink 'Primus'); Log = 'junction-parent.log' })) {
    $log = Join-Path $LogDir $case.Log
    $argumentLine = "/i `"$Msi`" INSTALLFOLDER=`"$($case.Dir)`" /qn /norestart /l*v `"$log`""
    Write-Host "  msiexec $argumentLine"
    $process = Start-Process -FilePath 'msiexec.exe' -ArgumentList $argumentLine -PassThru
    $null = $process.Handle
    if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
      Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
      throw "✗ $($case.Name)：msiexec 超过 $TimeoutSeconds 秒未结束（日志 $log）"
    }
    $refused = Select-String -LiteralPath $log -SimpleMatch 'primus-install-acl: error: install dir or one of its parents is a junction'
    if ($process.ExitCode -ne 1603 -or -not $refused) {
      Write-Host "---- $log 中含 primus-install-acl / CheckInstallDir 的行 ----"
      Select-String -LiteralPath $log -Pattern 'primus-install-acl|CheckInstallDir' | ForEach-Object { Write-Host $_.Line }
    }
    Assert-True ($process.ExitCode -eq 1603) "$($case.Name)：安装失败并回滚（退出码 $($process.ExitCode)）"
    Assert-True ($null -ne $refused) "$($case.Name)：由 CheckInstallDir 拒绝（日志中有 install-acl.ps1 的拒绝信息）"
    Assert-True ((Get-Acl -LiteralPath $probeTarget).Sddl -eq $targetSddl) "$($case.Name)：联接目标的 ACL 未被改动"
    Assert-True (@(Get-ChildItem -LiteralPath $probeTarget -Recurse -File -Force).Count -eq 0) "$($case.Name)：联接目标中没有写入文件"
    Assert-True ($null -eq (Get-UninstallEntry)) "$($case.Name)：未留下安装记录"
  }
} finally {
  # 只删联接本身（不跟随），再删目标
  if (Test-Path -LiteralPath $probeLink) { [IO.Directory]::Delete($probeLink) }
  Remove-Item -LiteralPath $probeTarget -Recurse -Force -ErrorAction SilentlyContinue
}

# ---- 1. 安装 ----
Write-Step "静默安装 $Msi → $InstallDir"
$installLog = Invoke-Msiexec -Action '/i' -LogName 'install.log' -Properties @("INSTALLFOLDER=`"$InstallDir`"")

# ---- 2. 检查安装布局 ----
Write-Step '检查安装布局（技术方案第 3.2 节）'
$coreDir = Join-Path $InstallDir 'resources\agent-core'
$nodeExe = Join-Path $InstallDir 'resources\runtime\node.exe'
$mainExe = Join-Path $InstallDir 'Primus.exe'
foreach ($relative in @(
    'Primus.exe',
    'resources\runtime\node.exe',
    'resources\runtime\LICENSE',
    'resources\agent-core\rpc-entry.js',
    'resources\agent-core\cli.js',
    'resources\agent-core\package.json',
    'resources\agent-core\manifest.json',
    'resources\agent-core\LICENSE',
    'resources\agent-core\extensions\primus-bundle.js'
  )) {
  Assert-True (Test-Path -LiteralPath (Join-Path $InstallDir $relative) -PathType Leaf) "存在 $relative"
}

$manifest = Get-Content -LiteralPath (Join-Path $coreDir 'manifest.json') -Raw | ConvertFrom-Json
$mismatched = @()
foreach ($file in $manifest.files) {
  $path = Join-Path $coreDir ($file.path -replace '/', '\')
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { $mismatched += "缺少 $($file.path)"; continue }
  $hash = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($hash -ne $file.sha256) { $mismatched += "内容不符 $($file.path)" }
}
if ($mismatched.Count -gt 0) { $mismatched | ForEach-Object { Write-Host "  - $_" } }
Assert-True ($mismatched.Count -eq 0) "resources\agent-core 与 manifest.json 一致（$(@($manifest.files).Count) 个文件）"
Assert-True (@($manifest.files | Where-Object { $_.path -eq 'LICENSE' }).Count -eq 1) 'manifest.json 收录 Core 的 MIT 许可文件 LICENSE'
$coreLicense = Get-Content -LiteralPath (Join-Path $coreDir 'LICENSE') -Raw
Assert-True ($coreLicense -match '^\s*MIT License') 'resources\agent-core\LICENSE 为 Core 上游 MIT 许可'

$signature = Get-AuthenticodeSignature -FilePath $nodeExe
Assert-True ($signature.Status -eq 'Valid') "安装后的 node.exe 官方签名有效（$($signature.Status)）"

$entry = Get-UninstallEntry
Assert-True ($null -ne $entry) "已写入卸载信息（$ProductName）"
Write-Host "  · 版本 $($entry.DisplayVersion)，发布者 $($entry.Publisher)"

# 重大升级靠这条记录沿用原安装目录（Primus.wxs 的 PREVIOUS_INSTALLFOLDER）
$recordedDir = Get-RecordedInstallDir
Assert-True ($null -ne $recordedDir -and $recordedDir.TrimEnd('\') -ieq $InstallDir) "已在 $InstallDirKey 记录安装目录（实际 $recordedDir）"

Assert-True (Test-Path -LiteralPath $ShortcutPath -PathType Leaf) "开始菜单快捷方式 $ShortcutPath"
$target = Get-ShortcutTarget $ShortcutPath
Assert-True ($target -ieq $mainExe) "快捷方式指向 $mainExe（实际 $target）"

# ---- 3. data 目录可写（第 3.3.2 节、第 3.7 节第 3 步）----
Write-Step 'data 目录权限'
Assert-True (Test-Path -LiteralPath $DataDir -PathType Container) "存在 $DataDir"
& icacls.exe $DataDir | ForEach-Object { Write-Host "    $_" }
$usersSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-545')
$fsr = [Security.AccessControl.FileSystemRights]
$inherit = [Security.AccessControl.InheritanceFlags]
$acl = Get-Acl -LiteralPath $DataDir
$usersRules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | Where-Object {
    $_.IdentityReference -eq $usersSid -and
    $_.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow
  })
$modifyRule = $usersRules | Where-Object {
  -not $_.IsInherited -and
  (($_.FileSystemRights -band $fsr::Modify) -eq $fsr::Modify) -and
  (($_.InheritanceFlags -band $inherit::ContainerInherit) -ne 0) -and
  (($_.InheritanceFlags -band $inherit::ObjectInherit) -ne 0)
} | Select-Object -First 1
Assert-True ($null -ne $modifyRule) 'ACL 含 BUILTIN\Users 显式“修改”(M)，并继承到子目录与文件 (OI)(CI)'
# 显式与继承的 Users 授权都要看：任一条带更改权限 / 取得所有权（如从自定义安装目录继承的完全控制）都不合格
$tooBroad = @($usersRules | Where-Object {
    (($_.FileSystemRights -band $fsr::ChangePermissions) -ne 0) -or
    (($_.FileSystemRights -band $fsr::TakeOwnership) -ne 0)
  })
Assert-True ($tooBroad.Count -eq 0) "Users 组的显式与继承授权都没有更改权限 / 取得所有权（不是完全控制；违规 $($tooBroad.Count) 条）"

if (-not $Gsudo) { $Gsudo = (Get-Command gsudo -ErrorAction SilentlyContinue)?.Source }
if ($Gsudo) {
  Write-Host '  · 以中完整性级别（去掉管理员权限）实际写入'
  $dataLiteral = ConvertTo-PsLiteral $DataDir
  $installLiteral = ConvertTo-PsLiteral $InstallDir
  $writeData = @"
`$ErrorActionPreference = 'Stop'
whoami /groups | Select-String 'Mandatory Label|S-1-5-32-544' | ForEach-Object { `$_.Line.Trim() }
`$file = Join-Path $dataLiteral 'medium-integrity-write.txt'
Set-Content -LiteralPath `$file -Value 'ok'
if ((Get-Content -LiteralPath `$file) -ne 'ok') { exit 2 }
`$sub = Join-Path $dataLiteral 'medium-integrity-dir'
New-Item -ItemType Directory -Path `$sub | Out-Null
Set-Content -LiteralPath (Join-Path `$sub 'nested.txt') -Value 'ok'
Remove-Item -LiteralPath `$sub -Recurse
Remove-Item -LiteralPath `$file
exit 0
"@
  Assert-True ((Invoke-AsMediumIntegrity $writeData) -eq 0) '中完整性级别可在 data 中创建、写入、删除文件与子目录'

  # 退出码：0 = 写入被拒（预期）；1 = 写入成功；3 = 写入成功但删除失败（测试文件残留）
  $writeRoot = @"
`$file = Join-Path $installLiteral 'medium-integrity-write.txt'
try { Set-Content -LiteralPath `$file -Value 'x' -ErrorAction Stop } catch { exit 0 }
try { Remove-Item -LiteralPath `$file -ErrorAction Stop } catch { exit 3 }
exit 1
"@
  $rootResult = Invoke-AsMediumIntegrity $writeRoot
  if ($rootResult -eq 3) { Remove-Item -LiteralPath (Join-Path $InstallDir 'medium-integrity-write.txt') -ErrorAction SilentlyContinue }
  Assert-True ($rootResult -eq 0) "中完整性级别写不进安装目录根（普通用户不能改程序文件；退出码 $rootResult）"
} else {
  Write-Host '  · 未找到 gsudo，跳过中完整性级别写入测试（ACL 检查已通过）'
}
# 安装目录所有者为 Administrators（Primus.wxs InstallDirAcl 的 O:BA）：目录若由普通用户预先建好，
# 原所有者会保有隐式的更改权限，可以改回 DACL 后替换程序文件
$installOwner = (Get-Acl -LiteralPath $InstallDir).GetOwner([Security.Principal.SecurityIdentifier]).Value
Assert-True ($installOwner -eq 'S-1-5-32-544') "安装目录所有者为 Administrators（实际 $installOwner）"
# 程序文件（Primus.wxs 的 CheckInstallDir / ResetProgramAcl）：所有者不是普通用户、无显式授权，全部从安装目录继承
# 中文界面的包会把 Action start/ended 日志行本地化（且按 ANSI 代码页写），只匹配引擎自身不本地化的行：
# 延迟自定义操作写入安装脚本时记 "Executing op: CustomActionSchedule(Action=<名>,"。
# 两个操作都是 Return="check"，执行失败会回滚、msiexec 返回 1603，上面已确认退出码为 0，故执行即成功
$installLogText = Get-Content -LiteralPath $installLog -Raw
foreach ($ca in 'CheckInstallDir', 'ResetProgramAcl') {
  $scheduled = $installLogText -match "Executing op: CustomActionSchedule\(Action=$ca,"
  if (-not $scheduled) {
    Write-Host "---- $installLog 中含 $ca 的行 ----"
    Select-String -LiteralPath $installLog -SimpleMatch $ca | ForEach-Object { Write-Host $_.Line }
  }
  Assert-True $scheduled "安装时执行了 $ca 并成功（Return=check，msiexec 退出码 0）"
}
foreach ($item in @((Join-Path $InstallDir 'Primus.exe'), (Join-Path $InstallDir 'resources'))) {
  $itemAcl = Get-Acl -LiteralPath $item
  $itemOwner = $itemAcl.GetOwner([Security.Principal.SecurityIdentifier]).Value
  # 全新安装时文件由安装服务（SYSTEM）新建，所有者是 Administrators 或 SYSTEM，都不是普通用户
  Assert-True ($itemOwner -in 'S-1-5-32-544', 'S-1-5-18') "$item 所有者为 Administrators 或 SYSTEM（实际 $itemOwner）"
  $explicit = @($itemAcl.Access | Where-Object { -not $_.IsInherited })
  Assert-True ($explicit.Count -eq 0) "$item 没有显式授权（实际 $($explicit.Count) 条）"
}

# ---- 4. WebView2（第 3.5 节）----
Write-Step 'WebView2 检测与引导'
$logText = Get-Content -LiteralPath $installLog -Raw
if ($webView2Before) {
  Assert-True ($logText -match 'Skipping action: InstallWebView2 \(condition is false\)') '已有 WebView2 运行时，引导程序被跳过'
} else {
  Assert-True ($logText -match 'Doing action: InstallWebView2') '缺少 WebView2 运行时，安装时运行了引导程序'
  $after = Get-WebView2Version
  Assert-True ($null -ne $after) "引导后 WebView2 运行时已安装（$after）"
}

# ---- 5. 用安装目录中的运行时跑 Core RPC 冒烟 ----
# 驱动冒烟脚本的 Node.js：显式传入 -Node 时用它，否则直接用安装目录中的 node.exe（不依赖 PATH）
$smokeNode = if ($Node) { $Node } else { $nodeExe }
$smokeScript = Join-Path $RepoRoot 'scripts\smoke-core-rpc.mjs'
if (-not (Test-Path -LiteralPath $smokeScript)) { throw "✗ 未找到 $smokeScript，无法执行 Core RPC 冒烟" }
Write-Step "Core RPC 冒烟（安装目录中的 node.exe + agent-core；驱动：$smokeNode）"
& $smokeNode $smokeScript --entry (Join-Path $coreDir 'rpc-entry.js') --node $nodeExe
Assert-True ($LASTEXITCODE -eq 0) '安装后的 Core 响应 get_state'

if ($ExtraChecks) {
  Write-Step "附加检查：$ExtraChecks"
  $extraArgs = @{ InstallDir = $InstallDir } + $ExtraChecksArgs
  try {
    & $ExtraChecks @extraArgs
  } catch {
    # 附加检查失败也要卸载，免得在虚拟机或运行器上留下安装
    Write-Host "  ✗ 附加检查失败：$($_.Exception.Message)" -ForegroundColor Red
    if (-not $KeepInstalled) { Invoke-Msiexec -Action '/x' -LogName 'uninstall-after-failure.log' | Out-Null }
    throw
  }
}

if ($KeepInstalled) {
  Write-Step "按 -KeepInstalled 保留安装（$InstallDir）"
  exit 0
}

# ---- 6. 卸载：程序移除，data 保留 ----
Write-Step '静默卸载（data 应保留）'
$marker = Join-Path $DataDir 'users\msi-smoke\keep.txt'
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $marker) | Out-Null
Set-Content -LiteralPath $marker -Value 'keep'
Invoke-Msiexec -Action '/x' -LogName 'uninstall.log' | Out-Null
Assert-True (-not (Test-Path -LiteralPath $mainExe)) '已移除 Primus.exe'
Assert-True (-not (Test-Path -LiteralPath (Join-Path $InstallDir 'resources\runtime'))) '已移除 resources\runtime'
Assert-True (-not (Test-Path -LiteralPath $coreDir)) '已移除 resources\agent-core'
Assert-True (-not (Test-Path -LiteralPath $ShortcutPath)) '已移除开始菜单快捷方式'
Assert-True ($null -eq (Get-UninstallEntry)) '已清除卸载信息'
Assert-True ($null -eq (Get-RecordedInstallDir)) "已清除 $InstallDirKey 中的安装目录记录"
Assert-True (Test-Path -LiteralPath $DataDir -PathType Container) "卸载后 data 目录保留（$DataDir）"
Assert-True ((Get-Content -LiteralPath $marker) -eq 'keep') '卸载后 data 中的文件保留'

# ---- 7. 清理 ----
if ($KeepData) {
  Write-Host "`n· 按 -KeepData 保留 $DataDir"
} else {
  # data\users\<SID> 只授予各自用户与 SYSTEM（第 4.3 节），管理员要先取得所有权才能删除其他用户的目录。
  # takeown /R 只能进入已有列目录权限的子目录：每一轮取得所有权并授权后才能看到下一层，所以多轮重试
  $removed = $false
  for ($round = 0; $round -lt 8 -and -not $removed; $round++) {
    try {
      Remove-Item -LiteralPath $InstallDir -Recurse -Force -ErrorAction Stop
      $removed = $true
    } catch {
      if ($round -eq 0) { Write-Host "  · 直接删除失败（$($_.Exception.Message)），取得所有权后重试" }
      # takeown /R、icacls /T 会顺着重解析点改到安装目录之外（data 可由普通用户写入、可建目录联接）：
      # 每轮先检查当前已能看到的部分，有就报错退出。pwsh 的 -Recurse 不进入联接；新一层在上一轮授权后才可见，
      # 所以每轮在 takeown 之前都检查一次
      $links = @(Get-ChildItem -LiteralPath $InstallDir -Recurse -Force -Attributes ReparsePoint -ErrorAction SilentlyContinue)
      if ($links.Count -gt 0) {
        throw "✗ $InstallDir 下有重解析点，拒绝取得所有权与改权限：$(($links | Select-Object -First 5 | ForEach-Object FullName) -join '; ')"
      }
      & takeown.exe /F $InstallDir /R /D Y 2>&1 | Out-Null
      # 只给管理员加显式授权（/T 逐个写到目录与文件上），不用 /reset：清理失败时 users\<SID> 仍是受保护的，
      # 不会改为继承 data 上 Users 的“修改”
      & icacls.exe $InstallDir /grant '*S-1-5-32-544:(OI)(CI)F' /T /C /Q 2>&1 | Out-Null
    }
  }
  if (-not $removed) {
    # 兜底：robocopy /B 以备份语义（管理员的备份 / 还原特权）把目录镜像为空，不受各文件 ACL 限制；
    # /XJ 不进入目录联接（data 可由普通用户写入，避免顺着联接删到安装目录之外）
    $empty = Join-Path ([IO.Path]::GetTempPath()) "primus-msi-smoke-empty-$PID"
    New-Item -ItemType Directory -Force -Path $empty | Out-Null
    & robocopy.exe $empty $InstallDir /MIR /B /XJ /R:0 /W:0 /NFL /NDL /NJH /NJS /NP | Out-Null
    Write-Host "  · robocopy /B 清空 $InstallDir（退出码 $LASTEXITCODE）"
    $global:LASTEXITCODE = 0  # robocopy 退出码 1–7 表示成功，免得作业按非零码判失败
    Remove-Item -LiteralPath $empty -Force
    Remove-Item -LiteralPath $InstallDir -Recurse -Force
  }
  Write-Host "`n· 已清理保留的 $InstallDir"
}

Write-Host "`n✓ MSI 安装 / 卸载冒烟通过（AppUserModelID $AppUserModelId）" -ForegroundColor Green
