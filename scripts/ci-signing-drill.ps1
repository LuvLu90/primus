# CI 签名演练（技术方案第 3.3.4 节）：正式代码签名证书与 updater 私钥只放在发布用的 CI 密钥库（第 22.3 节），
# PR 与日常推送拿不到。为了让每次 CI 都完整走一遍签名流程（签 Primus.exe → 签 MSI → tauri signer 生成 .sig
# → 校验 .sig → signtool verify /pa 三个文件），这里临时生成一次性的自签名代码签名证书和 updater 密钥：
#
#   - 证书：调用 import-release-signing.ps1（与发布流程相同）：New-SelfSignedCertificate 生成到 CurrentUser\My
#     （私钥不可导出），公钥证书导入 LocalMachine\Root 与 TrustedPublisher，使 signtool verify /pa 在本运行器上
#     能建立信任链（运行器用完即销毁，因此拒绝在自托管运行器上运行）
#   - 证书的 PFX 分支：再生成一张可导出的临时证书，导出为带随机口令的 PFX 后经 PRIMUS_SIGN_PFX_BASE64 / PASSWORD
#     交给导入脚本导回（以后正式证书走这条路），之后的签名用这张证书；PFX 文件立即删除
#   - updater 密钥：tauri signer generate 写到 RUNNER_TEMP，随机口令
#   - 写入 GITHUB_ENV：PRIMUS_SIGN_CERT_SHA1、PRIMUS_SIGN_TIMESTAMP_URL（导入脚本写）、TAURI_SIGNING_PRIVATE_KEY_PATH、
#     TAURI_SIGNING_PRIVATE_KEY_PASSWORD（已打码）、TAURI_SIGNING_PUBLIC_KEY、PRIMUS_REQUIRE_SIGNING=1
#
# 这样产出的安装包只在本运行器上受信任，不能对外分发；发布流程改用密钥库中的正式证书与私钥。
# 用法（仓库根目录，pwsh）：./scripts/ci-signing-drill.ps1 [-TimestampUrl <RFC 3161 时间戳服务器>]
param(
  [string]$TimestampUrl = "http://timestamp.digicert.com"
)
$ErrorActionPreference = "Stop"
# 自托管运行器同样有 GITHUB_ENV / RUNNER_TEMP，但不会用完即销毁，导入的演练证书会被长期信任：只允许 GitHub 托管运行器
if (-not $env:GITHUB_ENV -or -not $env:RUNNER_TEMP -or $env:RUNNER_ENVIRONMENT -ne "github-hosted") {
  throw "只能在 GitHub 托管运行器上运行（会改动本机受信任根证书；RUNNER_ENVIRONMENT=$env:RUNNER_ENVIRONMENT）"
}

# 证书与发布流程共用 import-release-signing.ps1 的无 Secret 路径（临时自签名证书、导入本机信任、写 GITHUB_ENV），
# 每次 CI 都实际执行一遍发布用的导入脚本，脚本本身的错误不会等到发版才暴露
& (Join-Path $PSScriptRoot "import-release-signing.ps1") -Version "ci-drill" -TimestampUrl $TimestampUrl
# 发布说明按证书来源描述证书范围（临时生成 = 每个架构各一张；PFX = 两个架构共用）：两条分支都核对写入的来源
function Assert-CertSource([string]$Expected) {
  $m = [regex]::Matches((Get-Content -Raw $env:GITHUB_ENV), '(?m)^PRIMUS_RELEASE_CERT_SOURCE=(\S+)\r?$') | Select-Object -Last 1
  if (-not $m -or $m.Groups[1].Value -cne $Expected) { throw "PRIMUS_RELEASE_CERT_SOURCE 应为 $Expected，实际 $(if ($m) { $m.Groups[1].Value } else { '未写入' })" }
}
Assert-CertSource "generated"

# 再演练导入脚本的 PFX 分支（以后配置正式证书 Secret 时走这条路）：临时生成一张可导出的自签名代码签名证书，导出为带随机口令的
# PFX，然后从证书存储中删掉原证书，经 PRIMUS_SIGN_PFX_BASE64 / PRIMUS_SIGN_PFX_PASSWORD 交给导入脚本导回。
# PFX 文件导出后立即删除，环境变量只在本进程内设置、用完即清除，不写进仓库也不传给后续步骤。
# 导入脚本后写入 GITHUB_ENV 的 PRIMUS_SIGN_CERT_SHA1 生效，演练后续的签名与校验都用这张经 PFX 导入的证书
$drillCert = New-SelfSignedCertificate -Type CodeSigningCert `
  -Subject "CN=Primus ci-drill pfx (self-signed), O=skaduv" `
  -CertStoreLocation Cert:\CurrentUser\My `
  -KeyAlgorithm RSA -KeyLength 3072 -HashAlgorithm SHA256 `
  -KeyExportPolicy Exportable `
  -NotAfter (Get-Date).AddDays(7)
$pfxPassword = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(24))
Write-Host "::add-mask::$pfxPassword"
$pfx = Join-Path $env:RUNNER_TEMP "primus-ci-drill.pfx"
try {
  Export-PfxCertificate -Cert $drillCert -FilePath $pfx -Password (ConvertTo-SecureString -String $pfxPassword -AsPlainText -Force) | Out-Null
  $pfxBase64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($pfx))
} finally {
  Remove-Item -LiteralPath $pfx -Force -ErrorAction SilentlyContinue
}
Remove-Item -LiteralPath "Cert:\CurrentUser\My\$($drillCert.Thumbprint)"
$env:PRIMUS_SIGN_PFX_BASE64 = $pfxBase64
$env:PRIMUS_SIGN_PFX_PASSWORD = $pfxPassword
try {
  & (Join-Path $PSScriptRoot "import-release-signing.ps1") -Version "ci-drill" -TimestampUrl $TimestampUrl
} finally {
  Remove-Item Env:\PRIMUS_SIGN_PFX_BASE64, Env:\PRIMUS_SIGN_PFX_PASSWORD -ErrorAction SilentlyContinue
}
$imported = Get-ChildItem Cert:\CurrentUser\My | Where-Object { $_.Thumbprint -eq $drillCert.Thumbprint -and $_.HasPrivateKey }
if (-not $imported) { throw "PFX 分支未把带私钥的证书导回 CurrentUser\My" }
$sha1 = [regex]::Matches((Get-Content -Raw $env:GITHUB_ENV), '(?m)^PRIMUS_SIGN_CERT_SHA1=(\S+)\r?$') | Select-Object -Last 1
if (-not $sha1 -or $sha1.Groups[1].Value -ne $drillCert.Thumbprint) { throw "PFX 分支未把证书指纹写入 GITHUB_ENV" }
Assert-CertSource "pfx"
Write-Host "PFX 分支演练通过：签名改用经 PFX 导入的证书 $($drillCert.Thumbprint)"
$principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
$elevated = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
Write-Host "当前进程$(if ($elevated) { '已' } else { '未' })以管理员权限运行（$([Security.Principal.WindowsIdentity]::GetCurrent().Name)）"

$key = Join-Path $env:RUNNER_TEMP "primus-ci-updater.key"
$password = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(24))
Write-Host "::add-mask::$password"
pnpm --filter @primus/desktop tauri signer generate --ci --force --password $password --write-keys $key | Out-Null
if ($LASTEXITCODE -ne 0) { throw "tauri signer generate 失败（退出码 $LASTEXITCODE）" }
if (-not (Test-Path -LiteralPath "$key.pub")) { throw "未生成 updater 公钥：$key.pub" }
$pubkey = (Get-Content -LiteralPath "$key.pub" -Raw).Trim()

# 写在导入脚本的 PRIMUS_REQUIRE_SIGNING=0 之后，后写的生效：演练要求 updater 密钥同时生效
@(
  "TAURI_SIGNING_PRIVATE_KEY_PATH=$key",
  "TAURI_SIGNING_PRIVATE_KEY_PASSWORD=$password",
  "TAURI_SIGNING_PUBLIC_KEY=$pubkey",
  "PRIMUS_REQUIRE_SIGNING=1"
) | Out-File -FilePath $env:GITHUB_ENV -Append -Encoding utf8
Write-Host "已生成一次性 updater 密钥（$key），签名环境变量已写入 GITHUB_ENV"
