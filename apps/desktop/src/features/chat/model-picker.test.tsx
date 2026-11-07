import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ModelSummary } from "@/lib/platform/types";
import { strings } from "@/lib/strings";
import { ModelPicker } from "./model-picker";

const t = strings.chat.model;

const model = (key: string, name: string, reasoning = true): ModelSummary => ({
  key,
  provider: key.split("/")[0] ?? "",
  id: key.split("/")[1] ?? "",
  name,
  api: "anthropic-messages",
  reasoning,
  image: true,
  contextWindow: 200_000,
  maxTokens: 8192,
});

const MODELS = [model("p/a", "Fable 5"), model("p/b", "Sonnet 5"), model("p/c", "Fast", false)];

function open(props: Partial<Parameters<typeof ModelPicker>[0]> = {}) {
  const onSelectModel = vi.fn();
  const onSelectThinking = vi.fn();
  render(
    <ModelPicker
      models={MODELS}
      current="p/a"
      thinkingLevel="medium"
      thinkingLevels={["off", "low", "medium", "high", "xhigh"]}
      onSelectModel={onSelectModel}
      onSelectThinking={onSelectThinking}
      {...props}
    />,
  );
  const trigger = screen.getByRole("button", { name: /模型：Fable 5，思考程度中/ });
  expect(trigger.textContent).toBe("Fable 5· 中");
  fireEvent.keyDown(trigger, { key: "Enter" });
  return { onSelectModel, onSelectThinking };
}

describe("模型选择", () => {
  it("按钮只显示“模型名 · 档位”：没有图标，不出现“思考”“默认”", () => {
    const { container } = render(
      <ModelPicker
        models={MODELS}
        current="p/b"
        thinkingLevel="high"
        thinkingLevels={["off", "low", "medium", "high"]}
        onSelectModel={vi.fn()}
        onSelectThinking={vi.fn()}
      />,
    );
    const trigger = screen.getByRole("button", { name: "模型：Sonnet 5，思考程度高" });
    expect(trigger.textContent).toBe("Sonnet 5· 高");
    expect(trigger.textContent).not.toContain(t.thinking);
    // 只有下拉箭头一个图标
    expect(container.querySelectorAll("svg")).toHaveLength(1);
  });

  it("档位未知时只显示模型名，不显示“默认”", () => {
    render(
      <ModelPicker
        models={MODELS}
        current="p/a"
        thinkingLevel={undefined}
        thinkingLevels={undefined}
        onSelectModel={vi.fn()}
        onSelectThinking={vi.fn()}
      />,
    );
    const trigger = screen.getByRole("button", { name: "模型：Fable 5" });
    expect(trigger.textContent).toBe("Fable 5");
    expect(trigger.textContent).not.toContain(t.levelDefault);
  });

  it("“模型”分组列出模型，当前项为选中；点选切换", async () => {
    const { onSelectModel } = open();
    expect(await screen.findByText(t.models)).toBeTruthy();
    const current = screen.getByRole("menuitemradio", { name: "Fable 5" });
    expect(current.getAttribute("aria-checked")).toBe("true");
    expect(
      screen.getByRole("menuitemradio", { name: "Sonnet 5" }).getAttribute("aria-checked"),
    ).toBe("false");
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Sonnet 5" }));
    expect(onSelectModel).toHaveBeenCalledWith("p/b");
  });

  it("思考程度滑杆：两端“更快 / 更聪明”，方向键与 Home/End 逐档移动，抬键才提交", async () => {
    const { onSelectThinking } = open();
    const slider = await screen.findByRole("slider", { name: t.thinkingDegree });
    expect(screen.getByText(t.faster)).toBeTruthy();
    expect(screen.getByText(t.smarter)).toBeTruthy();
    expect(slider.getAttribute("aria-valuenow")).toBe("2");
    expect(slider.getAttribute("aria-valuetext")).toBe("中");
    fireEvent.keyDown(slider, { key: "ArrowLeft" });
    fireEvent.keyDown(slider, { key: "ArrowLeft" });
    expect(slider.getAttribute("aria-valuetext")).toBe("关闭");
    expect(onSelectThinking).not.toHaveBeenCalled();
    fireEvent.keyUp(slider, { key: "ArrowLeft" });
    expect(onSelectThinking).toHaveBeenLastCalledWith("off");
    fireEvent.keyDown(slider, { key: "End" });
    fireEvent.keyUp(slider, { key: "End" });
    expect(onSelectThinking).toHaveBeenLastCalledWith("xhigh");
    fireEvent.keyDown(slider, { key: "ArrowRight" });
    expect(slider.getAttribute("aria-valuenow")).toBe("4");
  });

  it("点轨道跳到最近的档位，松手提交", async () => {
    const { onSelectThinking } = open();
    const slider = await screen.findByRole("slider", { name: t.thinkingDegree });
    slider.getBoundingClientRect = () =>
      ({ left: 0, width: 232, top: 0, height: 34, right: 232, bottom: 34 }) as DOMRect;
    // 拇指中心可达范围 16–216：x=166 → 0.75 → 第 3 档（高）
    fireEvent.pointerDown(slider, { button: 0, clientX: 166, pointerId: 1 });
    expect(slider.getAttribute("aria-valuetext")).toBe("高");
    fireEvent.pointerUp(slider, { pointerId: 1 });
    expect(onSelectThinking).toHaveBeenLastCalledWith("high");
  });

  it("只有一个档位的模型不显示思考程度", async () => {
    const onSelectModel = vi.fn();
    render(
      <ModelPicker
        models={MODELS}
        current="p/c"
        thinkingLevel="off"
        thinkingLevels={["off"]}
        onSelectModel={onSelectModel}
        onSelectThinking={vi.fn()}
      />,
    );
    const trigger = screen.getByRole("button", { name: "模型：Fast" });
    expect(trigger.textContent).toBe("Fast");
    fireEvent.keyDown(trigger, { key: "Enter" });
    await screen.findByRole("menuitemradio", { name: "Fast" });
    expect(screen.queryByRole("slider")).toBeNull();
  });
});
