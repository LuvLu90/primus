#requires -Version 7.2
<#
.SYNOPSIS
  安装矩阵：按位置名给出安装目录，必要时准备 D 盘（开发计划第 4 周 P0：Program Files、D 盘）。

.DESCRIPTION
  programfiles  默认目录 C:\Program Files\Primus
  d-drive       新建 4 GB 动态 VHDX（NTFS）；优先 D:，已有 D: 时使用其他空闲盘符，绝不修改现有卷
  输出安装目录；在 GitHub Actions 中同时写入 PRIMUS_MATRIX_DIR。需要管理员权限（d-drive 建盘时）。
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)] [ValidateSet('programfiles', 'd-drive')] [string] $Location
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Test-FixedDrive([string] $Letter) {
  $volume = Get-Volume -DriveLetter $Letter -ErrorAction SilentlyContinue
  return $null -ne $volume -and $volume.DriveType -eq 'Fixed' -and $volume.FileSystem -eq 'NTFS'
}

switch ($Location) {
  'programfiles' { $dir = Join-Path $env:ProgramFiles 'Primus' }
  'd-drive' {
    # 托管运行器的现有 D: 可归 NETWORK SERVICE 所有且承载 checkout，不能改变其所有者/ACL。
    # 只格式化自己新建的 VHDX；盘符占用时换空闲字母，安装器的祖先安全检查保持不变。
    $letter = @('D','E','F','G','H','I','J','K','L','M','N','O','P','Q','R','S','T','U','V','W','X','Y','Z') |
      Where-Object { -not (Get-PSDrive -Name $_ -ErrorAction SilentlyContinue) -and -not (Get-Volume -DriveLetter $_ -ErrorAction SilentlyContinue) } |
      Select-Object -First 1
    if (-not $letter) { throw '没有可用盘符，无法创建隔离的安装测试卷' }
    $vhd = 'C:\primus-matrix-d.vhdx'
    if (Test-Path -LiteralPath $vhd) { throw "测试 VHDX 已存在，拒绝覆盖：$vhd" }
    $script = Join-Path $env:TEMP 'primus-matrix-diskpart.txt'
    @(
      "create vdisk file=`"$vhd`" maximum=4096 type=expandable",
      "select vdisk file=`"$vhd`"",
      'attach vdisk',
      'create partition primary',
      'format fs=ntfs quick label=PrimusD',
      "assign letter=$letter"
    ) | Set-Content -LiteralPath $script -Encoding ascii
    & diskpart.exe /s $script | ForEach-Object { Write-Host "  $_" }
    if ($LASTEXITCODE -ne 0) { throw "diskpart 退出码 $LASTEXITCODE" }
    $deadline = (Get-Date).AddSeconds(30)
    while (-not (Test-FixedDrive $letter) -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 1 }
    if (-not (Test-FixedDrive $letter)) { throw "挂载的 VHDX 未出现为 NTFS 固定磁盘 ${letter}:" }
    Write-Host "· 已建隔离测试卷 ${letter}:（$vhd）"
    $dir = "${letter}:\primus"
  }
}

if ($env:GITHUB_ENV) { "PRIMUS_MATRIX_DIR=$dir" | Out-File -FilePath $env:GITHUB_ENV -Append -Encoding utf8 }
Write-Output $dir
