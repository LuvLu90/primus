"use client";

import { useEffect, useState } from "react";
import { getPlatform } from "@/lib/platform";

/**
 * 当前用户未选工作区时会话使用的默认目录（session_default_workspace）。
 * 读取中为 undefined，读取失败为 null。
 */
export function useSessionDefaultWorkspace(): string | null | undefined {
  const [path, setPath] = useState<string | null>();
  useEffect(() => {
    let alive = true;
    getPlatform()
      .then((p) => p.sessionDefaultWorkspace())
      .then(
        (dir) => alive && setPath(dir || null),
        () => alive && setPath(null),
      );
    return () => {
      alive = false;
    };
  }, []);
  return path;
}
