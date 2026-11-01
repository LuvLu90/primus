// 安装矩阵：对安装后的 Primus.exe 完成一次含工具调用的真实对话（开发计划第 4 周 P0 安装测试）。
// 只在安装矩阵中运行：需要 PRIMUS_E2E_APP（安装目录中的 Primus.exe）与 PRIMUS_E2E_FAUX_URL
// （scripts/install-matrix/faux-serve.mjs 的地址）；缺少任一项时整组跳过，普通端到端冒烟不受影响。
// 模型配置写进 <安装目录>\data\users\<SID>\core\models.json（薄壳的 core_config 尚未实现，
// 账号服务下发也未做），Core 在首次发送时才拉起，所以先启动 App、再写配置、再发送。
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { $, $$, browser, expect } from "@wdio/globals";
import { strings } from "../../apps/desktop/src/lib/strings.ts";

const MATRIX_REPLY = "PRIMUS-MATRIX-OK";
const MATRIX_TOOL_PATH = "primus-matrix.txt";
const app = process.env.PRIMUS_E2E_APP;
const fauxUrl = process.env.PRIMUS_E2E_FAUX_URL;

/** 指向 Faux 模型服务的 models.json（与 scripts/core-contract/faux-model.mjs 的 fauxModelsJson 相同） */
function fauxModelsJson(baseUrl: string) {
  return {
    providers: {
      faux: {
        name: "Faux",
        baseUrl,
        api: "anthropic-messages",
        apiKey: "faux-contract-key",
        models: [
          {
            id: "faux-1",
            name: "Faux 1",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 32_000,
            maxTokens: 1_024,
          },
        ],
      },
    },
  };
}

/** 当前 Windows 用户的 SID（薄壳按它分 data\users\<SID>，第 4.3 节） */
function currentSid(): string {
  const out = execFileSync("whoami", ["/user", "/fo", "csv", "/nh"], { encoding: "utf8" });
  const sid = out.trim().split(",").at(-1)?.replaceAll('"', "");
  if (!sid?.startsWith("S-1-")) throw new Error(`无法解析 whoami 输出的 SID：${out}`);
  return sid;
}

/** 在会话记录的一行中找出 read 工具的结果（带 toolName 与 isError 的对象） */
function findReadResults(value: unknown): { isError: unknown }[] {
  if (Array.isArray(value)) return value.flatMap(findReadResults);
  if (!value || typeof value !== "object") return [];
  const obj = value as Record<string, unknown>;
  const own = obj.toolName === "read" && "isError" in obj ? [{ isError: obj.isError }] : [];
  return [...own, ...Object.values(obj).flatMap(findReadResults)];
}

describe("对话（安装矩阵）", () => {
  let coreDir = "";

  before(function () {
    if (!app || !fauxUrl) this.skip();
    coreDir = join(dirname(app), "data", "users", currentSid(), "core");
  });

  it("App 启动后在 <安装目录>\\data\\users\\<SID> 下建好 Core 目录", async () => {
    await browser.waitUntil(() => existsSync(coreDir), {
      timeout: 30_000,
      timeoutMsg: `未出现 ${coreDir}`,
    });
    writeFileSync(
      join(coreDir, "models.json"),
      JSON.stringify(fauxModelsJson(fauxUrl ?? ""), null, 2),
    );
    // 对话的工作目录是 users\<SID>\chat（sessions.rs 的 DEFAULT_WORKSPACE_DIR）：放好 read 要读的文件
    const chatDir = join(dirname(coreDir), "chat");
    mkdirSync(chatDir, { recursive: true });
    writeFileSync(join(chatDir, MATRIX_TOOL_PATH), "矩阵测试文件\n", "utf8");
  });

  it("发送消息后收到含 read 工具调用的回复", async () => {
    const input = $(`textarea[aria-label="${strings.chat.inputLabel}"]`);
    await input.waitForDisplayed({ timeout: 30_000 });
    await input.setValue(`读取 ${MATRIX_TOOL_PATH} 后回复`);
    await $(`button[aria-label="${strings.chat.send}"]`).click();
    await browser.waitUntil(
      async () => {
        const articles = await $$(`article[aria-label="${strings.chat.assistant}"]`);
        for (const article of articles) {
          if ((await article.getText()).includes(MATRIX_REPLY)) return true;
        }
        return false;
      },
      { timeout: 90_000, interval: 500, timeoutMsg: `90 秒内未出现包含 ${MATRIX_REPLY} 的回复` },
    );
  });

  it("会话文件写在 <安装目录>\\data 下", async () => {
    const sessions = join(coreDir, "sessions");
    await browser.waitUntil(
      () =>
        existsSync(sessions) &&
        readdirSync(sessions, { recursive: true }).some((f) => String(f).endsWith(".jsonl")),
      { timeout: 15_000, timeoutMsg: `${sessions} 下没有会话文件` },
    );
    // read 工具确实读到了文件：会话中 read 的工具结果 isError 为 false
    const results = readdirSync(sessions, { recursive: true })
      .filter((f) => String(f).endsWith(".jsonl"))
      .flatMap((f) => readFileSync(join(sessions, String(f)), "utf8").split("\n"))
      .filter((line) => line.trim())
      .flatMap((line) => findReadResults(JSON.parse(line)));
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.isError === false)).toBe(true);
    await expect($(`main[aria-label="${strings.layout.timeline}"]`)).toBeExisting();
  });
});
