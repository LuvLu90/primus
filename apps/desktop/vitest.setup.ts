import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

// 未开启 vitest globals，RTL 不会自动清理，需要手动在每个用例后卸载
afterEach(cleanup);

// 组件里用 useRouter 导航；测试环境没有 App Router，统一替换成可断言的替身（同一个对象）
const router = { push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() };
// usePathname 默认在主页；需要别的路径的用例用 vi.mocked(usePathname).mockReturnValue(...) 覆盖
vi.mock("next/navigation", () => ({ useRouter: () => router, usePathname: vi.fn(() => "/") }));
afterEach(async () => {
  for (const fn of Object.values(router)) fn.mockClear();
  const { usePathname } = await import("next/navigation");
  vi.mocked(usePathname).mockImplementation(() => "/");
});

// jsdom 缺少的浏览器 API（lore-glass 玻璃组件与外观设置会用到）
if (!window.matchMedia) {
  window.matchMedia = vi.fn((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

if (!("ResizeObserver" in window)) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

// jsdom 没有 canvas 实现，调用 getContext 会打印 "Not implemented"；玻璃组件拿到 null 时会自行降级
HTMLCanvasElement.prototype.getContext = (() =>
  null) as typeof HTMLCanvasElement.prototype.getContext;
