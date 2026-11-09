import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  hasApiKey,
  hasToolResult,
  MATRIX_MODEL_NAME,
  MATRIX_REPLY,
  modelsResponse,
  replyFor,
  startMatrixFaux,
} from "./faux-serve.mjs";

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
      const missing = await fetch(`${baseUrl}/v1/other`);
      expect(missing.status).toBe(404);
      const log = readFileSync(join(out, "faux-requests.jsonl"), "utf8").trim().split("\n");
      expect(log).toHaveLength(2);
      expect(JSON.parse(log[0])).toMatchObject({ n: 1, toolResult: false });
      expect(JSON.parse(log[1])).toMatchObject({ unexpected: "GET /v1/other" });
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it("GET /v1/models 带密钥时返回 faux 模型（薄壳的“获取模型”），缺密钥返回 401", async () => {
    const out = mkdtempSync(join(tmpdir(), "primus-matrix-faux-"));
    dirs.push(out);
    const { baseUrl, server } = await startMatrixFaux({ out });
    try {
      // anthropic-messages：x-api-key + anthropic-version（providers.rs auth_headers）
      const anthropic = await fetch(`${baseUrl}/v1/models`, {
        headers: { "x-api-key": "faux-key", "anthropic-version": "2023-06-01" },
      });
      expect(anthropic.status).toBe(200);
      const body = await anthropic.json();
      expect(body).toEqual(modelsResponse());
      expect(body.data).toEqual([
        expect.objectContaining({ id: "faux-1", object: "model", display_name: MATRIX_MODEL_NAME }),
      ]);
      // openai-responses 风格的 Bearer 同样接受
      const openai = await fetch(`${baseUrl}/v1/models`, {
        headers: { authorization: "Bearer faux-key" },
      });
      expect(openai.status).toBe(200);
      const anonymous = await fetch(`${baseUrl}/v1/models`);
      expect(anonymous.status).toBe(401);
      const log = readFileSync(join(out, "faux-requests.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));
      expect(log.map((l) => l.authorized)).toEqual([true, true, false]);
      // 模型列表请求不计入对话请求编号
      expect(log.every((l) => l.models === true && !("n" in l))).toBe(true);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it("hasApiKey 只认非空的 x-api-key 或 Bearer", () => {
    expect(hasApiKey({ "x-api-key": "k" })).toBe(true);
    expect(hasApiKey({ authorization: "Bearer k" })).toBe(true);
    expect(hasApiKey({ "x-api-key": " " })).toBe(false);
    expect(hasApiKey({ authorization: "Bearer " })).toBe(false);
    expect(hasApiKey({})).toBe(false);
  });
});
