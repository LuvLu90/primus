#!/usr/bin/env node
// 构建 MSI（技术方案第 3.3.1、3.3.3、3.3.4 节，第 22.1 节第 6 步）：
//
//   1. pnpm --filter @primus/desktop tauri build --no-bundle [--target <三元组>] -- --locked
//      编译 Primus.exe（前端静态导出后嵌入）；目标架构与 rustc 主机不同时才加 --target（交叉编译）
//   2. signtool 签名 Primus.exe（配置了证书时；node.exe 保留 OpenJS 官方签名，不重签）
//   3. wix build Primus.wxs（WiX 7：-arch x64|arm64 -culture zh-CN -acceptEula wix7，
//      -bindpath app / core / runtime，-d ProductVersion=<主.次.修订.构建>，
//      -d ShellDir=<src-tauri>（图标与许可 RTF），-d WebView2Setup=<WebView2 引导程序>）
//   4. signtool 签名 MSI（配置了证书时），写 SHA-256 校验文件
//   5. tauri signer sign --app-version <版本> 生成 updater 签名 .sig（配置了 updater 私钥时），
//      随即按 tauri-plugin-updater 的规则用 TAURI_SIGNING_PUBLIC_KEY 校验（scripts/updater-signature.mjs）
//   6. signtool verify /pa 校验 Primus.exe、node.exe 与 MSI（配置了证书时，第 3.3.4 节第 4 步）
//   内置 node.exe 在构建前就校验 OpenJS 官方签名（有效且签名者为 OpenJS Foundation），不论是否配置证书
//
// 前提：pnpm build:core --platform win-<架构>（dist/agent-core 与 dist/runtime，运行时平台须与 --arch 一致）
// 与 pnpm build:extensions（primus-bundle.js）已完成；
// 已安装 WiX 7 .NET 工具与 UI、Util 扩展（版本见 scripts/version-baseline.json，CI 中 `wix extension add -g`）。
// WiX 只能在 Windows 上运行；其他平台只能用 --dry-run 查看将要执行的命令。
//
// 用法：node scripts/build-msi.mjs [--arch x64|arm64] [--version <SemVer>] [--skip-tauri] [--out-dir <目录>]
//                                  [--webview2 <文件>] [--dry-run]
//   --arch      目标架构（第 3.1 节交付物），默认 x64：决定 Rust 目标三元组、WiX -arch、内置 Node 运行时平台
//               与 MSI 文件名 Primus_<ver>_<arch>_zh-CN.msi
//   --version   默认取 apps/desktop/src-tauri/tauri.conf.json 的 version；与之不同时经
//               tauri build --config 同步给 Primus.exe，保证 exe、MSI 与文件名同一版本
//               （与 --skip-tauri 同用且版本不同则拒绝构建：已有的 exe 版本无法保证一致）
//   --skip-tauri 已编译好 Primus.exe 时跳过第 1 步；须是本脚本上次构建的产物：脚本在签名后把
//               exe 的版本、架构、大小与修改时间写进旁边的 Primus.exe.build.json，跳过时逐项校验，
//               记录缺失、版本或架构与 MSI 不同、exe 已被其他方式重新生成都拒绝构建
//   --out-dir   MSI 输出目录，默认仓库根下 out/（已在 .gitignore 中）
//   --webview2  WebView2 Evergreen 引导程序（第 3.5 节），默认 apps/desktop/src-tauri/windows/webview2/
//               MicrosoftEdgeWebview2Setup.exe；不存在时从微软官方地址下载（不入库）。微软会更新该文件，
//               不固化哈希，改为校验 Authenticode 签名有效且签名者为 Microsoft Corporation
//
// 签名所需环境变量（证书与私钥只保存在 CI 密钥库，第 22.3 节）：
//   PRIMUS_SIGN_CERT_SHA1      代码签名证书指纹（signtool /sha1）
//   PRIMUS_SIGN_TIMESTAMP_URL  RFC 3161 时间戳服务器（signtool /tr）
//   PRIMUS_SIGNTOOL            signtool.exe 路径（默认取 Windows SDK 中最新版本的 signtool，找不到再用 PATH）
//   TAURI_SIGNING_PRIVATE_KEY 或 TAURI_SIGNING_PRIVATE_KEY_PATH
//                              updater 签名私钥（前者为私钥内容，后者为私钥文件路径；tauri signer sign 读取）
//   TAURI_SIGNING_PRIVATE_KEY_PASSWORD  updater 私钥口令
//   TAURI_SIGNING_PUBLIC_KEY   updater 公钥（与 tauri.conf.json plugins.updater.pubkey 同格式），校验 .sig 用
//   PRIMUS_REQUIRE_SIGNING=1   证书与 updater 密钥必须都配置齐，否则拒绝构建（CI 签名演练与正式证书发布用）
//   PRIMUS_REQUIRE_UPDATER_SIGNING=1  updater 密钥必须配置齐（每次发布都要 .sig 供自动更新，ADR 0007；release.yml 设置）
// 证书指纹与时间戳服务器须成对配置、updater 私钥须配公钥，配一半拒绝构建；都不配时跳过签名并提示（开发与 PR 构建）。
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { MANIFEST_FILE, verifyManifest } from "./core-dist.mjs";
import { verifyUpdaterSignature } from "./updater-signature.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const tauriDir = join(root, "apps/desktop/src-tauri");
export const WXS = join(tauriDir, "windows/Primus.wxs");
export const CULTURE = "zh-CN";
// 安装目录 ACL 处理脚本（与 NSIS 安装钩子共用），以 -d InstallAclScript 嵌入 Primus.wxs 的 CheckInstallDir / ResetProgramAcl
export const INSTALL_ACL_PS1 = join(tauriDir, "windows/install-acl.ps1");

/**
 * install-acl.ps1 → powershell -Command 用的 Base64：去掉 BOM、整行注释与空行（缩短命令行），按 UTF-16LE 编码。
 * 脚本中不用块注释与 here-string，整行注释可以安全去掉。
 */
export function encodeInstallAclScript(source) {
  const code = source
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .join("\n");
  return Buffer.from(code, "utf16le").toString("base64");
}

export const WIX_EXTENSIONS = ["WixToolset.UI.wixext", "WixToolset.Util.wixext"];
// 微软 WebView2 文档给出的 Evergreen 引导程序下载地址
export const WEBVIEW2_BOOTSTRAPPER_URL = "https://go.microsoft.com/fwlink/p/?LinkId=2124703";
export const WEBVIEW2_BOOTSTRAPPER = join(
  tauriDir,
  "windows/webview2/MicrosoftEdgeWebview2Setup.exe",
);

/**
 * 预发布阶段在 MSI 第三字段中的偏移（第 3.3.3 节）。Windows Installer 只比较 ProductVersion 的前三个字段、
 * 忽略第四个，所以预发布到稳定版的先后必须体现在前三个字段里：第三字段 = 修订号 × 100 + 阶段偏移，
 * alpha.N → N、beta.N → 30 + N、rc.N → 60 + N（N ≤ 29），稳定版 → 99。
 * 例：1.3.0-alpha.1 → 1.3.1.0 < 1.3.0-beta.2 → 1.3.32.0 < 1.3.0-rc.1 → 1.3.61.0 < 1.3.0 → 1.3.99.0
 * < 1.3.1-alpha.0 → 1.3.100.0。稳定版严格高于同版本的所有预发布版，MajorUpgrade 可正常替换；
 * 反过来用预发布版覆盖同版本稳定版属于降级，仍被拒绝。
 */
export const MSI_PRERELEASE_STAGES = { alpha: 0, beta: 30, rc: 60 };
export const MSI_PRERELEASE_MAX = 29;
export const MSI_STABLE_OFFSET = 99;
export const MSI_PATCH_SCALE = 100;
// 第三字段上限 65535：修订号 ≤ 654（654 × 100 + 99 = 65499）
export const MSI_MAX_PATCH = Math.floor((65535 - MSI_STABLE_OFFSET) / MSI_PATCH_SCALE);

/**
 * SemVer → MSI ProductVersion（第 3.3.3 节）：主.次.(修订 × 100 + 阶段偏移).0。
 * 预发布标识只接受 alpha.N / beta.N / rc.N（N ≤ 29）；构建元数据（+…）不参与。
 * 主、次 ≤ 255，修订 ≤ 654（第三字段 ≤ 65535）。
 */
export function msiProductVersion(semver) {
  const m =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
      semver,
    );
  if (!m) throw new Error(`版本号不是 SemVer：${semver}`);
  const [major, minor, patch] = [m[1], m[2], m[3]].map(Number);
  if (major > 255 || minor > 255) throw new Error(`MSI 版本的主、次版本不得超过 255：${semver}`);
  if (patch > MSI_MAX_PATCH)
    throw new Error(`MSI 版本的修订号不得超过 ${MSI_MAX_PATCH}（第三字段 ≤ 65535）：${semver}`);
  let offset = MSI_STABLE_OFFSET;
  if (m[4]) {
    const pre = /^(alpha|beta|rc)\.(0|[1-9]\d*)$/.exec(m[4]);
    if (!pre)
      throw new Error(
        `预发布标识须为 alpha.N、beta.N 或 rc.N，才能映射为有序的 MSI 版本：${semver}`,
      );
    const n = Number(pre[2]);
    if (n > MSI_PRERELEASE_MAX)
      throw new Error(`预发布序号不得超过 ${MSI_PRERELEASE_MAX}：${semver}`);
    offset = MSI_PRERELEASE_STAGES[pre[1]] + n;
  }
  return `${major}.${minor}.${patch * MSI_PATCH_SCALE + offset}.0`;
}

/** 按 Windows Installer 的规则比较两个 ProductVersion：只看前三个字段（负数 / 0 / 正数） */
export function compareMsiVersions(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

/**
 * 支持的 Windows 架构（第 3.1 节交付物）：Rust 目标三元组、内置 Node 运行时平台（scripts/node-runtime.json）。
 * WiX 的 -arch 与 Tauri NSIS 文件名中的架构名都直接用键名（x64、arm64）。
 */
export const ARCHES = {
  x64: { rustTarget: "x86_64-pc-windows-msvc", nodePlatform: "win-x64" },
  arm64: { rustTarget: "aarch64-pc-windows-msvc", nodePlatform: "win-arm64" },
};

/** 校验并返回架构信息；不支持的架构直接抛错 */
export function archInfo(arch) {
  if (!Object.hasOwn(ARCHES, arch))
    throw new Error(`不支持的架构 ${arch}（可选：${Object.keys(ARCHES).join("、")}）`);
  return ARCHES[arch];
}

/**
 * Rust 编译目标：目标三元组与 rustc 主机相同就不加 --target，产物在 target/release（e2e 与现有脚本沿用）；
 * 不同（如在 x64 上交叉编译 arm64）才加 --target，产物在 target/<三元组>/release。
 * tauri build 与 tauri bundle 用同一结果，保证 NSIS 打包的正是刚编译的 exe。
 */
export function cargoTarget(arch, hostTriple) {
  const { rustTarget } = archInfo(arch);
  return rustTarget === hostTriple
    ? { args: [], releaseDir: "release" }
    : { args: ["--target", rustTarget], releaseDir: `${rustTarget}/release` };
}

/**
 * rustc 主机三元组（rustc -vV 的 host 行，按仓库 rust-toolchain.toml 选用工具链）。
 * 非 Windows 上只做 --dry-run 演练，假定是同 CPU 架构的 Windows 主机。
 */
export function rustHostTriple(cwd) {
  if (process.platform !== "win32")
    return ARCHES[process.arch === "arm64" ? "arm64" : "x64"].rustTarget;
  const r = spawnSync("rustc", ["-vV"], { cwd, encoding: "utf8" });
  const host = /^host:\s*(\S+)/m.exec(r.stdout ?? "")?.[1];
  if (r.status !== 0 || !host)
    fail(`无法从 rustc -vV 读取主机三元组：${r.stderr || r.error?.message}`);
  return host;
}

/** Cargo 产物根目录（CARGO_TARGET_DIR 优先） */
export function cargoTargetRoot(env = process.env) {
  return env.CARGO_TARGET_DIR ? resolve(tauriDir, env.CARGO_TARGET_DIR) : join(tauriDir, "target");
}

/** 交付物文件名（第 3.1 节）：Primus_<ver>_<arch>_zh-CN.msi */
export function msiFileName(semver, arch = "x64") {
  archInfo(arch);
  return `Primus_${semver}_${arch}_${CULTURE}.msi`;
}

/** wix build 参数（第 3.3.1 节第 3 步） */
export function wixBuildArgs({
  wxs = WXS,
  arch = "x64",
  appDir,
  coreDir,
  runtimeDir,
  shellDir = tauriDir,
  webview2Setup = WEBVIEW2_BOOTSTRAPPER,
  productVersion,
  out,
  installAclScript = encodeInstallAclScript(readFileSync(INSTALL_ACL_PS1, "utf8")),
}) {
  archInfo(arch);
  return [
    "build",
    wxs,
    "-arch",
    arch,
    "-culture",
    CULTURE,
    "-acceptEula",
    "wix7",
    ...WIX_EXTENSIONS.flatMap((ext) => ["-ext", ext]),
    "-bindpath",
    `app=${appDir}`,
    "-bindpath",
    `core=${coreDir}`,
    "-bindpath",
    `runtime=${runtimeDir}`,
    "-d",
    `ProductVersion=${productVersion}`,
    "-d",
    `ShellDir=${shellDir}`,
    "-d",
    `WebView2Setup=${webview2Setup}`,
    "-d",
    `InstallAclScript=${installAclScript}`,
    "-o",
    out,
  ];
}

/**
 * dist/agent-core/manifest.json 记录的内置运行时平台须与目标架构一致（build-core.mjs --platform 写入）。
 * 一致返回 null，否则返回原因。
 */
export function checkRuntimePlatform(manifest, arch) {
  const { nodePlatform } = archInfo(arch);
  const actual = manifest?.runtime?.platform;
  if (actual === nodePlatform) return null;
  return `dist/runtime 的内置 Node 运行时平台为 ${actual ?? "未知"}，与目标架构 ${arch} 不符，请先运行 pnpm build:core --platform ${nodePlatform}`;
}

/** 构建记录文件名（写在 Primus.exe 旁边，供 --skip-tauri 与 build-nsis.mjs 校验 exe 的版本与架构） */
export const EXE_STAMP = "Primus.exe.build.json";

/** 由 exe 的文件信息生成构建记录 */
export function exeStamp(version, stat, arch = "x64") {
  return { version, arch, size: stat.size, mtimeMs: Math.trunc(stat.mtimeMs) };
}

/**
 * 校验已有 Primus.exe 是本脚本以 version、arch 构建的产物（第 3.3.3 节：exe 与安装包同一版本、同一架构）。
 * stamp 为上次写下的构建记录（缺失为 null；早期记录没有 arch 字段，视为 x64），stat 为 exe 当前文件信息；
 * 一致返回 null，否则返回原因（remedy 为附在原因后的处理建议）。
 */
export function checkExeStamp(
  stamp,
  version,
  stat,
  { arch = "x64", remedy = "请去掉 --skip-tauri 重新编译" } = {},
) {
  if (!stamp) return `未找到构建记录 ${EXE_STAMP}，无法确认 Primus.exe 的版本，${remedy}`;
  if (stamp.version !== version)
    return `已有 Primus.exe 的版本为 ${stamp.version}，与目标版本 ${version} 不一致，${remedy}`;
  const stampArch = stamp.arch ?? "x64";
  if (stampArch !== arch)
    return `已有 Primus.exe 为 ${stampArch} 架构的构建，与目标架构 ${arch} 不一致，${remedy}`;
  const now = exeStamp(version, stat, arch);
  if (stamp.size !== now.size || stamp.mtimeMs !== now.mtimeMs)
    return `Primus.exe 在上次构建后被其他方式重新生成（大小或修改时间与 ${EXE_STAMP} 不符），版本无法确认，${remedy}`;
  return null;
}

/** signtool 签名参数（第 3.3.1 节第 2、4 步）；未配置证书时返回 null */
export function signtoolArgs(file, env = process.env) {
  const sha1 = env.PRIMUS_SIGN_CERT_SHA1;
  const tsa = env.PRIMUS_SIGN_TIMESTAMP_URL;
  if (!sha1 || !tsa) return null;
  return ["sign", "/fd", "sha256", "/tr", tsa, "/td", "sha256", "/sha1", sha1, file];
}

/** signtool 校验参数（第 3.3.4 节第 4 步）：/pa 按默认 Authenticode 策略校验，/all 校验文件上的全部签名 */
export function signtoolVerifyArgs(file) {
  return ["verify", "/pa", "/all", file];
}

/**
 * 签名配置（第 3.3.4 节）：证书指纹与时间戳服务器成对配置才签 Authenticode；updater 私钥（内容或路径二选一）
 * 须同时给公钥，生成 .sig 后立即校验。配一半一律视为配置错误（problems 非空），免得发布出半签名的安装包；
 * PRIMUS_REQUIRE_SIGNING=1 时两类签名都必须配置，PRIMUS_REQUIRE_UPDATER_SIGNING=1 时 updater 签名必须配置。
 */
export function signingConfig(env = process.env) {
  const problems = [];
  const sha1 = env.PRIMUS_SIGN_CERT_SHA1;
  const tsa = env.PRIMUS_SIGN_TIMESTAMP_URL;
  if (Boolean(sha1) !== Boolean(tsa))
    problems.push("PRIMUS_SIGN_CERT_SHA1 与 PRIMUS_SIGN_TIMESTAMP_URL 必须同时配置");
  const keyValue = env.TAURI_SIGNING_PRIVATE_KEY;
  const keyPath = env.TAURI_SIGNING_PRIVATE_KEY_PATH;
  const pubkey = env.TAURI_SIGNING_PUBLIC_KEY;
  if (keyValue && keyPath)
    problems.push("TAURI_SIGNING_PRIVATE_KEY 与 TAURI_SIGNING_PRIVATE_KEY_PATH 只能配置一个");
  if ((keyValue || keyPath) && !pubkey)
    problems.push("配置了 updater 私钥时必须同时配置 TAURI_SIGNING_PUBLIC_KEY（用于校验 .sig）");
  if (!keyValue && !keyPath && pubkey)
    problems.push("配置了 TAURI_SIGNING_PUBLIC_KEY 但没有 updater 私钥");
  const authenticode = Boolean(sha1 && tsa);
  const updater = Boolean((keyValue || keyPath) && pubkey);
  if (env.PRIMUS_REQUIRE_SIGNING === "1" && !(authenticode && updater))
    problems.push("PRIMUS_REQUIRE_SIGNING=1 要求同时配置代码签名证书与 updater 签名密钥");
  if (env.PRIMUS_REQUIRE_UPDATER_SIGNING === "1" && !updater)
    problems.push(
      "PRIMUS_REQUIRE_UPDATER_SIGNING=1 要求配置 updater 签名密钥（TAURI_SIGNING_PRIVATE_KEY 与 TAURI_SIGNING_PUBLIC_KEY）：自动更新需要每个安装包的 .sig",
    );
  return { authenticode, updater, problems };
}

/**
 * updater 私钥文件路径（TAURI_SIGNING_PRIVATE_KEY_PATH）解析后的绝对路径：tauri signer 经
 * `pnpm --filter @primus/desktop` 在 apps/desktop 下运行，相对路径以该目录为基准；未配置路径时返回 null。
 */
export function updaterKeyFile(env = process.env, base = join(root, "apps/desktop")) {
  const keyPath = env.TAURI_SIGNING_PRIVATE_KEY_PATH;
  return keyPath ? resolve(base, keyPath) : null;
}

/**
 * signtool.exe 路径：PRIMUS_SIGNTOOL 优先；否则取 Windows SDK（Windows Kits\10\bin\<版本>\<主机架构>）
 * 中版本最新的一个（GitHub 托管运行器装了 SDK，但 signtool 不在 PATH）；都没有时退回 PATH 中的 signtool。
 */
export function resolveSigntool(
  env = process.env,
  { hostArch = process.arch, exists = existsSync, list = readdirSync } = {},
) {
  if (env.PRIMUS_SIGNTOOL) return env.PRIMUS_SIGNTOOL;
  const bin = win32.join(
    env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
    "Windows Kits",
    "10",
    "bin",
  );
  let versions = [];
  try {
    versions = list(bin).filter((name) => /^10\.\d+\.\d+\.\d+$/.test(name));
  } catch {
    return "signtool";
  }
  const numeric = (v) => v.split(".").map(Number);
  versions.sort((a, b) => {
    const [x, y] = [numeric(a), numeric(b)];
    for (let i = 0; i < 4; i++) if (x[i] !== y[i]) return y[i] - x[i];
    return 0;
  });
  // arm64 主机优先用原生 arm64 版本，没有时 x64 版本可在仿真下运行
  const dirs = hostArch === "arm64" ? ["arm64", "x64"] : ["x64"];
  for (const version of versions)
    for (const dir of dirs) {
      const candidate = win32.join(bin, version, dir, "signtool.exe");
      if (exists(candidate)) return candidate;
    }
  return "signtool";
}

/**
 * Authenticode 签名（Windows PowerShell 自带 Get-AuthenticodeSignature；路径经环境变量传入，免转义）。
 * 从 pwsh 7 启动时继承的 PSModulePath 指向 PowerShell 7 的模块，Windows PowerShell 5.1 会加载
 * Microsoft.PowerShell.Security 失败、取不到签名，所以去掉 PSModulePath 让它用自己的默认模块路径；
 * 命令出错一律以非零退出，避免把"读不到签名"误报成"签名不可信"。
 */
export function authenticodeEnv(env, file) {
  const out = Object.fromEntries(
    Object.entries(env).filter(([key]) => key.toLowerCase() !== "psmodulepath"),
  );
  out.PRIMUS_VERIFY_FILE = file;
  return out;
}

function authenticode(file) {
  const r = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$ErrorActionPreference = 'Stop'; " +
        "$s = Get-AuthenticodeSignature -LiteralPath $env:PRIMUS_VERIFY_FILE; " +
        "[pscustomobject]@{ Status = [string]$s.Status; Subject = [string]$s.SignerCertificate.Subject } | ConvertTo-Json -Compress",
    ],
    { encoding: "utf8", env: authenticodeEnv(process.env, file) },
  );
  if (r.status !== 0) fail(`无法读取 ${file} 的签名：${r.stderr || r.error?.message}`);
  const signature = JSON.parse(r.stdout);
  if (!signature.Status) fail(`无法读取 ${file} 的签名：${r.stderr || r.stdout}`);
  return signature;
}

/** 微软签名有效的引导程序才能打进 MSI（它在安装时以 SYSTEM 身份运行） */
export function isTrustedMicrosoftSignature({ Status, Subject }) {
  return Status === "Valid" && /(^|,\s*)O="?Microsoft Corporation"?(,|$)/.test(Subject ?? "");
}

/** 内置 node.exe 须保留有效的 OpenJS 官方签名（第 3.3.4 节第 1 步，不重签） */
export function isTrustedOpenJsSignature({ Status, Subject }) {
  return Status === "Valid" && /(^|,\s*)O="?OpenJS Foundation"?(,|$)/.test(Subject ?? "");
}

async function prepareWebView2(file, { download }) {
  if (!existsSync(file)) {
    if (!download) fail(`未找到 WebView2 引导程序：${file}`);
    console.log(`\n> 下载 WebView2 引导程序 ${WEBVIEW2_BOOTSTRAPPER_URL}`);
    const res = await fetch(WEBVIEW2_BOOTSTRAPPER_URL);
    if (!res.ok) fail(`下载 WebView2 引导程序失败：HTTP ${res.status}`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  }
  const signature = authenticode(file);
  if (!isTrustedMicrosoftSignature(signature))
    fail(`WebView2 引导程序签名不可信：${signature.Status} ${signature.Subject}（${file}）`);
  const size = (readFileSync(file).length / 1024 / 1024).toFixed(1);
  console.log(`✓ WebView2 引导程序 ${size} MiB，微软签名有效（${signature.Subject}）`);
}

async function main() {
  const { values: args } = parseArgs({
    options: {
      arch: { type: "string", default: "x64" },
      version: { type: "string" },
      "skip-tauri": { type: "boolean", default: false },
      "out-dir": { type: "string" },
      webview2: { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
  });
  const dryRun = args["dry-run"];
  const isWindows = process.platform === "win32";
  if (!isWindows && !dryRun) fail("WiX 只能在 Windows 上运行；在其他平台可用 --dry-run 查看命令");

  // wix、signtool 是 exe，直接启动（参数原样传递，路径含空格与中文也无需转义）；
  // pnpm 在 Windows 上是 .cmd，Node 不允许不经 shell 启动 .cmd，只有它走 shell，路径参数加引号
  const run = (command, commandArgs, { capture = false, shell = false, attempts = 1 } = {}) => {
    console.log(`\n> ${[command, ...commandArgs].join(" ")}`);
    if (dryRun) return "";
    for (let attempt = 1; ; attempt++) {
      const r = spawnSync(command, commandArgs, {
        cwd: root,
        stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
        encoding: "utf8",
        shell,
      });
      if (r.error) fail(`无法启动 ${command}：${r.error.message}`);
      if (r.status === 0) return capture ? r.stdout : "";
      if (attempt >= attempts)
        fail(`命令失败（退出码 ${r.status}）：${command} ${commandArgs.join(" ")}`);
      // 只用于 signtool sign：时间戳服务器偶发超时，稍等重试（签名失败不会改动文件）
      console.log(`  第 ${attempt} 次失败（退出码 ${r.status}），5 秒后重试`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000);
    }
  };
  const [pnpm, ...pnpmPrefix] = (process.env.PRIMUS_PNPM ?? "pnpm").split(" ").filter(Boolean);
  const runPnpm = (pnpmArgs) => run(pnpm, [...pnpmPrefix, ...pnpmArgs], { shell: isWindows });
  const quoted = (p) => (isWindows ? `"${p}"` : p);

  const tauriConf = JSON.parse(readFileSync(join(tauriDir, "tauri.conf.json"), "utf8"));
  const version = args.version ?? tauriConf.version;
  const versionOverride = version !== tauriConf.version;
  if (versionOverride && args["skip-tauri"])
    fail(
      `--version ${version} 与 tauri.conf.json 的 ${tauriConf.version} 不同，不能与 --skip-tauri 同用（已构建的 Primus.exe 版本会与 MSI 不一致）`,
    );
  const productVersion = msiProductVersion(version);
  const arch = args.arch;
  let nodePlatform;
  try {
    ({ nodePlatform } = archInfo(arch));
  } catch (e) {
    fail(e.message);
  }
  const target = cargoTarget(arch, rustHostTriple(root));
  const outDir = resolve(root, args["out-dir"] ?? "out");
  const msi = join(outDir, msiFileName(version, arch));
  const appDir = join(cargoTargetRoot(), target.releaseDir);
  const coreDir = join(root, "dist/agent-core");
  const runtimeDir = join(root, "dist/runtime");
  const nodeExe = join(runtimeDir, "node.exe");
  console.log(`乾元 Primus MSI：版本 ${version} → ProductVersion ${productVersion}，架构 ${arch}`);

  // 签名配置先查：配一半（只有证书指纹没有时间戳服务器、有私钥没公钥等）在编译前就拒绝
  const signing = signingConfig();
  if (signing.problems.length) fail(`签名配置有误：\n  ${signing.problems.join("\n  ")}`);
  // 私钥文件不存在时在编译前就失败，而不是签完 exe 与 MSI 后才在 tauri signer 处失败（--dry-run 不读文件）
  const keyFile = updaterKeyFile();
  if (!dryRun && keyFile && !existsSync(keyFile))
    fail(`TAURI_SIGNING_PRIVATE_KEY_PATH 指向的文件不存在：${keyFile}`);
  const signtool = signing.authenticode ? resolveSigntool() : null;
  console.log(
    `签名：代码签名${signing.authenticode ? `已配置（${signtool}）` : "未配置"}，updater 签名${signing.updater ? "已配置" : "未配置"}`,
  );

  // 0. 前提：Core 产物与 manifest 一致、第一方扩展已打包、内置运行时就位、WiX 版本与基线一致
  if (!dryRun) {
    const manifestPath = join(coreDir, MANIFEST_FILE);
    if (!existsSync(manifestPath))
      fail("未找到 dist/agent-core/manifest.json，请先运行 pnpm build:core");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const problems = verifyManifest(coreDir, manifest, { skip: ["extensions"] });
    if (problems.length) fail(`dist/agent-core 与 manifest 不符：\n  ${problems.join("\n  ")}`);
    if (!existsSync(join(coreDir, "extensions/primus-bundle.js")))
      fail("未找到 dist/agent-core/extensions/primus-bundle.js，请先运行 pnpm build:extensions");
    if (!existsSync(nodeExe))
      fail(`未找到 dist/runtime/node.exe，请先运行 pnpm build:core --platform ${nodePlatform}`);
    // node.exe 不重签，构建前确认官方签名完好（第 3.3.4 节第 1 步）
    const nodeSignature = authenticode(nodeExe);
    if (!isTrustedOpenJsSignature(nodeSignature))
      fail(
        `内置 node.exe 的签名不是有效的 OpenJS 官方签名：${nodeSignature.Status} ${nodeSignature.Subject}`,
      );
    console.log(`✓ 内置 node.exe 保留 OpenJS 官方签名（${nodeSignature.Subject}）`);
    // 内置运行时须与目标架构一致：x64 的 node.exe 打进 arm64 包（或反之）会在仿真下运行甚至无法启动
    const problem = checkRuntimePlatform(manifest, arch);
    if (problem) fail(problem);
    const baseline = JSON.parse(readFileSync(join(root, "scripts/version-baseline.json"), "utf8"));
    const wixVersion = run("wix", ["--version"], { capture: true }).trim();
    if (!wixVersion.startsWith(`${baseline.toolchain.wix}`))
      fail(`WiX 版本为 ${wixVersion}，基线为 ${baseline.toolchain.wix}（技术方案第 2.4 节）`);
  }

  // WebView2 引导程序：缺失时下载，校验微软签名
  const webview2Setup = resolve(root, args.webview2 ?? WEBVIEW2_BOOTSTRAPPER);
  if (!dryRun) await prepareWebView2(webview2Setup, { download: !args.webview2 });

  // 1. 编译 Primus.exe（不打包）
  if (!args["skip-tauri"]) {
    const tauriArgs = [
      "--filter",
      "@primus/desktop",
      "tauri",
      "build",
      "--no-bundle",
      ...target.args,
    ];
    if (versionOverride) {
      // 覆盖版本写进临时配置文件，经 --config 合并进 tauri.conf.json（避免在 shell 中转义 JSON）
      const confFile = join(
        dryRun ? tmpdir() : mkdtempSync(join(tmpdir(), "primus-msi-")),
        "tauri.version.json",
      );
      if (!dryRun) writeFileSync(confFile, `${JSON.stringify({ version })}\n`);
      tauriArgs.push("--config", quoted(confFile));
    }
    runPnpm([...tauriArgs, "--", "--locked"]);
  }
  const exe = join(appDir, "Primus.exe");
  const stampFile = join(appDir, EXE_STAMP);
  if (!dryRun && !existsSync(exe)) fail(`未找到 ${exe}`);
  if (args["skip-tauri"] && !dryRun) {
    const stamp = existsSync(stampFile) ? JSON.parse(readFileSync(stampFile, "utf8")) : null;
    const problem = checkExeStamp(stamp, version, statSync(exe), { arch });
    if (problem) fail(problem);
  }

  // 2. 签名 Primus.exe
  const signExe = signtoolArgs(exe);
  if (signExe) run(signtool, signExe, { attempts: 3 });
  else
    console.log(
      "\n· 未配置 PRIMUS_SIGN_CERT_SHA1 / PRIMUS_SIGN_TIMESTAMP_URL，跳过 Primus.exe 签名",
    );
  // 签名会改写 exe，签名之后再记录（供下次 --skip-tauri 校验）
  if (!dryRun)
    writeFileSync(stampFile, `${JSON.stringify(exeStamp(version, statSync(exe), arch))}\n`);

  // 3. WiX 7 构建 MSI；先删掉上次构建留下的 .sig，免得新 MSI 旁边留着旧签名
  if (!dryRun) {
    mkdirSync(outDir, { recursive: true });
    rmSync(`${msi}.sig`, { force: true });
  }
  run(
    "wix",
    wixBuildArgs({ arch, appDir, coreDir, runtimeDir, webview2Setup, productVersion, out: msi }),
  );

  // 4. 签名 MSI，写 SHA-256 校验文件
  const signMsi = signtoolArgs(msi);
  if (signMsi) run(signtool, signMsi, { attempts: 3 });
  else console.log("\n· 未配置代码签名证书，跳过 MSI 签名");
  if (!dryRun) {
    const digest = createHash("sha256").update(readFileSync(msi)).digest("hex");
    writeFileSync(`${msi}.sha256`, `${digest}  ${basename(msi)}\n`);
  }

  // 5. updater 签名（.sig 写在 MSI 旁边），绑定应用版本后立即按 updater 规则校验
  if (signing.updater) {
    runPnpm([
      "--filter",
      "@primus/desktop",
      "tauri",
      "signer",
      "sign",
      "--app-version",
      version,
      quoted(msi),
    ]);
    if (!dryRun) {
      try {
        verifyUpdaterSignature(
          readFileSync(msi),
          readFileSync(`${msi}.sig`, "utf8"),
          process.env.TAURI_SIGNING_PUBLIC_KEY,
          { version },
        );
      } catch (e) {
        fail(`${basename(msi)}.sig 校验失败：${e.message}`);
      }
      console.log(`✓ updater 签名有效（${basename(msi)}.sig，version ${version}）`);
    }
  } else console.log("\n· 未配置 updater 签名密钥，跳过 updater 签名（.sig）");

  // 6. signtool verify /pa 校验三个文件（第 3.3.4 节第 4 步）
  if (signing.authenticode) {
    for (const file of [exe, nodeExe, msi]) run(signtool, signtoolVerifyArgs(file));
    if (!dryRun) console.log("✓ signtool verify /pa：Primus.exe、node.exe、MSI 均通过");
  }

  console.log(`\n✓ ${dryRun ? "（演练）" : ""}MSI：${msi}`);
  if (!dryRun) console.log(`  SHA-256：${readFileSync(`${msi}.sha256`, "utf8").split(" ")[0]}`);
  return msi;
}

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
