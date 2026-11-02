import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { extractBuiltinKey, KEY_ENV, smokeModelsConfig } from "./builtin-models.mjs";
import { hasOnlyAllowedApis } from "./real-models-config.mjs";

const shellDir = join(import.meta.dirname, "..", "apps", "desktop", "src-tauri");
const catalog = JSON.parse(readFileSync(join(shellDir, "builtin", "catalog.json"), "utf8"));

describe("内置模型冒烟配置", () => {
  it("能从 builtin.rs 取出内置令牌常量", () => {
    const key = extractBuiltinKey(readFileSync(join(shellDir, "src", "builtin.rs"), "utf8"));
    // 只检查形状，不在测试输出中出现令牌
    expect(key.length > 8).toBe(true);
    expect(() => extractBuiltinKey('const OTHER: &str = "x";')).toThrow();
  });

  it("每个内置模型展开为一个只用两协议的供应商，且只写环境变量引用", () => {
    const config = smokeModelsConfig(catalog);
    const providers = Object.entries(config.providers);
    const total = Object.values(catalog.providers).reduce(
      (n: number, p) => n + (p as { models: unknown[] }).models.length,
      0,
    );
    expect(providers).toHaveLength(total);
    const apis = new Set<string>();
    for (const [id, p] of providers) {
      expect(id).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
      expect(p.apiKey).toBe(`$${KEY_ENV}`);
      expect(p.baseUrl.startsWith("https://")).toBe(true);
      expect(hasOnlyAllowedApis(p)).toBe(true);
      apis.add(p.api);
    }
    expect([...apis].sort()).toEqual(["anthropic-messages", "openai-responses"]);
  });

  it("展开后的供应商 ID 冲突时直接报错，不静默少测模型", () => {
    const base = { baseUrl: "https://gw.example", api: "openai-responses" };
    expect(() =>
      smokeModelsConfig({
        providers: {
          a: { ...base, models: [{ id: "m.1" }, { id: "m-1" }] },
        },
      }),
    ).toThrow(/重复/);
  });
});
