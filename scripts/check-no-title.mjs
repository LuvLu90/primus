#!/usr/bin/env node
// 悬停提示检查：apps/desktop/src 的 JSX 里不在原生元素上写 title 属性（<button title=…>、<span title=…>），
// 悬停提示统一用 @/components/ui/tooltip 的 <Tooltip>（深色小字、300 ms 延迟、避让窗口边缘、aria-describedby）；
// dangerouslySetInnerHTML 渲染的 HTML 字符串里写 data-tooltip，由 useDelegatedTooltip 显示。
// 组件自己的 title 属性（<Section title=…>、<Dialog title=…>，大写开头）不算。
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "./check-type-scale.mjs";

/** 要扫描的目录（相对仓库根） */
export const SCAN_DIRS = ["apps/desktop/src"];
const EXTENSIONS = /\.[cm]?[jt]sx$/;
const TEST_FILE = /\.test\.[cm]?[jt]sx?$/;
const SKIP_DIRS = new Set(["node_modules", "dist", "out", ".next"]);

/**
 * 从 title= 往前找它所在的开始标签：跳过成对的 {…} 与引号；遇到 `<名字` 即为标签，
 * 先遇到 `>` 说明 title= 不在标签属性里（如正文文字）。返回标签名或 null。
 */
function owningTag(code, index) {
  let depth = 0;
  for (let k = index - 1; k >= 0; k--) {
    const c = code[k];
    if (c === "}") depth++;
    else if (c === "{") depth--;
    else if (depth === 0 && (c === '"' || c === "'")) {
      const open = code.lastIndexOf(c, k - 1);
      if (open < 0) return null;
      k = open;
    } else if (depth === 0 && c === ">") return null;
    else if (depth === 0 && c === "<") {
      const m = /^<([A-Za-z][\w.:-]*)/.exec(code.slice(k));
      return m ? m[1] : null;
    }
  }
  return null;
}

/** 返回一段代码中原生元素上的 title 属性位置 */
export function findViolations(code) {
  const clean = stripComments(code);
  const out = [];
  for (const m of clean.matchAll(/(?<=\s)title=(?=[{"'])/g)) {
    const tag = owningTag(clean, m.index);
    // 小写开头是原生元素（含 svg 元素）；大写或带点的是组件
    if (!tag || !/^[a-z]/.test(tag) || tag.includes(".")) continue;
    const line = clean.slice(0, m.index).split("\n").length;
    out.push({ line, tag });
  }
  return out;
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

/** 扫描仓库，返回违规清单（"路径:行 <标签 title>"） */
export function run(root) {
  const findings = [];
  let scanned = 0;
  for (const dir of SCAN_DIRS) {
    for (const file of walk(join(root, dir))) {
      const rel = relative(root, file).split(sep).join("/");
      scanned += 1;
      for (const v of findViolations(readFileSync(file, "utf8")))
        findings.push(`${rel}:${v.line} <${v.tag} title=…>`);
    }
  }
  return { findings, scanned };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const { findings, scanned } = run(root);
  if (findings.length > 0) {
    console.error(`✗ 发现 ${findings.length} 处原生 title 悬停提示：`);
    for (const f of findings) console.error(`  - ${f}`);
    console.error(
      "  请改用 @/components/ui/tooltip 的 <Tooltip content=…>；HTML 字符串里用 data-tooltip（useDelegatedTooltip）。",
    );
    process.exit(1);
  }
  console.log(`✓ 悬停提示检查通过（扫描 ${scanned} 个文件）`);
}
