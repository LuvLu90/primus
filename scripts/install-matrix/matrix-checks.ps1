#requires -Version 7.2
<#
.SYNOPSIS
  安装矩阵的附加检查（开发计划第 4 周 P0 安装测试）：由 msi-smoke.ps1 -ExtraChecks 在安装后、卸载前调用。

.DESCRIPTION
  在已安装的 <InstallDir> 上：
  1. 把本目录与 core-contract 复制到 C:\PrimusMatrix\scripts（标准用户可读），启动常驻 Faux 模型服务
  2. -Gui 时：以中完整性级别（gsudo 降权）跑端到端对话 conversation.e2e.ts，对象为安装目录中的 Primus.exe；
     之后确认当前用户的会话与 WebView2 数据都在 data\users\<SID>\ 下，没有落到 %APPDATA% / %LOCALAPPDATA%
  3. 新建一个标准用户（只在 Users 组），授予“作为批处理作业登录”，经计划任务以该用户运行 std-user.ps1：
     启动 App、ACL 与隔离、Core 对话（含工具调用）、数据不落到 data 之外
  4. 删除该用户与计划任务、结束 Faux 服务；日志与结果放在 -OutDir
  任何一步不符合预期即抛错。需要管理员权限。

.PARAMETER InstallDir
  安装目录（msi-smoke.ps1 传入）。

.PARAMETER OutDir
  结果与日志目录，默认 C:\PrimusMatrix\out。

.PARAMETER Gui
  同时跑端到端对话（需要 tauri-driver、msedgedriver、gsudo，以及 e2e 依赖已安装；PRIMUS_NATIVE_DRIVER 指向 msedgedriver）。
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)] [string] $InstallDir,
  [string] $OutDir = 'C:\PrimusMatrix\out',
  [switch] $Gui
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Write-Step([string] $Message) { Write-Host "`n==> $Message" -ForegroundColor Cyan }
function ConvertTo-PsLiteral([string] $Value) { return "'" + ($Value -replace "'", "''") + "'" }
# 以中完整性级别运行一段 PowerShell。gsudo 在 PowerShell 中调用时会再经一层 PowerShell 解析命令行，
# 直接传 -Command 字符串时其中的 $变量 会在外层被展开；用 -EncodedCommand（Base64）原样传递脚本
function Invoke-MediumPwsh([string] $Script) {
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($Script))
  # 子进程输出直接写到主机，不进函数的输出流（否则返回值会变成输出行加退出码的数组）
  & gsudo --integrity Medium pwsh -NoProfile -NonInteractive -EncodedCommand $encoded | Out-Host
  return [int] $LASTEXITCODE
}
function Assert-True([bool] $Condition, [string] $Message) {
  if (-not $Condition) { throw "✗ $Message" }
  Write-Host "  ✓ $Message"
}

$RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$Stage = 'C:\PrimusMatrix'
$StageScripts = Join-Path $Stage 'scripts'
$dataDir = Join-Path $InstallDir 'data'
$node = Join-Path $InstallDir 'resources\runtime\node.exe'
$mySid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$StdUser = 'primus-matrix-std'
$TaskName = 'PrimusMatrixStdUser'
$policyKey = 'HKLM:\Software\Policies\Microsoft\Edge\WebView2\UserDataFolder'
$policyApplied = $false

# ---- 1. 准备脚本与 Faux 模型服务 ----
Write-Step "准备 $Stage 与 Faux 模型服务"
New-Item -ItemType Directory -Force -Path $StageScripts, $OutDir | Out-Null
Copy-Item -LiteralPath (Join-Path $RepoRoot 'scripts\install-matrix') -Destination $StageScripts -Recurse -Force
Copy-Item -LiteralPath (Join-Path $RepoRoot 'scripts\core-contract') -Destination $StageScripts -Recurse -Force
& icacls.exe $Stage /grant '*S-1-5-32-545:(OI)(CI)RX' /T /Q | Out-Null
& icacls.exe $OutDir /grant '*S-1-5-32-545:(OI)(CI)M' /T /Q | Out-Null
$urlFile = Join-Path $OutDir 'faux-url.txt'
Remove-Item -LiteralPath $urlFile -ErrorAction SilentlyContinue
$faux = Start-Process -FilePath $node -ArgumentList @((Join-Path $StageScripts 'install-matrix\faux-serve.mjs'), '--out', $OutDir) `
  -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $OutDir 'faux.log') -RedirectStandardError (Join-Path $OutDir 'faux.err.log')
$deadline = (Get-Date).AddSeconds(20)
while (-not (Test-Path -LiteralPath $urlFile) -and (Get-Date) -lt $deadline -and -not $faux.HasExited) { Start-Sleep -Milliseconds 200 }
if (-not (Test-Path -LiteralPath $urlFile)) {
  # 尚未进入下方 try，finally 不会执行：先停掉 node，免得占用文件影响失败后的卸载
  if (-not $faux.HasExited) { Stop-Process -Id $faux.Id -Force -ErrorAction SilentlyContinue }
  throw '✗ Faux 模型服务未在 20 秒内写出 faux-url.txt'
}
Write-Host '  ✓ Faux 模型服务已启动'
$fauxUrl = (Get-Content -LiteralPath $urlFile -Raw).Trim()
Write-Host "  · $fauxUrl"

try {
  # ---- 2. 端到端对话（当前用户，中完整性级别）----
  if ($Gui) {
    Write-Step '端到端对话：安装目录中的 Primus.exe（WebdriverIO + tauri-driver，中完整性级别）'
    $e2eDir = Join-Path $RepoRoot 'e2e'
    $env:PRIMUS_E2E_APP = Join-Path $InstallDir 'Primus.exe'
    $env:PRIMUS_E2E_FAUX_URL = $fauxUrl
    $env:NO_PROXY = '127.0.0.1,localhost'
    Push-Location $e2eDir
    try {
      $e2eCode = Invoke-MediumPwsh './node_modules/.bin/wdio.cmd run wdio.conf.ts --spec ./specs/conversation.e2e.ts; exit $LASTEXITCODE'
    } finally {
      Pop-Location
    }
    Assert-True ($e2eCode -eq 0) "端到端对话通过（wdio 退出码 $e2eCode）"
    $myDir = Join-Path $dataDir "users\$mySid"
    Assert-True (@(Get-ChildItem -LiteralPath (Join-Path $myDir 'core\sessions') -Recurse -Filter *.jsonl -ErrorAction SilentlyContinue).Count -gt 0) "会话文件在 users\$mySid\core\sessions"
    # 驱动使用与 App 相同的实际数据目录；错误覆盖场景由下方标准用户检查。
    Assert-True (@(Get-ChildItem -LiteralPath (Join-Path $myDir 'webview') -Force -ErrorAction SilentlyContinue).Count -gt 0) 'WebView2 数据在当前用户的 webview 目录'
    foreach ($base in $env:APPDATA, $env:LOCALAPPDATA) {
      $leak = Join-Path $base 'com.primus.desktop'
      Assert-True (-not (Test-Path -LiteralPath $leak)) "没有 $leak（约束 C2）"
    }
  }

  # ---- 3. 标准用户 ----
  # 隔离检查需要另一个用户的 users\<SID>：没跑端到端对话（ARM64 格）时，以中完整性级别启动一次安装目录中的
  # Primus.exe，由 App 自己的数据准备逻辑建好当前用户的目录与 ACL（不手工建目录、设 ACL）
  $myDir = Join-Path $dataDir "users\$mySid"
  if (-not (Test-Path -LiteralPath (Join-Path $myDir 'core\sessions'))) {
    Write-Step '以中完整性级别启动一次 Primus.exe，建好当前用户的 data\users\<SID>（供隔离检查）'
    $exe = ConvertTo-PsLiteral (Join-Path $InstallDir 'Primus.exe')
    $wait = ConvertTo-PsLiteral (Join-Path $myDir 'core\sessions')
    $launchCode = Invoke-MediumPwsh "`$p = Start-Process -FilePath $exe -PassThru; `$d = (Get-Date).AddSeconds(60); while (-not (Test-Path -LiteralPath $wait) -and -not `$p.HasExited -and (Get-Date) -lt `$d) { Start-Sleep -Milliseconds 500 }; Start-Sleep -Seconds 2; if (-not `$p.HasExited) { & taskkill.exe /PID `$p.Id /T /F | Out-Null }; exit 0"
    Write-Host "  · 中完整性级别启动脚本退出码 $launchCode"
    Assert-True (Test-Path -LiteralPath (Join-Path $myDir 'core\sessions')) "Primus.exe 建好 users\$mySid"
  }

  Write-Step "标准用户 $StdUser：启动 App、ACL 与隔离、Core 对话"
  $chars = [char[]]'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  $plain = -join (1..20 | ForEach-Object { $chars[[Security.Cryptography.RandomNumberGenerator]::GetInt32($chars.Length)] }) + '!a1'
  $password = ConvertTo-SecureString $plain -AsPlainText -Force
  Get-LocalUser -Name $StdUser -ErrorAction SilentlyContinue | Remove-LocalUser
  $user = New-LocalUser -Name $StdUser -Password $password -PasswordNeverExpires -AccountNeverExpires -Description 'Primus 安装矩阵临时标准用户'
  Add-LocalGroupMember -SID 'S-1-5-32-545' -Member $StdUser
  $stdSid = $user.SID.Value
  $inAdmins = @(Get-LocalGroupMember -SID 'S-1-5-32-544' | Where-Object { $_.SID.Value -eq $stdSid })
  Assert-True ($inAdmins.Count -eq 0) "$StdUser（$stdSid）不在管理员组"

  # Policies 是管理员配置：不要让标准用户测试靠提权或放宽注册表 ACL 才能运行。
  # 只设置本测试的 Primus.exe 值；已有值时拒绝覆盖，finally 只删除自己创建的值。
  $existingPolicy = Get-Item -LiteralPath $policyKey -ErrorAction SilentlyContinue
  if ($existingPolicy -and $existingPolicy.GetValueNames() -contains 'Primus.exe') { throw '已有 Primus.exe WebView2 策略，拒绝覆盖' }
  if (-not $existingPolicy) { $null = New-Item -Path $policyKey -Force }
  $null = New-ItemProperty -LiteralPath $policyKey -Name 'Primus.exe' -Value (Join-Path $OutDir 'webview-override-must-not-exist') -PropertyType String
  $policyApplied = $true

  # 计划任务以密码登录需要“作为批处理作业登录”（SeBatchLogonRight），Users 组默认没有
  $inf = Join-Path $env:TEMP 'primus-matrix-secpol.inf'
  $db = Join-Path $env:TEMP 'primus-matrix-secpol.sdb'
  & secedit.exe /export /cfg $inf /areas USER_RIGHTS | Out-Null
  $lines = [Collections.Generic.List[string]](Get-Content -LiteralPath $inf)
  $i = $lines.FindIndex({ param($l) $l -match '^SeBatchLogonRight\s*=' })
  if ($i -ge 0) { $lines[$i] = "$($lines[$i]),*$stdSid" } else {
    $p = $lines.FindIndex({ param($l) $l -eq '[Privilege Rights]' })
    $lines.Insert($p + 1, "SeBatchLogonRight = *$stdSid")
  }
  Set-Content -LiteralPath $inf -Value $lines -Encoding Unicode
  & secedit.exe /configure /db $db /cfg $inf /areas USER_RIGHTS /quiet | Out-Null
  Assert-True ($LASTEXITCODE -eq 0) "已授予 $StdUser 作为批处理作业登录"

  $pwsh = (Get-Command pwsh).Source
  $stdScript = Join-Path $StageScripts 'install-matrix\std-user.ps1'
  $argLine = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$stdScript`" -InstallDir `"$InstallDir`" -OutDir `"$OutDir`" -FauxUrl `"$fauxUrl`" -OtherSid $mySid"
  $action = New-ScheduledTaskAction -Execute $pwsh -Argument $argLine -WorkingDirectory $Stage
  $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Register-ScheduledTask -TaskName $TaskName -Action $action -Settings $settings -User $StdUser -Password $plain -RunLevel Limited | Out-Null
  $resultFile = Join-Path $OutDir 'std-user-result.json'
  Remove-Item -LiteralPath $resultFile -ErrorAction SilentlyContinue
  Start-ScheduledTask -TaskName $TaskName
  $deadline = (Get-Date).AddMinutes(8)
  do {
    Start-Sleep -Seconds 2
    $state = (Get-ScheduledTask -TaskName $TaskName).State
  } while (($state -eq 'Running' -or -not (Test-Path -LiteralPath $resultFile)) -and (Get-Date) -lt $deadline)
  $info = Get-ScheduledTaskInfo -TaskName $TaskName
  $log = Join-Path $OutDir 'std-user.log'
  if (Test-Path -LiteralPath $log) { Get-Content -LiteralPath $log | ForEach-Object { Write-Host "    $_" } }
  Assert-True (Test-Path -LiteralPath $resultFile) "标准用户任务写出结果（任务状态 $state，LastTaskResult $($info.LastTaskResult)）"
  $stdResult = Get-Content -LiteralPath $resultFile -Raw | ConvertFrom-Json
  Assert-True ([bool] $stdResult.ok) "标准用户检查全部通过$(if ($stdResult.error) { "：$($stdResult.error)" })"
  Assert-True ($stdResult.sid -eq $stdSid) "检查以 $StdUser（$stdSid）身份运行"
  $stdDir = Join-Path $dataDir "users\$stdSid"
  Assert-True (Test-Path -LiteralPath $stdDir) "标准用户的数据在 $stdDir"
} finally {
  Write-Step '清理：计划任务、临时用户、Faux 服务'
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  # 先结束标准用户残留的进程（Primus、Core 等），免得其打开的文件让卸载后的清理删不掉
  Get-Process -IncludeUserName -ErrorAction SilentlyContinue |
    Where-Object { $_.UserName -and $_.UserName.EndsWith("\$StdUser") } |
    ForEach-Object { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue }
  Get-LocalUser -Name $StdUser -ErrorAction SilentlyContinue | Remove-LocalUser
  if (-not $faux.HasExited) { Stop-Process -Id $faux.Id -Force -ErrorAction SilentlyContinue }
  $logs = Join-Path $dataDir 'shared\logs'
  if (Test-Path -LiteralPath $logs) { Copy-Item -LiteralPath $logs -Destination (Join-Path $OutDir 'data-logs') -Recurse -Force -ErrorAction SilentlyContinue }
  if ($policyApplied) { Remove-ItemProperty -LiteralPath $policyKey -Name 'Primus.exe' }
}

Write-Host "`n✓ 安装矩阵附加检查通过（$InstallDir）" -ForegroundColor Green
