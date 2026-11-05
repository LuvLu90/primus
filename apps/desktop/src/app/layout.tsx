import "./globals.css";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { KeepAliveShell } from "@/components/layout/keep-alive-shell";
import { AppearanceController } from "@/components/theme/appearance-controller";
import { strings } from "@/lib/strings";

// 主界面去掉顶栏后，产品名只出现在文档标题里（任务栏与 CI 冒烟检查都读它）
export const metadata: Metadata = { title: strings.appName };

// 布局只放外壳；页面根组件一律 "use client"（第 16.1.1 节）
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        {/* 同源同步脚本：首帧前应用深色主题。CSP 只允许 'self'，不能内联；也不能用 next/script 延后加载 */}
        <script src="/theme-init.js" />
      </head>
      <body>
        <AppearanceController />
        {/* 主界面常驻在布局里，切换页面时不卸载（见 KeepAliveShell）；主页本身不再渲染内容 */}
        <KeepAliveShell />
        {children}
      </body>
    </html>
  );
}
