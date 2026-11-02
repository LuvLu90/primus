#requires -Version 7.2
<#
.SYNOPSIS
  安装矩阵：以标准用户（非管理员）身份验证安装后的 App（由 matrix-checks.ps1 经计划任务以该用户身份运行）。

.DESCRIPTION
  1. 确认当前用户不是管理员
  2. 启动安装目录中的 Primus.exe，等它在 <安装目录>\data\users\<SID>\ 下建好目录布局后结束进程树
     （计划任务在非交互会话中运行，窗口可能建不起来；这里只验证薄壳的数据目录逻辑，界面对话由端到端测试覆盖）
  3. users\<SID> 的所有者是当前用户、没有授予 Users 组；读不了其他用户的 users\<SID>；写不进安装目录根
  4. 用安装目录中的 node.exe 跑 converse.mjs：按薄壳的方式拉起 Core，完成一次含 read 工具调用的对话，
     会话写在 data\users\<SID>\core\sessions
  5. 用户主目录下没有 .primus，%APPDATA% / %LOCALAPPDATA% 下没有 com.primus.desktop
  结果写入 <OutDir>\std-user-result.json（ok、checks、error），控制台输出写入 std-user.log。
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)] [string] $InstallDir,
  [Parameter(Mandatory)] [string] $OutDir,
  [Parameter(Mandatory)] [string] $FauxUrl,
  [string] $OtherSid
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Start-Transcript -LiteralPath (Join-Path $OutDir 'std-user.log') -Force | Out-Null

$result = [ordered]@{ ok = $false; user = $null; sid = $null; checks = [Collections.Generic.List[object]]::new(); error = $null }
function Assert-True([bool] $Condition, [string] $Message) {
  $result.checks.Add([ordered]@{ ok = $Condition; message = $Message })
  if (-not $Condition) { throw "✗ $Message" }
  Write-Host "  ✓ $Message"
}
$policyKey = 'HKCU:\Software\Policies\Microsoft\Edge\WebView2\UserDataFolder'
$policyCreated = $false

try {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $sid = $identity.User.Value
  $result.user = $identity.Name
  $result.sid = $sid
  $isAdmin = ([Security.Principal.WindowsPrincipal] $identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  Assert-True (-not $isAdmin) "以标准用户运行（$($identity.Name)，$sid）"

  $dataDir = Join-Path $InstallDir 'data'
  $userDir = Join-Path $dataDir "users\$sid"
  $mainExe = Join-Path $InstallDir 'Primus.exe'

  # ---- 启动 App，等数据目录就绪 ----
  # 故意注入 data 外目录；App 必须覆盖它，而不是让 WebView2 使用继承值。
  $overrideDir = Join-Path $OutDir 'webview-override-must-not-exist'
  Assert-True (-not (Test-Path -LiteralPath $overrideDir)) 'WebView2 覆盖探针目录尚不存在'
  # 专用临时用户下增加 UserDataFolder 策略，覆盖“只清除环境变量仍会落到注册表指定目录”的情况。
  Assert-True (-not (Test-Path -LiteralPath $policyKey)) '临时用户没有已有 WebView2 数据目录策略'
  $null = New-Item -Path $policyKey -Force
  $policyCreated = $true
  $null = New-ItemProperty -LiteralPath $policyKey -Name 'Primus.exe' -Value $overrideDir -PropertyType String
  $proc = Start-Process -FilePath $mainExe -WorkingDirectory $InstallDir -PassThru -WindowStyle Hidden -Environment @{ WEBVIEW2_USER_DATA_FOLDER = $overrideDir }
  $deadline = (Get-Date).AddSeconds(60)
  $ready = $false
  while ((Get-Date) -lt $deadline) {
    if (Test-Path -LiteralPath (Join-Path $userDir 'core\sessions')) { $ready = $true; break }
    if ($proc.HasExited) { break }
    Start-Sleep -Milliseconds 500
  }
  # WebView2 环境异步创建：等 users\<SID>\webview 中出现数据（最多 30 秒）再结束 App
  $webviewDir = Join-Path $userDir 'webview'
  $webviewDeadline = (Get-Date).AddSeconds(30)
  while ($ready -and -not $proc.HasExited -and (Get-Date) -lt $webviewDeadline -and
    @(Get-ChildItem -LiteralPath $webviewDir -Force -ErrorAction SilentlyContinue).Count -eq 0) { Start-Sleep -Milliseconds 500 }
  Start-Sleep -Seconds 3
  $exitedEarly = $proc.HasExited
  $exitCode = if ($exitedEarly) { $proc.ExitCode } else { $null }
  if (-not $exitedEarly) { & taskkill.exe /PID $proc.Id /T /F | Out-Null }
  Assert-True $ready "Primus.exe 以标准用户启动后建好 $userDir（提前退出：$exitedEarly，退出码 $exitCode）"
  Assert-True (-not $exitedEarly -or $exitCode -eq 0) "Primus.exe 没有以非零退出码提前退出（退出码 $exitCode）"
  foreach ($sub in 'app', 'core', 'core\sessions', 'vault', 'tmp', 'webview') {
    Assert-True (Test-Path -LiteralPath (Join-Path $userDir $sub) -PathType Container) "存在 users\<SID>\$sub"
  }
  $webviewItems = @(Get-ChildItem -LiteralPath $webviewDir -Force -ErrorAction SilentlyContinue | ForEach-Object Name)
  Assert-True ($webviewItems.Count -gt 0) "WebView2 用户数据在 users\<SID>\webview（$($webviewItems -join ', ')）"
  Assert-True (-not (Test-Path -LiteralPath $overrideDir)) '继承的 WebView2 覆盖目录未被创建'
  Assert-True (Test-Path -LiteralPath (Join-Path $dataDir 'shared\logs') -PathType Container) '存在 data\shared\logs'

  # ---- ACL ----
  $acl = Get-Acl -LiteralPath $userDir
  $ownerSid = (New-Object Security.Principal.NTAccount($acl.Owner)).Translate([Security.Principal.SecurityIdentifier]).Value
  Assert-True ($ownerSid -eq $sid) "users\<SID> 的所有者是当前用户（$($acl.Owner)）"
  $grantees = @($acl.Access | ForEach-Object {
      try { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value } catch { $_.IdentityReference.Value }
    })
  Assert-True (-not ($grantees -contains 'S-1-5-32-545')) "users\<SID> 未授予 Users 组（授予：$($grantees -join ', ')）"
  if ($OtherSid -and $OtherSid -ne $sid) {
    $other = Join-Path $dataDir "users\$OtherSid"
    if (Test-Path -LiteralPath $other) {
      $denied = $false
      try { Get-ChildItem -LiteralPath $other -Force -ErrorAction Stop | Out-Null } catch [UnauthorizedAccessException] { $denied = $true } catch { $denied = $_.Exception -is [UnauthorizedAccessException] -or $_.CategoryInfo.Category -eq 'PermissionDenied' }
      Assert-True $denied "读不了其他用户的 users\$OtherSid"
    } else {
      Assert-True $false "其他用户的 users\$OtherSid 不存在，无法检查隔离"
    }
  }
  $probe = Join-Path $InstallDir 'std-user-write.txt'
  $rootWritable = $true
  try { Set-Content -LiteralPath $probe -Value 'x' -ErrorAction Stop; Remove-Item -LiteralPath $probe -ErrorAction SilentlyContinue } catch { $rootWritable = $false }
  Assert-True (-not $rootWritable) '写不进安装目录根'

  # ---- Core 对话 ----
  $node = Join-Path $InstallDir 'resources\runtime\node.exe'
  $converse = Join-Path $PSScriptRoot 'converse.mjs'
  $converseOut = Join-Path $OutDir 'std-user-converse.json'
  & $node $converse --install-dir $InstallDir --user-dir $userDir --faux-url $FauxUrl --out $converseOut 2>&1 | ForEach-Object { Write-Host "    $_" }
  $converseCode = $LASTEXITCODE
  Assert-True ($converseCode -eq 0) "标准用户的 Core 完成一次含工具调用的对话（converse.mjs 退出码 $converseCode）"

  # ---- 没有落到 data 之外 ----
  Assert-True (-not (Test-Path -LiteralPath (Join-Path $env:USERPROFILE '.primus'))) "用户主目录下没有 .primus"
  foreach ($base in $env:APPDATA, $env:LOCALAPPDATA) {
    $leak = Join-Path $base 'com.primus.desktop'
    Assert-True (-not (Test-Path -LiteralPath $leak)) "没有 $leak（App 数据都在 data 下，约束 C2）"
  }
  $result.ok = $true
} catch {
  $result.error = $_.Exception.Message
  Write-Host $result.error
} finally {
  if ($policyCreated) { Remove-Item -LiteralPath $policyKey -Force }
  $result | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $OutDir 'std-user-result.json') -Encoding utf8
  Stop-Transcript | Out-Null
}
exit ($result.ok ? 0 : 1)
