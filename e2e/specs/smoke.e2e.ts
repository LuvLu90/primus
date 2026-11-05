// 冒烟：应用能启动、主界面三栏都在（第 1 周 · 第 6 项；右栏默认收起，点开关展开）。
// 顶栏已移除（只留细标题栏与窗口按钮），左右栏开关在纸面左上角、右上角。
import { $, expect } from "@wdio/globals";
import { strings } from "../../apps/desktop/src/lib/strings.ts";

describe("冒烟", () => {
  it("显示左侧会话栏", async () => {
    await expect($(`nav[aria-label="${strings.layout.sessions}"]`)).toBeExisting();
  });

  it("显示中央时间线", async () => {
    await expect($(`main[aria-label="${strings.layout.timeline}"]`)).toBeExisting();
  });

  it("右侧面板默认收起，可展开", async () => {
    // 启动时右栏收起（不渲染 aside），纸面右上角是“展开右侧面板”开关
    await expect($("aside")).not.toBeExisting();
    const toggle = $(`button[aria-label="${strings.layout.showInspector}"]`);
    await expect(toggle).toBeExisting();
    await toggle.click();
    await expect($("aside")).toBeExisting();
  });

  it("显示窗口按钮", async () => {
    await expect($(`button[aria-label="${strings.layout.close}"]`)).toBeExisting();
  });
});
