#!/usr/bin/env node
// 安装矩阵用的常驻 Faux 模型服务（Anthropic Messages 协议，127.0.0.1 随机端口）。
// 与契约测试的 core-contract/faux-model.mjs 共用 SSE 编码，但回复不靠队列，而按请求内容决定，
// 这样桌面端（端到端对话）与标准用户（Core 对话）两条链路可以同时、按任意顺序使用同一个服务：
//   - 最后一条消息不含 tool_result：回复一次 read 工具调用（读取 primus-matrix.txt）
//   - 最后一条消息含 tool_result：回复文本 MATRIX_REPLY，本轮结束
// 每个请求追加一行到 <out>/faux-requests.jsonl（路径、是否含工具结果），供矩阵脚本核对。
//
//   node faux-serve.mjs --out <目录>     启动后把 baseUrl 写入 <out>/faux-url.txt，一直运行到被结束
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { encodeSse, sseEvents } from "../core-contract/faux-model.mjs";

export const MATRIX_REPLY = "PRIMUS-MATRIX-OK 安装矩阵对话成功";
export const MATRIX_TOOL_PATH = "primus-matrix.txt";

/** 请求体最后一条消息是否带工具结果（Anthropic Messages：user 消息中的 tool_result 内容块） */
export function hasToolResult(body) {
  const last = body?.messages?.at(-1);
  return Array.isArray(last?.content) && last.content.some((b) => b?.type === "tool_result");
}

/** 按请求决定回复：先调一次 read，拿到工具结果后回复文本 */
export function replyFor(body, index) {
  if (hasToolResult(body)) return { chunks: [MATRIX_REPLY] };
  return {
    blocks: [
      { type: "text", chunks: ["先读一下文件。"] },
      {
        type: "tool_use",
        id: `toolu_matrix_${index}`,
        name: "read",
        chunks: [JSON.stringify({ path: MATRIX_TOOL_PATH })],
      },
    ],
  };
}

export function startMatrixFaux({ out }) {
  mkdirSync(out, { recursive: true });
  const log = join(out, "faux-requests.jsonl");
  let count = 0;
  const server = createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (d) => {
      raw += d;
    });
    req.on("end", () => {
      const { pathname } = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method !== "POST" || pathname !== "/v1/messages") {
        appendFileSync(log, `${JSON.stringify({ unexpected: `${req.method} ${req.url}` })}\n`);
        res.writeHead(404, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ type: "error", error: { type: "not_found_error", message: req.url } }),
        );
        return;
      }
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        body = undefined;
      }
      count += 1;
      const toolResult = hasToolResult(body);
      appendFileSync(
        log,
        `${JSON.stringify({ n: count, toolResult, at: new Date().toISOString() })}\n`,
      );
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      for (const event of sseEvents(replyFor(body, count), { messageId: `msg_matrix_${count}` })) {
        res.write(encodeSse(event));
      }
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const baseUrl = `http://127.0.0.1:${server.address().port}`;
      writeFileSync(join(out, "faux-url.txt"), baseUrl, "utf8");
      resolve({ baseUrl, server });
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { out: { type: "string" } } });
  if (!values.out) {
    console.error("用法：node faux-serve.mjs --out <目录>");
    process.exit(2);
  }
  const { baseUrl } = await startMatrixFaux({ out: values.out });
  console.log(`Faux 模型服务：${baseUrl}`);
}
