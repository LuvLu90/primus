#requires -Version 7.2
<#
.SYNOPSIS
  更新服务 PrimusUpdate 静默升级冒烟（ADR 0007）。CI 的两个 Windows 作业与安装测试虚拟机共用。

.DESCRIPTION
  以管理员身份静默安装基准 MSI，然后以中完整性级别（gsudo 降权，相当于普通用户，不能弹 UAC）调用
  PrimusUpdate.exe --request（与 Primus.exe 发同样的命名管道请求），依次验证：
  1. 签名与版本不符的请求被拒绝（signature），已安装版本不变
  2. 安装目录下有进程一直在运行（模拟其他会话里还开着 Primus）：服务接受请求，安装进程等待约 30 秒后放弃，版本不变
  3. 安装目录下有进程运行一小会儿（模拟 Primus 正在退出）：等它退出后静默安装第一个升级包，版本更新
  4. 没有进程在运行：直接静默安装第二个升级包
  5. 降级请求被拒绝（notNewer）
  6. 每次升级后服务仍按 Primus.wxs 安装、暂存安装包已删除；最后静默卸载，服务、版本记录与 ProgramData\Primus 都被删除
  升级包由 scripts/build-upgrade-test-msi.mjs 用同一批二进制、更高的版本号与同一把 updater 密钥构建。
  “安装后以请求者身份重新打开 Primus”需要交互会话，在虚拟机上按 docs/安装测试清单.md 手工验证。

.PARAMETER Msi
  基准 MSI（版本即 tauri.conf.json 的版本）。

.PARAMETER Upgrade1 / Upgrade2
  两个升级 MSI（同目录下有同名 .sig），版本依次更高。

.PARAMETER Gsudo
  gsudo.exe 路径；默认取 PATH 中的 gsudo。找不到时以当前身份请求（只在手工排查时使用）。
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)] [string] $Msi,
  [Parameter(Mandatory)] [string] $Upgrade1,
  [Parameter(Mandatory)] [string] $Upgrade2,
  [string] $InstallDir = (Join-Path $env:ProgramFiles 'Primus'),
  [string] $Gsudo,
  [string] $LogDir = (Join-Path ([IO.Path]::GetTempPath()) 'primus-update-service-smoke'),
  [int] $TimeoutSeconds = 300
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$RepoRoot = Split-Path -Parent $PSScriptRoot
$InstallDir = [IO.Path]::GetFullPath($InstallDir.TrimEnd('\'))
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Write-Step([string] $Message) { Write-Host "`n==> $Message" -ForegroundColor Cyan }
function Assert-True([bool] $Condition, [string] $Message) {
  if (-not $Condition) { throw "✗ $Message" }
  Write-Host "  ✓ $Message"
}
. (Join-Path $PSScriptRoot 'update-service-checks.ps1')

if (-not $Gsudo) { $Gsudo = (Get-Command gsudo -ErrorAction SilentlyContinue)?.Source }
$principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw '✗ 需要以管理员身份运行' }
if (Test-Path -LiteralPath $InstallDir) { throw "✗ 安装目录已存在：$InstallDir（请在干净环境中运行）" }

# MSI 文件名 Primus_<ver>_<arch>_zh-CN.msi 中的版本
function Get-MsiVersion([string] $Path) {
  $m = [regex]::Match((Split-Path -Leaf $Path), '^Primus_(.+)_(x64|arm64)_zh-CN\.msi$')
  if (-not $m.Success) { throw "✗ 无法从文件名读出版本：$Path" }
  return $m.Groups[1].Value
}
$BaseVersion = Get-MsiVersion $Msi
$Version1 = Get-MsiVersion $Upgrade1
$Version2 = Get-MsiVersion $Upgrade2

function Invoke-Msiexec([string[]] $Arguments, [string] $LogName) {
  $log = Join-Path $LogDir $LogName
  $line = ($Arguments + @('/qn', '/norestart', '/l*v', "`"$log`"")) -join ' '
  Write-Host "  msiexec $line"
  $p = Start-Process -FilePath 'msiexec.exe' -ArgumentList $line -PassThru
  if (-not $p.WaitForExit($TimeoutSeconds * 1000)) {
    $p.Kill()
    if (Test-Path -LiteralPath $log) { Get-Content -LiteralPath $log -Tail 60 | ForEach-Object { Write-Host "    $_" } }
    throw "✗ msiexec 超过 $TimeoutSeconds 秒未结束（日志 $log）"
  }
  if ($p.ExitCode -ne 0) {
    if (Test-Path -LiteralPath $log) { Get-Content -LiteralPath $log -Tail 60 | ForEach-Object { Write-Host "    $_" } }
    throw "✗ msiexec 失败，退出码 $($p.ExitCode)（日志 $log）"
  }
}

# 升级包复制到当前用户的临时目录（请求者自己能读、普通用户可写的位置，与薄壳的 users\<SID>\updates 同类）
$Packages = Join-Path ([IO.Path]::GetTempPath()) "primus-update-packages-$PID"
New-Item -ItemType Directory -Force -Path $Packages | Out-Null
foreach ($file in @($Upgrade1, "$Upgrade1.sig", $Upgrade2, "$Upgrade2.sig")) { Copy-Item -LiteralPath $file -Destination $Packages }
$Pkg1 = Join-Path $Packages (Split-Path -Leaf $Upgrade1)
$Pkg2 = Join-Path $Packages (Split-Path -Leaf $Upgrade2)

# 以中完整性级别请求安装；返回 @{ Code; Output }
function Invoke-Request([string] $Package, [string] $SignatureFile, [string] $Version) {
  $exe = Join-Path $InstallDir 'PrimusUpdate.exe'
  $quote = { param($v) "'" + ($v -replace "'", "''") + "'" }
  $script = "& $(& $quote $exe) --request --package $(& $quote $Package) --signature-file $(& $quote $SignatureFile) --version $(& $quote $Version); exit `$LASTEXITCODE"
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($script))
  if ($Gsudo) {
    $output = & $Gsudo --integrity Medium pwsh.exe -NoProfile -NonInteractive -EncodedCommand $encoded 2>&1
  } else {
    $output = & pwsh.exe -NoProfile -NonInteractive -EncodedCommand $encoded 2>&1
  }
  $code = $LASTEXITCODE
  $text = ($output | Out-String).Trim()
  Write-Host "    请求 $Version → 退出码 $code：$text"
  return @{ Code = $code; Output = $text }
}

$ServiceLog = Join-Path $UpdateStagingDir 'service.log'
function Wait-Until([scriptblock] $Condition, [string] $What, [int] $Seconds = $TimeoutSeconds) {
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    if (& $Condition) { return }
    Start-Sleep -Seconds 2
  }
  if (Test-Path -LiteralPath $ServiceLog) { Get-Content -LiteralPath $ServiceLog -Tail 40 | ForEach-Object { Write-Host "    $_" } }
  $msiLog = Join-Path $UpdateStagingDir 'msiexec.log'
  if (Test-Path -LiteralPath $msiLog) { Get-Content -LiteralPath $msiLog -Tail 40 | ForEach-Object { Write-Host "    $_" } }
  throw "✗ $Seconds 秒内没有等到：$What"
}
function Get-ServiceLogText { if (Test-Path -LiteralPath $ServiceLog) { Get-Content -LiteralPath $ServiceLog -Raw } else { '' } }
function Wait-Installed([string] $Version) {
  Wait-Until { (Get-InstalledPrimusVersion) -ceq $Version } "静默升级到 $Version"
  # 安装进程删除暂存安装包后才算结束
  Wait-Until { -not (Test-Path -LiteralPath (Join-Path $UpdateStagingDir 'package.msi')) } '暂存安装包被删除' 60
  Assert-True ((Get-InstalledPrimusVersion) -ceq $Version) "已静默升级到 $Version"
  Assert-UpdateServiceInstalled $InstallDir $Version
}
# 安装目录下的一个长时间运行的进程（内置 node.exe），模拟仍在运行的 Primus
function Start-Holder([int] $Seconds) {
  $node = Join-Path $InstallDir 'resources\runtime\node.exe'
  return Start-Process -FilePath $node -ArgumentList '-e', "`"setTimeout(() => {}, $($Seconds * 1000))`"" -PassThru -WindowStyle Hidden
}

try {
  Write-Step "安装基准版本 $BaseVersion → $InstallDir"
  Invoke-Msiexec @('/i', "`"$((Resolve-Path -LiteralPath $Msi).Path)`"", "INSTALLFOLDER=`"$InstallDir`"") 'base-install.log'
  Assert-UpdateServiceInstalled $InstallDir $BaseVersion
  Assert-True ((Get-Service $UpdateServiceName).Status -eq 'Stopped') '更新服务安装后未运行（按需启动）'

  Write-Step '签名与版本不符：拒绝'
  $r = Invoke-Request $Pkg1 "$Pkg2.sig" $Version1
  Assert-True ($r.Code -eq 1 -and $r.Output -match '"code":"signature"') '用另一个版本的签名请求被拒绝（signature）'
  $r = Invoke-Request $Pkg1 "$Pkg1.sig" $Version2
  Assert-True ($r.Code -eq 1 -and $r.Output -match '"code":"signature"') '版本号与签名绑定的版本不符被拒绝（signature）'
  Assert-True ((Get-InstalledPrimusVersion) -ceq $BaseVersion) "版本仍为 $BaseVersion"
  Assert-True ((Get-Service $UpdateServiceName).Status -eq 'Running') '普通用户的请求按需启动了更新服务'

  Write-Step '安装目录下的程序一直在运行：放弃本次安装'
  $holder = Start-Holder 120
  try {
    $r = Invoke-Request $Pkg1 "$Pkg1.sig" $Version1
    Assert-True ($r.Code -eq 0 -and $r.Output -match '"code":"accepted"') '服务接受请求'
    Wait-Until { (Get-ServiceLogText) -match '安装目录下仍有进程在运行，放弃本次安装' } '安装进程放弃安装' 90
    Assert-True ((Get-InstalledPrimusVersion) -ceq $BaseVersion) "版本仍为 $BaseVersion"
    Assert-True (-not $holder.HasExited) '运行中的程序没有被结束'
  } finally {
    if (-not $holder.HasExited) { $holder.Kill() }
  }
  Wait-Until { -not (Test-Path -LiteralPath (Join-Path $UpdateStagingDir 'package.msi')) } '暂存安装包被删除' 60

  Write-Step "程序正在退出：等它退出后静默升级到 $Version1"
  $holder = Start-Holder 10
  $r = Invoke-Request $Pkg1 "$Pkg1.sig" $Version1
  Assert-True ($r.Code -eq 0) '服务接受请求'
  Wait-Installed $Version1
  Assert-True $holder.HasExited '安装开始前程序已退出'

  Write-Step "程序未运行：静默升级到 $Version2"
  $r = Invoke-Request $Pkg2 "$Pkg2.sig" $Version2
  Assert-True ($r.Code -eq 0) '服务接受请求'
  Wait-Installed $Version2
  Assert-True ((Get-ServiceLogText) -match 'msiexec 结束：Success') '服务日志记录 msiexec 成功'

  Write-Step '降级：拒绝'
  $r = Invoke-Request $Pkg1 "$Pkg1.sig" $Version1
  Assert-True ($r.Code -eq 1 -and $r.Output -match '"code":"notNewer"') "请求安装 $Version1 被拒绝（notNewer）"
  Assert-True ((Get-InstalledPrimusVersion) -ceq $Version2) "版本仍为 $Version2"

  Write-Step '静默卸载'
  # 等服务空闲停止前也能卸载：ServiceControl Stop="both" 会先停服务
  Invoke-Msiexec @('/x', "`"$Pkg2`"") 'uninstall.log'
  Assert-UpdateServiceRemoved
  Assert-True (-not (Test-Path -LiteralPath (Join-Path $InstallDir 'PrimusUpdate.exe'))) '已移除 PrimusUpdate.exe'
} finally {
  Remove-Item -LiteralPath $Packages -Recurse -Force -ErrorAction SilentlyContinue
  if (Test-Path -LiteralPath $InstallDir) {
    & takeown.exe /F $InstallDir /R /D Y 2>&1 | Out-Null
    & icacls.exe $InstallDir /grant '*S-1-5-32-544:(OI)(CI)F' /T /C /Q 2>&1 | Out-Null
    Remove-Item -LiteralPath $InstallDir -Recurse -Force -ErrorAction SilentlyContinue
  }
}

Write-Host "`n✓ 更新服务静默升级冒烟通过（$BaseVersion → $Version1 → $Version2）" -ForegroundColor Green
