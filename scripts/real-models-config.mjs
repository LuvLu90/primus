import { execSync } from "node:child_process";
import { resolve } from "node:path";
import { coreEnv } from "./core-target.mjs";

const ALLOWED_APIS = new Set(["openai-responses", "anthropic-messages"]);
const ENV_REF = /^\$([A-Za-z_][A-Za-z0-9_]*)$/;
const COMMAND_KEY_ENV = "PRIMUS_REAL_MODELS_API_KEY";
// Core 需要进程启动、网络访问与显式密钥引用所需的变量；其余变量不传给子进程。
const INHERITED_ENV = new Set([
  "PATH",
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "COMSPEC",
  "PATHEXT",
  "WINDIR",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "NODE_EXTRA_CA_CERTS",
]);

/** 校验供应商级协议以及每个模型的协议；模型未设置 api 时继承供应商级 api。 */
export function hasOnlyAllowedApis(provider) {
  const apis = (provider.models ?? []).map((model) => model.api ?? provider.api);
  if (provider.api !== undefined) apis.push(provider.api);
  return apis.length > 0 && apis.every((api) => ALLOWED_APIS.has(api));
}

/**
 * 冒烟只用 models 的第一个模型，它必须带非空字符串 id，否则 Core 会收到 --model undefined；
 * id 会作为命令行参数传给 spawn，含 NUL 字符时 spawn 会直接抛错。
 */
export function hasModelId(provider) {
  const id = provider.models?.[0]?.id;
  return typeof id === "string" && id.length > 0 && !id.includes("\u0000");
}

/** apiKey 只允许设在供应商级：模型级字段会随整个供应商原样写入临时 models.json。 */
export function hasModelLevelApiKey(provider) {
  return (provider.models ?? []).some((model) => model.apiKey !== undefined);
}

function executeKeyCommand(command, env) {
  return execSync(command, {
    encoding: "utf8",
    env,
    timeout: 10_000,
    maxBuffer: 64 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
  });
}

/**
 * 将密钥配置转换为可写入临时 models.json 的环境变量引用。
 * 取密钥命令在父进程以完整环境执行，命令原文与命令输出都不会写入临时配置。
 */
export function resolveApiKey(apiKey, { env = process.env, execute = executeKeyCommand } = {}) {
  if (typeof apiKey !== "string" || !apiKey) {
    throw new Error('缺少 apiKey（应为 "$环境变量名" 或 "!取密钥命令"）');
  }
  if (apiKey.startsWith("!")) {
    const command = apiKey.slice(1);
    if (!command.trim()) throw new Error("取密钥命令不能为空");
    let key;
    try {
      key = execute(command, env).trim();
    } catch {
      throw new Error("取密钥命令执行失败");
    }
    if (!key) throw new Error("取密钥命令没有返回密钥");
    return { config: `$${COMMAND_KEY_ENV}`, extraEnv: { [COMMAND_KEY_ENV]: key } };
  }
  const match = ENV_REF.exec(apiKey);
  if (!match) throw new Error('apiKey 必须是 "$环境变量名" 或 "!取密钥命令"，不接受明文 key');
  if (!env[match[1]]) throw new Error(`环境变量 ${match[1]} 未设置`);
  return { config: apiKey, extraEnv: {} };
}

/** 构造 Core 的最小环境，并保留代理、自定义 CA 和本次解析出的密钥变量。 */
export function smokeEnv({ home, coreDir, tmpDir, apiKey, extraEnv = {}, env = process.env }) {
  const keyEnv = ENV_REF.exec(apiKey)?.[1];
  const allowed = new Set(INHERITED_ENV);
  if (keyEnv) allowed.add(keyEnv.toUpperCase());
  const inherited = Object.fromEntries(
    Object.entries(env).filter(([name]) => allowed.has(name.toUpperCase())),
  );
  // Core 在沙箱工作目录启动，相对路径的自定义 CA 要先按当前目录解析成绝对路径；
  // Windows 环境变量名不区分大小写，与上面的过滤规则一致，按大小写不敏感匹配。
  for (const name of Object.keys(inherited)) {
    if (name.toUpperCase() === "NODE_EXTRA_CA_CERTS" && inherited[name]) {
      inherited[name] = resolve(inherited[name]);
    }
  }
  return {
    ...coreEnv({ home, coreDir, env: inherited }),
    ...extraEnv,
    TEMP: tmpDir,
    TMP: tmpDir,
  };
}

/**
 * 上游额度暂时用尽（HTTP 429 且带 model_cooldown / RESOURCE_EXHAUSTED / quota 字样）不是配置或代码问题，
 * 冒烟把它记为跳过而不是失败；其他 429（如鉴权网关限流但没有额度字样）仍算失败。
 */
export function isQuotaExhausted(errorMessage) {
  if (typeof errorMessage !== "string" || !/\b429\b/.test(errorMessage)) return false;
  return /model_cooldown|RESOURCE_EXHAUSTED|exhausted your capacity|quota/i.test(errorMessage);
}
