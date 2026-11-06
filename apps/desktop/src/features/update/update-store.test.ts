import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Platform, setPlatformForTesting, type UpdateStatus } from "@/lib/platform";
import { resetUpdateStoreForTesting, useUpdateStore } from "./update-store";

const status: UpdateStatus = {
  currentVersion: "0.0.6",
  available: true,
  installKind: "msi",
  settings: { autoUpdate: true, channel: "stable" },
  phase: "idle",
  progress: null,
  pending: null,
  lastCheck: null,
  lastError: null,
};

describe("更新状态订阅", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    setPlatformForTesting(undefined);
    resetUpdateStoreForTesting();
  });

  it("首次订阅失败后自动重试，恢复接收状态", async () => {
    let calls = 0;
    setPlatformForTesting({
      updateWatch: async (onChange: (s: UpdateStatus) => void) => {
        calls += 1;
        if (calls === 1) throw new Error("暂时失败");
        onChange(status);
      },
    } as Platform);
    await useUpdateStore.getState().start();
    expect(useUpdateStore.getState().loadError).toBe("暂时失败");
    expect(useUpdateStore.getState().status).toBeNull();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(calls).toBe(2);
    expect(useUpdateStore.getState().status).toEqual(status);
    expect(useUpdateStore.getState().loadError).toBeNull();
  });
});
