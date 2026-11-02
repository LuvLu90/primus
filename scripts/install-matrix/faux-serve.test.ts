import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hasToolResult, MATRIX_REPLY, replyFor, startMatrixFaux } from "./faux-serve.mjs";

describe("安装矩阵 Faux 模型服务", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("没有工具结果时先调用 read，拿到工具结果后回复文本", () => {
    const first = { messages: [{ role: "user", content: "读取" }] };
    expect(hasToolResult(first)).toBe(false);
    const call = replyFor(first, 1);
    expect(
      call.blocks?.some(
        (b: { type: string; name?: string }) => b.type === "tool_use" && b.name === "read",
      ),
    ).toBe(true);

    const second = {
      messages: [
        ...first.messages,
        { role: "assistant", content: [{ type: "tool_use", id: "t", name: "read", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "x" }] },
      ],
    };
    expect(hasToolResult(second)).toBe(true);
    expect(replyFor(second, 2)).toEqual({ chunks: [MATRIX_REPLY] });
  });

  it("监听 127.0.0.1，写出地址并记录每个请求", async () => {
    const out = mkdtempSync(join(tmpdir(), "primus-matrix-faux-"));
    dirs.push(out);
    const { baseUrl, server } = await startMatrixFaux({ out });
    try {
      expect(readFileSync(join(out, "faux-url.txt"), "utf8")).toBe(baseUrl);
      const res = await fetch(`${baseUrl}/v1/messages`, {
        method: "POST",
        body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
      });
      const text = await res.text();
      expect(res.headers.get("content-type")).toBe("text/event-stream");
      expect(text).toContain("tool_use");
      const missing = await fetch(`${baseUrl}/v1/models`);
      expect(missing.status).toBe(404);
      const log = readFileSync(join(out, "faux-requests.jsonl"), "utf8").trim().split("\n");
      expect(log).toHaveLength(2);
      expect(JSON.parse(log[0])).toMatchObject({ n: 1, toolResult: false });
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});
