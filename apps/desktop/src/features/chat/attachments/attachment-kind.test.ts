import { describe, expect, it } from "vitest";
import { attachmentKind, extensionOf, kindFromMime } from "./attachment-kind";

describe("附件类型", () => {
  it("按扩展名映射到七种类型（不区分大小写，兼容 Windows 路径）", () => {
    expect(attachmentKind("C:\\Users\\me\\截图.PNG")).toBe("image");
    expect(attachmentKind("/tmp/photo.jpeg")).toBe("image");
    expect(attachmentKind("需求说明.docx")).toBe("document");
    expect(attachmentKind("notes.md")).toBe("document");
    expect(attachmentKind("预算.xlsx")).toBe("spreadsheet");
    expect(attachmentKind("data.csv")).toBe("spreadsheet");
    expect(attachmentKind("路演.pptx")).toBe("presentation");
    expect(attachmentKind("chat-panel.tsx")).toBe("code");
    expect(attachmentKind("icon.svg")).toBe("code");
    expect(attachmentKind("demo.mov")).toBe("video");
    expect(attachmentKind("archive.zip")).toBe("other");
    expect(attachmentKind("Makefile")).toBe("other");
  });

  it("扩展名：隐藏文件与无扩展名为空", () => {
    expect(extensionOf(".gitignore")).toBe("");
    expect(extensionOf("C:\\a.b\\file")).toBe("");
    expect(extensionOf("a/b/c.Tar.GZ")).toBe("gz");
  });

  it("MIME：只有可解码的图片格式算图片", () => {
    expect(kindFromMime("image/png")).toBe("image");
    expect(kindFromMime("image/jpeg")).toBe("image");
    expect(kindFromMime("image/webp")).toBe("image");
    expect(kindFromMime("image/svg+xml")).toBe("other");
    expect(kindFromMime("application/pdf")).toBe("other");
  });
});
