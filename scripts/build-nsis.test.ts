import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error 纯 JS 脚本，无类型声明
import { archInfo } from "./build-msi.mjs";
// @ts-expect-error 纯 JS 脚本，无类型声明
import {
  NSIS_PRODUCT_NAME,
  nsisBundleConfig,
  nsisFileName,
  pickNsisOutput,
} from "./build-nsis.mjs";

const SCRIPT = fileURLToPath(new URL("./build-nsis.mjs", import.meta.url));
const HOST_ARCH = process.arch === "arm64" ? "arm64" : "x64";
const tauriFile = (path: string) => new URL(`../apps/desktop/src-tauri/${path}`, import.meta.url);

describe("build-nsis", () => {
  it("交付物文件名", () => {
    expect(nsisFileName("0.0.1")).toBe("Primus_0.0.1_x64-setup.exe");
    expect(nsisFileName("0.0.1", "arm64")).toBe("Primus_0.0.1_arm64-setup.exe");
    expect(() => nsisFileName("0.0.1", "x86")).toThrow("不支持的架构");
  });

  it("打包时的临时配置：产品名与 MSI 一致，resources 与 MSI 安装布局一致", () => {
    expect(NSIS_PRODUCT_NAME).toBe("乾元 Primus");
    const wxs = readFileSync(tauriFile("windows/Primus.wxs"), "utf8");
    expect(wxs).toContain(
      `<Package Name="${NSIS_PRODUCT_NAME}" Manufacturer="${NSIS_PRODUCT_NAME}"`,
    );
    expect(
      nsisBundleConfig({ runtimeDir: "C:/r/dist/runtime", coreDir: "C:/r/dist/agent-core" }),
    ).toEqual({
      productName: "乾元 Primus",
      bundle: {
        resources: {
          "C:/r/dist/runtime": "resources/runtime/",
          "C:/r/dist/agent-core": "resources/agent-core/",
        },
      },
    });
  });

  it("配置了证书时临时配置让 tauri bundle 用同一证书签名，配一半不签", () => {
    const dirs = { runtimeDir: "C:/r/dist/runtime", coreDir: "C:/r/dist/agent-core" };
    const signed = nsisBundleConfig(dirs, {
      PRIMUS_SIGN_CERT_SHA1: "ABCDEF",
      PRIMUS_SIGN_TIMESTAMP_URL: "http://ts.example",
    });
    expect(signed.bundle.windows).toEqual({
      certificateThumbprint: "ABCDEF",
      digestAlgorithm: "sha256",
      timestampUrl: "http://ts.example",
      tsp: true,
    });
    expect(signed.bundle.resources).toEqual(nsisBundleConfig(dirs).bundle.resources);
    expect(nsisBundleConfig(dirs, { PRIMUS_SIGN_CERT_SHA1: "ABCDEF" }).bundle).not.toHaveProperty(
      "windows",
    );
  });

  it("tauri.conf.json 的 NSIS 设置（第 3.4 节）", () => {
    const conf = JSON.parse(readFileSync(tauriFile("tauri.conf.json"), "utf8"));
    // tauri build 不打包（MSI 由 WiX 构建），NSIS 只经 tauri bundle 生成
    expect(conf.bundle.active).toBe(false);
    expect(conf.bundle.targets).toEqual(["nsis"]);
    // 发布者与 MSI 的 Manufacturer 一致：Tauri 的 NSIS 安装程序据显示名 + 发布者识别已装的 MSI 并提示先卸载
    expect(conf.bundle.publisher).toBe(NSIS_PRODUCT_NAME);
    expect(conf.bundle.licenseFile).toBe("windows/Privacy.rtf");
    // 按官方产品对外：安装界面与卸载信息里不出现代码仓库地址
    expect(conf.bundle.homepage).toBeUndefined();
    const policy = readFileSync(tauriFile(conf.bundle.licenseFile), "latin1");
    expect(policy.startsWith("{\\rtf1")).toBe(true);
    expect(policy).not.toMatch(/github|MIT|License/i);
    // resources 不写进 tauri.conf.json：tauri-build 编译时会检查它们存在，开发构建不应依赖 dist/
    expect(conf.bundle.resources).toBeUndefined();
    const nsis = conf.bundle.windows.nsis;
    expect(nsis.languages).toEqual(["SimpChinese"]);
    expect(nsis.displayLanguageSelector).toBe(false);
    expect(nsis.installMode).toBe("perMachine");
    // 与 MSI 同一套界面图片（Primus.wxs 的 WixUIBannerBmp / WixUIDialogBmp）
    for (const img of [nsis.headerImage, nsis.sidebarImage]) {
      expect(readFileSync(tauriFile(img)).subarray(0, 2).toString("latin1")).toBe("BM");
    }
    expect(conf.bundle.windows.webviewInstallMode).toEqual({
      type: "embedBootstrapper",
      silent: true,
    });
    const hooks = readFileSync(tauriFile(nsis.installerHooks));
    // UTF-8 BOM：makensis 才会按 UTF-8 读取中文
    expect([...hooks.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = hooks.toString("utf8");
    expect(text).toContain("!macro NSIS_HOOK_POSTINSTALL");
    // data 目录与 Primus.wxs 一致：Users 组（按 SID）“修改”并继承，不是完全控制
    expect(text).toContain("/grant *S-1-5-32-545:(OI)(CI)M");
    expect(text).not.toMatch(/:\(OI\)\(CI\)F/);
  });

  it("按文件名后缀挑出本次产物，架构不符或数量不对即失败", () => {
    expect(pickNsisOutput(["乾元 Primus_0.0.1_x64-setup.exe", "other.txt"], "0.0.1", "x64")).toBe(
      "乾元 Primus_0.0.1_x64-setup.exe",
    );
    expect(() => pickNsisOutput(["乾元 Primus_0.0.1_x64-setup.exe"], "0.0.1", "arm64")).toThrow(
      "恰有一个",
    );
    expect(() => pickNsisOutput([], "0.0.1", "x64")).toThrow("无");
    expect(() =>
      pickNsisOutput(["a_0.0.1_x64-setup.exe", "b_0.0.1_x64-setup.exe"], "0.0.1", "x64"),
    ).toThrow("实际 2 个");
  });

  it.skipIf(process.platform === "win32")("非 Windows 上拒绝真实构建，--dry-run 列出命令", () => {
    const real = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8" });
    expect(real.status).toBe(1);
    expect(real.stderr).toContain("只能在 Windows 上构建");
    const conf = JSON.parse(readFileSync(tauriFile("tauri.conf.json"), "utf8"));
    const same = spawnSync(process.execPath, [SCRIPT, "--dry-run", "--arch", HOST_ARCH], {
      encoding: "utf8",
    });
    expect(same.status).toBe(0);
    expect(same.stdout).toMatch(/tauri bundle --bundles nsis --config \S*tauri\.nsis\.json --ci/);
    expect(same.stdout).toContain(`Primus_${conf.version}_${HOST_ARCH}-setup.exe`);
    const other = HOST_ARCH === "x64" ? "arm64" : "x64";
    const cross = spawnSync(process.execPath, [SCRIPT, "--dry-run", "--arch", other], {
      encoding: "utf8",
    });
    expect(cross.status).toBe(0);
    expect(cross.stdout).toContain(
      `tauri bundle --bundles nsis --target ${archInfo(other).rustTarget} --config`,
    );
    expect(cross.stdout).toContain(`Primus_${conf.version}_${other}-setup.exe`);
  });

  it.skipIf(process.platform === "win32")(
    "签名配置：配一半拒绝，配齐时 --dry-run 列出 signtool verify",
    () => {
      const clean = { ...process.env };
      for (const k of Object.keys(clean))
        if (
          k.startsWith("PRIMUS_SIGN") ||
          k.startsWith("TAURI_SIGNING") ||
          k === "PRIMUS_REQUIRE_SIGNING"
        )
          delete clean[k];
      const half = spawnSync(process.execPath, [SCRIPT, "--dry-run", "--arch", HOST_ARCH], {
        encoding: "utf8",
        env: { ...clean, PRIMUS_SIGN_CERT_SHA1: "ABCDEF" },
      });
      expect(half.status).toBe(1);
      expect(half.stderr).toContain("必须同时配置");
      const required = spawnSync(process.execPath, [SCRIPT, "--dry-run", "--arch", HOST_ARCH], {
        encoding: "utf8",
        env: { ...clean, PRIMUS_REQUIRE_SIGNING: "1" },
      });
      expect(required.status).toBe(1);
      expect(required.stderr).toContain("PRIMUS_REQUIRE_SIGNING=1");
      const full = spawnSync(process.execPath, [SCRIPT, "--dry-run", "--arch", HOST_ARCH], {
        encoding: "utf8",
        env: {
          ...clean,
          PRIMUS_SIGN_CERT_SHA1: "ABCDEF",
          PRIMUS_SIGN_TIMESTAMP_URL: "http://ts.example",
          PRIMUS_SIGNTOOL: "signtool-test",
        },
      });
      expect(full.status).toBe(0);
      expect(full.stdout).toMatch(/signtool-test verify \/pa \/all \S*-setup\.exe/);
      expect(full.stdout).toMatch(/signtool-test verify \/pa \/all \S*Primus\.exe/);
    },
  );
});
