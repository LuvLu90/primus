import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildTable,
  normalizeModelId,
  OUTPUT,
  pinnedRevision,
  render,
} from "./generate-model-capabilities.mjs";

const committed = readFileSync(OUTPUT, "utf8");

describe("已知模型能力表", () => {
  it("与 Core 锁定的模型目录修订版一致", () => {
    expect(JSON.parse(committed).revision).toBe(pinnedRevision());
  });

  it("有锁定目录的缓存时，重新生成的内容与提交的表完全一致", () => {
    const revision = pinnedRevision();
    const hash = revision.replace(/^sha256-/, "");
    const cached = join(__dirname, "..", "agent-core", ".artifacts", `model-catalog-${hash}.json`);
    // 没有缓存（未运行过 build:core）时只核对修订号；CI 构建 Core 之后可用 --check 完整核对
    if (!existsSync(cached)) return;
    const bytes = readFileSync(cached);
    if (createHash("sha256").update(bytes).digest("hex") !== hash) return;
    expect(render(revision, buildTable(JSON.parse(bytes.toString("utf8"))))).toBe(committed);
  });

  it("规范化与薄壳一致；按供应商优先级去重，只收聊天模型与带版本号的 ID", () => {
    expect(normalizeModelId(" Anthropic/Claude-Opus-4.5 ")).toBe("claude-opus-4-5");
    expect(normalizeModelId("~openai/gpt_5.5:batch")).toBe("gpt-5-5");
    const table = buildTable({
      openrouter: [
        { id: "anthropic/claude-x-1.5", contextWindow: 1, maxTokens: 1, input: ["text"] },
        { id: "openrouter/auto", contextWindow: 9, maxTokens: 9, input: ["text"] },
      ],
      anthropic: [
        {
          id: "claude-x-1-5",
          contextWindow: 200000,
          maxTokens: 300000,
          input: ["text", "image"],
          reasoning: true,
        },
        { id: "claude-img-1", type: "image", contextWindow: 1, maxTokens: 1 },
        { id: "claude-bad-1", contextWindow: 0, maxTokens: 1 },
      ],
    });
    expect(table).toEqual({ "claude-x-1-5": [200000, 200000, 1, 1] });
  });
});
