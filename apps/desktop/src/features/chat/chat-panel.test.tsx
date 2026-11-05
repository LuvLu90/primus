import type { CoreBatch } from "@primus/protocol";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CORE_NOT_RUNNING, PlatformError, setPlatformForTesting } from "@/lib/platform";
import { createMockPlatform } from "@/lib/platform/mock";
import { strings } from "@/lib/strings";
import { initialAppState, useAppStore } from "@/stores/app-store";
import { ChatPanel } from "./chat-panel";

/** 用户消息的 prompt（不含 primus-guard 的 /primus-mode 等扩展命令） */
const isUserPrompt = (r: { type: string; message?: unknown }) =>
  r.type === "prompt" && !String(r.message ?? "").startsWith("/primus-");

const t = strings.chat;

describe("对话区（mock 事件流）", () => {
  beforeEach(() => setPlatformForTesting(createMockPlatform({ intervalMs: 1, batchSize: 50 })));
  afterEach(() => {
    setPlatformForTesting(undefined);
    useAppStore.setState(initialAppState);
  });

  it("未选择工作区时输入框上方显示选择文件夹；选好后收起并在工具栏显示工作区", async () => {
    render(<ChatPanel />);
    const bar = screen.getByRole("button", { name: new RegExp(t.chooseFolder) });
    fireEvent.keyDown(bar, { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: /示例工作区/ }));
    await waitFor(() => expect(useAppStore.getState().workspace?.name).toBe("示例工作区"));
    expect(screen.queryByRole("button", { name: new RegExp(t.chooseFolder) })).toBeNull();
    expect(screen.getByRole("button", { name: "示例工作区" })).toBeTruthy();
    // 名称左侧的关闭按钮取消已选工作区，选择文件夹栏重新出现
    fireEvent.click(
      screen.getByRole("button", { name: new RegExp(`${t.clearWorkspace}.*示例工作区`) }),
    );
    await waitFor(() => expect(useAppStore.getState().workspace).toBeNull());
    expect(screen.getByRole("button", { name: new RegExp(t.chooseFolder) })).toBeTruthy();
  });

  it("发送消息后流式显示回答，结束后恢复发送按钮", async () => {
    render(<ChatPanel />);
    expect(screen.getByText(t.previewBadge)).toBeTruthy();

    const input = screen.getByRole("textbox", { name: t.inputLabel });
    fireEvent.change(input, { target: { value: "你好" } });
    fireEvent.keyDown(input, { key: "Enter" });

    // 发送成功后才清空输入
    await waitFor(() => expect((input as HTMLTextAreaElement).value).toBe(""));
    await screen.findByRole("article", { name: t.you });
    await waitFor(() => expect(screen.getByText(/mock 平台/)).toBeTruthy());
    // 工具调用收进工作过程：结束后收起成“用时 …”，展开后看到“已读取 路径”一行
    const expand = await screen.findByRole("button", { name: t.work.expand });
    fireEvent.click(expand);
    expect((await screen.findAllByText(new RegExp(t.work.tools.read.done))).length).toBeGreaterThan(
      0,
    );
    await waitFor(() => expect(screen.getByRole("button", { name: t.send })).toBeTruthy());
  });

  it("没有可用的模型配置时禁止发送，重试成功后恢复", async () => {
    const base = createMockPlatform({ intervalMs: 1, batchSize: 50 });
    const ok = await base.modelsGet();
    const modelsRefresh = vi.fn(async () => ok);
    setPlatformForTesting({
      ...base,
      modelsGet: async () => ({
        ...ok,
        version: null,
        models: [],
        defaultModel: null,
        compactionModel: null,
        titleModel: null,
        error: "写入模型配置失败：拒绝访问",
      }),
      modelsRefresh,
    });
    render(<ChatPanel />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(t.modelConfigUnavailable);
    expect(alert.textContent).toContain("拒绝访问");
    const input = screen.getByRole("textbox", { name: t.inputLabel });
    fireEvent.change(input, { target: { value: "你好" } });
    expect((screen.getByRole("button", { name: t.send }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(input, { key: "Enter" });
    expect((input as HTMLTextAreaElement).value).toBe("你好");

    fireEvent.click(screen.getByRole("button", { name: t.retryModelConfig }));
    await waitFor(() => expect(modelsRefresh).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText(t.modelConfigUnavailable)).toBeNull());
    expect((screen.getByRole("button", { name: t.send }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it("Core 拒绝 prompt 时显示错误并保留草稿", async () => {
    const base = createMockPlatform({ intervalMs: 1, batchSize: 50 });
    let deliver: ((b: CoreBatch) => void) | undefined;
    setPlatformForTesting({
      ...base,
      sessionOpen: async (_path, _model, onBatch) => {
        deliver = onBatch;
        return { sessionKey: "k" } as Awaited<ReturnType<typeof base.sessionOpen>>;
      },
      coreSend: async (sessionKey, record) => {
        deliver?.({
          sessionKey,
          seq: 1,
          dropped: 0,
          records: [
            {
              type: "response",
              id: record.id,
              command: record.type,
              success: false,
              error: "拒绝",
            },
          ],
        });
      },
    });
    render(<ChatPanel />);
    const input = screen.getByRole("textbox", { name: t.inputLabel });
    fireEvent.change(input, { target: { value: "你好" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect((input as HTMLTextAreaElement).value).toBe("你好");
  });

  it("命令 10 秒无响应时提示内核无响应，重启内核后恢复", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let stalled = true;
      const base = createMockPlatform({
        intervalMs: 1,
        batchSize: 50,
        stallCommand: (cmd) => stalled && isUserPrompt(cmd),
      });
      const coreRestart = vi.fn(async () => {
        stalled = false;
      });
      const coreSend = vi.fn(base.coreSend);
      setPlatformForTesting({ ...base, coreSend, coreRestart });
      render(<ChatPanel />);
      const input = screen.getByRole("textbox", { name: t.inputLabel });
      fireEvent.change(input, { target: { value: "你好" } });
      fireEvent.keyDown(input, { key: "Enter" });

      await vi.advanceTimersByTimeAsync(10_000);
      expect(await screen.findByText(t.unresponsive)).toBeTruthy();
      // 超时提示来自集中管理的文案，不显示原始命令名
      expect(screen.getByText(t.responseTimeout)).toBeTruthy();
      expect((input as HTMLTextAreaElement).value).toBe("你好"); // 保留草稿
      // 超时的 prompt 可能已被受理：恢复前禁止重发
      const sendButton = screen.getByRole("button", { name: t.send }) as HTMLButtonElement;
      expect(sendButton.disabled).toBe(true);
      const sentBefore = coreSend.mock.calls.length;
      fireEvent.keyDown(input, { key: "Enter" });
      fireEvent.click(sendButton);
      await vi.advanceTimersByTimeAsync(0);
      expect(coreSend).toHaveBeenCalledTimes(sentBefore);
      expect(coreSend.mock.calls.filter(([, r]) => isUserPrompt(r))).toHaveLength(1);

      fireEvent.click(screen.getByRole("button", { name: t.restartCore }));
      await waitFor(() => expect(coreRestart).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(screen.queryByText(t.unresponsive)).toBeNull());
      // 重启不留下错误提示，可以再次发送
      expect(screen.queryByRole("alert")).toBeNull();
      expect(sendButton.disabled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("内核未运行时提示已停止并提供重启，重启后可继续发送", async () => {
    let stopped = true;
    const base = createMockPlatform({ intervalMs: 1, batchSize: 50 });
    const coreSend = vi.fn(async (key: string, record: Parameters<typeof base.coreSend>[1]) => {
      if (stopped) throw new PlatformError("会话的内核未运行，请重启内核：k", CORE_NOT_RUNNING);
      return base.coreSend(key, record);
    });
    const coreRestart = vi.fn(async () => {
      stopped = false;
    });
    setPlatformForTesting({ ...base, coreSend, coreRestart });
    render(<ChatPanel />);
    const input = screen.getByRole("textbox", { name: t.inputLabel });
    fireEvent.change(input, { target: { value: "你好" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(await screen.findByText(t.coreStopped)).toBeTruthy();
    expect(screen.getByText(t.coreStoppedHint)).toBeTruthy();
    expect(screen.queryByText(t.unresponsive)).toBeNull();
    expect((input as HTMLTextAreaElement).value).toBe("你好"); // 保留草稿
    const sendButton = screen.getByRole("button", { name: t.send }) as HTMLButtonElement;
    expect(sendButton.disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: t.restartCore }));
    await waitFor(() => expect(coreRestart).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByText(t.coreStopped)).toBeNull());
    expect(screen.queryByRole("alert")).toBeNull();
    expect(sendButton.disabled).toBe(false);
    fireEvent.click(sendButton);
    // 内核未运行时权限模式同步就已失败，第一次的用户消息不会发出；重启后的这次才发出
    await waitFor(() =>
      expect(coreSend.mock.calls.filter(([, r]) => isUserPrompt(r))).toHaveLength(1),
    );
    // 重启后的发送才到达 mock：其回复应渲染到会话中
    await waitFor(() => expect(screen.getByText(/mock 平台/)).toBeTruthy());
    expect(screen.queryByText(t.coreStopped)).toBeNull();
  });

  it("重启后重建时内核未运行：提示已停止而不是无响应，保留重启入口", async () => {
    let stopped = true;
    const base = createMockPlatform({ intervalMs: 1, batchSize: 50 });
    const coreSend = vi.fn(async (key: string, record: Parameters<typeof base.coreSend>[1]) => {
      if (stopped) throw new PlatformError("会话的内核未运行，请重启内核：k", CORE_NOT_RUNNING);
      return base.coreSend(key, record);
    });
    // 重启“成功”但新进程随即退出：重建请求仍得到 coreNotRunning
    const coreRestart = vi.fn(async () => {});
    setPlatformForTesting({ ...base, coreSend, coreRestart });
    render(<ChatPanel />);
    const input = screen.getByRole("textbox", { name: t.inputLabel });
    fireEvent.change(input, { target: { value: "你好" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(await screen.findByText(t.coreStopped)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: t.restartCore }));
    await waitFor(() => expect(coreRestart).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(coreSend.mock.calls.some(([, r]) => r.type === "get_messages")).toBe(true),
    );
    await waitFor(() => expect(screen.getByText(t.coreStopped)).toBeTruthy());
    expect(screen.queryByText(t.unresponsive)).toBeNull();
    const sendButton = screen.getByRole("button", { name: t.send }) as HTMLButtonElement;
    expect(sendButton.disabled).toBe(true);
    expect(screen.getByRole("button", { name: t.restartCore })).toBeTruthy();
    stopped = false;
  });

  it("其他发送错误只显示错误文案，不锁定发送", async () => {
    const base = createMockPlatform({ intervalMs: 1, batchSize: 50 });
    const coreSend = vi.fn(async () => {
      throw new PlatformError("写入失败", undefined);
    });
    setPlatformForTesting({ ...base, coreSend });
    render(<ChatPanel />);
    const input = screen.getByRole("textbox", { name: t.inputLabel });
    fireEvent.change(input, { target: { value: "你好" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(await screen.findByText("写入失败")).toBeTruthy();
    expect(screen.queryByText(t.coreStopped)).toBeNull();
    expect(screen.queryByRole("button", { name: t.restartCore })).toBeNull();
    const sendButton = screen.getByRole("button", { name: t.send }) as HTMLButtonElement;
    expect(sendButton.disabled).toBe(false);
  });

  it("重启失败时保留已停止提示与重启入口", async () => {
    const base = createMockPlatform({ intervalMs: 1, batchSize: 50 });
    const coreSend = vi.fn(async () => {
      throw new PlatformError("会话的内核未运行，请重启内核：k", CORE_NOT_RUNNING);
    });
    const coreRestart = vi.fn(async () => {
      throw new PlatformError("内核 1 分钟内连续崩溃 3 次", undefined);
    });
    setPlatformForTesting({ ...base, coreSend, coreRestart });
    render(<ChatPanel />);
    const input = screen.getByRole("textbox", { name: t.inputLabel });
    fireEvent.change(input, { target: { value: "你好" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(await screen.findByText(t.coreStopped)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: t.restartCore }));
    await waitFor(() => expect(coreRestart).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("内核 1 分钟内连续崩溃 3 次")).toBeTruthy();
    expect(screen.getByText(t.coreStopped)).toBeTruthy();
    const restartButton = screen.getByRole("button", { name: t.restartCore }) as HTMLButtonElement;
    await waitFor(() => expect(restartButton.disabled).toBe(false));
  });

  it("重启进行中按钮禁用，连点只重启一次", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let stalled = true;
      const base = createMockPlatform({
        intervalMs: 1,
        batchSize: 50,
        stallCommand: (cmd) => stalled && isUserPrompt(cmd),
      });
      let finishRestart: (() => void) | undefined;
      const coreRestart = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finishRestart = () => {
              stalled = false;
              resolve();
            };
          }),
      );
      setPlatformForTesting({ ...base, coreRestart });
      render(<ChatPanel />);
      const input = screen.getByRole("textbox", { name: t.inputLabel });
      fireEvent.change(input, { target: { value: "你好" } });
      fireEvent.keyDown(input, { key: "Enter" });
      await vi.advanceTimersByTimeAsync(10_000);
      const restartButton = (await screen.findByRole("button", {
        name: t.restartCore,
      })) as HTMLButtonElement;

      fireEvent.click(restartButton);
      fireEvent.click(restartButton);
      await waitFor(() => expect(restartButton.disabled).toBe(true));
      fireEvent.click(restartButton);
      expect(coreRestart).toHaveBeenCalledTimes(1);

      finishRestart?.();
      await waitFor(() => expect(screen.queryByText(t.unresponsive)).toBeNull());
      expect(coreRestart).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole("alert")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("重启后重建失败保持无响应，之后缺口触发的重建成功即解除锁定", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const base = createMockPlatform({ intervalMs: 1, batchSize: 50 });
      let deliver: ((b: CoreBatch) => void) | undefined;
      let seq = 0;
      let phase: "stall" | "failResync" | "ok" = "stall";
      const respond = (sessionKey: string, id: string, command: string, success: boolean) => {
        seq += 1;
        deliver?.({
          sessionKey,
          seq,
          dropped: 0,
          records: [
            success
              ? { type: "response", id, command, success: true, data: {} }
              : { type: "response", id, command, success: false, error: "未就绪" },
          ] as CoreBatch["records"],
        });
      };
      const coreRestart = vi.fn(async () => {
        phase = "failResync";
      });
      setPlatformForTesting({
        ...base,
        coreRestart,
        sessionOpen: async (_path, _model, onBatch) => {
          deliver = onBatch;
          return { sessionKey: "k" } as Awaited<ReturnType<typeof base.sessionOpen>>;
        },
        coreSend: async (sessionKey, record) => {
          const { id, type } = record as { id: string; type: string };
          if (phase === "stall") return;
          queueMicrotask(() => respond(sessionKey, id, type, phase === "ok"));
        },
      });
      render(<ChatPanel />);
      const input = screen.getByRole("textbox", { name: t.inputLabel });
      fireEvent.change(input, { target: { value: "你好" } });
      fireEvent.keyDown(input, { key: "Enter" });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await screen.findByText(t.unresponsive)).toBeTruthy();

      fireEvent.click(screen.getByRole("button", { name: t.restartCore }));
      await waitFor(() => expect(coreRestart).toHaveBeenCalledTimes(1));
      // 重建失败：仍提示无响应，禁止发送
      expect(await screen.findByText(new RegExp(t.resyncFailed))).toBeTruthy();
      const sendButton = screen.getByRole("button", { name: t.send }) as HTMLButtonElement;
      expect(screen.getByText(t.unresponsive)).toBeTruthy();
      expect(sendButton.disabled).toBe(true);

      // 之后出现缺口，重建成功：解除锁定并清除重建错误
      phase = "ok";
      seq += 5;
      deliver?.({ sessionKey: "k", seq, dropped: 0, records: [] });
      await waitFor(() => expect(screen.queryByText(t.unresponsive)).toBeNull());
      await waitFor(() => expect(screen.queryByText(new RegExp(t.resyncFailed))).toBeNull());
      expect(sendButton.disabled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("打开历史会话：挂载后立即恢复会话并显示历史消息，工作区锁定", async () => {
    const platform = createMockPlatform({ intervalMs: 1, batchSize: 50 });
    setPlatformForTesting(platform);
    const first = await platform.sessionOpen("C:\\work\\demo", undefined, () => {});
    await platform.coreSend(first.sessionKey, { id: "h1", type: "prompt", message: "上次的问题" });
    await waitFor(async () => expect((await platform.sessionList(null)).items).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 50));
    await platform.sessionClose(first.sessionKey);
    const [entry] = (await platform.sessionList(null)).items;
    if (!entry) throw new Error("缺少索引条目");

    const sessionOpen = vi.spyOn(platform, "sessionOpen");
    render(
      <ChatPanel
        tab={{
          id: "tab-h",
          sessionPath: entry.path,
          sessionId: entry.id,
          workspace: entry.workspace,
          running: false,
          opening: false,
        }}
      />,
    );
    expect(await screen.findByText("上次的问题")).toBeTruthy();
    expect(sessionOpen).toHaveBeenCalledTimes(1);
    expect(sessionOpen.mock.calls[0]?.slice(0, 2)).toEqual(["C:\\work\\demo", entry.path]);
    // 历史会话的工作区锁定显示，不出现选择文件夹条
    expect(screen.queryByRole("button", { name: new RegExp(t.chooseFolder) })).toBeNull();
    expect(screen.getByTitle(new RegExp(t.workspaceLocked)).textContent).toContain("demo");
  });

  it("历史会话打开失败后，下一次发送前重新打开并加载历史", async () => {
    const platform = createMockPlatform({ intervalMs: 1, batchSize: 50 });
    setPlatformForTesting(platform);
    const first = await platform.sessionOpen("C:\\work\\demo", undefined, () => {});
    await platform.coreSend(first.sessionKey, { id: "h1", type: "prompt", message: "上次的问题" });
    await waitFor(async () => expect((await platform.sessionList(null)).items).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 50));
    await platform.sessionClose(first.sessionKey);
    const [entry] = (await platform.sessionList(null)).items;
    if (!entry) throw new Error("缺少索引条目");

    const sessionOpen = vi
      .spyOn(platform, "sessionOpen")
      .mockRejectedValueOnce(new Error("内核启动失败"));
    render(
      <ChatPanel
        tab={{
          id: "tab-r",
          sessionPath: entry.path,
          sessionId: entry.id,
          workspace: entry.workspace,
          running: false,
          opening: false,
        }}
      />,
    );
    expect(await screen.findByText(/内核启动失败/)).toBeTruthy();
    expect(screen.queryByText("上次的问题")).toBeNull();

    const input = screen.getByRole("textbox", { name: t.inputLabel });
    fireEvent.change(input, { target: { value: "继续" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(await screen.findByText("上次的问题")).toBeTruthy();
    expect(sessionOpen).toHaveBeenCalledTimes(2);
    expect(sessionOpen.mock.calls[1]?.[1]).toBe(entry.path);
    await waitFor(() => expect((input as HTMLTextAreaElement).value).toBe(""));
  });

  it("Shift+Enter 不发送；空内容不能发送", () => {
    render(<ChatPanel />);
    const input = screen.getByRole("textbox", { name: t.inputLabel });
    expect((screen.getByRole("button", { name: t.send }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(input, { target: { value: "第一行" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect((input as HTMLTextAreaElement).value).toBe("第一行");
    expect(screen.queryByRole("article")).toBeNull();
  });

  it("附件只引用本地路径：选中后显示文件名，可移除，单独附件也能发送", async () => {
    render(<ChatPanel />);
    fireEvent.click(await screen.findByRole("button", { name: t.attach }));
    expect(await screen.findByText("README.md")).toBeTruthy();
    expect(screen.getByText("main.ts")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: `${t.removeAttachment} main.ts` }));
    expect(screen.queryByText("main.ts")).toBeNull();
    expect((screen.getByRole("button", { name: t.send }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it("三档权限都可选，选择后发给 Core（/primus-mode），打开会话时先同步当前档位", async () => {
    const platform = createMockPlatform({ intervalMs: 1, batchSize: 50 });
    setPlatformForTesting(platform);
    const sent: string[] = [];
    const coreSend = platform.coreSend.bind(platform);
    vi.spyOn(platform, "coreSend").mockImplementation((key, record) => {
      if (record.type === "prompt") sent.push(String((record as { message: string }).message));
      return coreSend(key, record);
    });
    render(<ChatPanel />);
    const trigger = screen.getByRole("button", { name: new RegExp(t.permissionMode) });
    fireEvent.keyDown(trigger, { key: "Enter" });
    const edit = await screen.findByRole("menuitemradio", {
      name: new RegExp(t.permissions.edit.label),
    });
    expect(edit.getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(edit);
    expect(useAppStore.getState().permissionMode).toBe("edit");

    const input = screen.getByRole("textbox", { name: t.inputLabel });
    fireEvent.change(input, { target: { value: "你好" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(sent).toEqual(["/primus-mode edit", "你好"]));

    // 会话已打开时切换档位立即同步
    fireEvent.keyDown(screen.getByRole("button", { name: new RegExp(t.permissionMode) }), {
      key: "Enter",
    });
    fireEvent.click(
      await screen.findByRole("menuitemradio", { name: new RegExp(t.permissions.full.label) }),
    );
    await waitFor(() => expect(sent.at(-1)).toBe("/primus-mode full"));
    // 扩展命令不显示为用户消息
    await waitFor(() => expect(screen.getAllByRole("article", { name: t.you })).toHaveLength(1));
  });

  it("模型按钮显示当前模型，可切换模型与思考强度", async () => {
    const platform = createMockPlatform({ intervalMs: 1, batchSize: 50 });
    setPlatformForTesting(platform);
    const records: { type: string; [k: string]: unknown }[] = [];
    const coreSend = platform.coreSend.bind(platform);
    vi.spyOn(platform, "coreSend").mockImplementation((key, record) => {
      records.push(record as { type: string });
      return coreSend(key, record);
    });
    render(<ChatPanel />);
    const button = await screen.findByRole("button", { name: /模型：Mock 大模型/ });
    // 会话打开前选择：记下，打开后发送第一条消息前应用
    fireEvent.keyDown(button, { key: "Enter" });
    // 思考强度是滑杆：拖到“高”，松手才切换（默认档位为 off/low/medium/high/xhigh，“高”是第 3 档）
    const slider = await screen.findByRole("slider", { name: "思考" });
    fireEvent.change(slider, { target: { value: "3" } });
    fireEvent.pointerUp(slider);
    // 滑杆松手后菜单保持打开，关掉再看按钮
    fireEvent.keyDown(slider, { key: "Escape" });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /模型：Mock 大模型，思考高/ })).toBeTruthy(),
    );
    const input = screen.getByRole("textbox", { name: t.inputLabel });
    fireEvent.change(input, { target: { value: "你好" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(records.find((r) => r.type === "set_thinking_level")).toMatchObject({
        level: "high",
      }),
    );
    // 会话打开后切换模型：立即发 set_model，按钮随之更新（等这一轮回答结束、按钮解锁）
    await waitFor(() => expect(screen.getByText(/你刚才说：「你好」/)).toBeTruthy());
    const second = await screen.findByRole("button", { name: /模型：Mock 大模型，思考高/ });
    await waitFor(() => expect(second.hasAttribute("disabled")).toBe(false));
    fireEvent.keyDown(second, { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "Mock 快速模型" }));
    await waitFor(() =>
      expect(records.find((r) => r.type === "set_model")).toMatchObject({
        provider: "mock-responses",
        modelId: "mock-fast",
      }),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /模型：Mock 快速模型/ })).toBeTruthy(),
    );
  });

  it("扩展的操作确认显示在输入框上方，选择后回复 Core 并消失", async () => {
    const platform = createMockPlatform({ intervalMs: 1, batchSize: 50 });
    let deliver: ((b: CoreBatch) => void) | undefined;
    const open = platform.sessionOpen.bind(platform);
    vi.spyOn(platform, "sessionOpen").mockImplementation(async (ws, path, onBatch) => {
      deliver = onBatch;
      return open(ws, path, onBatch);
    });
    const responses: unknown[] = [];
    const coreSend = platform.coreSend.bind(platform);
    vi.spyOn(platform, "coreSend").mockImplementation((key, record) => {
      if (record.type === "extension_ui_response") responses.push(record);
      return coreSend(key, record);
    });
    setPlatformForTesting(platform);
    render(<ChatPanel />);
    const input = screen.getByRole("textbox", { name: t.inputLabel });
    fireEvent.change(input, { target: { value: "你好" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(deliver).toBeDefined());
    const key = (
      platform.sessionOpen as unknown as {
        mock: { results: { value: Promise<{ sessionKey: string }> }[] };
      }
    ).mock.results[0]?.value;
    const sessionKey = (await key)?.sessionKey ?? "";
    deliver?.({
      sessionKey,
      seq: 10_000,
      dropped: 0,
      records: [
        {
          type: "extension_ui_request",
          id: "ask-1",
          method: "select",
          title: "运行命令：npm test",
          options: ["允许", "本会话内始终允许", "拒绝"],
        },
      ],
    });
    const card = await screen.findByRole("alertdialog", { name: t.approval.label });
    expect(card.textContent).toContain("运行命令：npm test");
    fireEvent.click(screen.getByRole("button", { name: "拒绝" }));
    await waitFor(() =>
      expect(responses).toEqual([{ type: "extension_ui_response", id: "ask-1", value: "拒绝" }]),
    );
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("多轮对话：每轮结束（agent_settled）后解锁输入，第二轮接在第一轮之后", async () => {
    render(<ChatPanel />);
    const input = screen.getByRole("textbox", { name: t.inputLabel });
    for (const text of ["第一问", "第二问"]) {
      await waitFor(() => expect(screen.getByRole("button", { name: t.send })).toBeTruthy());
      fireEvent.change(input, { target: { value: text } });
      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() => expect((input as HTMLTextAreaElement).value).toBe(""));
    }
    await waitFor(() => expect(screen.getByText(/你刚才说：「第二问」/)).toBeTruthy());
    await waitFor(() => expect(screen.getByRole("button", { name: t.send })).toBeTruthy());
    const users = screen.getAllByRole("article", { name: t.you }).map((a) => a.textContent);
    expect(users).toEqual(["第一问", "第二问"]);
    // 每轮的工具调用回复与最终回答合成一轮（工作过程 + 总结）
    expect(screen.getAllByRole("article", { name: t.assistant })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: t.work.expand })).toHaveLength(2);
    expect(screen.getByText(/你刚才说：「第一问」/)).toBeTruthy();
  });

  it("运行中可以停止：1 秒内恢复发送，半截回复标为已停止，之后可以继续对话", async () => {
    setPlatformForTesting(createMockPlatform({ intervalMs: 20, batchSize: 2 }));
    render(<ChatPanel />);
    const input = screen.getByRole("textbox", { name: t.inputLabel });
    fireEvent.change(input, { target: { value: "长任务" } });
    fireEvent.keyDown(input, { key: "Enter" });
    const stopButton = await screen.findByRole("button", { name: t.stop });
    // 等到助手回复开始输出再停止
    await screen.findByRole("article", { name: t.assistant });
    const started = performance.now();
    fireEvent.click(stopButton);
    // 先填好下一条：停止生效即发送按钮可用（不只是出现）
    fireEvent.change(input, { target: { value: "继续" } });
    await waitFor(
      () =>
        expect((screen.getByRole("button", { name: t.send }) as HTMLButtonElement).disabled).toBe(
          false,
        ),
      { timeout: 1000 },
    );
    expect(performance.now() - started).toBeLessThan(1000);
    expect(screen.getByText(t.stopped)).toBeTruthy();
    expect(screen.queryByText(/mock 平台/)).toBeNull();

    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(screen.getByText(/你刚才说：「继续」/)).toBeTruthy(), {
      timeout: 5000,
    });
  });

  it("输入框里按 Esc 不停止；停止进行中按钮禁用，不重复发 abort", async () => {
    const base = createMockPlatform({ intervalMs: 20, batchSize: 2 });
    const coreSend = vi.fn(base.coreSend);
    setPlatformForTesting({ ...base, coreSend });
    render(<ChatPanel />);
    const input = screen.getByRole("textbox", { name: t.inputLabel });
    fireEvent.change(input, { target: { value: "长任务" } });
    fireEvent.keyDown(input, { key: "Enter" });
    const stopBtn = await screen.findByRole("button", { name: t.stop });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(coreSend.mock.calls.some(([, r]) => r.type === "abort")).toBe(false);
    fireEvent.click(stopBtn);
    const stopping = await screen.findByRole("button", { name: t.stopping });
    expect((stopping as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(stopping);
    await waitFor(() => expect(screen.getByRole("button", { name: t.send })).toBeTruthy());
    expect(coreSend.mock.calls.filter(([, r]) => r.type === "abort")).toHaveLength(1);
  });

  it("abort 失败时停止按钮恢复可用，可以重试；成功前不提前恢复", async () => {
    const base = createMockPlatform({ intervalMs: 20, batchSize: 2 });
    let reject = true;
    // 第一次 abort 不交给 mock，而是把失败响应并入下一个批次
    const inject: CoreBatch["records"] = [];
    const coreSend = vi.fn(async (key: string, record: Parameters<typeof base.coreSend>[1]) => {
      if (record.type === "abort" && reject) {
        reject = false;
        inject.push({
          type: "response",
          id: record.id,
          command: "abort",
          success: false,
          error: "拒绝",
        });
        return;
      }
      return base.coreSend(key, record);
    });
    setPlatformForTesting({
      ...base,
      coreSend,
      sessionOpen: (ws, path, onBatch) =>
        base.sessionOpen(ws, path, (b) =>
          onBatch({ ...b, records: [...inject.splice(0), ...b.records] }),
        ),
    });
    render(<ChatPanel />);
    const input = screen.getByRole("textbox", { name: t.inputLabel });
    fireEvent.change(input, { target: { value: "长任务" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(await screen.findByRole("button", { name: t.stop }));
    // 失败后恢复为可用的停止按钮
    const again = await screen.findByRole("button", { name: t.stop });
    expect((again as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(again);
    await waitFor(() => expect(screen.getByRole("button", { name: t.send })).toBeTruthy());
    expect(coreSend.mock.calls.filter(([, r]) => r.type === "abort")).toHaveLength(2);
  });

  it("时间线按悬浮输入框的实测高度留出底部空间，欢迎页不被遮挡", () => {
    const spy = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        const h = this.querySelector("form") ? 150 : 0;
        return { height: h, width: 0, top: 0, left: 0, right: 0, bottom: h, x: 0, y: 0 } as DOMRect;
      });
    try {
      render(<ChatPanel />);
      const scroller = screen
        .getByRole("heading", { name: t.welcomeTitle })
        .closest(".overflow-y-auto") as HTMLElement;
      // 输入框 150px + 间距 16px
      expect(scroller.style.paddingBottom).toBe("166px");
    } finally {
      spy.mockRestore();
    }
  });
});
