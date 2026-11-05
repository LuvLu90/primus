#!/usr/bin/env node
// 真实模型冒烟（第 4 周第 3 项，仅限开发）：用开发用 models.json（放在已 gitignore 的
// .dev-data/dev-models.json，或 --models 指定）对其中每个供应商拉起 Core，各完成一次含工具调用的对话：
// 让模型用 read 工具读取临时目录里的文件并复述其中的口令，检查 tool_execution_end 成功且回复含口令。
// 模板见 scripts/dev-models.example.json（复制到 .dev-data/dev-models.json 后填入端点与模型）。
// 密钥不落盘（AGENTS.md 2.5）：apiKey 只能写 "$环境变量名" 或 "!取密钥命令"，字面量 key 直接拒绝。
// 取密钥命令由父进程执行，写给 Core 的临时 models.json 只含环境变量引用，不含命令原文或密钥。
// 用法：PRIMUS_DEV_OPENAI_API_KEY=… PRIMUS_DEV_ANTHROPIC_API_KEY=… node scripts/smoke-real-models.mjs [--models <path>] [--provider <id>] [--timeout <ms>]
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { CoreProcess } from "./core-contract/core-process.mjs";
import { prepareCoreTarget, repoRoot } from "./core-target.mjs";
import {
  hasModelId,
  hasModelLevelApiKey,
  hasOnlyAllowedApis,
  isQuotaExhausted,
  resolveApiKey,
  smokeEnv,
} from "./real-models-config.mjs";

// 供应商 ID 参与临时目录拼接，只允许安全字符（排除路径分隔符、"."、".."）
const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

const { values: args } = parseArgs({
  options: {
    models: { type: "string", default: resolve(".dev-data/dev-models.json") },
    provider: { type: "string" },
    timeout: { type: "string", default: "120000" },
  },
});

const config = JSON.parse(readFileSync(args.models, "utf8"));
const providers = Object.entries(config.providers ?? {}).filter(
  ([id]) => !args.provider || id === args.provider,
);
if (!providers.length) {
  console.error(`✗ ${args.models} 中没有可用的供应商`);
  process.exit(1);
}

const textOf = (message) =>
  (message?.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("");

const devDataDir = resolve(repoRoot, ".dev-data");
mkdirSync(devDataDir, { recursive: true });
const sandbox = mkdtempSync(join(devDataDir, "real-models-"));
let failed = 0;
let passed = 0;
let quotaSkipped = 0;
try {
  const target = prepareCoreTarget({ sandbox: join(sandbox, "target") });
  for (const [id, provider] of providers) {
    const firstModel = provider.models?.[0];
    const model = firstModel?.id;
    const api = firstModel?.api ?? provider.api;
    const label = `${id}（${api}）`;
    if (!PROVIDER_ID.test(id)) {
      console.error(`✗ ${JSON.stringify(id)}：供应商 ID 只能包含字母、数字、- 和 _`);
      failed++;
      continue;
    }
    if (!hasOnlyAllowedApis(provider)) {
      console.error(`✗ ${label}：只允许 openai-responses / anthropic-messages`);
      failed++;
      continue;
    }
    if (!hasModelId(provider)) {
      console.error(`✗ ${label}：models 的第一个模型缺少 id`);
      failed++;
      continue;
    }
    if (hasModelLevelApiKey(provider)) {
      console.error(`✗ ${label}：apiKey 只能设在供应商级，模型级不允许`);
      failed++;
      continue;
    }
    let auth;
    try {
      auth = resolveApiKey(provider.apiKey);
    } catch (err) {
      console.error(`✗ ${label}：${err.message}`);
      failed++;
      continue;
    }
    const coreDir = join(sandbox, id, "core");
    const workDir = join(sandbox, id, "work");
    const tmpDir = join(sandbox, id, "tmp");
    mkdirSync(coreDir, { recursive: true });
    mkdirSync(workDir, { recursive: true });
    mkdirSync(tmpDir, { recursive: true });
    const coreProvider = { ...provider, apiKey: auth.config };
    writeFileSync(
      join(coreDir, "models.json"),
      JSON.stringify({ providers: { [id]: coreProvider } }),
    );
    const secret = `乾元-${Math.random().toString(36).slice(2, 8)}`;
    writeFileSync(join(workDir, "口令.txt"), `口令是：${secret}\n`);
    // spawn 可能因参数或环境变量非法同步抛错；只记为本供应商失败，继续测试后面的供应商
    let core;
    try {
      core = new CoreProcess({
        ...target,
        args: ["--provider", id, "--model", model, "--no-session", "--tools", "read"],
        cwd: workDir,
        env: smokeEnv({
          home: join(sandbox, id),
          coreDir,
          tmpDir,
          apiKey: auth.config,
          extraEnv: auth.extraEnv,
        }),
      });
    } catch (err) {
      console.error(`✗ ${label} ${model}：Core 启动失败：${err.message}`);
      failed++;
      continue;
    }
    const started = Date.now();
    try {
      const from = core.records.length;
      const r = await core.request(
        {
          type: "prompt",
          message: "请用 read 工具读取当前目录下的「口令.txt」，然后只回复文件里的口令。",
        },
        { timeoutMs: Number(args.timeout) },
      );
      if (r.success !== true) throw new Error(`prompt 被拒绝：${JSON.stringify(r)}`);
      await core.waitFor((x) => x.type === "agent_settled", {
        label: "agent_settled",
        fromIndex: from,
        timeoutMs: Number(args.timeout),
      });
      const records = core.records.slice(from);
      const tools = records.filter((x) => x.type === "tool_execution_end");
      const finalMessage = records
        .filter((x) => x.type === "message_end" && x.message?.role === "assistant")
        .at(-1)?.message;
      if (finalMessage?.errorMessage && isQuotaExhausted(finalMessage.errorMessage)) {
        quotaSkipped++;
        console.warn(
          `⚠ ${label} ${model}：上游额度暂时用尽，跳过（${finalMessage.errorMessage.slice(0, 200)}）`,
        );
        continue;
      }
      if (finalMessage?.errorMessage)
        throw new Error(`模型报错：${finalMessage.errorMessage.slice(0, 300)}`);
      if (
        !tools.some((t) => t.toolName === "read" && !t.isError && textOf(t.result).includes(secret))
      ) {
        throw new Error(
          `没有成功读取并返回口令的 read 工具调用：${JSON.stringify(tools.map((t) => [t.toolName, t.isError]))}`,
        );
      }
      const answer = textOf(finalMessage);
      if (!answer?.includes(secret))
        throw new Error(`回复未包含口令 ${secret}：${JSON.stringify(answer)}`);
      passed++;
      console.log(`✓ ${label} ${model}：调用 read 并复述口令（${Date.now() - started} ms）`);
    } catch (err) {
      failed++;
      console.error(`✗ ${label} ${model}：${err.message}\n--- Core stderr ---\n${core.stderr}`);
    } finally {
      await core.stop();
    }
  }
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
// 额度用尽只算跳过；但至少要有一个模型真正跑通，全部跳过视为失败
if (quotaSkipped) console.warn(`⚠ ${quotaSkipped} 个模型因上游额度用尽跳过`);
if (!failed && !passed) console.error("✗ 没有任何模型完成冒烟");
process.exit(failed || !passed ? 1 : 0);
