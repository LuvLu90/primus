#requires -Version 7.2
<#
.SYNOPSIS
  检查 out/ 中某个架构的 MSI（只发 MSI，ADR 0007），CI 与发布工作流共用（技术方案第 3.1、16.5、22 章）。

.DESCRIPTION
  - out/ 中该架构恰有一个 Primus_<ver>_<arch>_zh-CN.msi，版本与 tauri.conf.json 一致；没有残留的 NSIS 安装程序
  - 安装包 < 120MB（第 16.5 节），旁边的 .sha256 与文件内容一致
  - MSI 摘要信息的 Template 平台与架构一致（x64;2052 / Arm64;2052）
  - MSI 的 ServiceInstall 表恰有更新服务 PrimusUpdate：LocalSystem、按需启动（SERVICE_DEMAND_START = 3）、参数 --service
  - 编译出的 Primus.exe 与 PrimusUpdate.exe 的 PE Machine 与架构一致（x64 = 0x8664，arm64 = 0xAA64），防止打进错误架构的程序
  通过后把 PRIMUS_MSI（完整路径）写进 GITHUB_ENV（在 Actions 中运行时）。

.PARAMETER Arch
  x64 或 arm64。

.PARAMETER AppExe
  编译出的 Primus.exe，默认 apps/desktop/src-tauri/target/release/Primus.exe（目标与 rustc 主机一致时的位置）。

.PARAMETER OutDir
  安装包目录，默认仓库根下 out/。
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)] [ValidateSet('x64', 'arm64')] [string] $Arch,
  [string] $AppExe,
  [string] $OutDir
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$RepoRoot = Split-Path -Parent $PSScriptRoot
if (-not $AppExe) { $AppExe = Join-Path $RepoRoot 'apps\desktop\src-tauri\target\release\Primus.exe' }
if (-not $OutDir) { $OutDir = Join-Path $RepoRoot 'out' }
$Version = (Get-Content -LiteralPath (Join-Path $RepoRoot 'apps\desktop\src-tauri\tauri.conf.json') -Raw | ConvertFrom-Json).version

function Assert-True([bool] $Condition, [string] $Message) {
  if (-not $Condition) { throw "✗ $Message" }
  Write-Host "  ✓ $Message"
}

# 某个架构的唯一安装包；同时确认文件名中的版本与 tauri.conf.json 一致
function Get-Installer([string] $Pattern, [string] $Expected) {
  $found = @(Get-ChildItem -LiteralPath $OutDir -Filter $Pattern -File)
  Assert-True ($found.Count -eq 1) "out/ 中恰有一个 $Pattern（实际 $($found.Count) 个：$(($found | ForEach-Object Name) -join '、')）"
  Assert-True ($found[0].Name -ceq $Expected) "文件名为 $Expected（实际 $($found[0].Name)）"
  $file = $found[0]
  Assert-True ($file.Length -lt 120MB) "$($file.Name) 小于 120MB（$([math]::Round($file.Length / 1MB, 1)) MiB）"
  $hash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
  $line = (Get-Content -LiteralPath "$($file.FullName).sha256" -Raw).Trim()
  Assert-True ($line -ceq "$hash  $($file.Name)") "$($file.Name).sha256 与文件一致（$hash）"
  return $file
}

Write-Host "检查 $Arch 安装包（版本 $Version）"
$msi = Get-Installer "Primus_*_${Arch}_zh-CN.msi" "Primus_${Version}_${Arch}_zh-CN.msi"
$stale = @(Get-ChildItem -LiteralPath $OutDir -Filter '*-setup.exe' -File)
Assert-True ($stale.Count -eq 0) "out/ 中没有 NSIS 安装程序（只发 MSI；实际 $(($stale | ForEach-Object Name) -join '、')）"

# MSI 摘要信息流第 7 项 Template：“平台;语言”，由 wix build -arch 写入
$installer = New-Object -ComObject WindowsInstaller.Installer
$summary = $installer.GetType().InvokeMember('SummaryInformation', 'GetProperty', $null, $installer, @($msi.FullName, 0))
$template = [string] $summary.GetType().InvokeMember('Property', 'GetProperty', $null, $summary, @(7))
[void] [Runtime.InteropServices.Marshal]::ReleaseComObject($summary)
$platform = @{ x64 = 'x64'; arm64 = 'Arm64' }[$Arch]
Assert-True ($template -ceq "$platform;2052") "MSI 平台与语言为 $platform;2052（实际 $template）"

# ServiceInstall 表（只读打开数据库：msiOpenDatabaseModeReadOnly = 0）
$database = $installer.GetType().InvokeMember('OpenDatabase', 'InvokeMethod', $null, $installer, @($msi.FullName, 0))
$view = $database.GetType().InvokeMember('OpenView', 'InvokeMethod', $null, $database,
  @('SELECT `Name`, `StartName`, `StartType`, `ServiceType`, `Arguments` FROM `ServiceInstall`'))
[void] $view.GetType().InvokeMember('Execute', 'InvokeMethod', $null, $view, $null)
$services = @()
while ($record = $view.GetType().InvokeMember('Fetch', 'InvokeMethod', $null, $view, $null)) {
  $field = { param($i) $record.GetType().InvokeMember('StringData', 'GetProperty', $null, $record, @($i)) }
  $services += [pscustomobject]@{
    Name = & $field 1; StartName = & $field 2; StartType = & $field 3; ServiceType = & $field 4; Arguments = & $field 5
  }
  [void] [Runtime.InteropServices.Marshal]::ReleaseComObject($record)
}
[void] $view.GetType().InvokeMember('Close', 'InvokeMethod', $null, $view, $null)
foreach ($o in @($view, $database, $installer)) { [void] [Runtime.InteropServices.Marshal]::ReleaseComObject($o) }
Assert-True ($services.Count -eq 1 -and $services[0].Name -ceq 'PrimusUpdate') "MSI 安装唯一的服务 PrimusUpdate（实际 $(($services | ForEach-Object Name) -join '、')）"
Assert-True ($services[0].StartName -ceq 'LocalSystem' -and $services[0].StartType -eq '3' -and $services[0].ServiceType -eq '16' -and $services[0].Arguments -ceq '--service') `
  "PrimusUpdate 以 LocalSystem、按需启动、独立进程运行，参数 --service（实际 $($services[0].StartName) / $($services[0].StartType) / $($services[0].ServiceType) / $($services[0].Arguments)）"

# PE 头：0x3C 处为 PE 签名偏移，签名 "PE\0\0" 之后两个字节是 Machine
$expectedMachine = @{ x64 = 0x8664; arm64 = 0xAA64 }[$Arch]
$ServiceExe = Join-Path (Split-Path -Parent $AppExe) 'PrimusUpdate.exe'
foreach ($exe in @($AppExe, $ServiceExe)) {
  $bytes = [IO.File]::ReadAllBytes((Resolve-Path -LiteralPath $exe).Path)
  $peOffset = [BitConverter]::ToInt32($bytes, 0x3C)
  Assert-True ([BitConverter]::ToUInt32($bytes, $peOffset) -eq 0x00004550) "$exe 是 PE 文件"
  $machine = [BitConverter]::ToUInt16($bytes, $peOffset + 4)
  Assert-True ($machine -eq $expectedMachine) ("$(Split-Path -Leaf $exe) 的 PE Machine 为 0x{0:X4}（期望 0x{1:X4}）" -f $machine, $expectedMachine)
}

if ($env:GITHUB_ENV) {
  "PRIMUS_MSI=$($msi.FullName)" | Out-File -FilePath $env:GITHUB_ENV -Append -Encoding utf8
}
Write-Host "`n✓ $Arch 安装包检查通过：$($msi.Name)" -ForegroundColor Green
