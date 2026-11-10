import { fireEvent, render, screen } from "@testing-library/react";
import { useRouter } from "next/navigation";
import { afterEach, describe, expect, it } from "vitest";
import { strings } from "@/lib/strings";
import { initialAppearance, useAppearanceStore } from "@/stores/appearance-store";
import { groupFromSearch, SettingsView } from "./settings-view";

const t = strings.settings;

describe("设置页", () => {
  afterEach(() => useAppearanceStore.setState(initialAppearance));

  it("列出第 18 章的全部分组，默认显示通用", () => {
    render(<SettingsView />);
    const nav = screen.getByRole("navigation", { name: t.title });
    for (const label of Object.values(t.groups)) expect(nav.textContent).toContain(label);
    expect(screen.getByRole("main", { name: t.groups.general })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: t.groups.general }).getAttribute("aria-current"),
    ).toBe("page");
  });

  it("用量是设置中的一个分组，可由 ?group=usage 直接打开", () => {
    expect(groupFromSearch("?group=usage")).toBe("usage");
    expect(groupFromSearch("?group=nope")).toBeNull();
    expect(groupFromSearch("")).toBeNull();
    window.history.replaceState(null, "", "/settings/?group=usage");
    render(<SettingsView />);
    expect(screen.getByRole("main", { name: t.groups.usage }).textContent).toContain(
      t.groupItems.usage,
    );
    window.history.replaceState(null, "", "/");
  });

  it("切换分组显示对应内容", () => {
    render(<SettingsView />);
    fireEvent.click(screen.getByRole("button", { name: t.groups.models }));
    expect(screen.getByRole("main", { name: t.groups.models }).textContent).toContain(
      t.groupItems.models,
    );
  });

  it("启动与通知开关在接入 settings.toml 前禁用；未实现的“恢复工作区”不显示", () => {
    render(<SettingsView />);
    expect(screen.queryByRole("switch", { name: /工作区/ })).toBeNull();
    for (const name of [t.minimizeToTray, t.notifyEnabled]) {
      expect((screen.getByRole("switch", { name }) as HTMLInputElement).disabled).toBe(true);
    }
  });

  it("主题选项写入外观设置", () => {
    render(<SettingsView />);
    const dark = screen.getByRole("tab", { name: t.themes.dark });
    // Radix Tabs 在 mousedown 时切换
    fireEvent.mouseDown(dark);
    expect(useAppearanceStore.getState().theme).toBe("dark");
    expect(dark.getAttribute("aria-selected")).toBe("true");
  });

  it("玻璃效果滑块显示当前着色程度", () => {
    useAppearanceStore.setState({ glassTint: 0.6 });
    render(<SettingsView />);
    const slider = screen.getByRole("slider", { name: t.glass }) as HTMLInputElement;
    expect(slider.value).toBe("60");
    fireEvent.change(slider, { target: { value: "20" } });
    expect(useAppearanceStore.getState().glassTint).toBe(0.2);
  });

  it("返回按钮回到主界面", () => {
    render(<SettingsView />);
    fireEvent.click(screen.getByRole("button", { name: t.back }));
    expect(useRouter().push).toHaveBeenCalledWith("/");
  });
});
