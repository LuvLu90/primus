// WebdriverIO + tauri-driver 端到端配置（技术方案第 18 章）。
// 只在 Windows 上运行：tauri-driver 包装 msedgedriver 驱动 WebView2。
// 先 `pnpm build` 产出 release 版 Primus.exe，再 `pnpm test:e2e`。
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { terminateStartedProcess } from "./process-lifecycle.ts";
import { e2eAppArgs, e2eDataRoot, sidFromWhoami } from "./webview-data.ts";

declare global {
  namespace WebdriverIO {
    interface Capabilities {
      /** tauri-driver 的扩展能力：要启动的 Tauri 程序路径 */
      "tauri:options"?: {
        application: string;
        args?: string[];
        webviewOptions?: { userDataFolder: string };
      };
    }
  }
}

const here = dirname(fileURLToPath(import.meta.url));
const DRIVER_HOST = "127.0.0.1";
const DRIVER_PORT = 4444;

/** 被测程序：默认 release 构建产物，可用 PRIMUS_E2E_APP 覆盖。 */
const application = resolve(
  process.env.PRIMUS_E2E_APP ?? join(here, "../apps/desktop/src-tauri/target/release/Primus.exe"),
);
const dataRoot = e2eDataRoot(application, resolve(here, ".."));
const appArgs = e2eAppArgs(dataRoot);

// release 应用固定使用此目录；让驱动在同一目录查找 DevToolsActivePort，不能依赖其 scoped_dir 覆盖。
// 覆盖被拒绝的行为由安装矩阵中的标准用户启动检查覆盖。
function webviewOptions(): { userDataFolder: string } | undefined {
  if (process.platform !== "win32") return undefined;
  const output = execFileSync("whoami.exe", ["/user", "/fo", "csv", "/nh"], { encoding: "utf8" });
  const sid = sidFromWhoami(output);
  return { userDataFolder: join(dataRoot, "users", sid, "webview") };
}
const webview = webviewOptions();

/** 先由 App 生产路径建好 users/SID 的受保护 ACL，避免驱动提前创建继承 ACL 的用户目录。 */
async function prepareAppData(): Promise<void> {
  if (!webview) return;
  const ready = join(dirname(webview.userDataFolder), "tmp");
  if (existsSync(ready) && existsSync(webview.userDataFolder)) return;
  const child = spawn(application, appArgs, { windowsHide: true, stdio: "ignore" });
  let error: Error | undefined;
  child.once("error", (e) => {
    error = e;
  });
  const deadline = Date.now() + 30_000;
  try {
    while (!existsSync(ready) || !existsSync(webview.userDataFolder)) {
      if (error) throw error;
      if (child.exitCode !== null || Date.now() >= deadline)
        throw new Error("App 未完成 E2E 数据目录准备");
      await new Promise((r) => setTimeout(r, 100));
    }
  } finally {
    await terminateStartedProcess(child, (pid) => {
      execFileSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
        timeout: 10_000,
      });
    });
  }
}

const tauriDriverBin = join(
  homedir(),
  ".cargo",
  "bin",
  process.platform === "win32" ? "tauri-driver.exe" : "tauri-driver",
);

let tauriDriver: ChildProcess | undefined;

function stopTauriDriver(): void {
  if (tauriDriver && tauriDriver.exitCode === null) {
    tauriDriver.kill();
  }
  tauriDriver = undefined;
}

/** 轮询直到 tauri-driver 在端口上接受连接。 */
async function waitForPort(host: string, port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((done) => {
      const socket = createConnection({ host, port });
      socket.once("connect", () => {
        socket.end();
        done(true);
      });
      socket.once("error", () => {
        socket.destroy();
        done(false);
      });
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`tauri-driver 未在 ${timeoutMs}ms 内监听 ${host}:${port}`);
}

export const config: WebdriverIO.Config = {
  runner: "local",
  hostname: DRIVER_HOST,
  port: DRIVER_PORT,
  specs: ["./specs/**/*.e2e.ts"],
  maxInstances: 1,
  capabilities: [
    {
      "tauri:options": { application, args: appArgs, webviewOptions: webview },
    },
  ],
  logLevel: "warn",
  framework: "mocha",
  reporters: ["spec"],
  mochaOpts: { ui: "bdd", timeout: 60_000 },

  onPrepare() {
    if (!existsSync(application)) {
      throw new Error(`找不到被测程序 ${application}：先运行 pnpm build，或用 PRIMUS_E2E_APP 指定`);
    }
  },

  async beforeSession() {
    await prepareAppData();
    const args: string[] = [];
    const nativeDriver = process.env.PRIMUS_NATIVE_DRIVER;
    if (nativeDriver) args.push("--native-driver", nativeDriver);
    tauriDriver = spawn(tauriDriverBin, args, { stdio: [null, process.stdout, process.stderr] });
    tauriDriver.once("error", (error) => {
      console.error("tauri-driver 启动失败：", error);
      process.exit(1);
    });
    await waitForPort(DRIVER_HOST, DRIVER_PORT, 30_000);
  },

  afterSession() {
    stopTauriDriver();
  },
};

// 测试进程异常退出时也结束 tauri-driver，避免残留进程占用端口
for (const signal of ["exit", "SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.once(signal, () => {
    stopTauriDriver();
    if (signal !== "exit") process.exit(130);
  });
}
