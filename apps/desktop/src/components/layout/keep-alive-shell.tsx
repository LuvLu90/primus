"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { AppShell } from "./app-shell";

/**
 * 主界面常驻：首次进入主页后一直挂载，切到设置、能力中心等页面时只隐藏。
 * 主界面卸载会关闭所有会话的 Core 连接、丢掉时间线状态，回来后会话打不开或无法继续对话；
 * 放在根布局里随页面切换保留，回到主页时原样恢复。
 */
export function KeepAliveShell() {
  const pathname = usePathname();
  const home = pathname === "/" || pathname === "";
  const [visited, setVisited] = useState(home);
  useEffect(() => {
    if (home) setVisited(true);
  }, [home]);
  if (!visited && !home) return null;
  return (
    <div hidden={!home} className={home ? "contents" : "hidden"}>
      <AppShell />
    </div>
  );
}
