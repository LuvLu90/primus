#!/usr/bin/env node
// 构建 NSIS 安装程序（EXE，技术方案第 3.4 节；与 MSI 一同发布）：
//
//   pnpm --filter @primus/desktop tauri bundle --bundles nsis [--target <三元组>] --config <临时配置> --ci
//
// 打包 build-msi.mjs 刚编译（并在配置证书时签名）的 Primus.exe，不重新编译：先运行
// pnpm build:msi --arch <同一架构>，本脚本按 Primus.exe.build.json 校验 exe 的版本与架构。
// Tauri 打包时会把安装方式写进 exe（binary patching，供 updater 识别），因此之后再用
// build-msi.mjs --skip-tauri 会因 exe 已变化而拒绝，需重新编译。
//
// NSIS 的固定设置在 tauri.conf.json 的 bundle 中（bundle.active 保持 false，tauri build 不打包）：
// 简体中文界面、按机器安装到 Program Files、内嵌 WebView2 引导程序、隐私政策页 windows/Privacy.rtf、安装界面图片 windows/art（与 MSI 同风格）、
// 安装钩子 windows/nsis/hooks.nsh（data 目录授予 Users 组“修改”，与 Primus.wxs 一致）。
// 只在打包时合并的临时配置（不写进 tauri.conf.json）：
//   - productName「乾元 Primus」：安装界面、开始菜单快捷方式、“应用和功能”中的显示名与 MSI 一致；
//     薄壳编译用的 productName 仍是 Primus（mainBinaryName 决定 exe 名，不受影响）
//   - resources：dist/runtime → resources\runtime、dist/agent-core → resources\agent-core（与 MSI 布局一致）。
//     tauri-build 编译时会检查 resources 是否存在，写进 tauri.conf.json 会让开发构建与 Linux 单测依赖 dist/
//
// 代码签名（配置了 PRIMUS_SIGN_CERT_SHA1 与 PRIMUS_SIGN_TIMESTAMP_URL 时，与 build-msi.mjs 同一证书）：
// Tauri 打包时会改写 Primus.exe（binary patching），build-msi.mjs 签过的签名随之失效，所以签名交给 tauri bundle
// 本身（临时配置的 bundle.windows.certificateThumbprint / timestampUrl）：它在改写后签 Primus.exe，再签
// 卸载程序与 setup.exe。打包后用 signtool verify /pa /all 校验 setup.exe 与改写后的 Primus.exe。
//
// updater 签名（配置了 TAURI_SIGNING_PRIVATE_KEY 与 TAURI_SIGNING_PUBLIC_KEY 时，与 build-msi.mjs 同一套规则）：
// 对交付物 setup.exe 执行 tauri signer sign --app-version <版本> 生成 .sig，随即按 updater 规则校验（自动更新，ADR 0007）。
//
// 输出 out/Primus_<ver>_<arch>-setup.exe、.sha256（供 CI 校验，不作为 Release 附件）与 .sig（配置了 updater 密钥时）。
// NSIS 只能在 Windows 上构建；其他平台只能用 --dry-run 查看将要执行的命令。
//
// 用法：node scripts/build-nsis.mjs [--arch x64|arm64] [--out-dir <目录>] [--dry-run]
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
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
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  archInfo,
  cargoTarget,
  cargoTargetRoot,
  checkExeStamp,
  checkRuntimePlatform,
  EXE_STAMP,
  resolveSigntool,
  rustHostTriple,
  signingConfig,
  signtoolVerifyArgs,
  updaterKeyFile,
} from "./build-msi.mjs";
import { verifyUpdaterSignature } from "./updater-signature.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const tauriDir = join(root, "apps/desktop/src-tauri");

/** 安装界面、快捷方式与卸载信息中的产品名（与 Primus.wxs 的 Package Name 一致） */
export const NSIS_PRODUCT_NAME = "乾元 Primus";

/** 交付物文件名（第 3.1 节）：Primus_<ver>_<arch>-setup.exe */
export function nsisFileName(semver, arch = "x64") {
  archInfo(arch);
  return `Primus_${semver}_${arch}-setup.exe`;
}

/**
 * 打包时合并进 tauri.conf.json 的临时配置。env 中证书指纹与时间戳服务器成对配置时，让 tauri bundle 用同一证书
 * 签名（RFC 3161 时间戳、SHA-256 摘要，与 build-msi.mjs 的 signtool 参数一致）。
 */
export function nsisBundleConfig({ runtimeDir, coreDir }, env = {}) {
  const sha1 = env.PRIMUS_SIGN_CERT_SHA1;
  const tsa = env.PRIMUS_SIGN_TIMESTAMP_URL;
  return {
    productName: NSIS_PRODUCT_NAME,
    bundle: {
      resources: {
        [runtimeDir]: "resources/runtime/",
        [coreDir]: "resources/agent-core/",
      },
      ...(sha1 && tsa
        ? {
            windows: {
              certificateThumbprint: sha1,
              digestAlgorithm: "sha256",
              timestampUrl: tsa,
              tsp: true,
            },
          }
        : {}),
    },
  };
}

/**
 * 在 Tauri 的 bundle/nsis 输出目录中找本次产物：文件名为 <productName>_<ver>_<arch>-setup.exe，
 * 架构取自编译目标，与 --arch 不符说明编译目标错了。恰好一个时返回文件名，否则抛错。
 */
export function pickNsisOutput(names, semver, arch) {
  const suffix = `_${semver}_${arch}-setup.exe`;
  const matched = names.filter((n) => n.endsWith(suffix));
  if (matched.length !== 1)
    throw new Error(
      `bundle/nsis 中应恰有一个 *${suffix}，实际 ${matched.length} 个（全部：${names.join("、") || "无"}）`,
    );
  return matched[0];
}

async function main() {
  const { values: args } = parseArgs({
    options: {
      arch: { type: "string", default: "x64" },
      "out-dir": { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
  });
  const dryRun = args["dry-run"];
  const isWindows = process.platform === "win32";
  if (!isWindows && !dryRun)
    fail("NSIS 安装程序只能在 Windows 上构建；在其他平台可用 --dry-run 查看命令");

  const arch = args.arch;
  try {
    archInfo(arch);
  } catch (e) {
    fail(e.message);
  }
  const version = JSON.parse(readFileSync(join(tauriDir, "tauri.conf.json"), "utf8")).version;
  const target = cargoTarget(arch, rustHostTriple(root));
  const releaseDir = join(cargoTargetRoot(), target.releaseDir);
  const exe = join(releaseDir, "Primus.exe");
  const coreDir = join(root, "dist/agent-core");
  const runtimeDir = join(root, "dist/runtime");
  const outDir = resolve(root, args["out-dir"] ?? "out");
  const out = join(outDir, nsisFileName(version, arch));
  const bundleDir = join(releaseDir, "bundle/nsis");
  console.log(`乾元 Primus NSIS 安装程序：版本 ${version}，架构 ${arch}`);

  // 签名配置与 build-msi.mjs 同一套规则：配一半、或 PRIMUS_REQUIRE_SIGNING=1 而未配齐时在打包前拒绝
  const signing = signingConfig();
  if (signing.problems.length) fail(`签名配置有误：\n  ${signing.problems.join("\n  ")}`);
  const keyFile = updaterKeyFile();
  if (!dryRun && keyFile && !existsSync(keyFile))
    fail(`TAURI_SIGNING_PRIVATE_KEY_PATH 指向的文件不存在：${keyFile}`);
  const signtool = signing.authenticode ? resolveSigntool() : null;
  console.log(
    `签名：代码签名${signing.authenticode ? `已配置（${signtool}）` : "未配置"}，updater 签名${signing.updater ? "已配置" : "未配置"}`,
  );

  // 0. 前提：build-msi.mjs 以同一版本、同一架构编译的 Primus.exe；Core 产物、第一方扩展与同架构的内置运行时
  if (!dryRun) {
    if (!existsSync(exe)) fail(`未找到 ${exe}，请先运行 pnpm build:msi --arch ${arch}`);
    const stampFile = join(releaseDir, EXE_STAMP);
    const stamp = existsSync(stampFile) ? JSON.parse(readFileSync(stampFile, "utf8")) : null;
    const problem = checkExeStamp(stamp, version, statSync(exe), {
      arch,
      remedy: `请先运行 pnpm build:msi --arch ${arch}`,
      pubkey: process.env.TAURI_SIGNING_PUBLIC_KEY,
    });
    if (problem) fail(problem);
    const manifestPath = join(coreDir, "manifest.json");
    if (!existsSync(manifestPath))
      fail("未找到 dist/agent-core/manifest.json，请先运行 pnpm build:core");
    const runtimeProblem = checkRuntimePlatform(
      JSON.parse(readFileSync(manifestPath, "utf8")),
      arch,
    );
    if (runtimeProblem) fail(runtimeProblem);
    if (!existsSync(join(runtimeDir, "node.exe"))) fail("未找到 dist/runtime/node.exe");
    if (!existsSync(join(coreDir, "extensions/primus-bundle.js")))
      fail("未找到 dist/agent-core/extensions/primus-bundle.js，请先运行 pnpm build:extensions");
  }

  // 1. tauri bundle（临时配置写进文件经 --config 合并，避免在 shell 中转义 JSON）
  const confFile = join(
    dryRun ? tmpdir() : mkdtempSync(join(tmpdir(), "primus-nsis-")),
    "tauri.nsis.json",
  );
  if (!dryRun) {
    writeFileSync(
      confFile,
      `${JSON.stringify(nsisBundleConfig({ runtimeDir, coreDir }, process.env), null, 2)}\n`,
    );
    // 清掉上次的产物，下面按文件名恰好匹配一个
    rmSync(bundleDir, { recursive: true, force: true });
  }
  const [pnpm, ...pnpmPrefix] = (process.env.PRIMUS_PNPM ?? "pnpm").split(" ").filter(Boolean);
  const quoted = (p) => (isWindows ? `"${p}"` : p);
  const bundleArgs = [
    ...pnpmPrefix,
    "--filter",
    "@primus/desktop",
    "tauri",
    "bundle",
    "--bundles",
    "nsis",
    ...target.args,
    "--config",
    quoted(confFile),
    "--ci",
  ];
  console.log(`\n> ${[pnpm, ...bundleArgs].join(" ")}`);
  if (!dryRun) {
    // pnpm 在 Windows 上是 .cmd，只能经 shell 启动，路径参数已加引号
    const r = spawnSync(pnpm, bundleArgs, { cwd: root, stdio: "inherit", shell: isWindows });
    if (r.error) fail(`无法启动 ${pnpm}：${r.error.message}`);
    if (r.status !== 0) fail(`tauri bundle 失败（退出码 ${r.status}）`);
  }

  // 2. 复制为交付物文件名，写 SHA-256 校验文件
  if (!dryRun) {
    let produced;
    try {
      produced = pickNsisOutput(existsSync(bundleDir) ? readdirSync(bundleDir) : [], version, arch);
    } catch (e) {
      fail(e.message);
    }
    mkdirSync(outDir, { recursive: true });
    // 先删掉上次留下的 .sig，免得新安装程序旁边留着旧签名
    rmSync(`${out}.sig`, { force: true });
    copyFileSync(join(bundleDir, produced), out);
    const digest = createHash("sha256").update(readFileSync(out)).digest("hex");
    writeFileSync(`${out}.sha256`, `${digest}  ${basename(out)}\n`);
    console.log(`\n✓ NSIS 安装程序：${out}（来自 ${produced}）`);
    console.log(`  SHA-256：${digest}`);
  }

  // 3. updater 签名（.sig 写在 setup.exe 旁边），绑定应用版本后立即按 updater 规则校验
  if (signing.updater) {
    const signArgs = [
      ...pnpmPrefix,
      "--filter",
      "@primus/desktop",
      "tauri",
      "signer",
      "sign",
      "--app-version",
      version,
      quoted(out),
    ];
    console.log(`\n> ${[pnpm, ...signArgs].join(" ")}`);
    if (!dryRun) {
      const r = spawnSync(pnpm, signArgs, { cwd: root, stdio: "inherit", shell: isWindows });
      if (r.error) fail(`无法启动 ${pnpm}：${r.error.message}`);
      if (r.status !== 0) fail(`tauri signer sign 失败（退出码 ${r.status}）`);
      try {
        verifyUpdaterSignature(
          readFileSync(out),
          readFileSync(`${out}.sig`, "utf8"),
          process.env.TAURI_SIGNING_PUBLIC_KEY,
          { version },
        );
      } catch (e) {
        fail(`${basename(out)}.sig 校验失败：${e.message}`);
      }
      console.log(`✓ updater 签名有效（${basename(out)}.sig，version ${version}）`);
    }
  } else console.log("\n· 未配置 updater 签名密钥，跳过 updater 签名（.sig）");

  // 4. signtool verify /pa：setup.exe 与改写后重签的 Primus.exe（配置了证书时）
  if (signing.authenticode) {
    for (const file of [out, exe]) {
      console.log(`\n> ${signtool} ${signtoolVerifyArgs(file).join(" ")}`);
      if (dryRun) continue;
      const r = spawnSync(signtool, signtoolVerifyArgs(file), { stdio: "inherit" });
      if (r.error) fail(`无法启动 ${signtool}：${r.error.message}`);
      if (r.status !== 0) fail(`signtool verify 失败（退出码 ${r.status}）：${file}`);
    }
    if (!dryRun) console.log("✓ signtool verify /pa：setup.exe、Primus.exe 均通过");
  } else if (!dryRun) {
    console.log("\n· 未配置 PRIMUS_SIGN_CERT_SHA1 / PRIMUS_SIGN_TIMESTAMP_URL，安装程序不签名");
  }
  if (dryRun) {
    console.log(`\n✓ （演练）NSIS 安装程序：${out}`);
  }
}

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
