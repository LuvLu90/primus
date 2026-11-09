import type { AgentMessage } from "@primus/protocol";
import { describe, expect, it } from "vitest";
import { lastWrittenFile } from "./written-file";

const call = (id: string, name: string, args: Record<string, unknown>) =>
  ({ type: "toolCall", id, name, arguments: args }) as const;
const assistant = (...content: ReturnType<typeof call>[]) =>
  ({ role: "assistant", content }) as unknown as AgentMessage;
const result = (toolCallId: string, isError = false) =>
  ({
    role: "toolResult",
    toolCallId,
    toolName: "write",
    content: [],
    isError,
  }) as unknown as AgentMessage;
const user = { role: "user", content: "hi" } as unknown as AgentMessage;

describe("一轮结束后要预览的文件", () => {
  it("取本轮最后一个写成功的文件，忽略失败与只读工具", () => {
    const messages = [
      user,
      assistant(call("1", "write", { path: "old.md" })),
      result("1"),
      user,
      assistant(call("2", "write", { path: "a.md" }), call("3", "read", { path: "b.md" })),
      result("2"),
      result("3"),
      assistant(call("4", "edit", { file_path: "c.ts" })),
      result("4", true),
    ];
    expect(lastWrittenFile(messages)).toBe("a.md");
  });

  it("本轮没有写文件时为 null（不回溯到上一轮）", () => {
    expect(
      lastWrittenFile([user, assistant(call("1", "write", { path: "x" })), result("1"), user]),
    ).toBeNull();
  });
});
