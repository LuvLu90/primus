import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
// @ts-expect-error 纯 JS 脚本，无类型声明
import {
  errorStatus,
  hasModelId,
  hasModelLevelApiKey,
  hasOnlyAllowedApis,
  isProviderRateLimited,
  isQuotaExhausted,
  resolveApiKey,
  smokeEnv,
} from "./real-models-config.mjs";

describe("真实模型配置", () => {
  it("校验供应商级与全部模型的协议，模型可继承供应商协议", () => {
    expect(
      hasOnlyAllowedApis({
        api: "openai-responses",
        models: [{ id: "a" }, { id: "b", api: "anthropic-messages" }],
      }),
    ).toBe(true);
    expect(
      hasOnlyAllowedApis({
        api: "openai-responses",
        models: [{ id: "a" }, { id: "b", api: "forbidden-api" }],
      }),
    ).toBe(false);
    expect(hasOnlyAllowedApis({ api: "forbidden-api", models: [] })).toBe(false);
    expect(hasOnlyAllowedApis({ models: [{ id: "a" }] })).toBe(false);
    expect(hasOnlyAllowedApis({ models: [] })).toBe(false);
  });

  it("第一个模型必须有非空 id", () => {
    expect(hasModelId({ models: [{ id: "a" }] })).toBe(true);
    expect(hasModelId({ models: [] })).toBe(false);
    expect(hasModelId({})).toBe(false);
    expect(hasModelId({ models: [{ id: "" }] })).toBe(false);
    expect(hasModelId({ models: [{ name: "a" }] })).toBe(false);
    expect(hasModelId({ models: [{ id: "a\u0000b" }] })).toBe(false);
  });

  it("拒绝模型级 apiKey", () => {
    expect(hasModelLevelApiKey({ apiKey: "$K", models: [{ id: "a" }] })).toBe(false);
    expect(hasModelLevelApiKey({ models: [{ id: "a", apiKey: "plain" }] })).toBe(true);
    expect(hasModelLevelApiKey({ models: [{ id: "a" }, { id: "b", apiKey: "$K" }] })).toBe(true);
  });

  it("环境变量引用保留原配置，拒绝缺失变量与明文 key", () => {
    expect(resolveApiKey("$TEST_KEY", { env: { TEST_KEY: "secret" } })).toEqual({
      config: "$TEST_KEY",
      extraEnv: {},
    });
    expect(() => resolveApiKey("$TEST_KEY", { env: {} })).toThrow("TEST_KEY 未设置");
    expect(() => resolveApiKey("plain-secret", { env: {} })).toThrow("不接受明文 key");
  });

  it("取密钥命令使用完整环境，临时配置只保留环境变量引用", () => {
    const execute = vi.fn().mockReturnValue("resolved-secret\n");
    const env = { DBUS_SESSION_BUS_ADDRESS: "unix:path=/tmp/test", VAULT_TOKEN: "token" };
    const resolved = resolveApiKey("!vault read dev-key", { env, execute });
    expect(execute).toHaveBeenCalledWith("vault read dev-key", env);
    expect(resolved.config).toBe("$PRIMUS_REAL_MODELS_API_KEY");
    expect(resolved.config).not.toContain("dev-key");
    expect(resolved.extraEnv).toEqual({ PRIMUS_REAL_MODELS_API_KEY: "resolved-secret" });
  });

  it("取密钥命令失败时不把命令原文带入错误", () => {
    const execute = () => {
      throw new Error("failed");
    };
    expect(() => resolveApiKey("!echo plain-secret", { env: {}, execute })).toThrow(
      /^取密钥命令执行失败$/,
    );
  });

  it("Core 继承代理、自定义 CA 与密钥变量，但不继承无关变量", () => {
    const env = {
      PATH: "path",
      HTTPS_PROXY: "http://proxy",
      HTTP_PROXY: "http://proxy",
      NO_PROXY: "localhost",
      NODE_EXTRA_CA_CERTS: "ca.pem",
      TEST_KEY: "secret",
      UNRELATED_SECRET: "do-not-inherit",
    };
    const result = smokeEnv({
      home: "home",
      coreDir: "core",
      tmpDir: "tmp",
      apiKey: "$TEST_KEY",
      env,
    });
    expect(result).toMatchObject({
      HTTPS_PROXY: "http://proxy",
      HTTP_PROXY: "http://proxy",
      NO_PROXY: "localhost",
      NODE_EXTRA_CA_CERTS: resolve("ca.pem"),
      TEST_KEY: "secret",
      TEMP: "tmp",
      TMP: "tmp",
    });
    expect(result.UNRELATED_SECRET).toBeUndefined();
    // 相对 CA 路径按当前目录解析成绝对路径，且不改动传入的环境
    expect(env.NODE_EXTRA_CA_CERTS).toBe("ca.pem");
  });

  it("大小写不同的 NODE_EXTRA_CA_CERTS 也解析成绝对路径", () => {
    const result = smokeEnv({
      home: "home",
      coreDir: "core",
      tmpDir: "tmp",
      apiKey: "$TEST_KEY",
      env: { node_extra_ca_certs: "ca.pem", TEST_KEY: "secret" },
    });
    expect(result.node_extra_ca_certs).toBe(resolve("ca.pem"));
  });

  it("上游额度用尽的 429 记为跳过，其他错误不算", () => {
    const cooldown =
      'primus-responses--gemini-3-1-flash-image API error (429): {"code":"model_cooldown","last_upstream_error":"RESOURCE_EXHAUSTED: Your quota will reset after 4h6m30s."}';
    expect(errorStatus(cooldown)).toBe(429);
    expect(isQuotaExhausted(cooldown)).toBe(true);
    expect(isQuotaExhausted("429: You have exhausted your capacity on this model.")).toBe(true);
    // 普通限流
    expect(isQuotaExhausted("x API error (429): Too Many Requests")).toBe(false);
    // 正文里的 429 不是状态码
    expect(
      errorStatus('x API error (500): {"request_id":"req-429-84","error":"RESOURCE_EXHAUSTED"}'),
    ).toBe(500);
    expect(
      isQuotaExhausted(
        'x API error (500): {"request_id":"req-429-84","error":"RESOURCE_EXHAUSTED"}',
      ),
    ).toBe(false);
    expect(isQuotaExhausted("upstream said 429 RESOURCE_EXHAUSTED")).toBe(false);
    // 账户额度用尽不会自动恢复，不能跳过
    expect(
      isQuotaExhausted(
        'x API error (429): {"error":{"code":"insufficient_quota","message":"RESOURCE_EXHAUSTED"}}',
      ),
    ).toBe(false);
    expect(isQuotaExhausted(undefined)).toBe(false);
  });

  it("智谱把限流报成 400 时识别为上游限流，其他 400 不算", () => {
    const glm = '400 {"detail":"您的账户已达到速率限制，请您控制请求频率"}';
    expect(errorStatus(glm)).toBe(400);
    expect(isProviderRateLimited(glm)).toBe(true);
    expect(isProviderRateLimited(`x API error (400): ${glm.slice(4)}`)).toBe(true);
    expect(isProviderRateLimited('400 {"detail":"model not found"}')).toBe(false);
    // 不是 400 的不归这里管
    expect(isProviderRateLimited('429 {"detail":"您的账户已达到速率限制"}')).toBe(false);
    expect(isProviderRateLimited('500 {"detail":"速率限制"}')).toBe(false);
    expect(isProviderRateLimited(undefined)).toBe(false);
  });
});
