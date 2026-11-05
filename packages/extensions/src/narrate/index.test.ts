import { describe, expect, it } from "vitest";
import narrate, { NARRATE_PROMPT } from "./index.ts";

type Handler = (event: { systemPrompt: string }) => { systemPrompt: string } | undefined;

describe("primus-narrate", () => {
  it("每轮开始前把进度说明追加到系统提示词末尾，只追加一次", () => {
    let handler: Handler | undefined;
    narrate({
      on: (event: string, h: Handler) => {
        if (event === "before_agent_start") handler = h;
      },
    });
    const first = handler?.({ systemPrompt: "base" });
    expect(first?.systemPrompt).toBe(`base\n${NARRATE_PROMPT}`);
    expect(handler?.({ systemPrompt: first?.systemPrompt ?? "" })).toBeUndefined();
  });

  it("没有事件 API 时什么也不做", () => {
    expect(() => narrate({})).not.toThrow();
  });
});
