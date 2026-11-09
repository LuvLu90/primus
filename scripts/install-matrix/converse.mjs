#!/usr/bin/env node
// 安装矩阵：以薄壳的方式拉起安装目录中的 Core，完成一次含工具调用的对话（技术方案第 4.4、5.3 节）。
// 由标准用户用安装目录里的 node.exe 运行（std-user.ps1），验证该用户的 Core 配置、会话、临时文件都落在
// <安装目录>\data\users\<SID>\ 下，且 Core 能正常调用模型与工具。
//
//   node converse.mjs --install-dir <安装目录> --user-dir <data\users\<SID>> --faux-url <url> --out <结果 JSON>
//
// Core 配置对照薄壳的生成逻辑（core_config.rs，ADR 0008）：模型清单与能力取自 Faux 服务的 GET /v1/models
// （与设置里“获取模型”同一个接口），models.json 的渠道形状与薄壳生成的一致，默认模型写进 settings.json 且保留
// 其他设置项（App 启动时写入的 defaultTools、内置渠道成为默认等）。唯一不同是密钥：薄壳写的是
// `!"<Primus.exe>" --secret provider:<渠道 ID>`，而 `--secret` 只在 App 的 Core 作业对象内可用，
// 本脚本直接拉起 Core 不在该作业内，所以写成 Core 配置的字面量（Faux 服务的占位密钥，不是真实密钥）。
//
// 环境变量与参数对照 supervisor.rs 的 core_command：PRIMUS_CODING_AGENT_DIR=core、SESSION_DIR=core\sessions、
// TEMP/TMP=tmp、PRIMUS_SKIP_VERSION_CHECK=1、PRIMUS_TELEMETRY=0、清空 NODE_OPTIONS；参数 --no-approve -e primus-bundle.js。
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { CoreProcess } from "../core-contract/core-process.mjs";
import { FAUX_API_KEY } from "../core-contract/faux-model.mjs";
import { MATRIX_REPLY, MATRIX_TOOL_PATH } from "./faux-serve.mjs";

const { values: args } = parseArgs({
  options: {
    "install-dir": { type: "string" },
    "user-dir": { type: "string" },
    "faux-url": { type: "string" },
    out: { type: "string" },
  },
});
for (const k of ["install-dir", "user-dir", "faux-url", "out"]) {
  if (!args[k]) {
    console.error(`缺少 --${k}`);
    process.exit(2);
  }
}

const result = { ok: false, checks: [], error: null };
function check(ok, message) {
  result.checks.push({ ok: Boolean(ok), message });
  console.log(`${ok ? "✓" : "✗"} ${message}`);
  if (!ok) throw new Error(message);
}

const installDir = args["install-dir"];
const userDir = args["user-dir"];
const coreDir = join(userDir, "core");
const sessionsDir = join(coreDir, "sessions");
const tmpDir = join(userDir, "tmp");
const chatDir = join(userDir, "chat");
const entry = join(installDir, "resources", "agent-core", "rpc-entry.js");
const extension = join(installDir, "resources", "agent-core", "extensions", "primus-bundle.js");

/** 与薄壳由名称生成的渠道 ID 一致（providers.rs generate_id("Faux")） */
const PROVIDER_ID = "faux";

/** 像设置里的“获取模型”一样读取 Faux 服务的模型列表（anthropic-messages：{baseUrl}/v1/models + x-api-key） */
async function fetchModels(baseUrl) {
  const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/v1/models`, {
    headers: { "x-api-key": FAUX_API_KEY, "anthropic-version": "2023-06-01" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`获取模型列表失败（HTTP ${res.status}）`);
  const body = await res.json();
  return (body.data ?? [])
    .filter((m) => typeof m?.id === "string" && m.id)
    .map((m) => ({
      id: m.id,
      name: m.display_name || m.name || m.id,
      reasoning: false,
      input: ["text"],
      contextWindow: m.context_window ?? 128_000,
      maxTokens: m.max_output_tokens ?? 32_000,
    }));
}

/** 与 core_config.rs models_json 相同的形状：供应商键 = 渠道 ID */
function modelsJsonFor(baseUrl, models) {
  return {
    providers: {
      [PROVIDER_ID]: {
        name: "Faux",
        baseUrl,
        api: "anthropic-messages",
        apiKey: FAUX_API_KEY,
        models,
      },
    },
  };
}

/** 把默认模型写进 settings.json，保留其他设置项（core_config.rs set_default） */
function setDefaultModel(dir, modelId) {
  const file = join(dir, "settings.json");
  let settings = {};
  if (existsSync(file)) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch (e) {
      throw new Error(`无法解析 ${file}：${e instanceof Error ? e.message : e}`);
    }
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) settings = parsed;
  }
  settings.defaultProvider = PROVIDER_ID;
  settings.defaultModel = modelId;
  writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  return settings;
}

let core;
try {
  for (const dir of [coreDir, sessionsDir, tmpDir, chatDir]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(chatDir, MATRIX_TOOL_PATH), "矩阵测试文件\n", "utf8");
  const models = await fetchModels(args["faux-url"]);
  check(models.length > 0, `从 Faux 服务获取到模型（${models.map((m) => m.id).join("、")}）`);
  writeFileSync(
    join(coreDir, "models.json"),
    `${JSON.stringify(modelsJsonFor(args["faux-url"], models), null, 2)}\n`,
  );
  const settings = setDefaultModel(coreDir, models[0].id);
  const kept = Object.keys(settings).filter((k) => k !== "defaultProvider" && k !== "defaultModel");
  check(
    true,
    `models.json 与默认模型已写入 ${coreDir}（保留的设置项：${kept.join("、") || "无"}）`,
  );

  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  Object.assign(env, {
    PRIMUS_CODING_AGENT_DIR: coreDir,
    PRIMUS_CODING_AGENT_SESSION_DIR: sessionsDir,
    TEMP: tmpDir,
    TMP: tmpDir,
    PRIMUS_SKIP_VERSION_CHECK: "1",
    PRIMUS_TELEMETRY: "0",
    PRIMUS_OFFLINE: "1",
    NO_PROXY: "127.0.0.1,localhost",
    no_proxy: "127.0.0.1,localhost",
  });
  core = new CoreProcess({
    nodeExe: process.execPath,
    entry,
    args: ["--no-approve", "-e", extension],
    cwd: chatDir,
    env,
  });

  const state = await core.request({ type: "get_state" }, { timeoutMs: 60_000 });
  const current = state.data?.model;
  check(
    state.success === true && current?.provider === PROVIDER_ID && current?.id === models[0].id,
    `Core 当前模型为 ${PROVIDER_ID}/${models[0].id}（${current ? `${current.provider}/${current.id}` : "无"}）`,
  );

  const from = core.records.length;
  const r = await core.request(
    { type: "prompt", message: `读取 ${MATRIX_TOOL_PATH} 后回复` },
    { timeoutMs: 60_000 },
  );
  check(r.success === true, `prompt 被受理（${JSON.stringify(r.data ?? r.error ?? null)}）`);
  const settled = await core.waitFor((x) => x.type === "agent_settled", {
    label: "agent_settled",
    fromIndex: from,
    timeoutMs: 120_000,
  });
  check(settled.aborted === false, "本轮正常结束（agent_settled.aborted=false）");
  const toolEnd = core.records
    .slice(from)
    .find((x) => x.type === "tool_execution_end" && x.toolName === "read");
  check(toolEnd && toolEnd.isError === false, "read 工具调用成功");
  const texts = core.records
    .slice(from)
    .filter((x) => x.type === "message_end" && x.message?.role === "assistant")
    .flatMap((x) => (x.message.content ?? []).filter((b) => b.type === "text").map((b) => b.text));
  check(
    texts.some((t) => t.includes(MATRIX_REPLY)),
    "收到模型的最终回复",
  );

  const code = await core.stop();
  core = undefined;
  check(code === 0, `关闭 stdin 后 Core 以 0 退出（${code}）`);

  const sessions = readdirSync(sessionsDir, { recursive: true }).filter((f) =>
    String(f).endsWith(".jsonl"),
  );
  check(sessions.length > 0, `会话文件写在 ${sessionsDir}（${sessions.length} 个）`);
  const home = process.env.USERPROFILE ?? "";
  check(!home || !existsSync(join(home, ".primus")), `用户主目录下没有 .primus（${home}）`);
  result.ok = true;
} catch (err) {
  result.error = err.message;
  if (core) result.stderr = core.stderr.slice(-4000);
} finally {
  await core?.stop();
  writeFileSync(args.out, JSON.stringify(result, null, 2), "utf8");
}
process.exit(result.ok ? 0 : 1);
