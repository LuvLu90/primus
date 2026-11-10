#!/usr/bin/env node
// 为更新服务冒烟（update-service-smoke.ps1，ADR 0007）构建“更高版本”的测试 MSI：复用 build-msi.mjs 刚编译的
// Primus.exe、PrimusUpdate.exe 与 dist/，只把 MSI 的 ProductVersion 与 HKLM\Software\Primus\Version 换成 --version，
// 再用当前的 updater 私钥（CI 签名演练生成的一次性密钥）签 .sig 并校验。安装后的 Primus.exe 仍是原版本：
// 冒烟只验证服务的静默升级流程（验签、拒绝降级、等待进程退出、msiexec、注册表版本），不发布这些包。
//
// 用法（仓库根，仅 Windows）：node scripts/build-upgrade-test-msi.mjs --arch x64|arm64 --version <SemVer> --out-dir <目录>
// 前提：node scripts/build-msi.mjs --arch <同一架构> 已完成；TAURI_SIGNING_PRIVATE_KEY(_PATH)、
// TAURI_SIGNING_PRIVATE_KEY_PASSWORD、TAURI_SIGNING_PUBLIC_KEY 与构建时相同。
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  archInfo,
  cargoTarget,
  cargoTargetRoot,
  msiFileName,
  msiProductVersion,
  rustHostTriple,
  WEBVIEW2_BOOTSTRAPPER,
  wixBuildArgs,
} from "./build-msi.mjs";
import { verifyUpdaterSignature } from "./updater-signature.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

function run(command, args, { shell = false } = {}) {
  console.log(`\n> ${[command, ...args].join(" ")}`);
  const r = spawnSync(command, args, { cwd: root, stdio: "inherit", shell });
  if (r.error) fail(`无法启动 ${command}：${r.error.message}`);
  if (r.status !== 0) fail(`命令失败（退出码 ${r.status}）：${command}`);
}

const { values: args } = parseArgs({
  options: {
    arch: { type: "string", default: "x64" },
    version: { type: "string" },
    "out-dir": { type: "string" },
  },
});
if (process.platform !== "win32") fail("只能在 Windows 上运行");
if (!args.version || !args["out-dir"]) fail("需要 --version 与 --out-dir");
try {
  archInfo(args.arch);
} catch (e) {
  fail(e.message);
}
for (const name of ["TAURI_SIGNING_PUBLIC_KEY", "TAURI_SIGNING_PRIVATE_KEY_PASSWORD"])
  if (!process.env[name]) fail(`需要 ${name}`);

const version = args.version;
const target = cargoTarget(args.arch, rustHostTriple(root));
const appDir = join(cargoTargetRoot(), target.releaseDir);
for (const exe of ["Primus.exe", "PrimusUpdate.exe"])
  if (!existsSync(join(appDir, exe))) fail(`未找到 ${join(appDir, exe)}，请先运行 build-msi.mjs`);
const outDir = resolve(root, args["out-dir"]);
mkdirSync(outDir, { recursive: true });
const msi = join(outDir, msiFileName(version, args.arch));
rmSync(`${msi}.sig`, { force: true });

run(
  "wix",
  wixBuildArgs({
    arch: args.arch,
    appDir,
    coreDir: join(root, "dist/agent-core"),
    runtimeDir: join(root, "dist/runtime"),
    webview2Setup: WEBVIEW2_BOOTSTRAPPER,
    productVersion: msiProductVersion(version),
    primusVersion: version,
    out: msi,
  }),
);
const [pnpm, ...prefix] = (process.env.PRIMUS_PNPM ?? "pnpm").split(" ").filter(Boolean);
run(
  pnpm,
  [
    ...prefix,
    "--filter",
    "@primus/desktop",
    "tauri",
    "signer",
    "sign",
    "--app-version",
    version,
    `"${msi}"`,
  ],
  { shell: true },
);
try {
  verifyUpdaterSignature(
    readFileSync(msi),
    readFileSync(`${msi}.sig`, "utf8"),
    process.env.TAURI_SIGNING_PUBLIC_KEY,
    { version },
  );
} catch (e) {
  fail(`.sig 校验失败：${e.message}`);
}
console.log(`\n✓ 升级测试 MSI：${msi}（version ${version}，.sig 已校验）`);
