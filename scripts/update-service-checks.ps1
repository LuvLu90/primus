# 更新服务 PrimusUpdate 的安装 / 卸载检查（ADR 0007），由 msi-smoke.ps1 与 update-service-smoke.ps1 点源引用。
# 调用方需已定义 Assert-True。

$UpdateServiceName = 'PrimusUpdate'
$UpdateStagingDir = Join-Path $env:ProgramData 'Primus\Update'
$PrimusRegistryKey = 'HKLM:\SOFTWARE\Primus'

function Get-InstalledPrimusVersion {
  $item = Get-ItemProperty -LiteralPath $PrimusRegistryKey -Name 'Version' -ErrorAction SilentlyContinue
  if ($null -eq $item) { return $null }
  return [string] $item.Version
}

# 服务已按 Primus.wxs 安装：LocalSystem、按需启动、映像在安装目录、交互用户只能查询与启动；版本记录与暂存目录就绪
function Assert-UpdateServiceInstalled([string] $InstallDir, [string] $Version) {
  $service = Get-CimInstance -ClassName Win32_Service -Filter "Name='$UpdateServiceName'"
  Assert-True ($null -ne $service) "已安装更新服务 $UpdateServiceName"
  Assert-True ($service.StartName -eq 'LocalSystem') "更新服务以 LocalSystem 运行（实际 $($service.StartName)）"
  Assert-True ($service.StartMode -eq 'Manual') "更新服务按需启动（实际 $($service.StartMode)）"
  $expected = '"' + (Join-Path $InstallDir 'PrimusUpdate.exe') + '" --service'
  Assert-True ($service.PathName -ieq $expected) "更新服务的命令行为 $expected（实际 $($service.PathName)）"
  $sddl = ((& sc.exe sdshow $UpdateServiceName) -join '').Trim()
  Assert-True ($LASTEXITCODE -eq 0) "读取更新服务的安全描述符（$sddl）"
  # 交互用户只有查询配置 / 状态、枚举依赖、询问、启动、读取（CC LC SW LO RP RC），没有停止（WP）、
  # 暂停（DT）、改配置（DC）、删除（SD）、改权限（WD）、取得所有权（WO）
  $iu = @([regex]::Matches($sddl, '\(A;;([A-Z]+);;;IU\)') | ForEach-Object { $_.Groups[1].Value })
  # 系统按自己的顺序输出权限缩写（如 CCLCSWRPLORC），按两字母一组排序后比较
  $rights = { param($text) (($text -split '(..)' | Where-Object { $_ }) | Sort-Object) -join '' }
  Assert-True ($iu.Count -eq 1 -and (& $rights $iu[0]) -ceq (& $rights 'CCLCSWLORPRC')) "交互用户对更新服务只能查询与启动（实际 $($iu -join ',')）"
  $others = [regex]::Matches($sddl, '\(A;;[A-Z]+;;;([A-Z]{2}|S-[\d-]+)\)') | ForEach-Object { $_.Groups[1].Value } |
    Where-Object { $_ -notin 'SY', 'BA', 'IU' }
  Assert-True (@($others).Count -eq 0) "更新服务的 DACL 只给 SYSTEM、Administrators、交互用户（多出 $($others -join ',')）"

  $installed = Get-InstalledPrimusVersion
  Assert-True ($installed -ceq $Version) "已在 $PrimusRegistryKey 记录版本 $Version（实际 $installed）"

  Assert-True (Test-Path -LiteralPath $UpdateStagingDir -PathType Container) "存在暂存目录 $UpdateStagingDir"
  foreach ($dir in @((Split-Path -Parent $UpdateStagingDir), $UpdateStagingDir)) {
    $acl = Get-Acl -LiteralPath $dir
    $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    Assert-True ($owner -eq 'S-1-5-18') "$dir 的所有者为 SYSTEM（实际 $owner）"
    Assert-True $acl.AreAccessRulesProtected "$dir 的 DACL 受保护（不继承 ProgramData 给 Users 的写入）"
    $principals = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) |
      ForEach-Object { $_.IdentityReference.Value } | Sort-Object -Unique)
    Assert-True (($principals -join ',') -eq 'S-1-5-18,S-1-5-32-544') "$dir 只授权 SYSTEM 与 Administrators（实际 $($principals -join ',')）"
  }
}

# 完全卸载后：服务、版本记录与 ProgramData\Primus 都已删除
function Assert-UpdateServiceRemoved {
  $service = Get-CimInstance -ClassName Win32_Service -Filter "Name='$UpdateServiceName'"
  Assert-True ($null -eq $service) "已删除更新服务 $UpdateServiceName"
  Assert-True ($null -eq (Get-InstalledPrimusVersion)) "已清除 $PrimusRegistryKey 中的版本记录"
  $parent = Split-Path -Parent $UpdateStagingDir
  Assert-True (-not (Test-Path -LiteralPath $parent)) "已删除 $parent"
}
