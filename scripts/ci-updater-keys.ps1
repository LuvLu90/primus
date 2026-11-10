# CI 的一次性 updater 签名密钥（技术方案第 3.6 节、ADR 0007）：发布用的 updater 私钥只放在发布用的 CI 密钥库
# （第 22.3 节），PR 与日常推送拿不到。为了让每次 CI 都完整走一遍 updater 签名（tauri signer 按版本签 .sig → 按
# updater 规则校验），并让 PrimusUpdate.exe 与 Primus.exe 内置同一把公钥、冒烟时真的能验签安装，这里临时生成一把：
#
#   - tauri signer generate 写到 RUNNER_TEMP，随机口令（已打码）
#   - 写入 GITHUB_ENV：TAURI_SIGNING_PRIVATE_KEY_PATH、TAURI_SIGNING_PRIVATE_KEY_PASSWORD、TAURI_SIGNING_PUBLIC_KEY、
#     PRIMUS_REQUIRE_UPDATER_SIGNING=1
#
# 不做 Authenticode 代码签名（项目不购买证书；安装包与程序不带签名，SmartScreen 会提示未知发布者）。
# 这样产出的安装包只在 CI 中使用，不能对外分发；发布流程改用密钥库中的正式 updater 私钥。
# 用法（仓库根目录，pwsh）：./scripts/ci-updater-keys.ps1
$ErrorActionPreference = "Stop"
if (-not $env:GITHUB_ENV -or -not $env:RUNNER_TEMP) {
  throw "只能在 GitHub Actions 中运行（需要 GITHUB_ENV 与 RUNNER_TEMP）"
}

$key = Join-Path $env:RUNNER_TEMP "primus-ci-updater.key"
$password = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(24))
Write-Host "::add-mask::$password"
pnpm --filter @primus/desktop tauri signer generate --ci --force --password $password --write-keys $key | Out-Null
if ($LASTEXITCODE -ne 0) { throw "tauri signer generate 失败（退出码 $LASTEXITCODE）" }
if (-not (Test-Path -LiteralPath "$key.pub")) { throw "未生成 updater 公钥：$key.pub" }
$pubkey = (Get-Content -LiteralPath "$key.pub" -Raw).Trim()

@(
  "TAURI_SIGNING_PRIVATE_KEY_PATH=$key",
  "TAURI_SIGNING_PRIVATE_KEY_PASSWORD=$password",
  "TAURI_SIGNING_PUBLIC_KEY=$pubkey",
  "PRIMUS_REQUIRE_UPDATER_SIGNING=1"
) | Out-File -FilePath $env:GITHUB_ENV -Append -Encoding utf8
Write-Host "已生成一次性 updater 密钥（$key），签名环境变量已写入 GITHUB_ENV"
