import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error 纯 JS 脚本，无类型声明
import * as gen from "./gen-update-manifest.mjs";

const SCRIPT = fileURLToPath(new URL("./gen-update-manifest.mjs", import.meta.url));
const { buildManifest, channelsToUpdate, compareSemver, manifestVersion, PLATFORMS } = gen;

const sigFor = (name: string) => Buffer.from(`sig of ${name}\n`).toString("base64");
const signaturesFor = (version: string) =>
  Object.fromEntries(
    Object.values(PLATFORMS as Record<string, (v: string) => string>).map((f) => [
      f(version),
      `${sigFor(f(version))}\n`,
    ]),
  );

describe("gen-update-manifest", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("SemVer 比较遵循预发布优先级", () => {
    const ordered = [
      "1.0.0-alpha",
      "1.0.0-alpha.1",
      "1.0.0-alpha.beta",
      "1.0.0-beta",
      "1.0.0-beta.2",
      "1.0.0-beta.11",
      "1.0.0-rc.1",
      "1.0.0",
      "1.0.1",
      "1.10.0",
    ];
    for (let i = 0; i + 1 < ordered.length; i++) {
      expect(compareSemver(ordered[i], ordered[i + 1])).toBeLessThan(0);
      expect(compareSemver(ordered[i + 1], ordered[i])).toBeGreaterThan(0);
    }
    expect(compareSemver("1.2.3", "1.2.3+build.5")).toBe(0);
    expect(() => compareSemver("1.2", "1.2.3")).toThrow("SemVer");
  });

  it("清单含四个 Windows 平台，url 指向本次 Release 附件，signature 为 .sig 内容", () => {
    const m = buildManifest({
      version: "0.0.7",
      tag: "v0.0.7",
      repo: "skaduv/primus",
      notes: "  更新说明\n",
      pubDate: "2026-11-05T12:00:00Z",
      signatures: signaturesFor("0.0.7"),
    });
    expect(Object.keys(m.platforms).sort()).toEqual([
      "windows-aarch64-msi",
      "windows-aarch64-nsis",
      "windows-x86_64-msi",
      "windows-x86_64-nsis",
    ]);
    expect(m.platforms["windows-x86_64-msi"]).toEqual({
      url: "https://github.com/skaduv/primus/releases/download/v0.0.7/Primus_0.0.7_x64_zh-CN.msi",
      signature: sigFor("Primus_0.0.7_x64_zh-CN.msi"),
    });
    expect(m.platforms["windows-aarch64-nsis"].url).toBe(
      "https://github.com/skaduv/primus/releases/download/v0.0.7/Primus_0.0.7_arm64-setup.exe",
    );
    expect(m).toMatchObject({
      version: "0.0.7",
      notes: "更新说明",
      pub_date: "2026-11-05T12:00:00Z",
    });
  });

  it("缺少或无效的签名、非法版本与仓库名报错", () => {
    const base = {
      version: "0.0.7",
      tag: "v0.0.7",
      repo: "skaduv/primus",
      pubDate: "2026-11-05T12:00:00Z",
    };
    const partial = signaturesFor("0.0.7");
    delete partial["Primus_0.0.7_arm64-setup.exe"];
    expect(() => buildManifest({ ...base, signatures: partial })).toThrow("arm64-setup.exe");
    expect(() =>
      buildManifest({
        ...base,
        signatures: { ...signaturesFor("0.0.7"), "Primus_0.0.7_x64_zh-CN.msi": "not base64!" },
      }),
    ).toThrow("x64_zh-CN.msi");
    expect(() => buildManifest({ ...base, version: "v0.0.7", signatures: {} })).toThrow("SemVer");
    expect(() =>
      buildManifest({ ...base, repo: "a/b/c", signatures: signaturesFor("0.0.7") }),
    ).toThrow("仓库");
  });

  it("通道规则：正式版写 stable 与 beta，预发布只写 beta；现有版本更高时不覆盖", () => {
    expect(channelsToUpdate("1.0.0", {})).toEqual(["stable", "beta"]);
    expect(channelsToUpdate("1.1.0-beta.1", { stable: "1.0.0", beta: "1.0.0" })).toEqual(["beta"]);
    // Beta 已经更高：正式版只更新 stable
    expect(channelsToUpdate("1.0.1", { stable: "1.0.0", beta: "1.1.0-beta.1" })).toEqual([
      "stable",
    ]);
    // 正式版高于当前 Beta：Beta 用户也收到正式版
    expect(channelsToUpdate("1.1.0", { stable: "1.0.1", beta: "1.1.0-rc.1" })).toEqual([
      "stable",
      "beta",
    ]);
    // 重新构建旧标签不回退，同一版本可以覆盖
    expect(channelsToUpdate("1.0.0", { stable: "1.0.1", beta: "1.0.1" })).toEqual([]);
    expect(channelsToUpdate("1.0.1", { stable: "1.0.1", beta: "1.0.1" })).toEqual([
      "stable",
      "beta",
    ]);
    expect(manifestVersion('{"version":"1.2.3"}')).toBe("1.2.3");
    expect(manifestVersion("")).toBeNull();
    expect(manifestVersion("{oops")).toBeNull();
    expect(manifestVersion('{"version":"x"}')).toBeNull();
  });

  it("命令行：读取附件目录的 .sig，按现有清单决定写哪些文件", () => {
    const dir = mkdtempSync(join(tmpdir(), "primus-feed-"));
    dirs.push(dir);
    const assets = join(dir, "assets");
    const out = join(dir, "out");
    mkdirSync(assets);
    for (const [name, sig] of Object.entries(signaturesFor("1.1.0"))) {
      writeFileSync(join(assets, name), "pkg");
      writeFileSync(join(assets, `${name}.sig`), sig);
    }
    writeFileSync(join(dir, "notes.md"), "## 更新内容\n- 自动更新\n");
    writeFileSync(join(dir, "beta.json"), JSON.stringify({ version: "1.2.0-beta.1" }));
    const run = (...extra: string[]) =>
      spawnSync(
        process.execPath,
        [
          SCRIPT,
          "--version",
          "1.1.0",
          "--tag",
          "v1.1.0",
          "--repo",
          "skaduv/primus",
          "--assets",
          assets,
          "--out-dir",
          out,
          "--notes-file",
          join(dir, "notes.md"),
          "--existing-beta",
          join(dir, "beta.json"),
          "--existing-stable",
          join(dir, "missing.json"),
          "--pub-date",
          "2026-11-05T00:00:00Z",
          ...extra,
        ],
        { encoding: "utf8" },
      );
    const r = run();
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim().split("\n")).toEqual(["stable.json"]);
    expect(r.stderr).toContain("beta.json 现有版本 1.2.0-beta.1");
    const stable = JSON.parse(readFileSync(join(out, "stable.json"), "utf8"));
    expect(stable.notes).toBe("## 更新内容\n- 自动更新");
    expect(stable.platforms["windows-aarch64-msi"].signature).toBe(
      sigFor("Primus_1.1.0_arm64_zh-CN.msi"),
    );
    // --verify 需要公钥
    const v = run("--verify");
    expect(v.status).toBe(1);
    expect(v.stderr).toContain("TAURI_SIGNING_PUBLIC_KEY");
    // 缺少 .sig 时失败
    rmSync(join(assets, "Primus_1.1.0_x64-setup.exe.sig"));
    const missing = run();
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("Primus_1.1.0_x64-setup.exe.sig");
  });
});
