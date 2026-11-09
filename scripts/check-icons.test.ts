import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  findForbiddenImports,
  findIconDataColors,
  findIconUsageIssues,
  run,
  // @ts-expect-error 纯 JS 脚本，无类型声明
} from "./check-icons.mjs";

type Finding = { line: number; what: string };
const brief = (list: Finding[]) => list.map((v) => [v.line, v.what]);

const dirs: string[] = [];

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "check-icons-"));
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

describe("findForbiddenImports", () => {
  it("报出图标库的静态、动态与 require 导入", () => {
    const code = [
      'import { X } from "lucide-react";',
      'import Foo from "lucide-react/dist/esm/icons/x";',
      'const m = await import("@heroicons/react/24/outline");',
      'const r = require("react-icons");',
      'import { Home } from "reicon-react";',
    ].join("\n");
    expect(brief(findForbiddenImports(code))).toEqual([
      [1, "lucide-react"],
      [2, "lucide-react/dist/esm/icons/x"],
      [3, "@heroicons/react/24/outline"],
      [4, "react-icons"],
      [5, "reicon-react"],
    ]);
  });

  it("本项目的图标模块、注释与名字相近的包不算违规", () => {
    const code = [
      'import { Icon } from "@/components/icons";',
      '// import { X } from "lucide-react";',
      'import x from "lucide-reactive";',
    ].join("\n");
    expect(findForbiddenImports(code)).toEqual([]);
  });
});

describe("findIconDataColors", () => {
  it("只允许 currentColor 与 none", () => {
    const code = [
      'check: [["path", { d: "M0 0", fill: "currentColor" }]],',
      'x: [["path", { "fill": "#e4e4e7" }]],',
      'y: [["path", { stroke: "red", strokeWidth: "1.5" }]],',
      'z: [["path", { fill: "none", stroke: "currentColor" }]],',
      'w: "rgb(0 0 0)",',
    ].join("\n");
    expect(brief(findIconDataColors(code))).toEqual([
      [2, 'fill="#e4e4e7"'],
      [2, "#e4e4e7"],
      [3, 'stroke="red"'],
      [5, "rgb("],
    ]);
  });

  it("彩色文件类型图标的数据另外允许 var(--color-file-*) 令牌，字面色值与其他令牌仍不允许", () => {
    const code = [
      'ts: { nodes: [["path", { d: "M0 0", fill: "var(--color-file-light-blue-700)" }]] },',
      'js: { nodes: [["path", { fill: "#ffca28" }]] },',
      'x: { nodes: [["path", { fill: "var(--color-accent)" }]] },',
    ].join("\n");
    expect(brief(findIconDataColors(code, { fileTokens: true }))).toEqual([
      [2, 'fill="#ffca28"'],
      [2, "#ffca28"],
      [3, 'fill="var(--color-accent)"'],
    ]);
    expect(brief(findIconDataColors(code))).toContainEqual([
      1,
      'fill="var(--color-file-light-blue-700)"',
    ]);
  });
});

describe("findIconUsageIssues", () => {
  it("报出 <Icon> 上的透明度、任意颜色与旧式数值属性", () => {
    const code = [
      '<Icon name="x" className="opacity-70" />',
      '<Icon name="file" className="text-fg/75" />',
      '<Icon name="x" size={14} strokeWidth={2} />',
      '<Icon name="stop" fill="currentColor" />',
      '<Icon name="mic" className="hover:text-white text-[#fff]" />',
    ].join("\n");
    expect(brief(findIconUsageIssues(code))).toEqual([
      [1, "opacity-70"],
      [2, "text-fg/75"],
      [3, "strokeWidth"],
      [3, "size 只能是 2xs / xs / sm / md / lg / xl"],
      [4, "fill"],
      [5, "text-white"],
      [5, "text-[#fff]"],
    ]);
  });

  it("令牌颜色、显隐用的 opacity-0/100 与尺寸令牌不算违规", () => {
    const code = [
      '<Icon name="x" size="sm" className="text-muted" />',
      '<Icon name="check-circle" className="mt-0.5 text-success" />',
      "<Icon",
      '  name="chevron-right"',
      '  className={cn("opacity-0 group-hover/step:opacity-100", open && "rotate-90")}',
      "/>",
      '<Icon name={icon} className={cn(failed && "text-danger")} />',
      '<Icon name="x" size={compact ? "xs" : "sm"} />',
    ].join("\n");
    expect(findIconUsageIssues(code)).toEqual([]);
  });

  it("size 表达式里有非令牌或数值时仍报出", () => {
    const code = [
      '<Icon name="x" size={compact ? 12 : "sm"} />',
      '<Icon name="x" size={compact ? "tiny" : "sm"} />',
      '<Icon name="x" size={s} />',
    ].join("\n");
    expect(findIconUsageIssues(code).map((i) => [i.line, i.kind])).toEqual([
      [1, "图标尺寸"],
      [2, "图标尺寸"],
      [3, "图标尺寸"],
    ]);
  });

  it("字符串里的 // 不当注释：后面的违规照样报出", () => {
    expect(findIconDataColors('a: ["/repo//cache", { fill: "#000" }]')).toHaveLength(2);
  });
});

describe("run", () => {
  it("扫描前端源码，图标目录额外检查颜色，跳过测试文件", () => {
    const root = fixture({
      "apps/desktop/src/a.tsx": 'import { X } from "lucide-react";',
      "apps/desktop/src/a.test.tsx": 'import { X } from "lucide-react";',
      "apps/desktop/src/components/icons/icons.generated.ts": 'a: [["path", { fill: "#000" }]],',
      "apps/desktop/src/components/icons/file-icons.generated.ts":
        'ts: [["path", { fill: "var(--color-file-blue-400)" }]],',
      "apps/desktop/src/b.tsx": 'const fill = "#000";',
      "packages/ui/c.tsx": 'import { Check } from "react-icons/fa";',
    });
    const { findings, scanned } = run(root);
    expect(scanned).toBe(5);
    expect(findings).toEqual([
      "apps/desktop/src/a.tsx:1 图标库导入 lucide-react",
      'apps/desktop/src/components/icons/icons.generated.ts:1 图标颜色 fill="#000"',
      "apps/desktop/src/components/icons/icons.generated.ts:1 图标颜色 #000",
      "packages/ui/c.tsx:1 图标库导入 react-icons/fa",
    ]);
  });
});
