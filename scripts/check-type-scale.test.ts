import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error 纯 JS 脚本，无类型声明
import { findViolations, run } from "./check-type-scale.mjs";

const dirs: string[] = [];

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "type-scale-"));
  dirs.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("findViolations", () => {
  it("报出任意字号、任意行高与内联字号", () => {
    const code = [
      '<p className="text-[13px] text-muted">',
      '<p className="md:text-[12.5px]">',
      '<p className="text-[0.9rem] leading-[22px]">',
      '<pre className="leading-[1.6]">',
      "<p style={{ fontSize: 13 }} />",
    ].join("\n");
    const found = findViolations(code).map((v: { line: number; what: string }) => [v.line, v.what]);
    expect(found).toEqual([
      [1, "text-[13px]"],
      [2, "text-[12.5px]"],
      [3, "text-[0.9rem]"],
      [3, "leading-[22px]"],
      [4, "leading-[1.6]"],
      [5, "fontSize:"],
    ]);
  });

  it("字号令牌、颜色任意值与注释不算违规", () => {
    const code = [
      '<p className="text-sm text-2xs text-base leading-input leading-relaxed">',
      '<span className="text-[#727274] text-[var(--x)] text-fg/80 text-black/[0.5]">',
      "// 以前是 text-[13px]",
      "/* leading-[22px] */",
      "<Icon name={x} /> // 以前是 text-[13px]",
    ].join("\n");
    expect(findViolations(code)).toEqual([]);
  });

  it("字符串、模板字符串与正则里的 // 不当注释，JSX 文字里的网址也不吞后面的内容", () => {
    const code = [
      'const p = "/repo//cache"; const c = "text-[13px]";',
      "const t = `a//b`; const d = 'leading-[22px]';",
      'const r = /\\/\\//; const e = "text-[12px]"; // text-[99px]',
      '<a>https://x.dev</a><b className="text-[11px]" />',
    ].join("\n");
    expect(findViolations(code).map((v) => [v.line, v.what])).toEqual([
      [1, "text-[13px]"],
      [2, "leading-[22px]"],
      [3, "text-[12px]"],
      [4, "text-[11px]"],
    ]);
  });
});

describe("run", () => {
  it("只扫描 apps/desktop/src，跳过测试文件", () => {
    const root = fixture({
      "apps/desktop/src/a.tsx": '<p className="text-[11px]" />',
      "apps/desktop/src/a.test.tsx": 'expect(x).toContain("text-[13px]")',
      "packages/ui/b.tsx": '<p className="text-[11px]" />',
    });
    const { findings, scanned } = run(root);
    expect(scanned).toBe(1);
    expect(findings).toEqual(["apps/desktop/src/a.tsx:1 任意字号 text-[11px]"]);
  });
});
