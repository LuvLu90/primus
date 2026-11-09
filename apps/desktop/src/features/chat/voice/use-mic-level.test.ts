import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isTauriRuntime } from "@/lib/platform";
import { useMicLevel } from "./use-mic-level";

describe("麦克风音量", () => {
  const original = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
  afterEach(() => {
    if (original) Object.defineProperty(navigator, "mediaDevices", original);
    else Reflect.deleteProperty(navigator, "mediaDevices");
  });

  it("浏览器预览（mock）录音时不调用 getUserMedia，不弹麦克风权限请求", () => {
    const getUserMedia = vi.fn(() => new Promise<MediaStream>(() => {}));
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });
    expect(isTauriRuntime()).toBe(false);
    const { result, rerender } = renderHook(({ active }) => useMicLevel(active, isTauriRuntime()), {
      initialProps: { active: false },
    });
    rerender({ active: true });
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(result.current()).toBeNull();
  });
});
