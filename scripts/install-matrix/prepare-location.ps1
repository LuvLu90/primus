#requires -Version 7.2
<#
.SYNOPSIS
  安装矩阵：按位置名给出安装目录，必要时准备 D 盘（开发计划第 4 周 P0：Program Files、D 盘）。

.DESCRIPTION
  programfiles  默认目录 C:\Program Files\Primus
  d-drive       D:\primus；没有固定磁盘 D: 时用 diskpart 建一个 4 GB 的动态 VHDX，格式化为 NTFS 并挂到 D:
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
    if (Test-FixedDrive 'D') {
      Write-Host '· 已有固定磁盘 D:（NTFS）'
    } else {
      if (Get-PSDrive -Name D -ErrorAction SilentlyContinue) { throw "D: 已被占用但不是 NTFS 固定磁盘，无法用于测试" }
      $vhd = 'C:\primus-matrix-d.vhdx'
      $script = Join-Path $env:TEMP 'primus-matrix-diskpart.txt'
      @(
        "create vdisk file=`"$vhd`" maximum=4096 type=expandable",
        "select vdisk file=`"$vhd`"",
        'attach vdisk',
        'create partition primary',
        'format fs=ntfs quick label=PrimusD',
        'assign letter=D'
      ) | Set-Content -LiteralPath $script -Encoding ascii
      & diskpart.exe /s $script | ForEach-Object { Write-Host "  $_" }
      if ($LASTEXITCODE -ne 0) { throw "diskpart 退出码 $LASTEXITCODE" }
      $deadline = (Get-Date).AddSeconds(30)
      while (-not (Test-FixedDrive 'D') -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 1 }
      if (-not (Test-FixedDrive 'D')) { throw '挂载的 VHDX 未出现为 NTFS 固定磁盘 D:' }
      Write-Host "· 已建 D:（$vhd）"
    }
    $dir = 'D:\primus'
  }
}

if ($env:GITHUB_ENV) { "PRIMUS_MATRIX_DIR=$dir" | Out-File -FilePath $env:GITHUB_ENV -Append -Encoding utf8 }
Write-Output $dir
