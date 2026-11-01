#requires -Version 7.2
<#
.SYNOPSIS
  生成发布用的自签名代码签名证书与 updater 密钥，并写入 GitHub 仓库 Secret（在维护者自己的 Windows 电脑上运行一次）。

.DESCRIPTION
  正式 CA 证书到位之前的过渡方案：自签名证书签出的安装包只在导入了公钥证书（Release 附件
  Primus-signing-cert.cer）的电脑上受信任，其他电脑上 SmartScreen 照常拦截、发布者显示“未知”。

  1. New-SelfSignedCertificate 生成代码签名证书（RSA 3072、SHA-256，默认 5 年），导出 PFX（随机口令）与公钥 .cer
  2. tauri signer generate 生成 updater 密钥对（随机口令）
  3. gh secret set 写入 5 个仓库 Secret（值经标准输入传给 gh，不出现在命令行与屏幕上）：
       PRIMUS_SIGN_PFX_BASE64、PRIMUS_SIGN_PFX_PASSWORD、
       TAURI_SIGNING_PRIVATE_KEY、TAURI_SIGNING_PRIVATE_KEY_PASSWORD、TAURI_SIGNING_PUBLIC_KEY
  4. 备份到 -BackupDir（PFX、updater 私钥、两个口令、公钥证书与 updater 公钥）。updater 公钥会写进以后的
     应用里，私钥丢失后已安装的版本将无法验证新版本，请把备份目录移到安全的离线位置
  5. 从本机证书存储中删除刚生成的证书（私钥只保留在备份的 PFX 中）

  前提：PowerShell 7、已在仓库根目录执行过 pnpm install（用 @tauri-apps/cli 的 tauri signer）、
  已安装 GitHub CLI 并以有仓库管理权限的账号 gh auth login。

.PARAMETER Repo
  目标仓库，默认 skaduv/primus。

.PARAMETER BackupDir
  备份目录，默认 ~\primus-signing-backup-<时间>；目录须不存在。

.PARAMETER Years
  证书有效期（年），默认 5。

.PARAMETER Force
  仓库中已有这些 Secret 时覆盖（会更换证书与 updater 密钥）。

.EXAMPLE
  pwsh -File scripts/new-release-signing-keys.ps1
#>
[CmdletBinding()]
param(
  [string]$Repo = "skaduv/primus",
  [string]$BackupDir = (Join-Path $HOME "primus-signing-backup-$(Get-Date -Format yyyyMMdd-HHmmss)"),
  [ValidateRange(1, 10)][int]$Years = 5,
  [switch]$Force
)
$ErrorActionPreference = "Stop"
if (-not $IsWindows) { throw "需要在 Windows 上运行（New-SelfSignedCertificate）" }
$root = Split-Path -Parent $PSScriptRoot
if (-not (Get-Command gh -ErrorAction SilentlyContinue)) { throw "未找到 GitHub CLI（gh），请先安装并 gh auth login" }
& gh auth status | Out-Null
if ($LASTEXITCODE -ne 0) { throw "gh 未登录，请先 gh auth login" }

$names = "PRIMUS_SIGN_PFX_BASE64", "PRIMUS_SIGN_PFX_PASSWORD", "TAURI_SIGNING_PRIVATE_KEY",
  "TAURI_SIGNING_PRIVATE_KEY_PASSWORD", "TAURI_SIGNING_PUBLIC_KEY"
$existing = @(& gh secret list --repo $Repo --json name --jq ".[].name")
if ($LASTEXITCODE -ne 0) { throw "无法读取 $Repo 的 Secret 列表（需要仓库管理权限）" }
$clash = @($names | Where-Object { $existing -contains $_ })
if ($clash.Count -gt 0 -and -not $Force) {
  throw "仓库中已有 $($clash -join '、')；确认要更换证书与 updater 密钥时加 -Force"
}
if (Test-Path -LiteralPath $BackupDir) { throw "备份目录已存在：$BackupDir" }
New-Item -ItemType Directory -Path $BackupDir | Out-Null

function New-Secret { [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(24)) }

# 1. 代码签名证书
$cert = New-SelfSignedCertificate -Type CodeSigningCert `
  -Subject "CN=Primus (self-signed), O=skaduv" `
  -FriendlyName "Primus release signing (self-signed)" `
  -CertStoreLocation Cert:\CurrentUser\My `
  -KeyAlgorithm RSA -KeyLength 3072 -HashAlgorithm SHA256 `
  -KeyExportPolicy Exportable `
  -NotAfter (Get-Date).AddYears($Years)
try {
  $pfxPassword = New-Secret
  $pfx = Join-Path $BackupDir "primus-signing.pfx"
  Export-PfxCertificate -Cert $cert -FilePath $pfx `
    -Password (ConvertTo-SecureString -String $pfxPassword -AsPlainText -Force) | Out-Null
  Export-Certificate -Cert $cert -FilePath (Join-Path $BackupDir "Primus-signing-cert.cer") | Out-Null
} finally {
  # 私钥只留在备份的 PFX 中
  Remove-Item -LiteralPath "Cert:\CurrentUser\My\$($cert.Thumbprint)" -DeleteKey -ErrorAction SilentlyContinue
}

# 2. updater 密钥
$keyPassword = New-Secret
$key = Join-Path $BackupDir "primus-updater.key"
Push-Location $root
try {
  pnpm --filter @primus/desktop tauri signer generate --ci --password $keyPassword --write-keys $key | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "tauri signer generate 失败（退出码 $LASTEXITCODE）" }
} finally { Pop-Location }
if (-not (Test-Path -LiteralPath "$key.pub")) { throw "未生成 updater 公钥：$key.pub" }

@(
  "PFX 口令：$pfxPassword",
  "updater 私钥口令：$keyPassword",
  "证书指纹：$($cert.Thumbprint)",
  "有效期至：$($cert.NotAfter)"
) | Set-Content -LiteralPath (Join-Path $BackupDir "passwords.txt") -Encoding utf8

# 3. 写入仓库 Secret（经标准输入）
$values = [ordered]@{
  PRIMUS_SIGN_PFX_BASE64             = [Convert]::ToBase64String([IO.File]::ReadAllBytes($pfx))
  PRIMUS_SIGN_PFX_PASSWORD           = $pfxPassword
  TAURI_SIGNING_PRIVATE_KEY          = (Get-Content -LiteralPath $key -Raw).Trim()
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD = $keyPassword
  TAURI_SIGNING_PUBLIC_KEY           = (Get-Content -LiteralPath "$key.pub" -Raw).Trim()
}
# PowerShell 管道给原生命令的字符串会多一个换行，口令带换行就对不上：值写进无换行的临时文件，重定向为 gh 的标准输入
$valueFile = Join-Path $BackupDir ".secret-value.tmp"
try {
  foreach ($name in $values.Keys) {
    [IO.File]::WriteAllText($valueFile, $values[$name])
    $p = Start-Process -FilePath (Get-Command gh).Source -ArgumentList @("secret", "set", $name, "--repo", $Repo) `
      -RedirectStandardInput $valueFile -NoNewWindow -Wait -PassThru
    if ($p.ExitCode -ne 0) { throw "写入 Secret $name 失败（退出码 $($p.ExitCode)）" }
    Write-Host "✓ 已写入 Secret $name"
  }
} finally {
  Remove-Item -LiteralPath $valueFile -Force -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "✓ 自签名代码签名证书：$($cert.Subject)，指纹 $($cert.Thumbprint)，有效期至 $($cert.NotAfter)"
Write-Host "✓ updater 公钥：$($values.TAURI_SIGNING_PUBLIC_KEY)"
Write-Host "备份（含私钥与口令）：$BackupDir —— 请移到安全的离线位置，不要提交到仓库"
