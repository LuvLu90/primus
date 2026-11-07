import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AttachmentImage } from "@/lib/platform/types";
import { strings } from "@/lib/strings";
import { STAGE, useAttachments } from "./use-attachments";

/** 可手动完成的读取：记录调用顺序，测试里逐个 resolve / reject */
function deferredReader() {
  const calls: {
    path: string;
    resolve: (v: AttachmentImage) => void;
    reject: (e: Error) => void;
  }[] = [];
  const readPath = vi.fn(
    (path: string) =>
      new Promise<AttachmentImage>((resolve, reject) => calls.push({ path, resolve, reject })),
  );
  const image = (name: string): AttachmentImage => ({
    mimeType: "image/png",
    data: btoa(name),
    thumb: `data:image/png;base64,${btoa(name)}`,
    width: 1,
    height: 1,
  });
  return { calls, readPath, image };
}

describe("useAttachments", () => {
  it("图片按顺序逐张读取，文件立即落地；读完前 pending", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { calls, readPath, image } = deferredReader();
      const { result } = renderHook(() => useAttachments({ imagesSupported: true, readPath }));
      act(() => result.current.addPaths(["C:\\a.png", "C:\\doc.pdf", "C:\\b.jpg"]));
      expect(result.current.items.map((a) => a.status)).toEqual(["reading", "ready", "queued"]);
      expect(result.current.items[0]?.progress).toBe(STAGE.reading);
      expect(result.current.pending).toBe(true);
      // 一次只读一张
      expect(calls.map((c) => c.path)).toEqual(["C:\\a.png"]);
      await act(async () => calls[0]?.resolve(image("a")));
      expect(result.current.items[0]?.progress).toBe(STAGE.done);
      await act(async () => vi.advanceTimersByTime(400));
      expect(result.current.items[0]?.status).toBe("ready");
      expect(calls.map((c) => c.path)).toEqual(["C:\\a.png", "C:\\b.jpg"]);
      await act(async () => calls[1]?.resolve(image("b")));
      await act(async () => vi.advanceTimersByTime(400));
      expect(result.current.pending).toBe(false);
      const built = result.current.build();
      expect(built.images.map((i) => i.data)).toEqual([btoa("a"), btoa("b")]);
      expect(built.paths).toEqual(["C:\\doc.pdf"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("同一路径去重；读取中移除即取消，迟到的结果被丢弃，队列继续", async () => {
    const { calls, readPath, image } = deferredReader();
    const { result } = renderHook(() => useAttachments({ imagesSupported: true, readPath }));
    act(() => result.current.addPaths(["C:\\a.png", "C:\\b.png"]));
    act(() => result.current.addPaths(["C:\\a.png"]));
    expect(result.current.items).toHaveLength(2);
    const first = result.current.items[0]?.id ?? "";
    act(() => result.current.remove(first));
    expect(result.current.items[0]?.removing).toBe(true);
    // 被移除的不再参与发送，下一张立即开始读
    await waitFor(() => expect(calls.map((c) => c.path)).toEqual(["C:\\a.png", "C:\\b.png"]));
    await act(async () => calls[0]?.resolve(image("a")));
    expect(result.current.items[0]?.image).toBeUndefined();
    act(() => result.current.finalizeRemove(first));
    expect(result.current.items.map((a) => a.path)).toEqual(["C:\\b.png"]);
    // 移除动画期间重新添加同一路径：作为新附件
    act(() => result.current.addPaths(["C:\\b.png"]));
    expect(result.current.items).toHaveLength(1);
  });

  it("读取失败：状态为 error 并带原因，按路径引用发送", async () => {
    const { calls, readPath } = deferredReader();
    const { result } = renderHook(() => useAttachments({ imagesSupported: true, readPath }));
    act(() => result.current.addPaths(["C:\\bad.png"]));
    await act(async () => calls[0]?.reject(new Error("图片无法解码")));
    expect(result.current.items[0]).toMatchObject({ status: "error", error: "图片无法解码" });
    expect(result.current.pending).toBe(false);
    expect(result.current.build()).toEqual({ images: [], paths: ["C:\\bad.png"] });
  });

  it("模型不看图：不读取，有路径的按路径引用，内存图片无法发送；换回能看图的模型后读取", async () => {
    const { calls, readPath, image } = deferredReader();
    const readBlob = vi.fn(async () => ({
      image: { type: "image" as const, mimeType: "image/png", data: "eA==" },
      thumb: "data:image/png;base64,eA==",
    }));
    const { result, rerender } = renderHook(
      ({ supported }) => useAttachments({ imagesSupported: supported, readPath, readBlob }),
      { initialProps: { supported: false } },
    );
    act(() => result.current.addPaths(["C:\\a.png"]));
    act(() => {
      result.current.addBlobs([new File(["x"], "image.png", { type: "image/png" })]);
    });
    expect(calls).toHaveLength(0);
    expect(result.current.items[0]).toMatchObject({ byPath: true, status: "ready" });
    expect(result.current.items[1]).toMatchObject({
      status: "error",
      error: strings.chat.attachments.unsupportedPasted,
      name: `${strings.chat.attachments.pasted} 1.png`,
    });
    expect(result.current.pending).toBe(false);
    expect(result.current.build()).toEqual({ images: [], paths: ["C:\\a.png"] });
    rerender({ supported: true });
    expect(result.current.pending).toBe(true);
    await waitFor(() => expect(calls).toHaveLength(1));
    await act(async () => calls[0]?.resolve(image("a")));
    await waitFor(() => expect(readBlob).toHaveBeenCalled());
    await waitFor(() => expect(result.current.pending).toBe(false), { timeout: 2000 });
    expect(result.current.build().images).toHaveLength(2);
  });

  it("提交中不能移除；clear 让全部播放移除动画", () => {
    const { readPath } = deferredReader();
    const { result, rerender } = renderHook(
      ({ locked }) => useAttachments({ imagesSupported: true, locked, readPath }),
      { initialProps: { locked: true } },
    );
    act(() => result.current.addPaths(["C:\\a.txt", "C:\\b.txt"]));
    act(() => result.current.remove(result.current.items[0]?.id ?? ""));
    expect(result.current.items.every((a) => !a.removing)).toBe(true);
    rerender({ locked: false });
    act(() => result.current.clear());
    expect(result.current.items.every((a) => a.removing)).toBe(true);
    expect(result.current.hasContent).toBe(false);
  });

  it("剪贴板里只接受图片", () => {
    const { readPath } = deferredReader();
    const { result } = renderHook(() => useAttachments({ imagesSupported: false, readPath }));
    let added = 0;
    act(() => {
      added = result.current.addBlobs([new File(["x"], "a.txt", { type: "text/plain" })]);
    });
    expect(added).toBe(0);
    expect(result.current.items).toHaveLength(0);
  });
});

describe("useAttachments：可发送内容", () => {
  it("模型不看图时，只有内存图片不算可发送内容（不会发出空消息）", () => {
    const { result } = renderHook(() =>
      useAttachments({ imagesSupported: false, readPath: vi.fn() }),
    );
    act(() => {
      result.current.addBlobs([new File(["x"], "image.png", { type: "image/png" })]);
    });
    expect(result.current.items).toHaveLength(1);
    expect(result.current.hasContent).toBe(false);
    act(() => result.current.addPaths(["C:\\a.txt"]));
    expect(result.current.hasContent).toBe(true);
  });
});
