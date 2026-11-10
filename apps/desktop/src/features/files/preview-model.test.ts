import { describe, expect, it } from "vitest";
import {
  blobTypeOf,
  breadcrumbs,
  formatModified,
  formatSize,
  joinPath,
  parentPath,
  prettyJson,
  trimDir,
} from "./preview-model";

describe("路径", () => {
  it("拼接子项：沿用原路径的分隔符，根目录不重复分隔符", () => {
    expect(joinPath("D:\\code\\alpha", "src")).toBe("D:\\code\\alpha\\src");
    expect(joinPath("D:\\code\\alpha\\", "a.ts")).toBe("D:\\code\\alpha\\a.ts");
    expect(joinPath("C:\\", "Users")).toBe("C:\\Users");
    expect(joinPath("/home/u", "a.md")).toBe("/home/u/a.md");
    expect(joinPath("/", "etc")).toBe("/etc");
  });

  it("上一级：根目录没有上一级", () => {
    expect(parentPath("D:\\code\\alpha")).toBe("D:\\code");
    expect(parentPath("D:\\code")).toBe("D:\\");
    expect(parentPath("D:\\")).toBeNull();
    expect(parentPath("C:")).toBeNull();
    expect(parentPath("/home/u/")).toBe("/home");
    expect(parentPath("/home")).toBe("/");
    expect(parentPath("/")).toBeNull();
    expect(trimDir("D:\\code\\")).toBe("D:\\code");
  });

  it("面包屑从根到当前", () => {
    expect(breadcrumbs("D:\\code\\alpha")).toEqual([
      { name: "D:", path: "D:\\" },
      { name: "code", path: "D:\\code" },
      { name: "alpha", path: "D:\\code\\alpha" },
    ]);
    expect(breadcrumbs("/home/u")).toEqual([
      { name: "/", path: "/" },
      { name: "home", path: "/home" },
      { name: "u", path: "/home/u" },
    ]);
  });
});

describe("格式", () => {
  it("大小按 1024 进制", () => {
    expect(formatSize(0)).toBe("0 B");
    expect(formatSize(1023)).toBe("1023 B");
    expect(formatSize(1024)).toBe("1 KB");
    expect(formatSize(1536)).toBe("1.5 KB");
    expect(formatSize(200 * 1024)).toBe("200 KB");
    expect(formatSize(5 * 1024 * 1024 * 1024)).toBe("5 GB");
  });

  it("修改时间为本地 YYYY-MM-DD HH:mm", () => {
    expect(formatModified(new Date(2026, 10, 3, 9, 5).getTime())).toBe("2026-11-03 09:05");
  });

  it("blob 类型按扩展名（不区分大小写）", () => {
    expect(blobTypeOf("C:\\a\\歌.MP3")).toEqual({ kind: "audio", mime: "audio/mpeg" });
    expect(blobTypeOf("/v/clip.webm")?.kind).toBe("video");
    expect(blobTypeOf("/v/clip.mov")?.mime).toBe("video/quicktime");
    expect(blobTypeOf("动图.gif")?.kind).toBe("image");
    expect(blobTypeOf("favicon.ico")?.kind).toBe("image");
    expect(blobTypeOf("a.png")).toBeNull();
    expect(blobTypeOf("mp3")).toBeNull();
  });
});

describe("JSON 格式化", () => {
  it("缩进 2 空格，空对象 / 数组在一行", () => {
    expect(prettyJson('{"a":1,"b":[1,2],"c":{},"d":[ ]}')).toBe(
      '{\n  "a": 1,\n  "b": [\n    1,\n    2\n  ],\n  "c": {},\n  "d": []\n}',
    );
  });

  it("字符串（含转义、括号、冒号）与大整数原样保留", () => {
    expect(prettyJson('{"k":"a\\"{,}:b","n":12345678901234567890,"f":1.0}')).toBe(
      '{\n  "k": "a\\"{,}:b",\n  "n": 12345678901234567890,\n  "f": 1.0\n}',
    );
  });

  it("不是合法 JSON 时返回 null", () => {
    expect(prettyJson("{a:1}")).toBeNull();
    expect(prettyJson('{"a":1} // 注释')).toBeNull();
    expect(prettyJson("42")).toBe("42");
  });
});
