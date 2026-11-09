import type { AgentMessage } from "@primus/protocol";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { strings } from "@/lib/strings";
import { AgentTurn } from "./agent-turn";

const t = strings.chat.work;

const assistant = (content: unknown[], stopReason = "stop"): AgentMessage =>
  ({
    role: "assistant",
    content,
    api: "openai-responses",
    provider: "ioply",
    model: "mock-large",
    usage: {},
    stopReason,
    timestamp: 2,
  }) as unknown as AgentMessage;

const toolResult = (toolCallId: string): AgentMessage =>
  ({
    role: "toolResult",
    toolCallId,
    toolName: "read",
    content: [{ type: "text", text: "ok" }],
    isError: false,
    timestamp: 3,
  }) as unknown as AgentMessage;

function renderTurn(messages: AgentMessage[], running: boolean, streaming: boolean) {
  return render(
    <AgentTurn
      messages={messages}
      toolRuns={{}}
      running={running}
      streaming={streaming}
      startedAt={1}
    />,
  );
}

describe("工作过程里的思考", () => {
  it("进行中的思考显示动画星光图标与“正在思考”", () => {
    const { container } = renderTurn(
      [assistant([{ type: "thinking", thinking: "先看看文件结构" }])],
      true,
      true,
    );
    expect(screen.getByRole("button", { name: t.thinkingNow })).toBeTruthy();
    const icon = container.querySelector('[data-icon="thinking"]');
    expect(icon?.getAttribute("class")).toContain("think-spark");
    // 星光图标是三个 path（右上小星、主星、右下小星），CSS 按顺序分别做动画
    expect(icon?.querySelectorAll(":scope > path").length).toBe(3);
  });

  it("思考结束（后面出现正文）后不再留下思考行", () => {
    const { container } = renderTurn(
      [
        assistant([
          { type: "thinking", thinking: "先看看文件结构" },
          { type: "text", text: "好的，结论如下。" },
        ]),
      ],
      true,
      true,
    );
    expect(screen.queryByRole("button", { name: t.thinkingNow })).toBeNull();
    expect(container.querySelector('[data-icon="thinking"]')).toBeNull();
    expect(container.textContent).not.toContain(t.thinkingNow);
  });

  it("历史轮次里的思考不显示", () => {
    const { container } = renderTurn(
      [
        assistant([
          { type: "thinking", thinking: "想一想" },
          { type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } },
        ]),
        toolResult("c1"),
        assistant([{ type: "text", text: "完成" }]),
      ],
      false,
      false,
    );
    expect(container.querySelector('[data-icon="thinking"]')).toBeNull();
    expect(container.textContent).not.toContain(t.thinkingNow);
  });
});

describe("工具行的文件类型图标", () => {
  it("读取 / 写入文件时路径前显示对应类型的彩色图标，命令行不显示", () => {
    const { container } = renderTurn(
      [
        assistant([
          { type: "toolCall", id: "c1", name: "read", arguments: { path: "src/app.tsx" } },
        ]),
        toolResult("c1"),
        // 中间的说明把连续的工具调用分开，每次调用单独一行
        assistant([
          { type: "text", text: "接着写文档" },
          { type: "toolCall", id: "c2", name: "write", arguments: { path: "docs/说明.md" } },
        ]),
        toolResult("c2"),
        assistant([
          { type: "text", text: "看看目录" },
          { type: "toolCall", id: "c3", name: "bash", arguments: { command: "ls" } },
        ]),
        toolResult("c3"),
        assistant([{ type: "text", text: "完成" }]),
      ],
      true,
      false,
    );
    const icons = [...container.querySelectorAll("[data-file-icon]")].map((el) =>
      el.getAttribute("data-file-icon"),
    );
    expect(icons).toEqual(["react-ts", "markdown"]);
  });
});
