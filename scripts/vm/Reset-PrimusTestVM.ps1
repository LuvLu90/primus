#requires -Version 5.1
#requires -RunAsAdministrator
#requires -Modules Hyper-V
<#
.SYNOPSIS
  一键还原安装测试虚拟机到「干净」检查点，复制 MSI 与 msi-smoke.ps1 进来宾，可选执行冒烟并拉回日志。

.DESCRIPTION
  在 Hyper-V 宿主机上以管理员身份运行（Windows PowerShell 5.1 或 PowerShell 7 均可）。
  1. 虚拟机未关机则直接断电（当前状态反正会被丢弃），还原检查点（默认 clean）
  2. 启动虚拟机，等待检测信号（Heartbeat）正常，再等待 PowerShell Direct 可连接
  3. 把 MSI（可多个，例如升级测试的新旧两个版本）、scripts/msi-smoke.ps1、scripts/smoke-core-rpc.mjs
     （及其依赖的 scripts/core-dist.mjs、scripts/install-acl-fixtures.ps1、scripts/update-service-checks.ps1），
     以及更新服务冒烟 scripts/update-service-smoke.ps1 复制到来宾的 -GuestDir（默认 C:\PrimusTest）：
       -CopyMethod PowerShellDirect（默认）：Copy-Item -ToSession，不需要网络，也不需要来宾服务接口
       -CopyMethod GuestServices：Copy-VMFile（需在虚拟机设置中启用「来宾服务接口」）
  4. -RunSmoke 时在来宾内以 PowerShell 7 运行 msi-smoke.ps1（干净镜像通常没有 PowerShell 7：可用
     -PwshZip 传入官方 PowerShell-7.x-win-x64.zip，复制进来宾解压后使用，不安装、不改动快照）
  5. 把来宾内的冒烟日志（msiexec 详细日志等）与 App 日志（<安装目录>\data\shared\logs，若存在）
     拉回宿主机 -LogDestination
  冒烟失败时退出码非 0；日志仍会拉回。

  凭据：PowerShell Direct 需要来宾内的本地管理员账户。不传 -Credential 时用 Get-Credential 交互输入；
  脚本不保存、不打印凭据。msi-smoke.ps1 需要管理员令牌：若来宾内会话未提升（本地非内置管理员账户受
  UAC 远程限制），脚本会报错并给出处理办法。

.PARAMETER VMName
  虚拟机名称。

.PARAMETER CheckpointName
  要还原的检查点名称，默认 clean。

.PARAMETER Credential
  来宾本地管理员凭据。省略时提示输入（Get-Credential）。

.PARAMETER Msi
  要复制进来宾的 MSI 路径，可传多个。-RunSmoke 时对第一个执行冒烟。

.PARAMETER SmokeScript
  msi-smoke.ps1 路径，默认为本仓库 scripts/msi-smoke.ps1。

.PARAMETER GuestDir
  来宾内的工作目录，默认 C:\PrimusTest（其下 scripts\、msi\、logs\）。

.PARAMETER CopyMethod
  PowerShellDirect（默认）或 GuestServices。

.PARAMETER RunSmoke
  复制后在来宾内执行 msi-smoke.ps1。

.PARAMETER InstallDir
  传给 msi-smoke.ps1 的安装目录，例如 'D:\测试 目录\乾元 Primus'。省略时用 msi-smoke.ps1 的默认值。

.PARAMETER KeepInstalled
  传给 msi-smoke.ps1：只安装与检查，不卸载，便于继续按清单手工测试。

.PARAMETER PwshZip
  宿主机上的 PowerShell 7 便携 zip（PowerShell-7.x.y-win-x64.zip）。来宾内没有 pwsh 时用它。

.PARAMETER LogDestination
  宿主机上存放拉回日志的目录，默认 .\vm-logs\<VMName>-<时间>。

.PARAMETER BootTimeoutSec
  等待来宾启动（检测信号与 PowerShell Direct）的最长秒数，默认 600。

.EXAMPLE
  .\scripts\vm\Reset-PrimusTestVM.ps1 -VMName Primus-Win11
  只还原并启动，用于手工测试前回到干净状态。

.EXAMPLE
  .\scripts\vm\Reset-PrimusTestVM.ps1 -VMName Primus-Win11 -Msi .\out\Primus_0.1.0_x64_zh-CN.msi -RunSmoke `
    -InstallDir 'D:\测试 目录\乾元 Primus' -PwshZip .\PowerShell-7.4.6-win-x64.zip
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'Medium')]
param(
  [Parameter(Mandatory)] [ValidateNotNullOrEmpty()] [string] $VMName,
  [ValidateNotNullOrEmpty()] [string] $CheckpointName = 'clean',
  [System.Management.Automation.PSCredential]
  [System.Management.Automation.Credential()]
  $Credential = [System.Management.Automation.PSCredential]::Empty,
  [string[]] $Msi = @(),
  [string] $SmokeScript = (Join-Path (Split-Path -Parent $PSScriptRoot) 'msi-smoke.ps1'),
  [ValidateNotNullOrEmpty()] [string] $GuestDir = 'C:\PrimusTest',
  [ValidateSet('PowerShellDirect', 'GuestServices')] [string] $CopyMethod = 'PowerShellDirect',
  [switch] $RunSmoke,
  [string] $InstallDir,
  [switch] $KeepInstalled,
  [string] $PwshZip,
  [string] $LogDestination = (Join-Path (Get-Location) ("vm-logs\{0}-{1:yyyyMMdd-HHmmss}" -f $VMName, (Get-Date))),
  [ValidateRange(60, 3600)] [int] $BootTimeoutSec = 600
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Write-Step([string] $Message) { Write-Host "`n==> $Message" -ForegroundColor Cyan }

# ---- 参数检查（在动虚拟机之前）----
$vm = Get-VM -Name $VMName -ErrorAction SilentlyContinue
if (-not $vm) { throw "未找到虚拟机「$VMName」。" }
$checkpoint = Get-VMCheckpoint -VMName $VMName -Name $CheckpointName -ErrorAction SilentlyContinue
if (-not $checkpoint) { throw "虚拟机「$VMName」没有检查点「$CheckpointName」。先运行 New-PrimusTestCheckpoint.ps1。" }
$Msi = @($Msi | ForEach-Object { (Resolve-Path -LiteralPath $_).Path })
if ($RunSmoke -and $Msi.Count -eq 0) { throw '-RunSmoke 需要至少一个 -Msi。' }
$copyItems = @()
if ($Msi.Count -gt 0) {
  $SmokeScript = (Resolve-Path -LiteralPath $SmokeScript).Path
  $copyItems += $Msi | ForEach-Object { @{ Source = $_; Target = "$GuestDir\msi\$(Split-Path -Leaf $_)" } }
  $copyItems += @{ Source = $SmokeScript; Target = "$GuestDir\scripts\msi-smoke.ps1" }
  # MSI 冒烟的 ACL 夹具与 Core RPC 脚本依赖；缺少任一项都会直接失败
  foreach ($name in @('smoke-core-rpc.mjs', 'core-dist.mjs', 'install-acl-fixtures.ps1', 'update-service-checks.ps1', 'update-service-smoke.ps1')) {
    $path = Join-Path (Split-Path -Parent $SmokeScript) $name
    if (-not (Test-Path -LiteralPath $path)) { throw "未找到 $path（msi-smoke.ps1 冒烟需要它）。" }
    $copyItems += @{ Source = $path; Target = "$GuestDir\scripts\$name" }
  }
}
if ($PwshZip) {
  $PwshZip = (Resolve-Path -LiteralPath $PwshZip).Path
  $copyItems += @{ Source = $PwshZip; Target = "$GuestDir\tools\pwsh.zip" }
}
if ($CopyMethod -eq 'GuestServices') {
  $guestService = Get-VMIntegrationService -VM $vm | Where-Object { $_.Id -match '6C09BB55-D683-4DA0-8931-C9BF705F6480' }
  if (-not $guestService -or -not $guestService.Enabled) {
    throw '来宾服务接口未启用：在虚拟机设置 → 集成服务中勾选「来宾服务」，或改用 -CopyMethod PowerShellDirect。'
  }
}

# ---- 1. 还原检查点 ----
if (-not $PSCmdlet.ShouldProcess("$VMName → 检查点「$CheckpointName」", '丢弃当前状态并还原')) { return }
if ($Credential -eq [System.Management.Automation.PSCredential]::Empty) {
  $Credential = Get-Credential -Message "虚拟机「$VMName」中的本地管理员账户（用于 PowerShell Direct）"
}
Write-Step "还原检查点「$CheckpointName」（$($checkpoint.CreationTime)）"
if ((Get-VM -Name $VMName).State -ne 'Off') {
  Stop-VM -VM $vm -TurnOff -Force
}
$checkpoint | Restore-VMCheckpoint -Confirm:$false
Write-Host '· 已还原'

# ---- 2. 启动并等待来宾就绪 ----
Write-Step '启动虚拟机并等待检测信号'
if ((Get-VM -Name $VMName).State -ne 'Running') { Start-VM -VM $vm }
$deadline = (Get-Date).AddSeconds($BootTimeoutSec)
while ((Get-VM -Name $VMName).Heartbeat -notin @('OkApplicationsHealthy', 'OkApplicationsUnknown')) {
  if ((Get-Date) -gt $deadline) { throw "来宾在 $BootTimeoutSec 秒内没有检测信号（检查集成服务中的「检测信号」是否启用）。" }
  Start-Sleep -Seconds 3
}
Write-Host '· 检测信号正常'

$session = $null
while (-not $session) {
  try {
    $session = New-PSSession -VMName $VMName -Credential $Credential -ErrorAction Stop
  } catch {
    if ((Get-Date) -gt $deadline) { throw "PowerShell Direct 在 $BootTimeoutSec 秒内无法连接：$($_.Exception.Message)" }
    Start-Sleep -Seconds 5
  }
}
Write-Host '· PowerShell Direct 已连接'

$smokeExit = 0
try {
  $isAdmin = Invoke-Command -Session $session -ScriptBlock {
    ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
      [Security.Principal.WindowsBuiltInRole]::Administrator)
  }
  if ($RunSmoke -and -not $isAdmin) {
    throw ('来宾内会话没有管理员令牌，msi-smoke.ps1 无法按机器安装。请改用来宾的内置 Administrator 账户，' +
      '或在来宾内设置 HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System\LocalAccountTokenFilterPolicy=1 后重建检查点。')
  }

  # ---- 3. 复制文件 ----
  if ($copyItems.Count -gt 0) {
    Write-Step "复制 $($copyItems.Count) 个文件到来宾 $GuestDir（$CopyMethod）"
    foreach ($item in $copyItems) {
      if ($CopyMethod -eq 'GuestServices') {
        Copy-VMFile -VM $vm -SourcePath $item.Source -DestinationPath $item.Target -FileSource Host -CreateFullPath -Force
      } else {
        $targetDir = Split-Path -Parent $item.Target
        Invoke-Command -Session $session -ScriptBlock {
          New-Item -ItemType Directory -Force -Path $using:targetDir | Out-Null
        }
        Copy-Item -LiteralPath $item.Source -Destination $item.Target -ToSession $session -Force
      }
      Write-Host "· $(Split-Path -Leaf $item.Source) → $($item.Target)"
    }
  }

  # ---- 4. 执行冒烟 ----
  if ($RunSmoke) {
    Write-Step "在来宾内执行 msi-smoke.ps1（$(Split-Path -Leaf $Msi[0])）"
    $smokeArgs = @{
      Msi           = "$GuestDir\msi\$(Split-Path -Leaf $Msi[0])"
      LogDir        = "$GuestDir\logs\msi-smoke"
      KeepInstalled = [bool] $KeepInstalled
    }
    if ($InstallDir) { $smokeArgs.InstallDir = $InstallDir }
    try {
      $smokeExit = Invoke-Command -Session $session -ScriptBlock {
        $GuestDir = $using:GuestDir
        $SmokeArgs = $using:smokeArgs
        $ErrorActionPreference = 'Stop'
        $pwsh = Get-Command pwsh -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Source
        $zip = Join-Path $GuestDir 'tools\pwsh.zip'
        if (-not $pwsh -and (Test-Path -LiteralPath $zip)) {
          $dest = Join-Path $GuestDir 'tools\pwsh'
          Expand-Archive -LiteralPath $zip -DestinationPath $dest -Force
          $pwsh = Join-Path $dest 'pwsh.exe'
        }
        if (-not $pwsh) { throw '来宾内没有 PowerShell 7（msi-smoke.ps1 需要 7.2+）：传入 -PwshZip，或在快照中预装 PowerShell 7。' }
        New-Item -ItemType Directory -Force -Path $SmokeArgs.LogDir | Out-Null
        $argList = @('-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $GuestDir 'scripts\msi-smoke.ps1'),
          '-Msi', $SmokeArgs.Msi, '-LogDir', $SmokeArgs.LogDir)
        if ($SmokeArgs.ContainsKey('InstallDir')) { $argList += @('-InstallDir', $SmokeArgs.InstallDir) }
        if ($SmokeArgs.KeepInstalled) { $argList += '-KeepInstalled' }
        # Windows PowerShell 5.1 中 Stop + 2>&1 会把原生命令的 stderr 当作终止错误，执行冒烟时放宽
        $ErrorActionPreference = 'Continue'
        & $pwsh @argList 2>&1 | Tee-Object -FilePath (Join-Path $SmokeArgs.LogDir 'console.log') | Out-Host
        $LASTEXITCODE
      }
      $smokeExit = [int] (@($smokeExit)[-1])
    } catch {
      Write-Warning "来宾内执行失败：$($_.Exception.Message)"
      $smokeExit = 1
    }
    if ($smokeExit -eq 0) { Write-Host '✓ 冒烟通过' -ForegroundColor Green } else { Write-Warning "冒烟失败（退出码 $smokeExit），日志见下方目录" }
  }

  # ---- 5. 拉回日志 ----
  Write-Step "拉回日志到 $LogDestination"
  New-Item -ItemType Directory -Force -Path $LogDestination | Out-Null
  # 来宾路径用字符串拼接，不让宿主机解析来宾盘符（Join-Path 遇到宿主机不存在的盘符会抛错）
  $appLogs = if ($InstallDir) { "$($InstallDir.TrimEnd('\'))\data\shared\logs" } else { 'C:\Program Files\Primus\data\shared\logs' }
  foreach ($source in @("$GuestDir\logs", $appLogs)) {
    $exists = Invoke-Command -Session $session -ScriptBlock { Test-Path -LiteralPath $using:source }
    if ($exists) {
      $name = if ($source -eq $appLogs) { 'app-logs' } else { 'guest-logs' }
      $target = New-Item -ItemType Directory -Force -Path (Join-Path $LogDestination $name)
      Copy-Item -Path "$source\*" -Destination $target.FullName -FromSession $session -Recurse -Force
      Write-Host "· $source → $name\"
    }
  }
} finally {
  if ($session) { Remove-PSSession -Session $session }
}

Write-Host "`n完成：虚拟机「$VMName」已回到检查点「$CheckpointName」并运行中。日志：$LogDestination"
exit $smokeExit
