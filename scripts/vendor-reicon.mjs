#!/usr/bin/env node
// 把 Reicon（https://reicon.dev，MIT）的 Outline 图标收进仓库（技术方案第 16 章“图标”）。
// 不引入依赖：先手动下载 npm 包 reicon-react 的 tarball 并解压，再运行
//   node scripts/vendor-reicon.mjs <解压出的 package 目录>
//   pnpm exec biome format --write apps/desktop/src/components/icons/icons.generated.ts
// 输出 apps/desktop/src/components/icons/icons.generated.ts（提交生成结果，不提交下载的包）。
//
// 规则：只取 Outline 字重（24px 网格，线宽 1.5）；颜色只允许 currentColor / none，
// 出现其他颜色、整幅 24×24 之外的 clipPath 或未知元素时直接失败；整幅 clipPath 去掉（多实例时 id 会重复）。
// 新增图标：在下面 ICONS 里加一行（名称用 kebab-case，按用途命名而不是按 Reicon 原名），重新生成。
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** 已验证的上游版本（下载 https://registry.npmjs.org/reicon-react/-/reicon-react-<版本>.tgz） */
export const REICON_VERSION = "1.2.6";

/**
 * 应用内图标名 → Reicon 图标。weight 默认 Outline（O）；只有"停止"这种实心语义用 Filled（F）。
 * mirror：水平镜像（Reicon 只有一侧的图标）。
 * extra：在源图标上追加的元素（同样只能用 currentColor、线宽 1.5），用于 Reicon 缺少的图形。
 */
export const ICONS = {
  // 通用操作
  check: { source: "Check" },
  x: { source: "Xmark" },
  plus: { source: "Plus" },
  minus: { source: "Minus" },
  copy: { source: "Copy" },
  search: { source: "Search" },
  trash: { source: "Trash2" },
  pen: { source: "Pen" },
  compose: { source: "PenSquare" },
  download: { source: "Download" },
  more: { source: "MoreH" },
  "arrow-up": { source: "ArrowUp" },
  "chevron-down": { source: "ChevronDown" },
  "chevron-left": { source: "ChevronLeft" },
  "chevron-right": { source: "ChevronRight" },
  maximize: { source: "Maximize" },
  minimize: { source: "Minimize" },
  stop: { source: "Stop", weight: "F" },
  refresh: { source: "Refresh" },
  retry: { source: "Restart" },
  archive: { source: "Archive" },
  "archive-restore": { source: "ArchiveUp" },
  mic: { source: "Microphone" },
  link: { source: "Link" },
  "external-link": { source: "ArrowUpRightSquare" },
  // 状态
  "alert-circle": { source: "AlertCircle" },
  "check-circle": { source: "CheckCircle" },
  "x-circle": { source: "XCircle" },
  "stop-circle": { source: "StopCircle" },
  ban: { source: "ForbiddenCircle" },
  activity: { source: "Graph" },
  "wifi-off": { source: "WifiOff" },
  key: { source: "Key" },
  gauge: { source: "Speedometer" },
  server: { source: "Server" },
  // 权限模式“询问”：会先问你（对话气泡）
  ask: { source: "ChatRoundDots" },
  "shield-check": { source: "ShieldCheck" },
  "shield-alert": { source: "ShieldAlert" },
  "shield-user": { source: "ShieldUser" },
  // 导航与布局
  "sidebar-left": { source: "Sidebar2" },
  // Reicon 只有左侧栏样式：水平镜像得到右侧栏
  "sidebar-right": { source: "Sidebar2", mirror: true },
  settings: { source: "Gear" },
  tuning: { source: "Tuning2" },
  user: { source: "User" },
  chart: { source: "Chart" },
  puzzle: { source: "Puzzle" },
  "list-check": { source: "ListCheck" },
  "file-tree": { source: "DiagramTree" },
  diff: { source: "PlusMinus" },
  logs: { source: "ClipboardList" },
  "git-branch": { source: "Hierarchy2" },
  // 工作过程（工具调用）
  terminal: { source: "Programming" },
  tool: { source: "Sledgehammer" },
  // 思考：主星 + 两颗小星（三个 path，顺序：右上小星、主星、右下小星），进行中由 CSS 分别做动画
  thinking: { source: "Sparkles" },
  "pen-edit": { source: "Pen2" },
  // 工具行“已读取”（彩色文件类型图标另见 scripts/vendor-file-icons.mjs）
  "file-text": { source: "FileText" },
  // 文件夹（工作区）
  folder: { source: "Folder2" },
  "folder-open": { source: "FolderOpen" },
  // Windows 标题栏按钮
  "window-maximize": { source: "Stop3" },
  "window-restore": { source: "Copy3" },
};

const MIRROR = "matrix(-1 0 0 1 24 0)";
const ALLOWED_TAGS = new Set([
  "path",
  "rect",
  "circle",
  "line",
  "polyline",
  "polygon",
  "ellipse",
  "g",
]);
const ALLOWED_PAINT = new Set(["currentColor", "none"]);
/** SVG 属性 → React 属性名 */
const REACT_ATTR = {
  "fill-rule": "fillRule",
  "clip-rule": "clipRule",
  "stroke-width": "strokeWidth",
  "stroke-linecap": "strokeLinecap",
  "stroke-linejoin": "strokeLinejoin",
  "stroke-miterlimit": "strokeMiterlimit",
  "stroke-dasharray": "strokeDasharray",
};

/** 读 reicon-react 的 icons/<名>.js，取出某个字重的 SVG 片段 */
export function readSource(pkgDir, name, weight = "O") {
  const file = join(pkgDir, "icons", `${name}.js`);
  if (!existsSync(file)) throw new Error(`Reicon 没有图标 ${name}（${file}）`);
  const m = readFileSync(file, "utf8").match(new RegExp(`\\b${weight}:\\s*\`([^\`]*)\``));
  if (!m) throw new Error(`${name} 没有 ${weight} 字重`);
  return m[1];
}

/** 极简 SVG 片段解析（Reicon 的片段只有扁平元素、<g> 与 <defs><clipPath>） */
export function parseSvg(fragment) {
  const root = { tag: "#root", attrs: {}, children: [] };
  const stack = [root];
  // 完整的注释单独作为一项先匹配：注释里写的 <path …/> 不当成标签
  const re = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z]+)((?:\s+[\w:-]+="[^"]*")*)\s*(\/?)>/g;
  // 标签之间只允许空白与注释：其他内容（如单引号属性的元素）说明没解析到，不能静默跳过
  const checkGap = (gap) => {
    const rest = gap.replace(/<!--[\s\S]*?-->/g, "").trim();
    if (rest) throw new Error(`无法解析的 SVG 内容：${rest.slice(0, 80)}`);
  };
  let last = 0;
  for (const m of fragment.matchAll(re)) {
    checkGap(fragment.slice(last, m.index));
    last = m.index + m[0].length;
    const [, closing, tag, rawAttrs, selfClosing] = m;
    if (tag === undefined) continue;
    if (closing) {
      const top = stack.pop();
      if (top?.tag !== tag) throw new Error(`标签不配对：</${tag}>`);
      continue;
    }
    const attrs = {};
    for (const a of rawAttrs.matchAll(/([\w:-]+)="([^"]*)"/g)) attrs[a[1]] = a[2];
    const node = { tag, attrs, children: [] };
    stack.at(-1).children.push(node);
    if (!selfClosing) stack.push(node);
  }
  checkGap(fragment.slice(last));
  if (stack.length !== 1) throw new Error("SVG 片段未闭合");
  return root.children;
}

/** 能确认覆盖整幅 24×24 画布的裁剪：只有一个无圆角、无变换的 0,0 起点矩形，clipPath 自身也不带变换等属性 */
function isFullClip(defs, id) {
  const clip = defs
    .flatMap((d) => d.children)
    .find((c) => c.tag === "clipPath" && c.attrs.id === id);
  const rect = clip?.children[0];
  if (clip?.children.length !== 1 || rect.tag !== "rect" || rect.children.length) return false;
  if (Object.keys(clip.attrs).some((k) => k !== "id")) return false;
  // 矩形上除宽高、0 起点与填色外的属性（rx / ry / transform…）都可能让裁剪小于画布
  const zero = (v) => v === undefined || Number(v) === 0;
  return (
    rect.attrs.width === "24" &&
    rect.attrs.height === "24" &&
    zero(rect.attrs.x) &&
    zero(rect.attrs.y) &&
    Object.keys(rect.attrs).every((k) => ["width", "height", "x", "y", "fill"].includes(k))
  );
}

/** 校验并规范化为 [标签, React 属性, 子节点?] */
export function normalize(nodes, iconName) {
  const defs = nodes.filter((n) => n.tag === "defs");
  const out = [];
  for (const n of nodes) {
    if (n.tag === "defs") continue;
    if (!ALLOWED_TAGS.has(n.tag)) throw new Error(`${iconName}: 不支持的元素 <${n.tag}>`);
    const attrs = {};
    for (const [k, v] of Object.entries(n.attrs)) {
      if (k === "clip-path") {
        const id = v.match(/^url\(#(.+)\)$/)?.[1];
        if (!id || !isFullClip(defs, id)) throw new Error(`${iconName}: 不支持局部 clipPath`);
        continue;
      }
      if (k === "id") continue;
      if ((k === "fill" || k === "stroke") && !ALLOWED_PAINT.has(v))
        throw new Error(`${iconName}: 颜色只能是 currentColor / none，发现 ${k}="${v}"`);
      if (k === "stroke-width" && v !== "1.5")
        throw new Error(`${iconName}: 线宽必须是 1.5，发现 ${v}`);
      if (["opacity", "fill-opacity", "stroke-opacity", "style", "class"].includes(k))
        throw new Error(`${iconName}: 不允许 ${k} 属性`);
      attrs[REACT_ATTR[k] ?? k] = v;
    }
    const children = normalize(n.children, iconName);
    // 整幅 clipPath 去掉后，无属性的 <g> 直接展开
    if (n.tag === "g" && Object.keys(attrs).length === 0) out.push(...children);
    else out.push(children.length ? [n.tag, attrs, children] : [n.tag, attrs]);
  }
  return out;
}

export function build(pkgDir) {
  const lines = [];
  for (const [name, spec] of Object.entries(ICONS)) {
    const svg = readSource(pkgDir, spec.source, spec.weight) + (spec.extra ?? "");
    let nodes = normalize(parseSvg(svg), name);
    if (spec.mirror) nodes = [["g", { transform: MIRROR }, nodes]];
    const from = `${spec.source}${spec.weight === "F" ? "（Filled）" : ""}${spec.mirror ? "（水平镜像）" : ""}${spec.extra ? " + 追加图形" : ""}`;
    lines.push(`  // ${from}`);
    lines.push(`  ${JSON.stringify(name)}: ${JSON.stringify(nodes)},`);
  }
  return [
    "// 由 scripts/vendor-reicon.mjs 生成，不要手改。",
    `// 来源：Reicon（reicon-react ${REICON_VERSION}，Outline 字重，MIT），许可与署名见同目录 NOTICE.md。`,
    'import type { IconNode } from "./icon-node";',
    "",
    "export const ICON_NODES = {",
    ...lines,
    "} as const satisfies Record<string, readonly IconNode[]>;",
    "",
    "export type IconName = keyof typeof ICON_NODES;",
    "",
  ].join("\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const pkgDir = process.argv[2];
  if (!pkgDir) {
    console.error("用法：node scripts/vendor-reicon.mjs <reicon-react 解压目录>");
    process.exit(1);
  }
  const version = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")).version;
  if (version !== REICON_VERSION)
    console.warn(`! 解压目录是 reicon-react ${version}，脚本验证过的是 ${REICON_VERSION}`);
  const root = fileURLToPath(new URL("..", import.meta.url));
  const out = join(root, "apps/desktop/src/components/icons/icons.generated.ts");
  writeFileSync(out, build(pkgDir));
  console.log(`✓ 已生成 ${Object.keys(ICONS).length} 个图标 → ${out}`);
}
