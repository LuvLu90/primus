#!/usr/bin/env node
// 生成薄壳内置的已知模型能力表 apps/desktop/src-tauri/src/model_capabilities.json（技术方案第 9.2 节）。
//
//   node scripts/generate-model-capabilities.mjs            按锁定的模型目录重新生成
//   node scripts/generate-model-capabilities.mjs --check    只核对已提交的表与锁定目录一致（不一致退出码 1）
//   node scripts/generate-model-capabilities.mjs --catalog <file>   用指定的目录文件（仍校验 SHA-256）
//
// 来源：agent-core/nix/model-catalog.json 锁定的模型目录修订版（与 pnpm build:core 用的是同一份，
// 缓存在 agent-core/.artifacts/，没有缓存时按 agent-core/nix/package.nix 的地址下载并校验 SHA-256）。
// 很多网关（如 CLIProxyAPI 一类）的 /models 只返回 id，获取模型时薄壳用这张表补上上下文长度、最大输出、
// 图片输入与思考；表里只有这四项，键是规范化后的模型 ID（与 providers.rs 的 normalize_model_id 一致）。

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const coreDir = join(root, "agent-core");
export const OUTPUT = join(root, "apps/desktop/src-tauri/src/model_capabilities.json");

/**
 * 收录的供应商，按优先级：同一个规范化 ID 以先出现的为准。
 * 先是各家官方渠道，再是聚合网关（ID 带 `厂商/` 前缀，规范化时去掉）。
 * 不收 Bedrock / Azure 等改写了模型 ID 的云渠道。
 */
export const PROVIDERS = [
  "anthropic",
  "openai",
  "google",
  "deepseek",
  "moonshotai",
  "zai",
  "xai",
  "mistral",
  "minimax",
  "xiaomi",
  "qwen-token-plan",
  "meta",
  "openrouter",
  "vercel-ai-gateway",
];

/** 规范化模型 ID：小写，去掉 `~`、`厂商/` 前缀与 `:变体` 后缀，`.` `_` 换成 `-`（与薄壳一致） */
export function normalizeModelId(id) {
  let s = String(id).trim().toLowerCase().replace(/^~/, "");
  s = s.slice(s.lastIndexOf("/") + 1);
  const colon = s.indexOf(":");
  if (colon >= 0) s = s.slice(0, colon);
  return s.replace(/[._]/g, "-");
}

const positive = (n) => (Number.isInteger(n) && n > 0 ? n : null);

/** 由模型目录生成能力表：规范化 ID → [上下文长度, 最大输出, 图片 0/1, 思考 0/1] */
export function buildTable(catalog) {
  const models = {};
  for (const provider of PROVIDERS) {
    for (const m of catalog[provider] ?? []) {
      if ((m.type ?? "chat") !== "chat" || typeof m.id !== "string") continue;
      const key = normalizeModelId(m.id);
      const ctx = positive(m.contextWindow);
      const max = positive(m.maxTokens);
      // 不含数字的是路由别名（如 auto），容易与网关里的同名模型混淆，不收
      if (!/\d/.test(key) || key in models || !ctx || !max) continue;
      const image = Array.isArray(m.input) && m.input.includes("image") ? 1 : 0;
      models[key] = [ctx, Math.min(max, ctx), image, m.reasoning === true ? 1 : 0];
    }
  }
  return Object.fromEntries(Object.entries(models).sort(([a], [b]) => (a < b ? -1 : 1)));
}

/** 表文件内容：每个模型一行，便于审查差异 */
export function render(revision, table) {
  const rows = Object.entries(table).map(([k, v]) => `    ${JSON.stringify(k)}: [${v.join(", ")}]`);
  return `{
  "generatedBy": "scripts/generate-model-capabilities.mjs",
  "revision": ${JSON.stringify(revision)},
  "fields": ["contextWindow", "maxTokens", "image", "reasoning"],
  "models": {
${rows.join(",\n")}
  }
}
`;
}

export function pinnedRevision() {
  const pin = JSON.parse(readFileSync(join(coreDir, "nix/model-catalog.json"), "utf8"));
  const revision = String(pin.revision ?? "");
  if (!/^sha256-[0-9a-f]{64}$/.test(revision))
    throw new Error(`模型目录修订号格式不正确：${revision}`);
  return revision;
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** 读取锁定的模型目录：指定文件 / 缓存 / 下载，均校验 SHA-256 */
async function loadCatalog(revision, file) {
  const expected = revision.replace(/^sha256-/, "");
  const cached = join(coreDir, ".artifacts", `model-catalog-${expected}.json`);
  for (const candidate of [file, cached].filter(Boolean)) {
    try {
      const bytes = readFileSync(candidate);
      if (sha256(bytes) === expected) return JSON.parse(bytes.toString("utf8"));
      if (candidate === file) throw new Error(`${file} 的 SHA-256 与锁定的修订版不一致`);
    } catch (e) {
      if (candidate === file) throw e;
    }
  }
  const nix = readFileSync(join(coreDir, "nix/package.nix"), "utf8");
  const template = nix.match(/url\s*=\s*"([^"]*\$\{modelCatalogPin\.revision\}[^"]*)"/)?.[1];
  if (!template) throw new Error("未在 agent-core/nix/package.nix 中找到模型目录下载地址");
  const url = template.replace(/\$\{modelCatalogPin\.revision\}/, revision);
  console.log(`> 下载锁定的模型目录 ${revision}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`下载模型目录失败：HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (sha256(bytes) !== expected) throw new Error("模型目录 SHA-256 校验失败");
  mkdirSync(dirname(cached), { recursive: true });
  writeFileSync(cached, bytes);
  return JSON.parse(bytes.toString("utf8"));
}

async function main(args) {
  const check = args.includes("--check");
  const i = args.indexOf("--catalog");
  const file = i >= 0 ? args[i + 1] : undefined;
  const revision = pinnedRevision();
  const text = render(revision, buildTable(await loadCatalog(revision, file)));
  if (check) {
    let current = "";
    try {
      current = readFileSync(OUTPUT, "utf8");
    } catch {}
    if (current !== text) {
      console.error(
        "✗ model_capabilities.json 与锁定的模型目录不一致：运行 node scripts/generate-model-capabilities.mjs",
      );
      process.exit(1);
    }
    console.log("✓ model_capabilities.json 与锁定的模型目录一致");
    return;
  }
  writeFileSync(OUTPUT, text);
  console.log(`✓ 已写入 ${Object.keys(JSON.parse(text).models).length} 个模型的能力`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(`✗ ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  });
}
