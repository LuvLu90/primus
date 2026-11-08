import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FILE_INLINE_MAX_BYTES } from "@primus/protocol";
import { afterAll, describe, expect, it } from "vitest";
import attach, { decodeText, expandAttachments, readInline } from "./index.ts";

const dir = mkdtempSync(join(tmpdir(), "primus-attach-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function file(name: string, data: string | Uint8Array): string {
  const path = join(dir, name);
  writeFileSync(path, data);
  return path;
}

type Handler = (
  event: { text: string; images?: unknown[]; source?: string },
  ctx: { cwd?: string },
) => Promise<{ action: string; text?: string; images?: unknown[] }>;

function handlerOf(): Handler {
  let handler: Handler | undefined;
  attach({
    on: (event: string, h: Handler) => {
      if (event === "input") handler = h;
    },
  });
  if (!handler) throw new Error("没有注册 input 处理器");
  return handler;
}

describe("primus-attach", () => {
  it("文本文件在上限内内联，去掉 BOM", async () => {
    const md = file("说明.md", "\ufeff# 标题\n正文");
    expect(await readInline(md)).toBe("# 标题\n正文");
  });

  it("二进制、空文件、超出上限、不存在的文件都不内联", async () => {
    const xlsx = file("表.xlsx", new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0, 0, 0]));
    const pdf = file("a.pdf", "%PDF-1.7\nplain looking text");
    const nul = file("a.bin", new Uint8Array([0x61, 0, 0x62]));
    const gbk = file("gbk.csv", new Uint8Array([0xc4, 0xe3, 0xba, 0xc3]));
    const empty = file("empty.txt", "");
    const big = file("big.log", "x".repeat(FILE_INLINE_MAX_BYTES + 1));
    const lines = file("lines.txt", "a\n".repeat(2500));
    for (const p of [xlsx, pdf, nul, gbk, empty, big, lines, join(dir, "missing.txt"), dir])
      expect(await readInline(p), p).toBeUndefined();
  });

  it("图片按文件头识别为二进制", () => {
    expect(decodeText(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]))).toBeUndefined();
    expect(decodeText(new TextEncoder().encode("纯文本"))).toBe("纯文本");
  });

  it("只展开消息末尾的空标签，其余原样保留", async () => {
    const md = file("a.md", "内容");
    const xlsx = file("b.xlsx", new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    const text = `帮我看看\n\n<file name="${md}"></file>\n<file name="${xlsx}"></file>`;
    expect(await expandAttachments(text, dir)).toBe(
      `帮我看看\n\n<file name="${md}">\n内容\n</file>\n<file name="${xlsx}"></file>`,
    );
    // 没有可展开的：不改写
    expect(await expandAttachments(`问\n\n<file name="${xlsx}"></file>`, dir)).toBeUndefined();
    expect(await expandAttachments("普通消息", dir)).toBeUndefined();
  });

  it("相对路径按会话工作目录解析，标签里仍写原路径", async () => {
    file("rel.txt", "hi");
    expect(await expandAttachments('<file name="rel.txt"></file>', dir)).toBe(
      '<file name="rel.txt">\nhi\n</file>',
    );
  });

  it("input 事件：改写正文并原样带上图片；扩展自己发出的消息不处理", async () => {
    const md = file("c.md", "C");
    const handler = handlerOf();
    const images = [{ type: "image", mimeType: "image/png", data: "x" }];
    const text = `看\n\n<file name="${md}"></file>`;
    expect(await handler({ text, images, source: "rpc" }, { cwd: dir })).toEqual({
      action: "transform",
      text: `看\n\n<file name="${md}">\nC\n</file>`,
      images,
    });
    expect(await handler({ text, source: "extension" }, { cwd: dir })).toEqual({
      action: "continue",
    });
    expect(await handler({ text: "hi", source: "rpc" }, { cwd: dir })).toEqual({
      action: "continue",
    });
  });

  it("没有事件 API 时什么也不做", () => {
    expect(() => attach({})).not.toThrow();
  });
});
