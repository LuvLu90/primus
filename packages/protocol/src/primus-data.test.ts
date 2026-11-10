import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  PREVIEW_DOCUMENT_MAX_BYTES,
  PREVIEW_IMAGE_MAX_BYTES,
  PREVIEW_MEDIA_MAX_BYTES,
  PREVIEW_TEXT_MAX_BYTES,
  PREVIEW_WIDGET,
  previewKindOf,
} from "./primus-data.ts";

const SHELL = new URL("../../../apps/desktop/src-tauri/src/", import.meta.url);
const rust = (file: string) => readFileSync(fileURLToPath(new URL(file, SHELL)), "utf8");
/** `pub(crate) const NAME: u64 = a * b * c;` 的值 */
const rustConst = (src: string, name: string) => {
  const m = new RegExp(`const ${name}: u64 = ([0-9_ *]+);`).exec(src);
  if (!m?.[1]) throw new Error(`找不到 ${name}`);
  return m[1].split("*").reduce((n, x) => n * Number(x.trim().replaceAll("_", "")), 1);
};

describe("primus:preview", () => {
  it("数据主题带 primus: 前缀", () => {
    expect(PREVIEW_WIDGET).toBe("primus:preview");
  });

  it("按扩展名分类（不区分大小写，Windows 与 POSIX 路径都行）", () => {
    expect(previewKindOf("C:\\w\\报告.DOCX")).toBe("document");
    expect(previewKindOf("/w/a.pptx")).toBe("document");
    expect(previewKindOf("/w/a.pdf")).toBe("document");
    expect(previewKindOf("/w/表.xlsm")).toBe("spreadsheet");
    expect(previewKindOf("/w/a.csv")).toBe("spreadsheet");
    expect(previewKindOf("/w/a.tsv")).toBe("spreadsheet");
    expect(previewKindOf("/w/README.md")).toBe("markdown");
    expect(previewKindOf("/w/index.HTM")).toBe("html");
    expect(previewKindOf("/w/logo.svg")).toBe("image");
    expect(previewKindOf("/w/a.JPEG")).toBe("image");
    expect(previewKindOf("/w/a.mp4")).toBe("media");
    expect(previewKindOf("/w/a.mp3")).toBe("media");
    expect(previewKindOf("/w/旧.doc")).toBe("other");
    expect(previewKindOf("/w/a.zip")).toBe("other");
    expect(previewKindOf("/w/main.ts")).toBe("text");
    expect(previewKindOf("/w/Makefile")).toBe("text");
    expect(previewKindOf("/w/.gitignore")).toBe("text");
  });

  it("上限与薄壳一致（preview.rs、attachments.rs）", () => {
    expect(PREVIEW_TEXT_MAX_BYTES).toBe(rustConst(rust("preview.rs"), "MAX_BYTES"));
    expect(PREVIEW_DOCUMENT_MAX_BYTES).toBe(rustConst(rust("preview.rs"), "MAX_DOCUMENT_BYTES"));
    expect(PREVIEW_IMAGE_MAX_BYTES).toBe(rustConst(rust("attachments.rs"), "MAX_INPUT_BYTES"));
    expect(PREVIEW_MEDIA_MAX_BYTES).toBe(rustConst(rust("preview.rs"), "MAX_MEDIA_BYTES"));
  });

  it("整份字节渲染的扩展名与薄壳 DOCUMENT_EXTENSIONS 一致", () => {
    const m = /DOCUMENT_EXTENSIONS: &\[&str\] = &\[([^\]]*)\]/.exec(rust("preview.rs"));
    const exts = [...(m?.[1] ?? "").matchAll(/"(\w+)"/g)].map((x) => x[1] as string);
    expect(exts.length).toBeGreaterThan(0);
    for (const ext of exts)
      expect(["document", "spreadsheet"]).toContain(previewKindOf(`a.${ext}`));
  });
});
