#!/usr/bin/env node
// 内置模型配置的真实模型冒烟（CI 与开发共用）：读取薄壳的内置配置
// （apps/desktop/src-tauri/builtin/catalog.json 与 src/builtin.rs 中的 BUILTIN_API_KEY，临时方案，后续改为账号服务下发），
// 把每个模型展开成一个供应商写入临时 models.json，再交给 smoke-real-models.mjs 各跑一次含 read 工具调用的对话。
// 密钥只经环境变量传给子进程；在 GitHub Actions 中先输出 ::add-mask:: 让日志遮蔽它，任何输出都不含密钥原文。
// 用法：node scripts/builtin-models.mjs [--timeout <ms>]
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const here = fileURLToPath(new URL(".", import.meta.url));
const root = resolve(here, "..");
const shellDir = join(root, "apps", "desktop", "src-tauri");
export const KEY_ENV = "PRIMUS_BUILTIN_API_KEY";

/** 从 builtin.rs 源码中取出 BUILTIN_API_KEY 常量的值。 */
export function extractBuiltinKey(source) {
  const match = /pub\(crate\) const BUILTIN_API_KEY: &str = "([^"\\]+)";/.exec(source);
  if (!match) throw new Error("builtin.rs 中找不到 BUILTIN_API_KEY 常量");
  return match[1];
}

/** 把内置客户端配置展开为“每个模型一个供应商”的冒烟配置；apiKey 只写环境变量引用。 */
export function smokeModelsConfig(catalog) {
  const providers = {};
  for (const [pid, provider] of Object.entries(catalog.providers ?? {})) {
    for (const model of provider.models ?? []) {
      const id = `${pid}--${model.id}`.replace(/[^A-Za-z0-9_-]/g, "-");
      providers[id] = {
        name: `${provider.name ?? pid} · ${model.name ?? model.id}`,
        baseUrl: model.baseUrl ?? provider.baseUrl,
        api: model.api ?? provider.api,
        apiKey: `$${KEY_ENV}`,
        models: [model],
      };
    }
  }
  return { providers };
}

function main() {
  const { values: args } = parseArgs({
    options: { timeout: { type: "string", default: "180000" } },
  });
  const key = extractBuiltinKey(readFileSync(join(shellDir, "src", "builtin.rs"), "utf8"));
  if (process.env.GITHUB_ACTIONS === "true") console.log(`::add-mask::${key}`);
  const catalog = JSON.parse(readFileSync(join(shellDir, "builtin", "catalog.json"), "utf8"));
  const devData = join(root, ".dev-data");
  mkdirSync(devData, { recursive: true });
  const dir = mkdtempSync(join(devData, "builtin-models-"));
  try {
    const file = join(dir, "models.json");
    writeFileSync(file, JSON.stringify(smokeModelsConfig(catalog), null, 2));
    const r = spawnSync(
      process.execPath,
      [join(here, "smoke-real-models.mjs"), "--models", file, "--timeout", args.timeout],
      { stdio: "inherit", env: { ...process.env, [KEY_ENV]: key } },
    );
    return r.status ?? 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
