#!/usr/bin/env node
// 字号阶梯检查（技术方案第 16 章“字号”）：
// 前端字号只用 globals.css `@theme` 定义的字号令牌（text-3xs … text-3xl、leading-input），
// 不得在 apps/desktop/src 里写 text-[13px]、text-[0.9rem]、leading-[22px] 这类任意字号 / 行高，
// 也不得在组件里用内联 style 写 fontSize / lineHeight。新的字号需求先在 @theme 里加令牌。
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** 要扫描的目录（相对仓库根） */
export const SCAN_DIRS = ["apps/desktop/src"];
const EXTENSIONS = /\.(?:[cm]?[jt]sx?)$/;
const TEST_FILE = /\.test\.[cm]?[jt]sx?$/;
const SKIP_DIRS = new Set(["node_modules", "dist", "out", ".next"]);

const PATTERNS = [
  // text-[13px]、text-[0.9rem]、md:text-[12.5px]、text-[length:13px]（颜色 text-[#fff]、text-[var(--x)] 不算）
  {
    re: /(?<![\w-])text-\[(?:length:)?-?\d*\.?\d+(?:px|rem|em|pt|%|vw|vh)?\]/g,
    kind: "任意字号",
  },
  // leading-[22px]、leading-[1.6]
  {
    re: /(?<![\w-])leading-\[(?:length:|number:)?-?\d*\.?\d+(?:px|rem|em|%)?\]/g,
    kind: "任意行高",
  },
  // style={{ fontSize: 13 }}、style={{ lineHeight: "22px" }}
  { re: /\b(?:fontSize|lineHeight)\s*:/g, kind: "内联字号/行高" },
];

/** 去掉注释（块注释保留换行，行号不变），避免注释里的示例被误报 */
export function stripComments(code) {
  const blank = (m) => m.replace(/[^\n]/g, " ");
  return code.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/(^|[^:\\])\/\/.*$/gm, "$1");
}

/** 返回一段代码中的违规位置 */
export function findViolations(code) {
  const clean = stripComments(code);
  const out = [];
  for (const { re, kind } of PATTERNS) {
    for (const m of clean.matchAll(re)) {
      const line = clean.slice(0, m.index).split("\n").length;
      out.push({ line, kind, what: m[0] });
    }
  }
  return out.sort((a, b) => a.line - b.line);
}

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    let st;
    try {
      st = lstatSync(full);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) yield* walk(full);
    else if (st.isFile() && EXTENSIONS.test(name) && !TEST_FILE.test(name)) yield full;
  }
}

/** 扫描仓库，返回违规清单（"路径:行 种类 内容"） */
export function run(root) {
  const findings = [];
  let scanned = 0;
  for (const dir of SCAN_DIRS) {
    for (const file of walk(join(root, dir))) {
      const rel = relative(root, file).split(sep).join("/");
      scanned += 1;
      for (const v of findViolations(readFileSync(file, "utf8")))
        findings.push(`${rel}:${v.line} ${v.kind} ${v.what}`);
    }
  }
  return { findings, scanned };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const { findings, scanned } = run(root);
  if (findings.length > 0) {
    console.error(`✗ 发现 ${findings.length} 处未使用字号令牌的字号 / 行高：`);
    for (const f of findings) console.error(`  - ${f}`);
    console.error(
      "  请改用 globals.css @theme 的字号令牌（text-2xs / xs / sm / base / md / lg / xl …）；需要新字号时先在 @theme 里加令牌。",
    );
    process.exit(1);
  }
  console.log(`✓ 字号阶梯检查通过（扫描 ${scanned} 个文件）`);
}
