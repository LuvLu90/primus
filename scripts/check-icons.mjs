#!/usr/bin/env node
// 图标检查（技术方案第 16.1.1 节“图标”）：
// 1. 前端只用 @/components/icons 的 <Icon>：不得 import lucide-react 等图标库；
// 2. 图标数据（components/icons/ 下的文件）里的颜色只能是 currentColor / none；
//    唯一例外是彩色文件类型图标的数据（file-icons.generated.ts）：只能用 var(--color-file-*) 设计令牌，不写十六进制等字面色值；
// 3. <Icon> 上不写透明度、任意颜色或旧的 size / strokeWidth / fill 数值属性，颜色用 text-muted 等令牌类。
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "./check-type-scale.mjs";

export { stripComments };

/** 要扫描的目录（相对仓库根） */
export const SCAN_DIRS = ["apps/desktop/src", "packages/ui"];
/** 图标数据所在目录（相对仓库根） */
export const ICON_DIR = "apps/desktop/src/components/icons";
/** 彩色文件类型图标的数据（scripts/vendor-file-icons.mjs 生成），颜色只能是 --color-file-* 令牌 */
export const FILE_ICON_DATA = `${ICON_DIR}/file-icons.generated.ts`;
const FILE_TOKEN = /^var\(--color-file-[a-z0-9-]+\)$/;
const EXTENSIONS = /\.(?:[cm]?[jt]sx?)$/;
const TEST_FILE = /\.test\.[cm]?[jt]sx?$/;
const SKIP_DIRS = new Set(["node_modules", "dist", "out", ".next"]);

/** 禁止的图标库（包名或包名前缀） */
export const FORBIDDEN_PACKAGES = [
  "lucide-react",
  "lucide",
  "reicon",
  "reicon-react",
  "@radix-ui/react-icons",
  "react-icons",
  "@heroicons/",
  "@tabler/icons",
  "@phosphor-icons/",
  "phosphor-react",
  "@iconify/",
  "@iconify-json/",
  "@mui/icons-material",
  "@fortawesome/",
];

const lineOf = (code, index) => code.slice(0, index).split("\n").length;

function isForbidden(spec) {
  return FORBIDDEN_PACKAGES.some((p) =>
    p.endsWith("/") ? spec.startsWith(p) : spec === p || spec.startsWith(`${p}/`),
  );
}

/** 导入了被禁图标库 */
export function findForbiddenImports(code) {
  const clean = stripComments(code);
  const out = [];
  const re = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)["']([^"']+)["']/g;
  for (const m of clean.matchAll(re)) {
    if (isForbidden(m[1]))
      out.push({ line: lineOf(clean, m.index), kind: "图标库导入", what: m[1] });
  }
  return out;
}

/**
 * 图标数据里出现 currentColor / none 之外的颜色。
 * `fileTokens`：彩色文件类型图标的数据，另外允许 var(--color-file-*) 令牌（字面色值仍不允许）。
 */
export function findIconDataColors(code, { fileTokens = false } = {}) {
  const clean = stripComments(code);
  const out = [];
  const re = /\b(fill|stroke|stop-color|stopColor|color)["']?\s*[:=]\s*["']([^"']*)["']/g;
  for (const m of clean.matchAll(re)) {
    if (m[2] !== "currentColor" && m[2] !== "none" && !(fileTokens && FILE_TOKEN.test(m[2])))
      out.push({ line: lineOf(clean, m.index), kind: "图标颜色", what: `${m[1]}="${m[2]}"` });
  }
  for (const m of clean.matchAll(/#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|oklch)\(/g))
    out.push({ line: lineOf(clean, m.index), kind: "图标颜色", what: m[0] });
  return out.sort((a, b) => a.line - b.line);
}

/** 颜色类：允许的令牌色（继承文字颜色或设计令牌），其余（text-white、text-fg/75、text-[#…]）不允许 */
const TOKEN_TEXT =
  /^text-(?:fg|muted|accent|danger|warning|success|select|surface|on-danger|inherit|current)$/;
/** <Icon size> 的尺寸令牌（--spacing-icon-*） */
const ICON_SIZES = new Set(["2xs", "xs", "sm", "md", "lg", "xl"]);
const BAD_ICON_PROP = /^(?:fill|stroke|color|strokeWidth|opacity|style)$/;

/**
 * 源码里每个 `<Icon` 起始标签的属性文本：扫到标签结束的 `>` 为止，
 * {…} 表达式与引号里的 `>`（如 onClick={() => x}）不算结束
 */
function iconTags(code) {
  const out = [];
  for (const m of code.matchAll(/<Icon\b/g)) {
    const start = m.index + m[0].length;
    let depth = 0;
    let quote = "";
    let i = start;
    for (; i < code.length; i++) {
      const ch = code[i];
      if (quote) {
        if (ch === "\\") i++;
        else if (ch === quote) quote = "";
      } else if (ch === '"' || ch === "'" || ch === "`") quote = ch;
      else if (ch === "{") depth++;
      else if (ch === "}") depth--;
      else if (ch === ">" && depth <= 0) break;
    }
    out.push({ index: m.index, attrs: code.slice(start, i).replace(/\/$/, "") });
  }
  return out;
}

/** size={…} 表达式每个结果分支的取值：字符串字面量给出内容，其余（数值、标识符、调用…）为 undefined */
function sizeBranches(expr) {
  const e = expr.trim();
  const lit = e.match(/^\(?\s*(["'`])([^"'`]*)\1\s*\)?$/);
  if (lit) return [lit[2]];
  // 顶层第一个 `?` 与它配对的 `:`（跳过引号内容、`?.`、`??` 与嵌套的条件表达式）
  let q = -1;
  let colon = -1;
  let nest = 0;
  let quote = "";
  for (let i = 0; i < e.length && colon < 0; i++) {
    const ch = e[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch === "?" && e[i + 1] === "?") i++;
    else if (ch === "?" && e[i + 1] === "." && !/\d/.test(e[i + 2] ?? "")) i++;
    else if (ch === "?") {
      if (q < 0) q = i;
      else nest++;
    } else if (ch === ":" && q >= 0) {
      if (nest === 0) colon = i;
      else nest--;
    }
  }
  if (q < 0 || colon < 0) return [undefined];
  return [...sizeBranches(e.slice(q + 1, colon)), ...sizeBranches(e.slice(colon + 1))];
}

/** <Icon …> 上的透明度、任意颜色与旧式数值属性 */
export function findIconUsageIssues(code) {
  const clean = stripComments(code);
  const out = [];
  for (const { index, attrs } of iconTags(clean)) {
    const line = lineOf(clean, index);
    for (const p of attrs.matchAll(/(?<![\w-])([A-Za-z]+)=/g)) {
      if (BAD_ICON_PROP.test(p[1])) out.push({ line, kind: "图标属性", what: p[1] });
    }
    // size 只能是尺寸令牌：size="sm"，或每个结果分支都是令牌字面量的条件表达式（size={compact ? "xs" : "sm"}）；
    // 分支是数值、标识符等（size={compact ? "sm" : other}）都不行
    const badSize = () =>
      out.push({ line, kind: "图标尺寸", what: "size 只能是 2xs / xs / sm / md / lg / xl" });
    for (const sz of attrs.matchAll(/(?<![\w-])size=(?:"([^"]*)"|'([^']*)')/g)) {
      if (!ICON_SIZES.has(sz[1] ?? sz[2])) badSize();
    }
    for (const sz of attrs.matchAll(/(?<![\w-])size=\{([^}]*)\}/g)) {
      if (!sizeBranches(sz[1]).every((b) => b !== undefined && ICON_SIZES.has(b))) badSize();
    }
    for (const c of attrs.matchAll(
      /(?<![\w-])(?:[\w-]+:)*((?:text|fill|stroke|opacity)-[^\s"'`}]+)/g,
    )) {
      const cls = c[1];
      if (cls.startsWith("opacity-") && !/^opacity-(?:0|100)$/.test(cls))
        out.push({ line, kind: "图标透明度", what: cls });
      else if (
        (cls.startsWith("fill-") || cls.startsWith("stroke-")) &&
        !/^(?:fill|stroke)-(?:current|none)$/.test(cls)
      )
        out.push({ line, kind: "图标颜色", what: cls });
      else if (cls.startsWith("text-") && !TOKEN_TEXT.test(cls))
        out.push({ line, kind: "图标颜色", what: cls });
    }
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

/** 扫描仓库，返回违规清单（"路径:行 种类 内容"） */
export function run(root) {
  const findings = [];
  let scanned = 0;
  for (const dir of SCAN_DIRS) {
    for (const file of walk(join(root, dir))) {
      const rel = relative(root, file).split(sep).join("/");
      const code = readFileSync(file, "utf8");
      scanned += 1;
      const found = [...findForbiddenImports(code), ...findIconUsageIssues(code)];
      if (rel.startsWith(`${ICON_DIR}/`))
        found.push(...findIconDataColors(code, { fileTokens: rel === FILE_ICON_DATA }));
      for (const v of found.sort((a, b) => a.line - b.line))
        findings.push(`${rel}:${v.line} ${v.kind} ${v.what}`);
    }
  }
  return { findings, scanned };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const { findings, scanned } = run(root);
  if (findings.length > 0) {
    console.error(`✗ 发现 ${findings.length} 处不符合图标规范：`);
    for (const f of findings) console.error(`  - ${f}`);
    console.error(
      '  请只用 @/components/icons 的 <Icon name size="sm|md|…" />；颜色用 text-muted / text-danger 等令牌类继承，不写透明度或任意颜色；缺图标时在 scripts/vendor-reicon.mjs 里加映射后重新生成。',
    );
    process.exit(1);
  }
  console.log(`✓ 图标检查通过（扫描 ${scanned} 个文件）`);
}
