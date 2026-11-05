"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { AppShell } from "./app-shell";

/**
 * 主界面常驻：首次进入主页后一直挂载，切到设置、能力中心等页面时只隐藏。
 * 主界面卸载会关闭所有会话的 Core 连接、丢掉时间线状态，回来后会话打不开或无法继续对话；
 * 放在根布局里随页面切换保留，回到主页时原样恢复。
 */
/**
 * 屏蔽 WebView 自带的右键菜单（返回、刷新、另存为、打印、检查……）：桌面应用里这些操作没有意义，
 * 刷新还会丢掉正在进行的会话。输入框里保留系统菜单（剪切、复制、粘贴）；开发模式保留以便“检查”。
 * 需要右键操作的地方（如会话列表）自己处理 contextmenu 弹出应用菜单。
 */
function useNoNativeContextMenu() {
  useEffect(() => {
    if (process.env.NODE_ENV === "development") return;
    const onContextMenu = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest("input, textarea, [contenteditable='true']")) return;
      e.preventDefault();
    };
    window.addEventListener("contextmenu", onContextMenu);
    return () => window.removeEventListener("contextmenu", onContextMenu);
  }, []);
}

export function KeepAliveShell() {
  useNoNativeContextMenu();
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
