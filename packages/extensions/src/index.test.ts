import { describe, expect, it } from "vitest";
import guard from "./guard/index.ts";
import extensions from "./index.ts";

describe("primus-bundle 扩展注册表", () => {
  it("注册全部 5 个第一方扩展且不重复", () => {
    expect(extensions).toHaveLength(5);
    expect(new Set(extensions).size).toBe(5);
    for (const ext of extensions) expect(typeof ext).toBe("function");
  });

  it("guard 最先注册，保证其他扩展的工具调用都经过审批（附录 A）", () => {
    expect(extensions[0]).toBe(guard);
  });
});
