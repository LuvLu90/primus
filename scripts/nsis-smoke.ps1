#requires -Version 7.2
<#
.SYNOPSIS
  NSIS 安装程序（EXE）静默安装 / 卸载冒烟（技术方案第 3.2、3.4、23 章）。CI 的 Windows 作业使用，与 msi-smoke.ps1 对应。

.DESCRIPTION
  1. <安装程序> /S /D=<目录> 静默安装（默认 C:\Program Files\乾元 Primus）
  2. 检查安装布局：Primus.exe、uninstall.exe、resources\runtime\node.exe（官方签名）、resources\agent-core
     （按 manifest.json 逐个校验 SHA-256）、Core 的 MIT 许可文件、primus-bundle.js、卸载信息（显示名“乾元 Primus”、
     版本与 tauri.conf.json 一致）、开始菜单快捷方式
  3. data 目录（hooks.nsh 创建）：ACL 含 BUILTIN\Users 显式“修改”且继承到子项、没有更改权限 / 取得所有权；
     有 gsudo 时再以中完整性级别实际写入 data，并确认写不进安装目录根
  4. 用安装目录里的 node.exe 跑 Core RPC 冒烟（scripts/smoke-core-rpc.mjs --entry/--node）
  5. 在 data 中留一个文件后 uninstall.exe /S 静默卸载：程序文件、resources、快捷方式、卸载信息被移除，data 与其中文件保留
  6. 清理保留的 data（-KeepData 时不清理），便于重复运行

  需要管理员权限（按机器安装）。任何一步不符合预期即抛错，退出码非 0。

.PARAMETER Exe
  NSIS 安装程序路径（Primus_<ver>_<arch>-setup.exe）。

.PARAMETER InstallDir
  安装目录（/D=，NSIS 要求它是最后一个参数且不加引号，可含空格与中文），默认 "$env:ProgramFiles\乾元 Primus"。

.PARAMETER Node
  运行 smoke-core-rpc.mjs 的 Node.js，默认用安装目录中的 resources\runtime\node.exe。

.PARAMETER Gsudo
  gsudo.exe 路径，用于中完整性级别写入测试。默认取 PATH 中的 gsudo；找不到时只做 ACL 检查。

.PARAMETER KeepData
  卸载后不删除保留下来的 data 目录。

.EXAMPLE
  pwsh -File scripts/nsis-smoke.ps1 -Exe out/Primus_0.0.1_x64-setup.exe
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)] [string] $Exe,
  [string] $InstallDir = (Join-Path $env:ProgramFiles '乾元 Primus'),
  [string] $Node,
  [string] $Gsudo,
  [switch] $KeepData
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$ProductName = '乾元 Primus'
$RepoRoot = Split-Path -Parent $PSScriptRoot
$Exe = (Resolve-Path -LiteralPath $Exe).Path
$InstallDir = [IO.Path]::GetFullPath($InstallDir.TrimEnd('\'))
$DataDir = Join-Path $InstallDir 'data'
$ShortcutPath = Join-Path ([Environment]::GetFolderPath('CommonPrograms')) "$ProductName.lnk"
$DesktopShortcut = Join-Path ([Environment]::GetFolderPath('CommonDesktopDirectory')) "$ProductName.lnk"
$Version = (Get-Content -LiteralPath (Join-Path $RepoRoot 'apps\desktop\src-tauri\tauri.conf.json') -Raw | ConvertFrom-Json).version

function Write-Step([string] $Message) { Write-Host "`n==> $Message" -ForegroundColor Cyan }
function Assert-True([bool] $Condition, [string] $Message) {
  if (-not $Condition) { throw "✗ $Message" }
  Write-Host "  ✓ $Message"
}

function Test-Administrator {
  $principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# Tauri 的 NSIS 安装程序按机器安装时把卸载信息写在 HKLM（64 位系统上为 64 位视图），两个视图都查
function Get-UninstallEntry {
  $keys = @(
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
  )
  Get-ItemProperty -Path $keys -ErrorAction SilentlyContinue |
    Where-Object { $_.PSObject.Properties['DisplayName'] -and $_.DisplayName -eq $ProductName }
}

# 运行 NSIS 程序并等待结束；返回退出码
function Invoke-Nsis([string] $FilePath, [string] $ArgumentLine) {
  Write-Host "  $FilePath $ArgumentLine"
  # 限时等待，避免步骤无限挂起
  $process = Start-Process -FilePath $FilePath -ArgumentList $ArgumentLine -PassThru
  $null = $process.Handle
  if (-not $process.WaitForExit(300 * 1000)) {
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    throw "✗ $FilePath 超过 300 秒未结束"
  }
  return $process.ExitCode
}

# 以中完整性级别运行一段 PowerShell（gsudo 降权：管理员组变为仅拒绝），返回退出码
function Invoke-AsMediumIntegrity([string] $Script) {
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($Script))
  & $Gsudo --integrity Medium pwsh.exe -NoProfile -NonInteractive -EncodedCommand $encoded | ForEach-Object { Write-Host "    $_" }
  return $LASTEXITCODE
}

# 解析快捷方式目标：NSIS 创建的快捷方式 WScript.Shell 可能读不出 TargetPath（实测为空），退到 Shell.Application，
# 打印用的是哪种方式
function Get-ShortcutTarget([string] $Path) {
  $target = (New-Object -ComObject WScript.Shell).CreateShortcut($Path).TargetPath
  if ($target) { Write-Host "  · 快捷方式目标（WScript.Shell）：$target"; return $target }
  $folder = (New-Object -ComObject Shell.Application).Namespace((Split-Path -Parent $Path))
  $item = if ($folder) { $folder.ParseName((Split-Path -Leaf $Path)) } else { $null }
  if ($item -and $item.IsLink) {
    $target = $item.GetLink.Path
    if ($target) { Write-Host "  · 快捷方式目标（Shell.Application）：$target"; return $target }
  }
  return ''
}

function ConvertTo-PsLiteral([string] $Value) { return "'" + ($Value -replace "'", "''") + "'" }

# 与卸载程序删除文件同样的访问检查：请求 DELETE 访问并允许其他句柄读、写、删除共享。
# 不用独占 ReadWrite 打开：别的进程以 FILE_SHARE_DELETE 持有文件时卸载仍能删除，独占打开却会一直失败。
Add-Type -Namespace PrimusSmoke -Name Native -MemberDefinition @'
[DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
public static extern Microsoft.Win32.SafeHandles.SafeFileHandle CreateFileW(string fileName, uint desiredAccess, uint shareMode, IntPtr securityAttributes, uint creationDisposition, uint flagsAndAttributes, IntPtr templateFile);
'@

function Test-DeleteAccess([string] $Path) {
  $DELETE = 0x00010000
  $FILE_SHARE_ALL = 0x7          # FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE
  $OPEN_EXISTING = 3
  $handle = [PrimusSmoke.Native]::CreateFileW($Path, $DELETE, $FILE_SHARE_ALL, [IntPtr]::Zero, $OPEN_EXISTING, 0, [IntPtr]::Zero)
  try { return -not $handle.IsInvalid } finally { $handle.Dispose() }
}

# 卸载前等安装目录中的文件不再被占用：Core RPC 冒烟刚用 resources\runtime\node.exe 跑过 Core，
# 进程退出后映像文件的句柄可能还要片刻才释放（杀毒扫描等）。NSIS 卸载程序遇到被占用的文件会静默跳过，
# 留下 resources 目录（ARM64 Runner 上偶发）。先等从安装目录启动的进程全部退出，再确认 resources 下的文件都能以删除访问打开。
function Wait-InstallDirReleased([int] $TimeoutSeconds = 30) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $prefix = $InstallDir.TrimEnd('\') + '\'
  while ($true) {
    $running = @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
        $path = try { $_.Path } catch { $null }
        $path -and $path.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
      })
    $locked = @()
    if ($running.Count -eq 0) {
      $locked = @(Get-ChildItem -LiteralPath (Join-Path $InstallDir 'resources') -Recurse -File -Force -ErrorAction SilentlyContinue |
          Where-Object { -not (Test-DeleteAccess $_.FullName) })
    }
    if ($running.Count -eq 0 -and $locked.Count -eq 0) { return }
    if ((Get-Date) -gt $deadline) {
      $names = ($running | ForEach-Object { "$($_.ProcessName)($($_.Id))" }) -join '、'
      $files = ($locked | ForEach-Object { $_.Name }) -join '、'
      throw "✗ 等待 $TimeoutSeconds 秒后安装目录仍被占用（进程：$names；被占用的文件：$files）"
    }
    Start-Sleep -Milliseconds 500
  }
}

# 列出安装目录中残留的文件（data 除外），用于卸载断言失败时定位
function Get-Leftovers {
  Get-ChildItem -LiteralPath $InstallDir -Recurse -File -Force -ErrorAction SilentlyContinue |
    Where-Object { -not $_.FullName.StartsWith($DataDir + '\', [StringComparison]::OrdinalIgnoreCase) } |
    ForEach-Object { $_.FullName.Substring($InstallDir.Length + 1) }
}

if (-not (Test-Administrator)) { throw '✗ 需要以管理员身份运行（按机器安装）' }
if (Get-UninstallEntry) { throw "✗ 本机已安装 $ProductName，请先卸载或在干净环境中运行" }
if (Test-Path -LiteralPath $InstallDir) { throw "✗ 安装目录已存在：$InstallDir（上次运行的残留？请先删除）" }

# ---- 1. 安装 ----
Write-Step "静默安装 $Exe → $InstallDir"
# /D= 必须是最后一个参数且不能加引号（NSIS 约定），路径中的空格原样保留
$code = Invoke-Nsis $Exe "/S /D=$InstallDir"
Assert-True ($code -eq 0) "安装程序退出码 0（实际 $code）"

# ---- 2. 检查安装布局 ----
Write-Step '检查安装布局（技术方案第 3.2 节）'
$coreDir = Join-Path $InstallDir 'resources\agent-core'
$nodeExe = Join-Path $InstallDir 'resources\runtime\node.exe'
$mainExe = Join-Path $InstallDir 'Primus.exe'
$uninstaller = Join-Path $InstallDir 'uninstall.exe'
foreach ($relative in @(
    'Primus.exe',
    'uninstall.exe',
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
$coreLicense = Get-Content -LiteralPath (Join-Path $coreDir 'LICENSE') -Raw
Assert-True ($coreLicense -match '^\s*MIT License') 'resources\agent-core\LICENSE 为 Core 上游 MIT 许可'

$signature = Get-AuthenticodeSignature -FilePath $nodeExe
Assert-True ($signature.Status -eq 'Valid') "安装后的 node.exe 官方签名有效（$($signature.Status)）"

$entry = @(Get-UninstallEntry)
Assert-True ($entry.Count -eq 1) "已写入卸载信息（$ProductName，$($entry.Count) 条）"
Write-Host "  · 版本 $($entry[0].DisplayVersion)，发布者 $($entry[0].Publisher)，位置 $($entry[0].InstallLocation)"
Assert-True ($entry[0].DisplayVersion -eq $Version) "卸载信息中的版本为 $Version"
Assert-True ($entry[0].Publisher -eq $ProductName) "卸载信息中的发布者为 $ProductName"

Assert-True (Test-Path -LiteralPath $ShortcutPath -PathType Leaf) "开始菜单快捷方式 $ShortcutPath"
$target = Get-ShortcutTarget $ShortcutPath
Assert-True ($target -ieq $mainExe) "快捷方式指向 $mainExe（实际 $target）"

# ---- 3. data 目录可写（与 MSI 一致，第 3.3.2 节）----
Write-Step 'data 目录权限（hooks.nsh）'
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
$tooBroad = @($usersRules | Where-Object {
    (($_.FileSystemRights -band $fsr::ChangePermissions) -ne 0) -or
    (($_.FileSystemRights -band $fsr::TakeOwnership) -ne 0)
  })
Assert-True ($tooBroad.Count -eq 0) "Users 组的显式与继承授权都没有更改权限 / 取得所有权（违规 $($tooBroad.Count) 条）"

if (-not $Gsudo) { $Gsudo = (Get-Command gsudo -ErrorAction SilentlyContinue)?.Source }
if ($Gsudo) {
  Write-Host '  · 以中完整性级别（去掉管理员权限）实际写入'
  $dataLiteral = ConvertTo-PsLiteral $DataDir
  $installLiteral = ConvertTo-PsLiteral $InstallDir
  $writeData = @"
`$ErrorActionPreference = 'Stop'
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
  Assert-True ($rootResult -eq 0) "中完整性级别写不进安装目录根（退出码 $rootResult）"
} else {
  Write-Host '  · 未找到 gsudo，跳过中完整性级别写入测试（ACL 检查已通过）'
}

# ---- 4. 用安装目录中的运行时跑 Core RPC 冒烟 ----
$smokeNode = if ($Node) { $Node } else { $nodeExe }
$smokeScript = Join-Path $RepoRoot 'scripts\smoke-core-rpc.mjs'
if (-not (Test-Path -LiteralPath $smokeScript)) { throw "✗ 未找到 $smokeScript，无法执行 Core RPC 冒烟" }
Write-Step "Core RPC 冒烟（安装目录中的 node.exe + agent-core；驱动：$smokeNode）"
& $smokeNode $smokeScript --entry (Join-Path $coreDir 'rpc-entry.js') --node $nodeExe
Assert-True ($LASTEXITCODE -eq 0) '安装后的 Core 响应 get_state'

# ---- 5. 卸载：程序移除，data 保留 ----
Write-Step '静默卸载（data 应保留）'
$marker = Join-Path $DataDir 'users\nsis-smoke\keep.txt'
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $marker) | Out-Null
Set-Content -LiteralPath $marker -Value 'keep'
Wait-InstallDirReleased
Write-Host '  · 安装目录中的进程均已退出，resources 下的文件未被占用'
# 卸载程序默认把自己复制到临时目录再运行、立即返回；_?=<目录> 让它就地运行并等到卸载结束（须是最后一个参数），
# 代价是 uninstall.exe 本身留在原处，结束后手动删除
$code = Invoke-Nsis $uninstaller "/S _?=$InstallDir"
Assert-True ($code -eq 0) "卸载程序退出码 0（实际 $code）"
Remove-Item -LiteralPath $uninstaller -Force -ErrorAction SilentlyContinue
Assert-True (-not (Test-Path -LiteralPath $mainExe)) '已移除 Primus.exe'
$resourcesLeft = Test-Path -LiteralPath (Join-Path $InstallDir 'resources')
if ($resourcesLeft) {
  Write-Host '  · 卸载后残留：'
  Get-Leftovers | ForEach-Object { Write-Host "    $_" }
  Get-ChildItem -LiteralPath (Join-Path $InstallDir 'resources') -Recurse -Directory -Force -ErrorAction SilentlyContinue |
    ForEach-Object { Write-Host "    [目录] $($_.FullName.Substring($InstallDir.Length + 1))" }
}
Assert-True (-not $resourcesLeft) '已移除 resources（runtime 与 agent-core 及其子目录）'
Assert-True (-not (Test-Path -LiteralPath $ShortcutPath)) '已移除开始菜单快捷方式'
Assert-True (-not (Test-Path -LiteralPath $DesktopShortcut)) '已移除桌面快捷方式（静默安装会创建）'
Assert-True ($null -eq (Get-UninstallEntry)) '已清除卸载信息'
Assert-True (Test-Path -LiteralPath $DataDir -PathType Container) "卸载后 data 目录保留（$DataDir）"
Assert-True ((Get-Content -LiteralPath $marker) -eq 'keep') '卸载后 data 中的文件保留'

# ---- 6. 清理 ----
if ($KeepData) {
  Write-Host "`n· 按 -KeepData 保留 $DataDir"
} else {
  Remove-Item -LiteralPath $InstallDir -Recurse -Force
  Write-Host "`n· 已清理保留的 $InstallDir"
}

Write-Host "`n✓ NSIS 安装 / 卸载冒烟通过" -ForegroundColor Green
