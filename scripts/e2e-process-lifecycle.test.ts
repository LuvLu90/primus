import { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { terminateStartedProcess } from "../e2e/process-lifecycle";

function childFixture() {
  const child = new ChildProcess();
  Object.defineProperty(child, "pid", { value: 123 });
  return child;
}

describe("E2E preparation process cleanup", () => {
  it("does not terminate an already exited child", async () => {
    const child = childFixture();
    child.exitCode = 0;
    const kill = vi.fn();
    await terminateStartedProcess(child, kill);
    expect(kill).not.toHaveBeenCalled();
  });
  it("observes exit even when it occurs synchronously during termination", async () => {
    const child = childFixture();
    await terminateStartedProcess(child, () => {
      child.emit("exit", 0, null);
    });
    expect(child.listenerCount("exit")).toBe(0);
  });
  it("ignores a missing-PID error only after observing the child's exit", async () => {
    const child = childFixture();
    await terminateStartedProcess(child, () => {
      setTimeout(() => child.emit("exit", 0, null), 1);
      throw new Error("PID no longer exists");
    });
    expect(child.listenerCount("exit")).toBe(0);
  });
  it("preserves real termination failures and removes its exit listener", async () => {
    const child = childFixture();
    const failure = new Error("access denied");
    await expect(
      terminateStartedProcess(
        child,
        () => {
          throw failure;
        },
        10,
      ),
    ).rejects.toBe(failure);
    expect(child.listenerCount("exit")).toBe(0);
  });
  it("fails if termination reports success but the child never exits", async () => {
    const child = childFixture();
    await expect(terminateStartedProcess(child, () => {}, 10)).rejects.toThrow("未在终止后退出");
  });
});
