import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error 纯 JS 脚本，无类型声明
import {
  ARCHES,
  archInfo,
  authenticodeEnv,
  cargoTarget,
  checkExeStamp,
  checkRuntimePlatform,
  compareMsiVersions,
  exeStamp,
  isTrustedMicrosoftSignature,
  isTrustedOpenJsSignature,
  msiFileName,
  msiProductVersion,
  resolveSigntool,
  signingConfig,
  signtoolArgs,
  signtoolVerifyArgs,
  updaterKeyFile,
  WXS,
  wixBuildArgs,
} from "./build-msi.mjs";

const SCRIPT = fileURLToPath(new URL("./build-msi.mjs", import.meta.url));
// --dry-run 在非 Windows 上假定同 CPU 架构的 Windows 主机：传同架构的 --arch，命令中不出现 --target
const HOST_ARCH = process.arch === "arm64" ? "arm64" : "x64";

describe("build-msi", () => {
  it("SemVer 按第 3.3.3 节映射为 MSI ProductVersion", () => {
    expect(msiProductVersion("1.2.3")).toBe("1.2.399.0");
    expect(msiProductVersion("0.0.0")).toBe("0.0.99.0");
    expect(msiProductVersion("1.3.0-alpha.1")).toBe("1.3.1.0");
    expect(msiProductVersion("1.3.0-beta.2")).toBe("1.3.32.0");
    expect(msiProductVersion("2.0.0-rc.1+build.7")).toBe("2.0.61.0");
    expect(msiProductVersion("1.0.0+build.7")).toBe("1.0.99.0");
    expect(msiProductVersion("255.255.654")).toBe("255.255.65499.0");
  });

  it("预发布版到稳定版的顺序体现在 MSI 前三个字段（Windows Installer 忽略第四字段）", () => {
    const ordered = [
      "1.2.2",
      "1.2.3-alpha.0",
      "1.2.3-alpha.29",
      "1.2.3-beta.0",
      "1.2.3-beta.2",
      "1.2.3-rc.1",
      "1.2.3-rc.29",
      "1.2.3",
      "1.2.4-alpha.0",
      "1.2.654",
      "1.3.0-beta.1",
      "1.3.0",
      "2.0.0-alpha.0",
    ].map(msiProductVersion);
    for (let i = 1; i < ordered.length; i++) {
      // 后一个严格更高：MajorUpgrade（AllowSameVersionUpgrades=no）可替换前一个
      expect(compareMsiVersions(ordered[i], ordered[i - 1])).toBeGreaterThan(0);
      // 反向替换是降级，被 MajorUpgrade 拒绝
      expect(compareMsiVersions(ordered[i - 1], ordered[i])).toBeLessThan(0);
    }
    for (const v of ordered) expect(v.endsWith(".0")).toBe(true);
    // 比较只看前三个字段
    expect(compareMsiVersions("1.2.3.0", "1.2.3.9")).toBe(0);
  });

  it("非法版本与越界版本直接失败", () => {
    expect(() => msiProductVersion("1.2")).toThrow();
    expect(() => msiProductVersion("v1.2.3")).toThrow();
    expect(() => msiProductVersion("01.2.3")).toThrow();
    expect(() => msiProductVersion("256.0.0")).toThrow();
    expect(() => msiProductVersion("1.0.655")).toThrow("654");
    expect(() => msiProductVersion("1.0.0-beta")).toThrow("alpha.N");
    expect(() => msiProductVersion("1.0.0-preview.1")).toThrow("alpha.N");
    expect(() => msiProductVersion("1.0.0-beta.1.2")).toThrow();
    expect(() => msiProductVersion("1.0.0-rc.30")).toThrow("29");
  });

  it("交付物文件名", () => {
    expect(msiFileName("1.2.3")).toBe("Primus_1.2.3_x64_zh-CN.msi");
    expect(msiFileName("1.2.3", "x64")).toBe("Primus_1.2.3_x64_zh-CN.msi");
    expect(msiFileName("0.0.1", "arm64")).toBe("Primus_0.0.1_arm64_zh-CN.msi");
    expect(() => msiFileName("1.2.3", "x86")).toThrow("不支持的架构");
  });

  it("架构对应的 Rust 目标与内置 Node 运行时平台", () => {
    expect(Object.keys(ARCHES)).toEqual(["x64", "arm64"]);
    expect(archInfo("x64")).toEqual({
      rustTarget: "x86_64-pc-windows-msvc",
      nodePlatform: "win-x64",
    });
    expect(archInfo("arm64")).toEqual({
      rustTarget: "aarch64-pc-windows-msvc",
      nodePlatform: "win-arm64",
    });
    expect(() => archInfo("toString")).toThrow("不支持的架构");
    // rust-toolchain.toml 须装好两个目标；node-runtime.json 须锁定两个平台的运行时
    const toolchain = readFileSync(new URL("../rust-toolchain.toml", import.meta.url), "utf8");
    const runtime = JSON.parse(
      readFileSync(new URL("./node-runtime.json", import.meta.url), "utf8"),
    );
    for (const { rustTarget, nodePlatform } of Object.values(ARCHES)) {
      expect(toolchain).toContain(`"${rustTarget}"`);
      expect(runtime.platforms[nodePlatform].archive).toBe(
        `node-v${runtime.version}-${nodePlatform}.zip`,
      );
    }
  });

  it("目标与 rustc 主机相同时不加 --target，不同则交叉编译到 target/<三元组>/release", () => {
    expect(cargoTarget("x64", "x86_64-pc-windows-msvc")).toEqual({
      args: [],
      releaseDir: "release",
    });
    expect(cargoTarget("arm64", "aarch64-pc-windows-msvc")).toEqual({
      args: [],
      releaseDir: "release",
    });
    expect(cargoTarget("arm64", "x86_64-pc-windows-msvc")).toEqual({
      args: ["--target", "aarch64-pc-windows-msvc"],
      releaseDir: "aarch64-pc-windows-msvc/release",
    });
    expect(cargoTarget("x64", "aarch64-pc-windows-msvc")).toEqual({
      args: ["--target", "x86_64-pc-windows-msvc"],
      releaseDir: "x86_64-pc-windows-msvc/release",
    });
  });

  it("内置运行时平台须与目标架构一致", () => {
    expect(checkRuntimePlatform({ runtime: { platform: "win-x64" } }, "x64")).toBeNull();
    expect(checkRuntimePlatform({ runtime: { platform: "win-arm64" } }, "arm64")).toBeNull();
    expect(checkRuntimePlatform({ runtime: { platform: "win-x64" } }, "arm64")).toContain(
      "--platform win-arm64",
    );
    expect(checkRuntimePlatform({ runtime: null }, "x64")).toContain("未知");
  });

  it("wix build 参数与技术方案第 3.3.1 节一致", () => {
    const args = wixBuildArgs({
      appDir: "C:/t/release",
      coreDir: "C:/r/dist/agent-core",
      runtimeDir: "C:/r/dist/runtime",
      shellDir: "C:/r/apps/desktop/src-tauri",
      webview2Setup: "C:/r/w/MicrosoftEdgeWebview2Setup.exe",
      productVersion: "1.2.399.0",
      out: "C:/r/out/Primus_1.2.3_x64_zh-CN.msi",
    });
    expect(args).toEqual([
      "build",
      WXS,
      "-arch",
      "x64",
      "-culture",
      "zh-CN",
      "-acceptEula",
      "wix7",
      "-ext",
      "WixToolset.UI.wixext",
      "-ext",
      "WixToolset.Util.wixext",
      "-bindpath",
      "app=C:/t/release",
      "-bindpath",
      "core=C:/r/dist/agent-core",
      "-bindpath",
      "runtime=C:/r/dist/runtime",
      "-d",
      "ProductVersion=1.2.399.0",
      "-d",
      "ShellDir=C:/r/apps/desktop/src-tauri",
      "-d",
      "WebView2Setup=C:/r/w/MicrosoftEdgeWebview2Setup.exe",
      "-o",
      "C:/r/out/Primus_1.2.3_x64_zh-CN.msi",
    ]);
  });

  it("只有同时配置证书指纹与时间戳服务器才签名", () => {
    expect(signtoolArgs("a.msi", {})).toBeNull();
    expect(signtoolArgs("a.msi", { PRIMUS_SIGN_CERT_SHA1: "AB" })).toBeNull();
    expect(
      signtoolArgs("a.msi", { PRIMUS_SIGN_CERT_SHA1: "AB", PRIMUS_SIGN_TIMESTAMP_URL: "http://t" }),
    ).toEqual([
      "sign",
      "/fd",
      "sha256",
      "/tr",
      "http://t",
      "/td",
      "sha256",
      "/sha1",
      "AB",
      "a.msi",
    ]);
  });

  it("updater 私钥路径以 apps/desktop 为基准解析（与 tauri signer 一致），绝对路径原样保留", () => {
    expect(updaterKeyFile({})).toBeNull();
    const base = resolve("/repo/apps/desktop");
    expect(updaterKeyFile({ TAURI_SIGNING_PRIVATE_KEY_PATH: "k.key" }, base)).toBe(
      resolve(base, "k.key"),
    );
    expect(updaterKeyFile({ TAURI_SIGNING_PRIVATE_KEY_PATH: "../../k.key" }, base)).toBe(
      resolve("/repo/k.key"),
    );
    const abs = resolve("/keys/updater.key");
    expect(updaterKeyFile({ TAURI_SIGNING_PRIVATE_KEY_PATH: abs }, base)).toBe(abs);
    expect(updaterKeyFile({ TAURI_SIGNING_PRIVATE_KEY_PATH: "k" })).toBe(
      resolve(fileURLToPath(new URL("..", import.meta.url)), "apps/desktop", "k"),
    );
  });

  it("签名配置：成对配置才签名，配一半或 PRIMUS_REQUIRE_SIGNING=1 而缺配置时报错", () => {
    expect(signingConfig({})).toEqual({ authenticode: false, updater: false, problems: [] });
    const full = {
      PRIMUS_SIGN_CERT_SHA1: "AB",
      PRIMUS_SIGN_TIMESTAMP_URL: "http://t",
      TAURI_SIGNING_PRIVATE_KEY_PATH: "k",
      TAURI_SIGNING_PUBLIC_KEY: "p",
      PRIMUS_REQUIRE_SIGNING: "1",
    };
    expect(signingConfig(full)).toEqual({ authenticode: true, updater: true, problems: [] });
    expect(signingConfig({ PRIMUS_SIGN_CERT_SHA1: "AB" }).problems).toEqual([
      "PRIMUS_SIGN_CERT_SHA1 与 PRIMUS_SIGN_TIMESTAMP_URL 必须同时配置",
    ]);
    expect(signingConfig({ TAURI_SIGNING_PRIVATE_KEY: "k" }).problems[0]).toContain(
      "必须同时配置 TAURI_SIGNING_PUBLIC_KEY",
    );
    expect(signingConfig({ TAURI_SIGNING_PUBLIC_KEY: "p" }).problems[0]).toContain(
      "没有 updater 私钥",
    );
    expect(signingConfig({ ...full, TAURI_SIGNING_PRIVATE_KEY: "k" }).problems[0]).toContain(
      "只能配置一个",
    );
    const { problems } = signingConfig({
      PRIMUS_REQUIRE_SIGNING: "1",
      PRIMUS_SIGN_CERT_SHA1: "AB",
      PRIMUS_SIGN_TIMESTAMP_URL: "http://t",
    });
    expect(problems).toEqual([
      "PRIMUS_REQUIRE_SIGNING=1 要求同时配置代码签名证书与 updater 签名密钥",
    ]);
  });

  it("signtool verify 用 /pa 校验全部签名", () => {
    expect(signtoolVerifyArgs("C:/a b/Primus.exe")).toEqual([
      "verify",
      "/pa",
      "/all",
      "C:/a b/Primus.exe",
    ]);
  });

  it("signtool 优先取环境变量，其次 Windows SDK 中最新版本，找不到退回 PATH", () => {
    const bin = "C:\\Program Files (x86)\\Windows Kits\\10\\bin";
    const present = new Set([
      `${bin}\\10.0.19041.0\\x64\\signtool.exe`,
      `${bin}\\10.0.26100.0\\x64\\signtool.exe`,
      `${bin}\\10.0.26100.0\\arm64\\signtool.exe`,
      `${bin}\\10.0.9200.0\\x64\\signtool.exe`,
    ]);
    const fs = {
      exists: (f: string) => present.has(f),
      list: () => ["10.0.9200.0", "10.0.26100.0", "10.0.19041.0", "x64"],
    };
    expect(resolveSigntool({ PRIMUS_SIGNTOOL: "D:/st.exe" }, fs)).toBe("D:/st.exe");
    expect(resolveSigntool({}, { ...fs, hostArch: "x64" })).toBe(
      `${bin}\\10.0.26100.0\\x64\\signtool.exe`,
    );
    expect(resolveSigntool({}, { ...fs, hostArch: "arm64" })).toBe(
      `${bin}\\10.0.26100.0\\arm64\\signtool.exe`,
    );
    expect(resolveSigntool({ "ProgramFiles(x86)": "E:\\PF" }, { ...fs, hostArch: "x64" })).toBe(
      "signtool",
    );
    expect(
      resolveSigntool(
        {},
        {
          hostArch: "x64",
          exists: () => false,
          list: () => {
            throw new Error("ENOENT");
          },
        },
      ),
    ).toBe("signtool");
  });

  it("内置 node.exe 只接受有效的 OpenJS Foundation 签名", () => {
    const subject =
      'CN="OpenJS Foundation", O="OpenJS Foundation", L=San Francisco, S=California, C=US';
    expect(isTrustedOpenJsSignature({ Status: "Valid", Subject: subject })).toBe(true);
    expect(isTrustedOpenJsSignature({ Status: "NotSigned", Subject: subject })).toBe(false);
    expect(
      isTrustedOpenJsSignature({ Status: "Valid", Subject: "CN=Evil, O=OpenJS Foundation Fake" }),
    ).toBe(false);
  });

  it("Primus.wxs 引用的 bindpath 与预处理变量都由脚本传入，UpgradeCode 已固定", () => {
    const wxs = readFileSync(WXS, "utf8");
    const args: string[] = wixBuildArgs({
      appDir: "a",
      coreDir: "c",
      runtimeDir: "r",
      productVersion: "1",
      out: "o",
    });
    const valuesAfter = (flag: string) =>
      args.flatMap((a, i) => (args[i - 1] === flag ? [a.split("=")[0]] : []));
    const usedBindpaths = new Set([...wxs.matchAll(/!\(bindpath\.(\w+)\)/g)].map((m) => m[1]));
    expect([...usedBindpaths].sort()).toEqual(valuesAfter("-bindpath").sort());
    const usedDefines = new Set([...wxs.matchAll(/\$\((\w+)\)/g)].map((m) => m[1]));
    expect([...usedDefines].sort()).toEqual(valuesAfter("-d").sort());
    expect(/UpgradeCode="([^"]+)"/.exec(wxs)?.[1]).toBe("5B4199DD-C352-459A-AEB0-7119A884608F");
  });

  it("Primus.wxs 的关键安装行为（第 3.3.2 节）", () => {
    const wxs = readFileSync(WXS, "utf8");
    expect(wxs).toContain('<ui:WixUI Id="WixUI_InstallDir" InstallDirectory="INSTALLFOLDER" />');
    expect(wxs).toMatch(/<Component Id="DataDir" Permanent="yes"/);
    expect(wxs).toContain('User="[WIX_ACCOUNT_USERS]"');
    expect(wxs).toContain("<util:QueryWindowsWellKnownSIDs />");
    // data 授予 icacls 的 (M)：不得含完全控制、更改权限、取得所有权与通用权限
    const permission = /<util:PermissionEx[^>]*>/.exec(wxs)?.[0] ?? "";
    for (const right of ["Delete", "CreateFile", "CreateChild", "Traverse", "WriteAttributes"])
      expect(permission).toContain(`${right}="yes"`);
    for (const right of ["GenericAll", "GenericWrite", "ChangePermission", "TakeOwnership"])
      expect(permission).not.toContain(right);
    // 安装目录本身：受保护的 DACL，Users 只读和执行（装在 D:\primus 等自选目录时不继承盘根的“修改”）
    expect(wxs).toContain('<ComponentRef Id="InstallDirAcl" />');
    const sddl = /<PermissionEx Sddl="([^"]+)"/.exec(wxs)?.[1] ?? "";
    expect(sddl).toMatch(/^D:P/);
    expect(sddl).toContain("(A;OICI;0x1200a9;;;BU)");
    expect(sddl).not.toMatch(/\(A;[^;]*;(FA|GA|GW|0x1301bf);;;(BU|AU|WD)\)/);
    expect(wxs).toContain('Value="com.primus.desktop"');
    const conf = JSON.parse(
      readFileSync(new URL("../apps/desktop/src-tauri/tauri.conf.json", import.meta.url), "utf8"),
    );
    expect(conf.identifier).toBe("com.primus.desktop");
    expect(wxs).toContain("{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}");
    expect(wxs).toMatch(
      /<Custom Action="InstallWebView2"[^>]*Condition="WEBVIEW2_MISSING AND NOT REMOVE"/,
    );
    // 重大升级沿用原安装目录：写入 HKLM，AppSearch 读回，用户未显式指定时在 CostFinalize 之前赋给 INSTALLFOLDER
    expect(wxs).toMatch(
      /<RegistryValue Root="HKLM" Key="Software\\Primus" Name="InstallDir"[^>]*Value="\[INSTALLFOLDER\]"/,
    );
    expect(wxs).toMatch(/<ComponentRef Id="InstallDirRegistry" \/>/);
    expect(wxs).toMatch(
      /<RegistrySearch Id="PreviousInstallFolderSearch" Root="HKLM" Key="Software\\Primus" Name="InstallDir"/,
    );
    expect(wxs).toMatch(
      /<SetProperty Id="INSTALLFOLDER" Value="\[PREVIOUS_INSTALLFOLDER\]" After="AppSearch"[^>]*Condition="PREVIOUS_INSTALLFOLDER AND NOT INSTALLFOLDER"/,
    );
  });

  it("WebView2 引导程序只接受微软签名有效的文件", () => {
    const subject =
      "CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US";
    expect(isTrustedMicrosoftSignature({ Status: "Valid", Subject: subject })).toBe(true);
    expect(isTrustedMicrosoftSignature({ Status: "HashMismatch", Subject: subject })).toBe(false);
    expect(
      isTrustedMicrosoftSignature({
        Status: "Valid",
        Subject: "CN=Evil, O=Microsoft Corporation Fake",
      }),
    ).toBe(false);
    expect(isTrustedMicrosoftSignature({ Status: "Valid", Subject: "" })).toBe(false);
  });

  it("读取签名时去掉继承自 pwsh 7 的 PSModulePath", () => {
    const env = authenticodeEnv({ PSModulePath: "C:\\pwsh7", PATH: "/bin" }, "C:\\a.exe");
    expect(env).toEqual({ PATH: "/bin", PRIMUS_VERIFY_FILE: "C:\\a.exe" });
    expect(authenticodeEnv({ PSMODULEPATH: "x" }, "f")).toEqual({ PRIMUS_VERIFY_FILE: "f" });
  });

  it.skipIf(process.platform === "win32")("非 Windows 上拒绝真实构建，--dry-run 列出命令", () => {
    const real = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8" });
    expect(real.status).toBe(1);
    expect(real.stderr).toContain("WiX 只能在 Windows 上运行");
    const dry = spawnSync(
      process.execPath,
      [SCRIPT, "--dry-run", "--arch", HOST_ARCH, "--version", "1.3.0-beta.2"],
      { encoding: "utf8" },
    );
    expect(dry.status).toBe(0);
    expect(dry.stdout).toContain("ProductVersion 1.3.32.0");
    expect(dry.stdout).toContain("-acceptEula wix7");
    expect(dry.stdout).toContain(`-arch ${HOST_ARCH} `);
    expect(dry.stdout).toContain(`Primus_1.3.0-beta.2_${HOST_ARCH}_zh-CN.msi`);
    // 覆盖版本同步给 tauri build，Primus.exe 与 MSI 同一版本
    expect(dry.stdout).toMatch(
      /tauri build --no-bundle --config \S*tauri\.version\.json -- --locked/,
    );
  });

  it.skipIf(process.platform === "win32")(
    "--version 与 tauri.conf.json 一致时不加 --config",
    () => {
      const conf = JSON.parse(
        readFileSync(new URL("../apps/desktop/src-tauri/tauri.conf.json", import.meta.url), "utf8"),
      );
      const dry = spawnSync(
        process.execPath,
        [SCRIPT, "--dry-run", "--arch", HOST_ARCH, "--version", conf.version],
        { encoding: "utf8" },
      );
      expect(dry.status).toBe(0);
      expect(dry.stdout).toContain("tauri build --no-bundle -- --locked");
      expect(dry.stdout).not.toContain("--config");
    },
  );

  it.skipIf(process.platform === "win32")(
    "--arch 与主机不同时交叉编译（--target），exe 取自 target/<三元组>/release",
    () => {
      const other = HOST_ARCH === "x64" ? "arm64" : "x64";
      const triple = archInfo(other).rustTarget;
      const dry = spawnSync(process.execPath, [SCRIPT, "--dry-run", "--arch", other], {
        encoding: "utf8",
      });
      expect(dry.status).toBe(0);
      expect(dry.stdout).toContain(`tauri build --no-bundle --target ${triple} -- --locked`);
      expect(dry.stdout).toMatch(new RegExp(`app=\\S*target[/\\\\]${triple}[/\\\\]release `));
      expect(dry.stdout).toContain(`-arch ${other} `);
      expect(dry.stdout).toMatch(new RegExp(`Primus_\\S+_${other}_zh-CN\\.msi`));
    },
  );

  it("不支持的架构直接失败", () => {
    const r = spawnSync(process.execPath, [SCRIPT, "--dry-run", "--arch", "x86"], {
      encoding: "utf8",
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("不支持的架构 x86");
  });

  it.skipIf(process.platform === "win32")(
    "--dry-run 在配置签名时按顺序签名、生成并校验 .sig、最后 signtool verify",
    () => {
      const env = {
        ...process.env,
        PRIMUS_SIGN_CERT_SHA1: "ABCD",
        PRIMUS_SIGN_TIMESTAMP_URL: "http://ts.example",
        PRIMUS_SIGNTOOL: "st.exe",
        TAURI_SIGNING_PRIVATE_KEY_PATH: "k.key",
        TAURI_SIGNING_PUBLIC_KEY: "pub",
        PRIMUS_REQUIRE_SIGNING: "1",
      };
      const dry = spawnSync(
        process.execPath,
        [SCRIPT, "--dry-run", "--arch", HOST_ARCH, "--version", "1.2.3"],
        {
          encoding: "utf8",
          env,
        },
      );
      expect(dry.status).toBe(0);
      const out = dry.stdout;
      const at = (needle: string) => {
        const i = out.indexOf(needle);
        expect(i, needle).toBeGreaterThanOrEqual(0);
        return i;
      };
      const signExe = at("st.exe sign /fd sha256 /tr http://ts.example /td sha256 /sha1 ABCD ");
      const wix = at("wix build");
      const signMsi = out.indexOf("st.exe sign", signExe + 1);
      const sig = at("tauri signer sign --app-version 1.2.3 ");
      const verifyExe = at("st.exe verify /pa /all ");
      expect(signExe).toBeLessThan(wix);
      expect(wix).toBeLessThan(signMsi);
      expect(signMsi).toBeLessThan(sig);
      expect(sig).toBeLessThan(verifyExe);
      expect(out.match(/st\.exe verify \/pa \/all /g)).toHaveLength(3);
      expect(out).toMatch(/verify \/pa \/all \S*Primus\.exe/);
      expect(out).toMatch(/verify \/pa \/all \S*node\.exe/);
      expect(out).toMatch(/verify \/pa \/all \S*Primus_1\.2\.3_\w+_zh-CN\.msi/);
    },
  );

  it("签名配一半时在编译前拒绝构建", () => {
    const r = spawnSync(process.execPath, [SCRIPT, "--dry-run", "--arch", HOST_ARCH], {
      encoding: "utf8",
      env: { ...process.env, PRIMUS_SIGN_CERT_SHA1: "ABCD", PRIMUS_SIGN_TIMESTAMP_URL: "" },
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("PRIMUS_SIGN_CERT_SHA1 与 PRIMUS_SIGN_TIMESTAMP_URL 必须同时配置");
    expect(r.stdout).not.toContain("tauri build");
  });

  it("--version 覆盖与 --skip-tauri 同用时拒绝构建", () => {
    const r = spawnSync(
      process.execPath,
      [SCRIPT, "--dry-run", "--skip-tauri", "--version", "9.9.9"],
      { encoding: "utf8" },
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("不能与 --skip-tauri 同用");
  });

  it("--skip-tauri 校验已有 Primus.exe 的构建记录", () => {
    const stat = { size: 1234, mtimeMs: 1700000000123.7 };
    const stamp = exeStamp("1.2.3", stat);
    expect(stamp).toEqual({ version: "1.2.3", arch: "x64", size: 1234, mtimeMs: 1700000000123 });
    expect(checkExeStamp(stamp, "1.2.3", stat)).toBeNull();
    // 记录缺失
    expect(checkExeStamp(null, "1.2.3", stat)).toContain("未找到构建记录");
    // 上次以 --version 9.9.9 构建，这次不带 --version 跳过编译
    expect(checkExeStamp(exeStamp("9.9.9", stat), "1.2.3", stat)).toContain("9.9.9");
    // exe 被其他方式重新生成
    expect(checkExeStamp(stamp, "1.2.3", { size: 1234, mtimeMs: 1700000009999 })).toContain(
      "重新生成",
    );
    expect(checkExeStamp(stamp, "1.2.3", { size: 4321, mtimeMs: 1700000000123 })).toContain(
      "重新生成",
    );
    // 架构：x64 的 exe 不能用于 arm64 安装包；早期记录没有 arch 字段，按 x64 处理
    expect(checkExeStamp(stamp, "1.2.3", stat, { arch: "arm64" })).toContain("x64 架构");
    const armStamp = exeStamp("1.2.3", stat, "arm64");
    expect(checkExeStamp(armStamp, "1.2.3", stat, { arch: "arm64" })).toBeNull();
    const { arch: _legacy, ...legacy } = stamp;
    expect(checkExeStamp(legacy, "1.2.3", stat)).toBeNull();
    expect(
      checkExeStamp(null, "1.2.3", stat, { arch: "arm64", remedy: "请先运行 pnpm build:msi" }),
    ).toContain("请先运行 pnpm build:msi");
  });
});
