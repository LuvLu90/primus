// 安装矩阵：对安装后的 Primus.exe 完成一次含工具调用的真实对话（开发计划第 4 周 P0 安装测试）。
// 只在安装矩阵中运行：需要 PRIMUS_E2E_APP（安装目录中的 Primus.exe）与 PRIMUS_E2E_FAUX_URL
// （scripts/install-matrix/faux-serve.mjs 的地址）；缺少任一项时整组跳过，普通端到端冒烟不受影响。
// 模型走用户真实的配置路径（ADR 0008）：在设置·模型·模型渠道里添加指向 Faux 服务的渠道（anthropic-messages），
// 点“获取模型”由薄壳请求 Faux 的 GET /v1/models，保存后薄壳把密钥存进保险库并生成 Core 的 models.json；
// 回到对话在模型选择器里选中 Faux 模型（内置渠道可能已拿到模型并成为默认），再发送。
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { $, $$, browser, expect } from "@wdio/globals";
import { strings } from "../../apps/desktop/src/lib/strings.ts";

const MATRIX_REPLY = "PRIMUS-MATRIX-OK";
const MATRIX_TOOL_PATH = "primus-matrix.txt";
/** Faux 服务 GET /v1/models 返回的模型（scripts/install-matrix/faux-serve.mjs 的 modelsResponse） */
const FAUX_MODEL_ID = "faux-1";
const FAUX_MODEL_NAME = "Faux 1";
/** 渠道名称与密钥：密钥只是 Faux 服务要求非空的占位值，不是真实密钥 */
const PROVIDER_NAME = "Faux";
const PROVIDER_KEY = "faux-e2e-key";
const app = process.env.PRIMUS_E2E_APP;
const fauxUrl = process.env.PRIMUS_E2E_FAUX_URL;

const tp = strings.settings.providers;
const fill = (template: string, values: Record<string, string | number>) =>
  template.replace(/\{(\w+)\}/g, (_, k: string) => String(values[k] ?? ""));
/** XPath 字符串字面量（文案不含双引号） */
const xq = (text: string) => `"${text}"`;
/** 按可见文字找按钮 */
const buttonByText = (text: string, scope = "") =>
  $(`${scope}//button[normalize-space(.)=${xq(text)}]`);
const DIALOG = '//*[@role="dialog"]';
/** 对话框中按标签文字找输入控件 */
const dialogField = (label: string, tag = "input") =>
  $(`${DIALOG}//label[normalize-space(.)=${xq(label)}]/following-sibling::${tag}`);

/** 当前 Windows 用户的 SID（薄壳按它分 data\users\<SID>，第 4.3 节） */
function currentSid(): string {
  const out = execFileSync("whoami", ["/user", "/fo", "csv", "/nh"], { encoding: "utf8" });
  const sid = out.trim().split(",").at(-1)?.replaceAll('"', "");
  if (!sid?.startsWith("S-1-")) throw new Error(`无法解析 whoami 输出的 SID：${out}`);
  return sid;
}

/** 在会话记录的一行中找出 read 工具的结果（带 toolName 与 isError 的对象） */
function findReadResults(value: unknown): { isError: unknown; text: string }[] {
  if (Array.isArray(value)) return value.flatMap(findReadResults);
  if (!value || typeof value !== "object") return [];
  const obj = value as Record<string, unknown>;
  // text：工具结果的全部内容序列化后的文本，用来确认读到的是测试写入的文件
  const own =
    obj.toolName === "read" && "isError" in obj
      ? [{ isError: obj.isError, text: JSON.stringify(obj.content ?? obj) }]
      : [];
  return [...own, ...Object.values(obj).flatMap(findReadResults)];
}

/** 会话目录下每个 .jsonl 的字节长度（相对路径 → 长度），目录不存在时为空 */
function sessionSizes(sessions: string): Map<string, number> {
  if (!existsSync(sessions)) return new Map();
  return new Map(
    readdirSync(sessions, { recursive: true })
      .map(String)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => [f, statSync(join(sessions, f)).size]),
  );
}

describe("对话（安装矩阵）", () => {
  let coreDir = "";
  // 发送前已有的会话内容（-KeepData 重跑时会保留旧会话，也可能恢复旧会话并在原文件末尾追加）：
  // 断言只看此后新增的行，新文件从 0 字节读起
  let sizesBeforeSend = new Map<string, number>();

  before(function () {
    if (!app || !fauxUrl) this.skip();
    coreDir = join(dirname(app), "data", "users", currentSid(), "core");
  });

  it("App 启动后在 <安装目录>\\data\\users\\<SID> 下建好 Core 目录", async () => {
    await browser.waitUntil(() => existsSync(coreDir), {
      timeout: 30_000,
      timeoutMsg: `未出现 ${coreDir}`,
    });
    // 对话的工作目录是 users\<SID>\chat（sessions.rs 的 DEFAULT_WORKSPACE_DIR）：放好 read 要读的文件
    const chatDir = join(dirname(coreDir), "chat");
    mkdirSync(chatDir, { recursive: true });
    writeFileSync(join(chatDir, MATRIX_TOOL_PATH), "矩阵测试文件\n", "utf8");
  });

  it("在设置·模型渠道中添加 Faux 渠道并获取模型", async function () {
    // 多步界面操作（各步等待之和可能超过 mocha 默认的 60 秒）
    this.timeout(150_000);
    // 侧栏设置菜单 → 设置 → 模型
    const settingsButton = $(`button[aria-label="${strings.layout.settings}"]`);
    await settingsButton.waitForClickable({ timeout: 30_000 });
    await settingsButton.click();
    const menuItem = $(
      `//*[@role="menuitem"][normalize-space(.)=${xq(strings.layout.menuSettings)}]`,
    );
    await menuItem.waitForClickable({ timeout: 10_000 });
    await menuItem.click();
    const groups = `//nav[@aria-label=${xq(strings.settings.title)}]`;
    const modelsGroup = buttonByText(strings.settings.groups.models, groups);
    await modelsGroup.waitForClickable({ timeout: 30_000 });
    await modelsGroup.click();
    const addButton = buttonByText(tp.add);
    await addButton.waitForClickable({ timeout: 30_000 });

    // -KeepData 重跑时上次的 Faux 渠道还在（地址是上次的端口）：先删掉，再按本次地址添加
    const stale = $(`button[aria-label="${fill(tp.deleteLabel, { name: PROVIDER_NAME })}"]`);
    if (await stale.isExisting()) {
      await stale.click();
      const confirm = buttonByText(tp.deleteConfirm, DIALOG);
      await confirm.waitForClickable({ timeout: 10_000 });
      await confirm.click();
      await stale.waitForExist({ reverse: true, timeout: 15_000 });
    }

    await addButton.click();
    const name = dialogField(tp.dialog.name);
    await name.waitForDisplayed({ timeout: 10_000 });
    await name.setValue(PROVIDER_NAME);
    await dialogField(tp.dialog.api, "select").selectByAttribute("value", "anthropic-messages");
    await dialogField(tp.dialog.baseUrl).setValue(fauxUrl ?? "");
    await dialogField(tp.dialog.apiKey).setValue(PROVIDER_KEY);

    // 获取模型：薄壳请求 {baseUrl}/v1/models；新渠道获取到的模型默认全部勾选
    await buttonByText(tp.dialog.fetch, DIALOG).click();
    const modelBox = $(`${DIALOG}//input[@type="checkbox"][@aria-label=${xq(FAUX_MODEL_NAME)}]`);
    await modelBox.waitForExist({
      timeout: 30_000,
      timeoutMsg: `获取模型后没有出现 ${FAUX_MODEL_NAME}`,
    });
    await expect($(`${DIALOG}//*[@role="alert"]`)).not.toBeExisting();
    await expect(modelBox).toBeSelected();

    await buttonByText(tp.dialog.save, DIALOG).click();
    await $(DIALOG).waitForExist({
      reverse: true,
      timeout: 15_000,
      timeoutMsg: "保存渠道后对话框未关闭",
    });
    await expect(
      $(`button[aria-label="${fill(tp.editLabel, { name: PROVIDER_NAME })}"]`),
    ).toBeExisting();

    // 薄壳生成的 models.json：Faux 渠道指向本次地址，密钥只以取密钥命令出现，不落明文
    const modelsFile = join(coreDir, "models.json");
    await browser.waitUntil(
      () =>
        existsSync(modelsFile) &&
        Object.values(
          (JSON.parse(readFileSync(modelsFile, "utf8")).providers ?? {}) as Record<
            string,
            { baseUrl?: string }
          >,
        ).some((p) => p.baseUrl === fauxUrl),
      { timeout: 15_000, timeoutMsg: `${modelsFile} 中没有指向 ${fauxUrl} 的渠道` },
    );
    const text = readFileSync(modelsFile, "utf8");
    expect(text.includes(PROVIDER_KEY)).toBe(false);
    const faux = Object.values(
      JSON.parse(text).providers as Record<
        string,
        { baseUrl: string; api: string; apiKey: string; models: { id: string }[] }
      >,
    ).find((p) => p.baseUrl === fauxUrl);
    expect(faux?.api).toBe("anthropic-messages");
    expect(faux?.apiKey).toMatch(/ --secret provider:[a-z0-9:-]+$/);
    expect(faux?.models.map((m) => m.id)).toEqual([FAUX_MODEL_ID]);

    await $(`button[aria-label="${strings.settings.back}"]`).click();
  });

  it("在模型选择器中选中 Faux 模型", async () => {
    const trigger = $(`button[aria-label^="${strings.chat.model.label}："]`);
    await trigger.waitForClickable({ timeout: 30_000 });
    await trigger.click();
    const item = $(
      `//*[@role="menuitemradio"][.//span[normalize-space(.)=${xq(FAUX_MODEL_NAME)}]]`,
    );
    await item.waitForClickable({ timeout: 10_000 });
    await item.click();
    await browser.waitUntil(
      async () => (await trigger.getAttribute("aria-label"))?.includes(FAUX_MODEL_NAME) ?? false,
      { timeout: 10_000, timeoutMsg: `模型选择器没有切换到 ${FAUX_MODEL_NAME}` },
    );
  });

  it("发送消息后收到含 read 工具调用的回复", async () => {
    const input = $(`textarea[aria-label="${strings.chat.inputLabel}"]`);
    await input.waitForDisplayed({ timeout: 30_000 });
    await input.setValue(`读取 ${MATRIX_TOOL_PATH} 后回复`);
    sizesBeforeSend = sessionSizes(join(coreDir, "sessions"));
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
    // 只取本次发送后新增的行
    const newLines = () =>
      [...sessionSizes(sessions)].flatMap(([f, size]) => {
        const from = sizesBeforeSend.get(f) ?? 0;
        if (size <= from) return [];
        return readFileSync(join(sessions, f))
          .subarray(from)
          .toString("utf8")
          .split("\n")
          .filter((line) => line.trim());
      });
    const readResults = () => newLines().flatMap((line) => findReadResults(JSON.parse(line)));
    // 等到 read 工具结果落盘：会话行逐条写入，先写入的可能是用户消息行，只等“有新行”会过早断言
    await browser.waitUntil(() => readResults().length > 0, {
      timeout: 15_000,
      timeoutMsg: `${sessions} 下没有本次对话写入的 read 工具结果`,
    });
    // read 工具确实读到了文件：本次新增的 read 工具结果 isError 为 false
    const results = readResults();
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.isError === false)).toBe(true);
    // faux 模型对任何工具结果都回复 MATRIX_REPLY，所以还要确认 read 读到的是测试写入的内容
    expect(results.some((r) => r.text.includes("矩阵测试文件"))).toBe(true);
    await expect($(`main[aria-label="${strings.layout.timeline}"]`)).toBeExisting();
  });
});
