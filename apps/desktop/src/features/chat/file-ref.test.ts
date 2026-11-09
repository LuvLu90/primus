import { describe, expect, it } from "vitest";
import {
  fileRefCopyText,
  fileRefFromCode,
  fileRefFromHref,
  fileRefIcon,
  fileRefLineLabel,
  resolveFileRefPath,
} from "./file-ref";

describe("链接地址识别为文件引用", () => {
  it.each([
    ["src/chat-panel.tsx", "src/chat-panel.tsx", "chat-panel.tsx", undefined, undefined],
    ["./a/b.ts", "./a/b.ts", "b.ts", undefined, undefined],
    ["../README.md", "../README.md", "README.md", undefined, undefined],
    ["/home/me/app.py", "/home/me/app.py", "app.py", undefined, undefined],
    ["~/notes.txt", "~/notes.txt", "notes.txt", undefined, undefined],
    ["chat-panel.tsx:42", "chat-panel.tsx", "chat-panel.tsx", 42, undefined],
    ["src/a.ts:42:7", "src/a.ts", "a.ts", 42, undefined],
    ["src/a.ts:42-58", "src/a.ts", "a.ts", 42, 58],
    ["src/a.ts#L10", "src/a.ts", "a.ts", 10, undefined],
    ["src/a.ts#L10-L20", "src/a.ts", "a.ts", 10, 20],
    ["src/a.ts#L10-20", "src/a.ts", "a.ts", 10, 20],
    ["docs/安装.md#快速开始", "docs/安装.md", "安装.md", undefined, undefined],
    ["docs/%E5%AE%89%E8%A3%85.md", "docs/安装.md", "安装.md", undefined, undefined],
    ["C:\\Users\\me\\a.ts", "C:\\Users\\me\\a.ts", "a.ts", undefined, undefined],
    ["C:/Users/me/a.ts:12", "C:/Users/me/a.ts", "a.ts", 12, undefined],
    [
      "\\\\server\\share\\报告.docx",
      "\\\\server\\share\\报告.docx",
      "报告.docx",
      undefined,
      undefined,
    ],
    ["file:///C:/Users/me/a%20b.ts", "C:/Users/me/a b.ts", "a b.ts", undefined, undefined],
    ["file:///home/me/a.py#L3", "/home/me/a.py", "a.py", 3, undefined],
    [
      "file:///home/me/My%20Project/report.md",
      "/home/me/My Project/report.md",
      "report.md",
      undefined,
      undefined,
    ],
    ["src/components/", "src/components/", "components", undefined, undefined],
  ])("%s", (href, path, name, line, endLine) => {
    const ref = fileRefFromHref(href);
    expect(ref).toMatchObject({ path, name });
    expect(ref?.line).toBe(line);
    expect(ref?.endLine).toBe(endLine);
  });

  it.each([
    "https://example.com/a.ts",
    "http://localhost:3000/src/a.ts",
    "HTTPS://EXAMPLE.COM",
    "mailto:me@example.com",
    "tel:10086",
    "javascript:alert(1)",
    "data:text/html,x",
    "ftp://host/file.zip",
    "vscode://file/a.ts",
    "//cdn.example.com/a.js",
    "#section",
    "www.example.com",
    "",
  ])("网址与其他协议不算：%s", (href) => {
    expect(fileRefFromHref(href)).toBeNull();
  });

  it("空格只在 Windows 绝对路径与 file:// 地址里允许，普通路径带空格不算", () => {
    expect(fileRefFromHref("src/my file.ts")).toBeNull();
    expect(fileRefFromHref("src/my%20file.ts")).toBeNull();
    expect(fileRefFromHref("C:\\Program Files\\a.ts")?.name).toBe("a.ts");
    expect(fileRefFromHref("file:///home/me/my%20file.ts")?.path).toBe("/home/me/my file.ts");
  });

  it("先分出 #片段再解码：编码的 %23 属于文件名", () => {
    expect(fileRefFromHref("file:///home/me/report%23final.pdf")?.path).toBe(
      "/home/me/report#final.pdf",
    );
    expect(fileRefFromHref("docs/a%23b.md#L4")).toMatchObject({ path: "docs/a#b.md", line: 4 });
  });

  it("行号按原文识别再解码：编码的 %3A 属于文件名", () => {
    const ref = fileRefFromHref("file:///home/me/report%3A2026");
    expect(ref).toMatchObject({ path: "/home/me/report:2026", name: "report:2026" });
    expect(ref?.line).toBeUndefined();
    expect(fileRefFromHref("file:///home/me/a%20b.ts:12")).toMatchObject({
      path: "/home/me/a b.ts",
      line: 12,
    });
  });

  it("file: 地址只认绝对路径", () => {
    expect(fileRefFromHref("file:notes.txt")).toBeNull();
    expect(fileRefFromCode("file:notes.txt")).toBeNull();
    expect(fileRefFromHref("file:/home/me/a.ts")?.path).toBe("/home/me/a.ts");
  });

  it("file:// 只接受本机地址，带主机名的网络引用不算", () => {
    expect(fileRefFromHref("file://server/share/report.pdf")).toBeNull();
    expect(fileRefFromCode("file://server/share/report.pdf")).toBeNull();
    expect(fileRefFromHref("file://localhost/home/me/a.ts")?.path).toBe("/home/me/a.ts");
    expect(fileRefFromHref("file://C:/Users/me/a.ts")?.path).toBe("C:/Users/me/a.ts");
  });

  it("文件夹以斜杠结尾", () => {
    expect(fileRefFromHref("src/components/")?.isDir).toBe(true);
    expect(fileRefFromHref("src/a.ts")?.isDir).toBe(false);
  });
});

describe("行内代码识别为文件引用", () => {
  it.each([
    ["package.json", "package.json", undefined],
    ["complaints_2026.csv", "complaints_2026.csv", undefined],
    ["apps/desktop/src/features/chat/chat-panel.tsx:42", "chat-panel.tsx", 42],
    ["src/a.ts:42:7", "a.ts", 42],
    ["src/a.ts#L10-L20", "a.ts", 10],
    ["@/lib/strings.ts", "strings.ts", undefined],
    ["C:\\Program Files\\Primus\\Primus.exe", "Primus.exe", undefined],
    ["D:/data/report.xlsx", "report.xlsx", undefined],
    ["src-tauri/", "src-tauri", undefined],
    ["/usr/local/bin", "bin", undefined],
    ["./scripts/build", "build", undefined],
    ["Dockerfile", "Dockerfile", undefined],
    [".gitignore", ".gitignore", undefined],
    [".env", ".env", undefined],
    ["config/.npmrc", ".npmrc", undefined],
    ["app/[id]/page.tsx", "page.tsx", undefined],
  ])("%s", (code, name, line) => {
    const ref = fileRefFromCode(code);
    expect(ref?.name).toBe(name);
    expect(ref?.line).toBe(line);
  });

  it.each([
    "console.log",
    "rows.filter",
    "os.path",
    "obj.method()",
    "v1.2.3",
    "1.0.0",
    "pnpm install",
    "pnpm analyze --month 10",
    "/compact",
    "/primus-plan",
    "a/b",
    "feat/new-ui",
    "text/plain",
    "std::vec::Vec",
    "foo.ts:bar",
    "https://example.com/a.ts",
    "mailto:a@b.c",
    "const x = 1",
    "a.ts#section",
    "x.y.z",
    "类别",
    "...",
    "$HOME/a.ts",
    "<div>",
    "",
    " a.ts",
  ])("普通代码不算：%s", (code) => {
    expect(fileRefFromCode(code)).toBeNull();
  });
});

/** 测试里确定能识别的地址 */
function refOf(href: string) {
  const ref = fileRefFromHref(href);
  if (!ref) throw new Error(`未识别：${href}`);
  return ref;
}

describe("显示与复制", () => {
  it("行号文字", () => {
    expect(fileRefLineLabel(refOf("a.ts"))).toBe("");
    expect(fileRefLineLabel(refOf("a.ts:42"))).toBe(":42");
    expect(fileRefLineLabel(refOf("a.ts:42:7"))).toBe(":42:7");
    expect(fileRefLineLabel(refOf("a.ts#L42-L58"))).toBe(":42–58");
    // 结束行不大于起始行时按单行处理
    expect(fileRefLineLabel(refOf("a.ts#L42-L42"))).toBe(":42");
  });

  it("复制的是路径加起始行", () => {
    expect(fileRefCopyText(refOf("src/a.ts#L42-L58"))).toBe("src/a.ts:42");
    expect(fileRefCopyText(refOf("src/a.ts:42:7"))).toBe("src/a.ts:42:7");
    expect(fileRefCopyText(refOf("C:\\x\\a.ts"))).toBe("C:\\x\\a.ts");
  });

  it.each([
    ["a.ts", "typescript"],
    ["a.tsx", "react-ts"],
    ["index.mjs", "javascript"],
    ["package.json", "json"],
    ["main.rs", "rust"],
    ["app.py", "python"],
    ["main.go", "go"],
    ["Main.java", "java"],
    ["x.cpp", "cpp"],
    ["build.sh", "console"],
    ["setup.ps1", "powershell"],
    ["ci.yml", "yaml"],
    ["Cargo.toml", "toml"],
    ["schema.sql", "database"],
    ["README.md", "markdown"],
    ["notes.txt", "document"],
    ["index.html", "html"],
    ["globals.css", "css"],
    ["方案.docx", "word"],
    ["手册.pdf", "pdf"],
    ["logo.PNG", "image"],
    ["icon.svg", "svg"],
    ["data.csv", "table"],
    ["汇报.pptx", "powerpoint"],
    ["Primus.msi", "exe"],
    ["src.zip", "zip"],
    ["demo.mp4", "video"],
    ["voice.mp3", "audio"],
    ["Makefile", "makefile"],
    ["Dockerfile", "docker"],
    ["LICENSE", "license"],
    [".gitignore", "git"],
    ["App.kt", "file"],
    ["a.unknownext", "file"],
  ])("%s 的图标是 %s", (name, icon) => {
    expect(fileRefIcon({ name, isDir: false })).toBe(icon);
  });

  it("文件夹用 folder 图标", () => {
    expect(fileRefIcon({ name: "src", isDir: true })).toBe("folder");
  });

  it("原型属性名当扩展名时回落到通用图标，行内代码也不认作文件", () => {
    for (const name of ["a.constructor", "a.__proto__", "a.toString", "a.hasOwnProperty"]) {
      expect(fileRefIcon({ name, isDir: false })).toBe("file");
    }
    expect(fileRefFromCode("a.toString")).toBeNull();
    expect(fileRefFromCode("x.valueOf")).toBeNull();
  });
});

describe("打开文件用的路径", () => {
  it.each([
    // 绝对路径原样（文件夹去掉末尾斜杠）
    ["C:\\Users\\me\\a.ts", "/w", "C:\\Users\\me\\a.ts"],
    ["C:/Users/me/a.ts", null, "C:/Users/me/a.ts"],
    ["/home/me/app.py", null, "/home/me/app.py"],
    ["~/notes.txt", null, "~/notes.txt"],
    ["\\\\server\\share\\报告.docx", null, "\\\\server\\share\\报告.docx"],
    ["/home/me/src/", null, "/home/me/src"],
    ["/", null, "/"],
    ["C:\\", null, "C:\\"],
    // 相对路径按工作区拼接，分隔符跟随工作区
    ["src/a.ts", "/home/me/proj", "/home/me/proj/src/a.ts"],
    ["./src/a.ts", "/home/me/proj/", "/home/me/proj/src/a.ts"],
    ["../other/b.md", "/home/me/proj", "/home/me/other/b.md"],
    ["src/a.ts", "C:\\work\\primus", "C:\\work\\primus\\src\\a.ts"],
    ["src\\lib\\", "C:\\work\\primus", "C:\\work\\primus\\src\\lib"],
    ["../../../../x.ts", "C:\\work\\primus", "C:\\x.ts"],
    ["../../../x.ts", "/a", "/x.ts"],
    ["a.ts", "\\\\srv\\share\\proj", "\\\\srv\\share\\proj\\a.ts"],
    ["../../../a.ts", "\\\\srv\\share\\proj", "\\\\srv\\share\\a.ts"],
    ["README.md", "C:/work/primus", "C:\\work\\primus\\README.md"],
  ])("%s（工作区 %s）→ %s", (path, base, expected) => {
    expect(resolveFileRefPath(path, base)).toBe(expected);
  });

  it.each([
    ["src/a.ts", null],
    ["@/components/icons.ts", "/w"],
    ["~other/a.ts", "/w"],
  ])("%s（工作区 %s）无法定位", (path, base) => {
    expect(resolveFileRefPath(path, base)).toBeNull();
  });

  it("识别出的路径不带行号", () => {
    const ref = fileRefFromCode("src/a.ts:42-58");
    expect(ref && resolveFileRefPath(ref.path, "/w")).toBe("/w/src/a.ts");
    const link = fileRefFromHref("src/a.ts#L3");
    expect(link && resolveFileRefPath(link.path, "/w")).toBe("/w/src/a.ts");
  });
});
