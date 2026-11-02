import type { ChildProcess } from "node:child_process";

/** 在终止前订阅 exit；PID 消失导致的 taskkill 失败仅在已观察到退出时忽略。 */
export async function terminateStartedProcess(
  child: ChildProcess,
  terminate: (pid: number) => void,
  timeoutMs = 1000,
): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let observedExit = false;
  let finish: (didExit: boolean) => void = () => {};
  const onExit = () => finish(true);
  const exited = new Promise<boolean>((resolve) => {
    finish = (didExit: boolean) => {
      observedExit = didExit;
      clearTimeout(timer);
      child.removeListener("exit", onExit);
      resolve(didExit);
    };
    child.once("exit", onExit);
  });
  let killError: unknown;
  try {
    terminate(child.pid);
  } catch (error) {
    killError = error;
  }
  // 同步 taskkill 本身可能超过一秒；退出事件的等待上限从它返回后开始。
  if (!observedExit) timer = setTimeout(() => finish(false), timeoutMs);
  if (!(await exited)) throw killError ?? new Error("E2E 准备进程未在终止后退出");
}
