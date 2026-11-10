import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error 纯 JS 脚本，无类型声明
import { findViolations, run } from "./check-no-title.mjs";

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("findViolations", () => {
  it("报出原生元素上的 title，含多行标签与表达式属性", () => {
    const code = [
      '<button type="button" title="关闭">',
      "<span",
      '  className="truncate"',
      "  onClick={() => go(a > b)}",
      "  title={name}",
      ">",
    ].join("\n");
    expect(findViolations(code)).toEqual([
      { line: 1, tag: "button" },
      { line: 5, tag: "span" },
    ]);
  });

  it("组件的 title 属性、正文与注释里的 title= 不算", () => {
    const code = [
      "<Section title={t.appearance}>",
      "<Menu.Item title={x} />",
      "<p>写 title=1 的例子</p>",
      "// <button title={x}>",
      "const o = { title: 1 };",
      "<svg><title>图</title></svg>",
    ].join("\n");
    expect(findViolations(code)).toEqual([]);
  });
});

describe("run", () => {
  it("扫描 apps/desktop/src，跳过测试文件", () => {
    const root = mkdtempSync(join(tmpdir(), "no-title-"));
    dirs.push(root);
    const src = join(root, "apps/desktop/src");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "a.tsx"), "export const A = () => <div\n title={x} />;\n");
    writeFileSync(join(src, "a.test.tsx"), 'const t = <i title="x" />;\n');
    writeFileSync(
      join(src, "b.tsx"),
      'export const B = () => <Tooltip content="x"><i /></Tooltip>;\n',
    );
    const { findings, scanned } = run(root);
    expect(scanned).toBe(2);
    expect(findings).toEqual(["apps/desktop/src/a.tsx:2 <div title=…>"]);
  });
});
