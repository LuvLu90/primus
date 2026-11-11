import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ModelSummary } from "@/lib/platform/types";
import { strings } from "@/lib/strings";
import { clampLevel, ModelPicker, modelIdOf, withCoreCaps } from "./model-picker";

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

  it("想要的强度超出模型支持的档位时，按 Core 的规则夹到能用的最高档", () => {
    render(
      <ModelPicker
        models={MODELS}
        current="p/b"
        thinkingLevel="xhigh"
        thinkingLevels={["off", "low", "medium", "high"]}
        onSelectModel={vi.fn()}
        onSelectThinking={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "模型：Sonnet 5，思考程度高" })).toBeTruthy();
    expect(clampLevel("medium", ["off", "high"])).toBe("off");
    expect(clampLevel("minimal", ["low", "high"])).toBe("low");
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

  it("列出模型，当前项为选中并打勾；每行右侧是上下文长度；点选切换", async () => {
    const { onSelectModel } = open();
    const current = await screen.findByRole("menuitemradio", { name: "Fable 5" });
    // 一行：名称、上下文长度、勾（只有当前项有勾）
    expect(current.textContent).toBe("Fable 5200K");
    expect(current.querySelectorAll("svg")).toHaveLength(1);
    const other = screen.getByRole("menuitemradio", { name: "Sonnet 5" });
    expect(other.querySelectorAll("svg")).toHaveLength(0);
    expect(current.getAttribute("aria-checked")).toBe("true");
    expect(
      screen.getByRole("menuitemradio", { name: "Sonnet 5" }).getAttribute("aria-checked"),
    ).toBe("false");
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Sonnet 5" }));
    expect(onSelectModel).toHaveBeenCalledWith("p/b");
  });

  it("会话已有消息：模型锁定（其他模型不可选），思考程度仍可调", async () => {
    const { onSelectModel, onSelectThinking } = open({ modelLocked: true });
    const other = await screen.findByRole("menuitemradio", { name: "Sonnet 5" });
    expect(other.getAttribute("data-disabled")).not.toBeNull();
    expect(
      screen.getByRole("menuitemradio", { name: "Fable 5" }).getAttribute("data-disabled"),
    ).toBeNull();
    fireEvent.click(other);
    expect(onSelectModel).not.toHaveBeenCalled();
    const slider = screen.getByRole("slider");
    fireEvent.keyDown(slider, { key: "ArrowRight" });
    fireEvent.keyUp(slider, { key: "ArrowRight" });
    expect(onSelectThinking).toHaveBeenCalledWith("high");
  });

  it("思考程度滑杆：两端“更快 / 更聪明”，方向键与 Home/End 逐档移动，抬键才提交", async () => {
    const { onSelectThinking } = open();
    const slider = await screen.findByRole("slider", { name: t.thinkingDegree });
    expect(screen.getByText(t.faster)).toBeTruthy();
    expect(screen.getByText(t.smarter)).toBeTruthy();
    expect(slider.getAttribute("aria-valuenow")).toBe("2");
    expect(slider.getAttribute("aria-valuetext")).toBe("中");
    // 修饰键松开不提交（没选档位）
    fireEvent.keyUp(slider, { key: "Shift" });
    expect(onSelectThinking).not.toHaveBeenCalled();
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

  it("支持思考的模型关闭思考：按钮只显示模型名，无障碍名称仍带“思考程度关闭”", () => {
    render(
      <ModelPicker
        models={MODELS}
        current="p/a"
        thinkingLevel="off"
        thinkingLevels={undefined}
        onSelectModel={vi.fn()}
        onSelectThinking={vi.fn()}
      />,
    );
    const trigger = screen.getByRole("button", { name: "模型：Fable 5，思考程度关闭" });
    expect(trigger.textContent).toBe("Fable 5");
  });

  it("不支持思考的模型只显示模型名（不显示“关闭”），不显示思考滑杆", async () => {
    const onSelectModel = vi.fn();
    render(
      <ModelPicker
        models={MODELS}
        current="p/c"
        thinkingLevel="medium"
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

  it("按渠道分组：每个渠道一个小节，标题为渠道名（缺少名称时显示渠道 ID）", async () => {
    const onSelectModel = vi.fn();
    render(
      <ModelPicker
        models={[
          model("ioply/a", "Fable 5"),
          model("corp/b", "Sonnet 5"),
          model("ioply/c", "Fast"),
        ]}
        providerNames={{ ioply: "ioply 网关" }}
        current="ioply/a"
        thinkingLevel="medium"
        thinkingLevels={["off", "medium"]}
        onSelectModel={onSelectModel}
        onSelectThinking={vi.fn()}
      />,
    );
    fireEvent.keyDown(screen.getByRole("button", { name: /模型：Fable 5/ }), { key: "Enter" });
    const first = await screen.findByRole("group", { name: "ioply 网关" });
    const second = screen.getByRole("group", { name: "corp" });
    // 同一渠道的模型归到一起，保持原有顺序
    expect(
      within(first)
        .getAllByRole("menuitemradio")
        .map((el) => el.querySelector("span")?.textContent),
    ).toEqual(["Fable 5", "Fast"]);
    expect(
      within(second)
        .getAllByRole("menuitemradio")
        .map((el) => el.querySelector("span")?.textContent),
    ).toEqual(["Sonnet 5"]);
    // 仍保留“思考程度”
    expect(screen.getByRole("slider", { name: t.thinkingDegree })).toBeTruthy();
    fireEvent.click(within(second).getByRole("menuitemradio", { name: "Sonnet 5" }));
    expect(onSelectModel).toHaveBeenCalledWith("corp/b");
  });

  it("没有可用的模型：弹层提示并可去设置添加渠道，不显示思考程度", async () => {
    const onOpenSettings = vi.fn();
    render(
      <ModelPicker
        models={[]}
        current={null}
        thinkingLevel={undefined}
        thinkingLevels={undefined}
        onSelectModel={vi.fn()}
        onSelectThinking={vi.fn()}
        onOpenSettings={onOpenSettings}
      />,
    );
    const trigger = screen.getByRole("button", { name: `模型：${t.empty}` });
    expect((trigger as HTMLButtonElement).disabled).toBe(false);
    fireEvent.keyDown(trigger, { key: "Enter" });
    expect(await screen.findByText(t.empty, { selector: "p" })).toBeTruthy();
    expect(screen.queryByRole("menuitemradio")).toBeNull();
    expect(screen.queryByRole("slider")).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: t.addProvider }));
    expect(onOpenSettings).toHaveBeenCalled();
  });

  it("列表可滚动且不显示滚动条：高度受 Radix 可用高度约束，思考滑杆固定在列表之外", async () => {
    open();
    const list = await screen.findByTestId("model-list");
    expect(list.className).toContain("overflow-y-auto");
    expect(list.className).toContain("scroll-none");
    const box = list.parentElement as HTMLElement;
    expect(box.className).toContain("--radix-dropdown-menu-content-available-height");
    const slider = screen.getByRole("slider", { name: t.thinkingDegree });
    expect(list.contains(slider)).toBe(false);
    expect(box.contains(slider)).toBe(true);
  });

  it("行的字号与行高与输入栏其他菜单一致（13px / py-[7px]）", async () => {
    open();
    const row = await screen.findByRole("menuitemradio", { name: "Sonnet 5" });
    expect(row.className).toContain("text-sm");
    expect(row.className).toContain("py-[7px]");
  });

  it("模型 ID 含 `/`：按钮只去掉渠道前缀", () => {
    expect(modelIdOf("gw/moonshotai/kimi-k3")).toBe("moonshotai/kimi-k3");
    render(
      <ModelPicker
        models={MODELS}
        current="gw/moonshotai/kimi-k3"
        thinkingLevel={undefined}
        thinkingLevels={undefined}
        onSelectModel={vi.fn()}
        onSelectThinking={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "模型：moonshotai/kimi-k3" })).toBeTruthy();
  });

  it("能力以 Core 报告的为准，Core 没报告的保持设置里的值", () => {
    const settings = [
      {
        ...model("gw/kimi-k3.1-pro", "Kimi K3.1 Pro", false),
        image: false,
        contextWindow: 128_000,
      },
      model("gw/other", "Other"),
    ];
    const merged = withCoreCaps(settings, {
      "gw/kimi-k3.1-pro": {
        image: true,
        reasoning: true,
        contextWindow: 1_048_576,
        maxTokens: 131_072,
      },
    });
    expect(merged[0]).toMatchObject({
      key: "gw/kimi-k3.1-pro",
      name: "Kimi K3.1 Pro",
      image: true,
      reasoning: true,
      contextWindow: 1_048_576,
    });
    expect(merged[1]).toBe(settings[1]);
    expect(withCoreCaps(settings, undefined)).toBe(settings);
  });

  it("打开弹层时通知外层（刷新 Core 的模型能力）", async () => {
    const onOpenChange = vi.fn();
    open({ onOpenChange });
    await screen.findByRole("menuitemradio", { name: "Fable 5" });
    expect(onOpenChange).toHaveBeenCalledWith(true);
  });
});
