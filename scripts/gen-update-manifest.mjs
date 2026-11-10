#!/usr/bin/env node
// 生成自动更新清单（技术方案第 3.6 节、ADR 0007）：Tauri 2 updater 的静态 JSON，发布作业（release.yml publish）
// 上传到固定的 Release `update-feed`，桌面端从
//   https://github.com/<repo>/releases/download/update-feed/stable.json（稳定版通道）
//   https://github.com/<repo>/releases/download/update-feed/beta.json  （Beta 通道）
// 读取。清单格式：
//   { "version": "1.2.3", "notes": "<Release 说明>", "pub_date": "<RFC 3339>",
//     "platforms": { "windows-x86_64-msi": { "url": "...", "signature": "<.sig 内容>" }, ... } }
// platforms 含 windows-x86_64-msi / windows-aarch64-msi（只发 MSI，ADR 0007），url 指向本次 Release 的附件
// （Primus_<ver>_<x64|arm64>_zh-CN.msi），signature 为同名 .sig 的内容。旧 NSIS 版只认 windows-<arch>-nsis，
// 收不到这些更新，需手动安装一次 MSI（MSI 会静默卸载 NSIS 版并沿用其 data）。
//
// 通道规则：正式版同时写 stable.json 与 beta.json；预发布（版本含 '-'）只写 beta.json。已有清单的版本更高时不覆盖
// （重新构建旧标签不会让通道回退；Beta 用户在正式版高于当前 Beta 时也收到正式版）；同一版本允许覆盖（重跑发布）。
//
// 用法：node scripts/gen-update-manifest.mjs --version <SemVer> --tag <标签> --repo <owner/name> --assets <目录>
//         --out-dir <目录> [--notes-file <文件>] [--existing-stable <文件>] [--existing-beta <文件>]
//         [--pub-date <RFC 3339>] [--verify]
//   --assets           含 2 个安装包与 2 个 .sig 的目录（发布作业从构建 artifact 下载；.sig 不作为 Release 附件）
//   --existing-*       update-feed 中现有的清单（不存在时省略或指向不存在的文件）
//   --verify           用 TAURI_SIGNING_PUBLIC_KEY 按 updater 规则校验每个 .sig（含绑定的版本）
// 输出：写入 out-dir 的清单文件名逐行打印到 stdout（没有要更新的清单时不打印）。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { verifyUpdaterSignature } from "./updater-signature.mjs";

/** 清单平台键 → 安装包文件名（与 build-msi.mjs 的交付物命名一致） */
export const PLATFORMS = {
  "windows-x86_64-msi": (v) => `Primus_${v}_x64_zh-CN.msi`,
  "windows-aarch64-msi": (v) => `Primus_${v}_arm64_zh-CN.msi`,
};

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z.-]+)?$/;

/** 解析 SemVer；不合法时抛错 */
export function parseSemver(version) {
  const m = SEMVER.exec(String(version ?? "").trim());
  if (!m) throw new Error(`不是合法的 SemVer：${version}`);
  return {
    core: [Number(m[1]), Number(m[2]), Number(m[3])],
    pre: m[4] ? m[4].split(".") : [],
  };
}

/** SemVer 比较（含预发布标识的优先级规则，忽略构建元数据）：a < b 返回负数 */
export function compareSemver(a, b) {
  const x = parseSemver(a);
  const y = parseSemver(b);
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] - y.core[i];
  if (!x.pre.length || !y.pre.length) return y.pre.length - x.pre.length;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) return Number(p) - Number(q);
    if (pn) return -1;
    if (qn) return 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

export function isPrerelease(version) {
  return parseSemver(version).pre.length > 0;
}

/** 校验 .sig 内容的形状（tauri signer 输出的 base64 文本），返回去掉空白后的内容 */
function normalizeSignature(sig, name) {
  const text = String(sig ?? "").trim();
  if (!text || !/^[A-Za-z0-9+/]+={0,2}$/.test(text))
    throw new Error(`${name}.sig 不是有效的签名内容`);
  return text;
}

/**
 * 生成清单对象。
 * @param {{ version: string, tag: string, repo: string, notes?: string, pubDate: string,
 *           signatures: Record<string, string> }} input signatures 以安装包文件名为键
 */
export function buildManifest({ version, tag, repo, notes = "", pubDate, signatures }) {
  parseSemver(version);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`仓库名不对：${repo}`);
  if (!tag || /[\s/]/.test(tag)) throw new Error(`标签不对：${tag}`);
  if (Number.isNaN(Date.parse(pubDate))) throw new Error(`发布时间不是 RFC 3339：${pubDate}`);
  const platforms = {};
  for (const [key, fileName] of Object.entries(PLATFORMS)) {
    const name = fileName(version);
    platforms[key] = {
      signature: normalizeSignature(signatures[name], name),
      url: `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${name}`,
    };
  }
  return { version, notes: String(notes).trim(), pub_date: pubDate, platforms };
}

/** 现有清单的版本；没有或读不出时为 null */
export function manifestVersion(text) {
  if (text === undefined || text === null || String(text).trim() === "") return null;
  try {
    const version = JSON.parse(text)?.version;
    parseSemver(version);
    return version;
  } catch {
    return null;
  }
}

/**
 * 本次要写哪些清单：正式版写 stable 与 beta，预发布只写 beta；现有清单版本更高的通道跳过。
 * @param {string} version 本次版本
 * @param {{ stable?: string | null, beta?: string | null }} existing 现有清单的版本
 * @returns {("stable" | "beta")[]}
 */
export function channelsToUpdate(version, existing = {}) {
  const wanted = isPrerelease(version) ? ["beta"] : ["stable", "beta"];
  return wanted.filter((ch) => {
    const current = existing[ch];
    return !current || compareSemver(version, current) >= 0;
  });
}

function main() {
  const { values } = parseArgs({
    options: {
      version: { type: "string" },
      tag: { type: "string" },
      repo: { type: "string" },
      assets: { type: "string" },
      "out-dir": { type: "string" },
      "notes-file": { type: "string" },
      "existing-stable": { type: "string" },
      "existing-beta": { type: "string" },
      "pub-date": { type: "string" },
      verify: { type: "boolean", default: false },
    },
  });
  const { version, tag, repo, assets } = values;
  const outDir = values["out-dir"];
  if (!version || !tag || !repo || !assets || !outDir) {
    console.error(
      "用法：node scripts/gen-update-manifest.mjs --version <SemVer> --tag <标签> --repo <owner/name> --assets <目录> --out-dir <目录> [--notes-file <文件>] [--existing-stable <文件>] [--existing-beta <文件>] [--pub-date <时间>] [--verify]",
    );
    process.exit(2);
  }
  const readOptional = (file) => (file && existsSync(file) ? readFileSync(file, "utf8") : null);
  try {
    const pubkey = process.env.TAURI_SIGNING_PUBLIC_KEY;
    if (values.verify && !pubkey) throw new Error("--verify 需要环境变量 TAURI_SIGNING_PUBLIC_KEY");
    const signatures = {};
    for (const fileName of Object.values(PLATFORMS)) {
      const name = fileName(version);
      const file = join(assets, name);
      if (!existsSync(file)) throw new Error(`缺少安装包 ${name}`);
      if (!existsSync(`${file}.sig`)) throw new Error(`缺少签名 ${name}.sig`);
      signatures[name] = readFileSync(`${file}.sig`, "utf8");
      if (values.verify)
        verifyUpdaterSignature(readFileSync(file), signatures[name], pubkey, { version });
    }
    const manifest = buildManifest({
      version,
      tag,
      repo,
      notes: readOptional(values["notes-file"]) ?? "",
      pubDate: values["pub-date"] ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      signatures,
    });
    const existing = {
      stable: manifestVersion(readOptional(values["existing-stable"])),
      beta: manifestVersion(readOptional(values["existing-beta"])),
    };
    const channels = channelsToUpdate(version, existing);
    for (const ch of isPrerelease(version) ? ["beta"] : ["stable", "beta"]) {
      if (!channels.includes(ch))
        console.error(`· ${ch}.json 现有版本 ${existing[ch]} 高于 ${version}，不覆盖`);
    }
    mkdirSync(outDir, { recursive: true });
    for (const ch of channels) {
      const name = `${ch}.json`;
      writeFileSync(join(outDir, name), `${JSON.stringify(manifest, null, 2)}\n`);
      console.log(name);
    }
  } catch (error) {
    console.error(`✗ ${error.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
