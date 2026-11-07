"use client";

import { useCallback, useEffect, useState } from "react";
import { getPlatform, type ModelsInfo, type Platform } from "@/lib/platform";

// 模型配置的订阅（`models_watch`）：薄壳只保留一个订阅，而主界面常驻、设置页同时打开，
// 这里在前端注册一次再分发给所有订阅者。本地保存 / 删除渠道后也经 publishModels 分发，界面立即更新。

type Listener = (info: ModelsInfo) => void;

const listeners = new Set<Listener>();
let watched: Platform | undefined;

/** 把新的模型配置分发给所有订阅者 */
export function publishModels(info: ModelsInfo): void {
  for (const listener of listeners) listener(info);
}

/** 订阅模型配置变化；返回取消订阅 */
export function subscribeModels(listener: Listener): () => void {
  listeners.add(listener);
  void getPlatform()
    .then((p) => {
      // 平台实现换了（测试注入）才重新注册；缺少该命令的实现（部分替身）忽略
      if (watched === p || typeof p.modelsWatch !== "function") return;
      watched = p;
      return p.modelsWatch(publishModels).catch(() => {
        // 注册失败时允许下一个订阅者重试
        if (watched === p) watched = undefined;
      });
    })
    .catch(() => {});
  return () => {
    listeners.delete(listener);
  };
}

/**
 * 当前模型配置：先 `models_get`，之后随 `models_watch` 推送更新。
 * `error` 为读取失败的原因（读取成功后清空）
 */
export function useModelsInfo() {
  const [info, setInfo] = useState<ModelsInfo | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    let cancelled = false;
    const unsubscribe = subscribeModels((i) => {
      if (cancelled) return;
      setInfo(i);
      setError(null);
    });
    getPlatform()
      .then((p) => p.modelsGet())
      .then((i) => {
        if (cancelled) return;
        // 推送可能先到：只在还没有数据时采用这次读取的结果
        setInfo((prev) => prev ?? i);
      })
      .catch((e: unknown) => !cancelled && setError(e));
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);
  /** 命令返回了新的模型配置：更新本组件并分发给其他订阅者 */
  const update = useCallback((i: ModelsInfo) => {
    setInfo(i);
    publishModels(i);
  }, []);
  return { info, error, update };
}

/** 渠道 ID → 渠道名称（模型选择器分组标题用）；模型配置变化时重新读取 */
export function useProviderNames(info: ModelsInfo | null): Record<string, string> {
  const [names, setNames] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!info) return;
    let cancelled = false;
    getPlatform()
      .then((p) => (typeof p.providersList === "function" ? p.providersList() : []))
      .then((list) => {
        if (!cancelled) setNames(Object.fromEntries(list.map((p) => [p.id, p.name])));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [info]);
  return names;
}
