// 右栏预览的纯逻辑：路径拼接与面包屑、大小与时间格式、按扩展名判断预览方式、JSON 格式化。

/** 路径用的分隔符：含反斜杠（Windows）用反斜杠，否则用斜杠 */
const sepOf = (path: string) => (path.includes("\\") ? "\\" : "/");

/** 去掉末尾分隔符（根目录 `C:\`、`/` 保留） */
export function trimDir(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  if (trimmed === "") return path.startsWith("/") ? "/" : path;
  // `C:` → `C:\`
  if (/^[A-Za-z]:$/.test(trimmed)) return `${trimmed}${sepOf(path) === "/" ? "/" : "\\"}`;
  return trimmed;
}

/** 文件夹下的子项路径 */
export function joinPath(dir: string, name: string): string {
  const base = trimDir(dir);
  return /[\\/]$/.test(base) ? `${base}${name}` : `${base}${sepOf(base)}${name}`;
}

/** 上一级文件夹；已是根目录（`C:\`、`/`）时为 null */
export function parentPath(path: string): string | null {
  const base = trimDir(path);
  if (/[\\/]$/.test(base)) return null;
  const i = Math.max(base.lastIndexOf("\\"), base.lastIndexOf("/"));
  if (i < 0) return null;
  // `C:\x` → `C:\`，`/x` → `/`
  return trimDir(base.slice(0, i + 1));
}

/** 面包屑：从根到当前文件夹的每一级（名称 + 路径） */
export function breadcrumbs(path: string): { name: string; path: string }[] {
  const out: { name: string; path: string }[] = [];
  let current: string | null = trimDir(path);
  while (current) {
    const name = /[\\/]$/.test(current)
      ? current.replace(/[\\/]$/, "") || "/"
      : current.slice(Math.max(current.lastIndexOf("\\"), current.lastIndexOf("/")) + 1);
    out.unshift({ name, path: current });
    current = parentPath(current);
  }
  return out;
}

/** 文件大小：B / KB / MB / GB（1024 进制，与资源管理器一致；KB 起保留 1 位小数，≥ 100 取整） */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const shown = value >= 100 ? Math.round(value).toString() : value.toFixed(1).replace(/\.0$/, "");
  return `${shown} ${units[unit]}`;
}

/** 修改时间：本地时间 `YYYY-MM-DD HH:mm` */
export function formatModified(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 整份字节交给前端、用 blob URL 显示或播放的类型（扩展名与薄壳 preview.rs 一致） */
export type BlobKind = "image" | "audio" | "video";

const BLOB_TYPES: Record<string, { kind: BlobKind; mime: string }> = {
  gif: { kind: "image", mime: "image/gif" },
  ico: { kind: "image", mime: "image/x-icon" },
  avif: { kind: "image", mime: "image/avif" },
  mp3: { kind: "audio", mime: "audio/mpeg" },
  wav: { kind: "audio", mime: "audio/wav" },
  ogg: { kind: "audio", mime: "audio/ogg" },
  oga: { kind: "audio", mime: "audio/ogg" },
  opus: { kind: "audio", mime: "audio/ogg" },
  m4a: { kind: "audio", mime: "audio/mp4" },
  aac: { kind: "audio", mime: "audio/aac" },
  flac: { kind: "audio", mime: "audio/flac" },
  mp4: { kind: "video", mime: "video/mp4" },
  m4v: { kind: "video", mime: "video/mp4" },
  webm: { kind: "video", mime: "video/webm" },
  mov: { kind: "video", mime: "video/quicktime" },
  ogv: { kind: "video", mime: "video/ogg" },
};

/** 按扩展名判断是否走 blob 显示 / 播放 */
export function blobTypeOf(path: string): { kind: BlobKind; mime: string } | null {
  const m = /\.([A-Za-z0-9]+)$/.exec(path);
  return (m?.[1] && BLOB_TYPES[m[1].toLowerCase()]) || null;
}

/**
 * JSON 格式化（缩进 2 空格）：先确认是合法 JSON，再按词法重排空白，数字、字符串原样保留
 * （不经 JSON.parse / stringify 往返，超过 2^53 的整数、`1.0` 这类写法不会被改写）。不是合法 JSON 时返回 null
 */
export function prettyJson(text: string): string | null {
  try {
    JSON.parse(text);
  } catch {
    return null;
  }
  let out = "";
  let depth = 0;
  const newline = () => `\n${"  ".repeat(depth)}`;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (ch === '"') {
      // 字符串整段原样复制（含转义）
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (ch === "{" || ch === "[") {
      // 空对象 / 空数组保持在一行
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j] as string)) j++;
      if (text[j] === (ch === "{" ? "}" : "]")) {
        out += ch + text[j];
        i = j;
      } else {
        depth++;
        out += ch + newline();
      }
    } else if (ch === "}" || ch === "]") {
      depth--;
      out += newline() + ch;
    } else if (ch === ",") {
      out += `,${newline()}`;
    } else if (ch === ":") {
      out += ": ";
    } else if (!/\s/.test(ch)) {
      out += ch;
    }
  }
  return out;
}
