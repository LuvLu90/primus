#!/usr/bin/env node
// 把 Material Icon Theme（https://github.com/material-extensions/vscode-material-icon-theme ，MIT）
// 的彩色文件类型图标收进仓库（技术方案第 16 章“图标”；与 scripts/vendor-reicon.mjs 是姊妹脚本）。
// 不引入依赖：先手动下载 npm 包 material-icon-theme 的 tarball 并解压，再运行
//   node scripts/vendor-file-icons.mjs <解压出的 package 目录>
//   pnpm exec biome format --write apps/desktop/src/components/icons/file-icons.generated.ts
// 输出 apps/desktop/src/components/icons/file-icons.generated.ts（提交生成结果，不提交下载的包）。
//
// 规则：文件类型图标是图标规范里唯一允许多色的一组（check:icons 对这个文件单独放行）：
// 颜色不写死十六进制，而是换成 globals.css @theme 里的 --color-file-* 令牌（Material 调色板命名），
// 深色主题需要提亮的颜色在 .dark 里覆盖。源文件出现未登记的颜色、渐变、蒙版、透明度或未知元素时直接失败。
// 新增类型：在 ICONS 里加一行（名称按用途命名），必要时在 PALETTE 与 globals.css 里补令牌，重新生成。
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSvg } from "./vendor-reicon.mjs";

/** 已验证的上游版本（下载 https://registry.npmjs.org/material-icon-theme/-/material-icon-theme-<版本>.tgz） */
export const MATERIAL_VERSION = "5.40.0";

/** 应用内文件图标名 → Material Icon Theme 的 icons/<名>.svg */
export const ICONS = {
  // 通用
  file: "file",
  folder: "folder",
  // 代码
  typescript: "typescript",
  "react-ts": "react_ts",
  javascript: "javascript",
  react: "react",
  json: "json",
  html: "html",
  css: "css",
  sass: "sass",
  python: "python",
  rust: "rust",
  go: "go",
  java: "java",
  c: "c",
  cpp: "cpp",
  csharp: "csharp",
  swift: "swift",
  php: "php",
  ruby: "ruby",
  vue: "vue",
  svelte: "svelte",
  lua: "lua",
  dart: "dart",
  scala: "scala",
  console: "console",
  powershell: "powershell",
  xml: "xml",
  yaml: "yaml",
  toml: "toml",
  settings: "settings",
  database: "database",
  graphql: "graphql",
  docker: "docker",
  makefile: "makefile",
  git: "git",
  diff: "diff",
  lock: "lock",
  // 文档与数据
  markdown: "markdown",
  document: "document",
  log: "log",
  readme: "readme",
  license: "license",
  tex: "tex",
  word: "word",
  table: "table",
  powerpoint: "powerpoint",
  pdf: "pdf",
  // 媒体与归档
  image: "image",
  svg: "svg",
  video: "video",
  audio: "audio",
  font: "font",
  zip: "zip",
  exe: "exe",
};

/** 源文件里的颜色 → 设计令牌名（--color-file-<名>，Material Design 调色板命名；Vue 的两种品牌色单列） */
export const PALETTE = {
  "#0288d1": "light-blue-700",
  "#03a9f4": "light-blue-500",
  "#4fc3f7": "light-blue-300",
  "#01579b": "light-blue-900",
  "#2196f3": "blue-500",
  "#42a5f5": "blue-400",
  "#64b5f6": "blue-300",
  "#1e88e5": "blue-600",
  "#00bcd4": "cyan-500",
  "#00acc1": "cyan-600",
  "#26a69a": "teal-400",
  "#8bc34a": "light-green-500",
  "#afb42b": "lime-700",
  "#fdd835": "yellow-600",
  "#f9a825": "yellow-800",
  "#ffd54f": "amber-300",
  "#ffca28": "amber-400",
  "#ffb300": "amber-600",
  "#ff9800": "orange-500",
  "#e65100": "orange-900",
  "#ff6e40": "deep-orange-a200",
  "#ff7043": "deep-orange-400",
  "#ff5722": "deep-orange-500",
  "#e64a19": "deep-orange-700",
  "#ff5252": "red-a200",
  "#ef5350": "red-400",
  "#f44336": "red-500",
  "#ec407a": "pink-400",
  "#7e57c2": "deep-purple-400",
  "#cfd8dc": "blue-grey-100",
  "#90a4ae": "blue-grey-300",
  "#41b883": "vue-green",
  "#35495e": "vue-navy",
};

/** 根 <svg> 上会影响渲染、但生成结果不保留的属性 */
const ROOT_RENDER_ATTR =
  /^(?:opacity|fill-opacity|fill-rule|clip-rule|clip-path|mask|filter|transform|style|color|display|visibility|stroke(?:-[a-z]+)?)$/;

const ALLOWED_TAGS = new Set(["path", "circle", "rect", "ellipse", "polygon", "g"]);
const KEEP_ATTRS = new Set([
  "d",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "x",
  "y",
  "width",
  "height",
  "points",
  "fill-rule",
  "clip-rule",
]);
const REACT_ATTR = { "fill-rule": "fillRule", "clip-rule": "clipRule" };

/** 颜色 → var(--color-file-…)；未登记的颜色直接失败 */
export function paint(value, iconName) {
  if (value === "none") return "none";
  const hex = value.toLowerCase();
  const token = PALETTE[hex];
  if (!token)
    throw new Error(
      `${iconName}: 颜色 ${value} 没有对应的 --color-file-* 令牌，先在 PALETTE 里登记`,
    );
  return `var(--color-file-${token})`;
}

/** 校验并规范化为 [标签, React 属性, 子节点?]；fill 继承自根元素，未填色的占位矩形（fill=none）去掉 */
export function normalize(nodes, iconName, inheritedFill) {
  const out = [];
  for (const n of nodes) {
    if (!ALLOWED_TAGS.has(n.tag)) throw new Error(`${iconName}: 不支持的元素 <${n.tag}>`);
    const fill = n.attrs.fill ?? inheritedFill;
    const attrs = {};
    for (const [k, v] of Object.entries(n.attrs)) {
      if (k === "fill" || k === "xmlns") continue;
      if (!KEEP_ATTRS.has(k)) throw new Error(`${iconName}: 不支持的属性 ${k}="${v}"`);
      attrs[REACT_ATTR[k] ?? k] = v;
    }
    if (n.tag === "g") {
      const children = normalize(n.children, iconName, fill);
      if (Object.keys(attrs).length === 0) out.push(...children);
      else out.push(["g", attrs, children]);
      continue;
    }
    if (!fill) throw new Error(`${iconName}: <${n.tag}> 没有填色（SVG 默认黑色），不收录`);
    if (fill === "none") continue;
    out.push([n.tag, { ...attrs, fill: paint(fill, iconName) }]);
  }
  return out;
}

export function readIcon(pkgDir, source, iconName) {
  const file = join(pkgDir, "icons", `${source}.svg`);
  if (!existsSync(file)) throw new Error(`Material Icon Theme 没有图标 ${source}（${file}）`);
  const [root, ...rest] = parseSvg(readFileSync(file, "utf8").replace(/<\?xml[^>]*>/, ""));
  if (root?.tag !== "svg" || rest.length) throw new Error(`${iconName}: 根元素不是单个 <svg>`);
  // 根元素上的渲染属性（opacity、transform、style…）生成时不会保留，不能静默丢掉
  for (const k of Object.keys(root.attrs)) {
    if (ROOT_RENDER_ATTR.test(k)) throw new Error(`${iconName}: 不支持根元素属性 ${k}`);
  }
  const viewBox = root.attrs.viewBox;
  if (!/^-?[\d.]+ -?[\d.]+ [\d.]+ [\d.]+$/.test(viewBox ?? ""))
    throw new Error(`${iconName}: viewBox 无效`);
  // 根元素的 fill 是子元素的默认填色（SVG 默认黑色：没写就当作必须显式填色）
  const nodes = normalize(root.children, iconName, root.attrs.fill);
  if (nodes.length === 0) throw new Error(`${iconName}: 没有可见图形`);
  return { viewBox, nodes };
}

/** 生成结果用到的全部令牌（globals.css 必须都定义） */
export function tokensOf(icons) {
  const used = new Set();
  const visit = (nodes) => {
    for (const [, attrs, children] of nodes) {
      const m = /^var\(--color-file-([a-z0-9-]+)\)$/.exec(attrs.fill ?? "");
      if (m) used.add(m[1]);
      if (children) visit(children);
    }
  };
  for (const icon of Object.values(icons)) visit(icon.nodes);
  return [...used].sort();
}

export function build(pkgDir) {
  const icons = {};
  const lines = [];
  for (const [name, source] of Object.entries(ICONS)) {
    const icon = readIcon(pkgDir, source, name);
    icons[name] = icon;
    lines.push(`  // ${source}.svg`);
    lines.push(`  ${JSON.stringify(name)}: ${JSON.stringify(icon)},`);
  }
  const code = [
    "// 由 scripts/vendor-file-icons.mjs 生成，不要手改。",
    `// 来源：Material Icon Theme（material-icon-theme ${MATERIAL_VERSION}，MIT），许可与署名见同目录 NOTICE.md。`,
    "// 颜色是 globals.css @theme 的 --color-file-* 令牌（文件类型图标是唯一允许多色的一组）。",
    'import type { IconNode } from "./icon-node";',
    "",
    "export const FILE_ICONS = {",
    ...lines,
    "} as const satisfies Record<string, { viewBox: string; nodes: readonly IconNode[] }>;",
    "",
    "export type FileIconName = keyof typeof FILE_ICONS;",
    "",
  ].join("\n");
  return { code, tokens: tokensOf(icons) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const pkgDir = process.argv[2];
  if (!pkgDir) {
    console.error("用法：node scripts/vendor-file-icons.mjs <material-icon-theme 解压目录>");
    process.exit(1);
  }
  const version = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")).version;
  if (version !== MATERIAL_VERSION)
    console.warn(`! 解压目录是 material-icon-theme ${version}，脚本验证过的是 ${MATERIAL_VERSION}`);
  const root = fileURLToPath(new URL("..", import.meta.url));
  const { code, tokens } = build(pkgDir);
  const css = readFileSync(join(root, "apps/desktop/src/app/globals.css"), "utf8");
  const missing = tokens.filter((t) => !css.includes(`--color-file-${t}:`));
  if (missing.length) {
    console.error(
      `✗ globals.css @theme 缺少令牌：${missing.map((t) => `--color-file-${t}`).join("、")}`,
    );
    process.exit(1);
  }
  const out = join(root, "apps/desktop/src/components/icons/file-icons.generated.ts");
  writeFileSync(out, code);
  console.log(
    `✓ 已生成 ${Object.keys(ICONS).length} 个文件类型图标（${tokens.length} 种颜色）→ ${out}`,
  );
}
