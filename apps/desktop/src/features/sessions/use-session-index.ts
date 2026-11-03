"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getPlatform } from "@/lib/platform";
import type { SessionSummary } from "@/lib/platform/types";

// 会话索引的前端视图（第 10.2 节、ADR 0006）：分页读取 session_list，订阅 session_watch，
// 索引一变就按已加载的页数重新拉取（每页 50 条），已滚动加载的内容不会因刷新丢失。

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export interface SessionIndexView {
  items: SessionSummary[];
  hasMore: boolean;
  loading: boolean;
  error?: string;
  /** 每次重新拉取成功加一：搜索结果据此跟着索引刷新 */
  version: number;
  loadMore: () => void;
  reload: () => void;
}

export function useSessionIndex(): SessionIndexView {
  const [items, setItems] = useState<SessionSummary[]>([]);
  const [cursor, setCursor] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [version, setVersion] = useState(0);
  const pages = useRef(1);
  // 代次：只采纳最近一次发起的加载结果，避免旧请求晚到覆盖新列表
  const generation = useRef(0);
  const mounted = useRef(false);
  const inFlight = useRef(false);
  const dirty = useRef(false);

  const reload = useCallback(async () => {
    // 加载进行中又收到变化：标记一下，结束后再拉一次，不并发请求
    if (inFlight.current) {
      dirty.current = true;
      return;
    }
    inFlight.current = true;
    const gen = ++generation.current;
    try {
      const platform = await getPlatform();
      let all: SessionSummary[] = [];
      let next: string | undefined;
      for (let i = 0; i < pages.current; i++) {
        const page = await platform.sessionList(null, next);
        all = all.concat(page.items);
        next = page.nextCursor;
        if (!next) break;
      }
      if (mounted.current && gen === generation.current) {
        setItems(all);
        setCursor(next);
        setError(undefined);
        setVersion((v) => v + 1);
      }
    } catch (e) {
      if (mounted.current && gen === generation.current) setError(errorText(e));
    } finally {
      inFlight.current = false;
      if (mounted.current && gen === generation.current) setLoading(false);
      if (dirty.current && mounted.current) {
        dirty.current = false;
        void reload();
      }
    }
  }, []);

  const loadMore = useCallback(async () => {
    if (!cursor || inFlight.current) return;
    inFlight.current = true;
    const gen = ++generation.current;
    setLoading(true);
    try {
      const platform = await getPlatform();
      const page = await platform.sessionList(null, cursor);
      if (mounted.current && gen === generation.current) {
        pages.current += 1;
        // 两页之间索引可能有变化：按路径去重
        setItems((prev) => {
          const seen = new Set(prev.map((s) => s.path));
          return prev.concat(page.items.filter((s) => !seen.has(s.path)));
        });
        setCursor(page.nextCursor);
      }
    } catch (e) {
      if (mounted.current && gen === generation.current) setError(errorText(e));
    } finally {
      inFlight.current = false;
      if (mounted.current && gen === generation.current) setLoading(false);
      if (dirty.current && mounted.current) {
        dirty.current = false;
        void reload();
      }
    }
  }, [cursor, reload]);

  useEffect(() => {
    mounted.current = true;
    void getPlatform()
      .then((p) =>
        p.sessionWatch(() => {
          if (mounted.current) void reload();
        }),
      )
      .catch((e) => mounted.current && setError(errorText(e)));
    void reload();
    return () => {
      mounted.current = false;
    };
  }, [reload]);

  return {
    items,
    hasMore: cursor !== undefined,
    loading,
    error,
    version,
    loadMore: () => void loadMore(),
    reload: () => void reload(),
  };
}

/** 搜索：输入停顿 200ms 后查询；查询为空时为 null（显示普通列表）。`version` 变化（索引有更新）时重新查询 */
export function useSessionSearch(
  query: string,
  version: number,
): {
  results: SessionSummary[] | null;
  error?: string;
} {
  const [results, setResults] = useState<SessionSummary[] | null>(null);
  const [error, setError] = useState<string>();
  const q = query.trim();
  // biome-ignore lint/correctness/useExhaustiveDependencies: version 只用来在索引更新后重新查询
  useEffect(() => {
    if (!q) {
      setResults(null);
      setError(undefined);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      getPlatform()
        .then((p) => p.sessionSearch(null, q))
        .then((found) => {
          if (cancelled) return;
          setResults(found);
          setError(undefined);
        })
        .catch((e) => {
          if (!cancelled) setError(errorText(e));
        });
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [q, version]);
  return { results, error };
}
