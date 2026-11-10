import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TOOLTIP_DELAY, Tooltip, useDelegatedTooltip } from "./tooltip";

afterEach(() => {
  vi.useRealTimers();
});

/** 悬停并等过延迟，返回提示（role="tooltip"）；Radix 另渲染一份隐藏副本供读屏，取它的文字即可 */
function hover(el: Element) {
  fireEvent.pointerMove(el, { pointerType: "mouse" });
  act(() => {
    vi.advanceTimersByTime(TOOLTIP_DELAY + 10);
  });
}

describe("Tooltip", () => {
  it("悬停约 300 ms 后显示，并用 aria-describedby 关联到触发元素", () => {
    vi.useFakeTimers();
    render(
      <Tooltip content="打开设置">
        <button type="button" aria-label="设置">
          ⚙
        </button>
      </Tooltip>,
    );
    const button = screen.getByRole("button", { name: "设置" });
    expect(button.getAttribute("title")).toBeNull();
    fireEvent.pointerMove(button, { pointerType: "mouse" });
    act(() => {
      vi.advanceTimersByTime(TOOLTIP_DELAY - 50);
    });
    expect(screen.queryByRole("tooltip")).toBeNull();
    act(() => {
      vi.advanceTimersByTime(60);
    });
    const tip = screen.getByRole("tooltip");
    expect(tip.textContent).toBe("打开设置");
    expect(button.getAttribute("aria-describedby")).toBe(tip.id);
    expect(document.querySelector(".ui-tooltip")?.classList.contains("text-2xs")).toBe(true);
  });

  it("内容为空时不弹出，触发元素保持原样", () => {
    vi.useFakeTimers();
    const { rerender } = render(
      <Tooltip content={undefined}>
        <button type="button">发送</button>
      </Tooltip>,
    );
    const button = screen.getByRole("button", { name: "发送" });
    hover(button);
    expect(screen.queryByRole("tooltip")).toBeNull();
    // 内容出现时同一个按钮直接可用，不重新挂载
    rerender(
      <Tooltip content="正在读取附件">
        <button type="button">发送</button>
      </Tooltip>,
    );
    expect(screen.getByRole("button", { name: "发送" })).toBe(button);
  });

  it("wrap：禁用按钮外包一层，悬停包装层也能显示提示", () => {
    vi.useFakeTimers();
    render(
      <Tooltip content="正在停止" wrap>
        <button type="button" disabled>
          停止
        </button>
      </Tooltip>,
    );
    const button = screen.getByRole("button", { name: "停止" });
    const wrapper = button.parentElement as HTMLElement;
    expect(wrapper.classList.contains("ui-tooltip-wrap")).toBe(true);
    hover(wrapper);
    expect(screen.getByRole("tooltip").textContent).toBe("正在停止");
  });

  it("把外层 asChild 触发器传来的属性与事件交给触发元素", () => {
    const onClick = vi.fn();
    render(
      <Tooltip content="提示" onClick={onClick} data-state="open" aria-haspopup="menu">
        <button type="button">菜单</button>
      </Tooltip>,
    );
    const button = screen.getByRole("button", { name: "菜单" });
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
    expect(button.getAttribute("aria-haspopup")).toBe("menu");
    // 外层（如 Popover）给的 data-state 优先，按钮的 data-[state=open] 样式不被提示的状态覆盖
    expect(button.getAttribute("data-state")).toBe("open");
  });
});

function Delegated() {
  const tip = useDelegatedTooltip();
  return (
    <>
      <div
        {...tip.handlers}
        // biome-ignore lint/security/noDangerouslySetInnerHtml: 测试用固定内容
        dangerouslySetInnerHTML={{
          __html:
            '<button type="button" data-tooltip="src/a.ts:12"><span>a.ts</span></button><p>正文</p>',
        }}
      />
      {tip.ui}
    </>
  );
}

describe("useDelegatedTooltip", () => {
  it("HTML 内容里带 data-tooltip 的元素悬停后显示同样的提示，移开即关闭", () => {
    vi.useFakeTimers();
    render(<Delegated />);
    const button = screen.getByRole("button", { name: "a.ts" });
    fireEvent.pointerOver(button.firstElementChild as Element);
    expect(screen.queryByRole("tooltip")).toBeNull();
    act(() => {
      vi.advanceTimersByTime(TOOLTIP_DELAY + 10);
    });
    const tip = screen.getByRole("tooltip");
    expect(tip.textContent).toBe("src/a.ts:12");
    expect(button.getAttribute("aria-describedby")).toBeTruthy();
    expect(
      document.getElementById(button.getAttribute("aria-describedby") ?? "")?.textContent,
    ).toBe("src/a.ts:12");
    fireEvent.pointerOut(button, { relatedTarget: screen.getByText("正文") });
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(button.getAttribute("aria-describedby")).toBeNull();
  });
});
