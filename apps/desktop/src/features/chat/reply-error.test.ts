import type { AssistantMessage } from "@primus/protocol";
import { describe, expect, it } from "vitest";
import {
  classifyError,
  connectionReason,
  errorReport,
  formatDuration,
  parseHttpStatus,
  redactSecrets,
} from "./reply-error";

describe("回复错误归类", () => {
  it("从 Core 的错误文本解析 HTTP 状态码", () => {
    expect(parseHttpStatus('ioply API error (401): {"error":"bad key"}')).toBe(401);
    expect(parseHttpStatus("429 Too Many Requests")).toBe(429);
    expect(parseHttpStatus("Request failed with status code 503")).toBe(503);
    expect(parseHttpStatus("HTTP 502 Bad Gateway")).toBe(502);
    // 端口号、token 数不算
    expect(parseHttpStatus("connect ECONNREFUSED 127.0.0.1:3304")).toBeUndefined();
    expect(parseHttpStatus("prompt is too long: 210000 tokens > 200000 maximum")).toBeUndefined();
    expect(parseHttpStatus("Connection error.")).toBeUndefined();
  });

  it("按状态码归类", () => {
    expect(classifyError("x API error (401): no")).toEqual({ category: "auth", status: 401 });
    expect(classifyError("x API error (403): no").category).toBe("auth");
    expect(classifyError("x API error (429): slow down").category).toBe("rateLimit");
    expect(classifyError("x API error (529): Overloaded").category).toBe("server");
    expect(classifyError("x API error (500): oops").category).toBe("server");
    expect(classifyError("x API error (400): bad").category).toBe("invalid");
    expect(classifyError("x API error (404): nope").category).toBe("invalid");
    expect(classifyError("x API error (408): timeout").category).toBe("connection");
  });

  it("没有状态码时按文本归类", () => {
    expect(classifyError("Connection error.")).toEqual({ category: "connection" });
    expect(classifyError("Request timed out.")).toEqual({
      category: "connection",
      reason: "timeout",
    });
    expect(classifyError("No API key found for provider ioply").category).toBe("auth");
    expect(classifyError("Rate limit reached for requests").category).toBe("rateLimit");
    expect(classifyError("Overloaded").category).toBe("server");
    expect(classifyError("Request was aborted").category).toBe("aborted");
    expect(classifyError("prompt is too long: maximum context length").category).toBe("invalid");
    expect(classifyError("Unexpected end of JSON input").category).toBe("unknown");
    expect(classifyError(undefined).category).toBe("unknown");
  });

  it("文本里带底层错误码时给出连接原因", () => {
    expect(connectionReason("getaddrinfo ENOTFOUND api.example.com")).toBe("dns");
    expect(connectionReason("connect ECONNREFUSED 127.0.0.1:3304")).toBe("refused");
    expect(connectionReason("unable to verify the first certificate")).toBe("certificate");
    expect(connectionReason("socket hang up")).toBe("reset");
    expect(connectionReason("Connection error.")).toBeUndefined();
    expect(classifyError("Connection error. (connect ECONNREFUSED 127.0.0.1:3304)")).toEqual({
      category: "connection",
      reason: "refused",
    });
  });

  it("耗时格式", () => {
    expect(formatDuration(320)).toBe("320ms");
    expect(formatDuration(10_412)).toBe("10.4s");
    expect(formatDuration(125_000)).toBe("2m 5s");
  });

  it("复制的详细信息包含元信息、错误文本与诊断", () => {
    const message = {
      role: "assistant",
      content: [],
      api: "openai-responses",
      provider: "gw",
      model: "m1",
      usage: {},
      stopReason: "error",
      errorMessage: "gw API error (529): Overloaded",
      timestamp: Date.UTC(2026, 10, 8, 4, 0, 0),
      durationMs: 1500,
      responseId: "resp_1",
      diagnostics: [
        {
          type: "provider_error",
          timestamp: 1,
          error: { name: "APIError", message: "Overloaded", code: 529 },
          details: { requestId: "r1" },
        },
      ],
    } as unknown as AssistantMessage;
    const report = errorReport(
      message,
      {
        title: "服务端错误",
        provider: "渠道",
        model: "模型",
        status: "HTTP",
        duration: "耗时",
        time: "时间",
      },
      "网关",
    );
    expect(report).toContain("服务端错误");
    expect(report).toContain("渠道: 网关 (gw)");
    expect(report).toContain("模型: m1 · openai-responses");
    expect(report).toContain("HTTP: 529");
    expect(report).toContain("耗时: 1.5s");
    expect(report).toContain("时间: 2026-11-08T04:00:00.000Z");
    expect(report).toContain("responseId: resp_1");
    expect(report).toContain("gw API error (529): Overloaded");
    expect(report).toContain("[provider_error] APIError: Overloaded (529)");
    expect(report).toContain('"requestId": "r1"');
  });

  it("独立的 SSL/TLS 失败归为连接错误，但不当成证书问题", () => {
    expect(classifyError("TLS handshake failed")).toEqual({ category: "connection" });
    expect(classifyError("SSL routines: wrong version number")).toEqual({ category: "connection" });
    expect(connectionReason("self-signed certificate in chain")).toBe("certificate");
    expect(
      classifyError('{"type":"invalid_request_error","message":"TLS client certs not allowed"}'),
    ).toEqual({ category: "invalid" });
  });

  it("错误文本中的疑似密钥替换成 ***", () => {
    const text =
      'Unauthorized: Bearer sk-abcdefgh12345678 rejected; {"x-api-key":"secret-key-9999"} key sk-ant-api03-zzzzzzzzzz';
    const out = redactSecrets(text);
    expect(out).not.toMatch(/abcdefgh12345678|secret-key-9999|zzzzzzzzzz/);
    expect(out).toContain("Bearer ***");
    expect(out).toContain("sk-ant-***");
    expect(redactSecrets("credential: abcd-1234-efgh rejected")).toBe("credential: *** rejected");
    expect(redactSecrets("Connection error.")).toBe("Connection error.");
  });
});
