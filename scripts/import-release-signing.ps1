#requires -Version 7.2
<#
.SYNOPSIS
  发布构建准备代码签名证书（release.yml 使用；技术方案第 3.3.4、22.3 节）。

.DESCRIPTION
  证书来源（环境变量，可选的仓库 Secret）：
    PRIMUS_SIGN_PFX_BASE64    代码签名证书 PFX（含私钥）的 Base64，留给以后的正式 CA 证书
    PRIMUS_SIGN_PFX_PASSWORD  PFX 口令
  三种情况：
    - 两个都为空（当前做法）：在本运行器上临时生成本次发布专用的自签名代码签名证书（私钥不可导出，
      运行器销毁即消失，不写进仓库、也不存为 Secret）。每次发布的证书都不同；没有 updater 密钥，不生成 .sig
    - 只配一个：配置错误，报错退出
    - 都有：导入 PFX 到 CurrentUser\My（私钥不可导出），检查有私钥、含代码签名用途、在有效期内，
      并写 PRIMUS_REQUIRE_SIGNING=1（要求 updater 密钥 TAURI_SIGNING_* 同时配置）
  自签名证书（颁发者 = 使用者）把公钥证书加入本机 Root 与 TrustedPublisher，使 signtool verify /pa 能在运行器上
  建立信任链（只允许 GitHub 托管运行器，用完即销毁）。公钥证书导出为 Primus-signing-cert-<Arch>.cer（未给 -Arch 时为
  Primus-signing-cert.cer），只放进发布工作流的作业间 artifact 供核对，不作为 Release 附件：每个架构的构建作业各自生成证书，由生成它的作业导出自己的公钥证书。
  写入 GITHUB_ENV：PRIMUS_SIGN_CERT_SHA1、PRIMUS_SIGN_TIMESTAMP_URL、PRIMUS_RELEASE_SIGNED=true、
  PRIMUS_RELEASE_SELF_SIGNED、PRIMUS_RELEASE_CERT_SOURCE（generated = 本次临时生成，pfx = 来自 PFX Secret；
  发布说明据此区分「每个版本、每个架构的证书都不同」与「两个架构共用 PFX 中的同一张证书」）、
  PRIMUS_SIGN_CER（导出的公钥证书路径）。

.PARAMETER Version
  本次发布的版本号，写进临时证书的使用者名称（例如 0.0.4）。

.PARAMETER Arch
  构建架构（x64 / arm64），写进导出的公钥证书文件名，使每个架构的安装包都有对应的证书文件（仅工作流内部使用）。

.PARAMETER TimestampUrl
  RFC 3161 时间戳服务器，默认 http://timestamp.digicert.com。
#>
param(
  [string]$TimestampUrl = "http://timestamp.digicert.com",
  [string]$Version = "",
  [ValidateSet("", "x64", "arm64")]
  [string]$Arch = ""
)
$ErrorActionPreference = "Stop"
if (-not $env:GITHUB_ENV -or -not $env:RUNNER_TEMP) { throw "只能在 GitHub Actions 运行器上运行" }

$pfxBase64 = $env:PRIMUS_SIGN_PFX_BASE64
$pfxPassword = $env:PRIMUS_SIGN_PFX_PASSWORD
if (-not $pfxBase64 -and -not $pfxPassword) {
  # 临时证书：私钥生成在运行器的证书存储里、不可导出，只用于本次发布。时间戳签名在证书过期后仍有效
  $label = (@($Version, $Arch) | Where-Object { $_ }) -join " "
  if ($label) { $label = " $label" }
  $cert = @(New-SelfSignedCertificate -Type CodeSigningCert `
      -Subject "CN=Primus$label (self-signed release), O=skaduv" `
      -CertStoreLocation Cert:\CurrentUser\My `
      -KeyAlgorithm RSA -KeyLength 3072 -HashAlgorithm SHA256 `
      -KeyExportPolicy NonExportable `
      -NotAfter (Get-Date).AddYears(3))
  $requireSigning = $false
  $certSource = "generated"
  Write-Host "::notice::未配置 PRIMUS_SIGN_PFX_BASE64，使用本次发布临时生成的自签名证书（私钥不可导出，不保存）"
} elseif (-not $pfxBase64 -or -not $pfxPassword) {
  throw "PRIMUS_SIGN_PFX_BASE64 与 PRIMUS_SIGN_PFX_PASSWORD 必须同时配置"
} else {
  $pfx = Join-Path $env:RUNNER_TEMP "primus-release-signing.pfx"
  try {
    [IO.File]::WriteAllBytes($pfx, [Convert]::FromBase64String(($pfxBase64 -replace '\s', '')))
    $secure = ConvertTo-SecureString -String $pfxPassword -AsPlainText -Force
    $cert = Import-PfxCertificate -FilePath $pfx -Password $secure -CertStoreLocation Cert:\CurrentUser\My
  } finally {
    Remove-Item -LiteralPath $pfx -Force -ErrorAction SilentlyContinue
  }
  $requireSigning = $true
  $certSource = "pfx"
}
$cert = @($cert | Where-Object HasPrivateKey)
if ($cert.Count -ne 1) { throw "PFX 中应恰有一张带私钥的证书，实际 $($cert.Count) 张" }
$cert = $cert[0]
$codeSigning = "1.3.6.1.5.5.7.3.3"
if (-not ($cert.EnhancedKeyUsageList | Where-Object ObjectId -eq $codeSigning)) {
  throw "证书不含'代码签名'用途（EKU $codeSigning）：$($cert.Subject)"
}
$now = Get-Date
if ($now -lt $cert.NotBefore -or $now -gt $cert.NotAfter) {
  throw "证书不在有效期内（$($cert.NotBefore) ~ $($cert.NotAfter)）：$($cert.Subject)"
}
$selfSigned = $cert.Subject -eq $cert.Issuer

$cer = Join-Path $env:RUNNER_TEMP "Primus-signing-cert$(if ($Arch) { "-$Arch" }).cer"
Export-Certificate -Cert $cert -FilePath $cer | Out-Null

if ($selfSigned) {
  # 自签名证书没有上级 CA：把公钥证书加入本机信任，signtool verify /pa 才能通过。只在 GitHub 托管运行器上做
  # （自托管机器不会销毁，会长期信任这张证书）。写本机证书存储的权限因镜像而异，回退方式与 ci-signing-drill.ps1 相同
  if ($env:RUNNER_ENVIRONMENT -ne "github-hosted") {
    throw "自签名证书只能在 GitHub 托管运行器上导入信任（RUNNER_ENVIRONMENT=$env:RUNNER_ENVIRONMENT）"
  }
  foreach ($store in "Root", "TrustedPublisher") {
    try {
      Import-Certificate -FilePath $cer -CertStoreLocation "Cert:\LocalMachine\$store" -ErrorAction Stop | Out-Null
    } catch {
      Write-Host "Import-Certificate 写 LocalMachine\$store 失败：$($_.Exception.Message)，改用 certutil"
      & certutil.exe -f -addstore $store $cer | Out-Host
      if ($LASTEXITCODE -ne 0) {
        $p = Start-Process -FilePath certutil.exe -ArgumentList @("-f", "-addstore", $store, "`"$cer`"") -Verb RunAs -Wait -PassThru -WindowStyle Hidden
        if ($p.ExitCode -ne 0) { throw "无法把证书加入 LocalMachine\$store（提升后的 certutil 退出码 $($p.ExitCode)）" }
      }
    }
    if (-not (Get-ChildItem "Cert:\LocalMachine\$store" | Where-Object Thumbprint -eq $cert.Thumbprint)) {
      throw "证书未出现在 LocalMachine\$store 中"
    }
  }
}
Write-Host "代码签名证书：$($cert.Subject)，指纹 $($cert.Thumbprint)，有效期至 $($cert.NotAfter)，$(if ($selfSigned) { '自签名' } else { 'CA 签发' })"

@(
  "PRIMUS_SIGN_CERT_SHA1=$($cert.Thumbprint)",
  "PRIMUS_SIGN_TIMESTAMP_URL=$TimestampUrl",
  "PRIMUS_REQUIRE_SIGNING=$(if ($requireSigning) { '1' } else { '0' })",
  "PRIMUS_RELEASE_SIGNED=true",
  "PRIMUS_RELEASE_SELF_SIGNED=$($selfSigned.ToString().ToLowerInvariant())",
  "PRIMUS_RELEASE_CERT_SOURCE=$certSource",
  "PRIMUS_SIGN_CER=$cer"
) | Out-File -FilePath $env:GITHUB_ENV -Append -Encoding utf8
