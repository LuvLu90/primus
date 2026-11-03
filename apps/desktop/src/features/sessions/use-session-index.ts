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
  /** 重新拉取；索引订阅尚未建立（之前订阅失败）时先重新订阅 */
  reload: () => void;
}

export function useSessionIndex(): SessionIndexView {
  const [items, setItems] = useState<SessionSummary[]>([]);
  const [cursor, setCursor] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  // 订阅失败单独记：列表重新拉取成功不清除它，只有重新订阅成功才清除
  const [watchError, setWatchError] = useState<string>();
  const [version, setVersion] = useState(0);
  const pages = useRef(1);
  // 代次：只采纳最近一次发起的加载结果，避免旧请求晚到覆盖新列表
  const generation = useRef(0);
  const mounted = useRef(false);
  const inFlight = useRef(false);
  const dirty = useRef(false);
  // 索引订阅已建立（sessionWatch 成功）；薄壳再次订阅时替换旧的 Channel，重复订阅无害
  const watching = useRef(false);
  const watchingPromise = useRef<Promise<void>>(null);

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
        setError(undefined);
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

  /** 订阅索引变化；已订阅或正在订阅时不重复发起。失败时记下错误，重试（reload）时再订阅 */
  const watch = useCallback(() => {
    if (watching.current || watchingPromise.current) return;
    watchingPromise.current = getPlatform()
      .then((p) =>
        p.sessionWatch(() => {
          if (mounted.current) void reload();
        }),
      )
      .then(() => {
        watching.current = true;
        if (mounted.current) setWatchError(undefined);
      })
      .catch((e) => {
        if (mounted.current) setWatchError(errorText(e));
      })
      .finally(() => {
        watchingPromise.current = null;
      });
  }, [reload]);

  useEffect(() => {
    mounted.current = true;
    watch();
    void reload();
    return () => {
      mounted.current = false;
    };
  }, [reload, watch]);

  return {
    items,
    hasMore: cursor !== undefined,
    loading,
    error: error ?? watchError,
    version,
    loadMore: () => void loadMore(),
    reload: () => {
      watch();
      void reload();
    },
  };
}

export interface SessionSearchView {
  /** 查询为空时为 null（显示普通列表）；当前查询还没有结果时为空数组（`pending`），不显示旧查询的结果或未筛选的列表 */
  results: SessionSummary[] | null;
  /** 当前查询的搜索尚未完成（输入去抖中或请求中） */
  pending: boolean;
  /** 当前查询的搜索错误（此时 `results` 为空数组） */
  error?: string;
  /** 按当前查询重新搜索（搜索出错后重试用） */
  retry: () => void;
}

/** 搜索：输入停顿 200ms 后查询。`version` 变化（索引有更新）时按同一查询重新查询，期间保留该查询已有的结果 */
export function useSessionSearch(query: string, version: number): SessionSearchView {
  // 结果连同它对应的查询一起记：查询变了而新结果未到时，旧结果不再算作当前结果
  const [settled, setSettled] = useState<{
    query: string;
    results: SessionSummary[];
    error?: string;
  }>();
  // 每次重试加一：查询与索引版本都没变时也能重新搜索
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => {
    setSettled(undefined);
    setAttempt((n) => n + 1);
  }, []);
  const q = query.trim();
  // biome-ignore lint/correctness/useExhaustiveDependencies: version 与 attempt 只用来在索引更新或重试时重新查询
  useEffect(() => {
    if (!q) {
      setSettled(undefined);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      getPlatform()
        .then((p) => p.sessionSearch(null, q))
        .then((found) => {
          if (!cancelled) setSettled({ query: q, results: found });
        })
        .catch((e) => {
          if (!cancelled) setSettled({ query: q, results: [], error: errorText(e) });
        });
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [q, version, attempt]);
  if (!q) return { results: null, pending: false, retry };
  if (settled?.query !== q) return { results: [], pending: true, retry };
  return { results: settled.results, pending: false, error: settled.error, retry };
}
