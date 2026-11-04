"use client";

import { BarChart3, Puzzle, Settings, SquarePen, UserRound } from "lucide-react";
import { useRouter } from "next/navigation";
import { GlassButton } from "@/components/ui/glass-button";
import {
  GlassPopover,
  GlassPopoverContent,
  GlassPopoverItem,
  GlassPopoverSeparator,
  GlassPopoverTrigger,
} from "@/components/ui/glass-popover";
import { SessionList } from "@/features/sessions/session-list";
import { useSessionsStore } from "@/features/sessions/sessions-store";
import { strings } from "@/lib/strings";
import { GlassPanel, glassButtonClass, toolbarButtonClass, useGlassStyle } from "./glass-panel";
import { seamBleedStyle, sidePanelSeamStyle, sideShellClass } from "./seam";

const t = strings.layout;

// 左栏（默认 232px，可拖动、可收起，第 16.2 节）：新会话 · 搜索 · 会话列表 · 设置菜单。
// 工作区在中央输入框上方选择；会话列表读取薄壳的会话索引（ADR 0006）。宽度由 AppShell 按视口计算后传入。
export function SessionsSidebar({ width }: { width: number }) {
  const router = useRouter();
  const glass = useGlassStyle();
  const newTab = useSessionsStore((s) => s.newTab);

  return (
    <div className={sideShellClass} style={{ width, ...sidePanelSeamStyle("left") }}>
      <GlassPanel className="shrink-0 shadow-none" style={seamBleedStyle("left", width)}>
        <nav aria-label={t.sessions} className="flex h-full flex-col gap-3 p-3">
          <GlassButton
            variant="capsule"
            size={36}
            {...glass}
            className={`w-full ${glassButtonClass}`}
            onClick={newTab}
          >
            <SquarePen aria-hidden size={16} strokeWidth={2} />
            <span className="text-[13px] font-medium">{t.newSession}</span>
          </GlassButton>

          {/* 搜索 + 会话列表 */}
          <SessionList />

          {/* 设置入口：先展开菜单（账户 · 用量 · 能力中心 · 设置）；“用量”是设置中的一个分组，直接打开设置页的该分组 */}
          <div className="flex items-center">
            <GlassPopover>
              <GlassPopoverTrigger asChild>
                <GlassButton
                  size={32}
                  {...glass}
                  aria-label={t.settings}
                  className={toolbarButtonClass}
                >
                  <Settings aria-hidden size={16} />
                </GlassButton>
              </GlassPopoverTrigger>
              <GlassPopoverContent side="top" sideOffset={8} tint={0.75} minWidth={168}>
                <GlassPopoverItem
                  icon={<UserRound />}
                  label={t.menuAccount}
                  sublabel={t.menuAccountHint}
                  disabled
                />
                <GlassPopoverItem
                  icon={<BarChart3 />}
                  label={t.menuUsage}
                  onSelect={() => router.push("/settings/?group=usage")}
                />
                <GlassPopoverItem
                  icon={<Puzzle />}
                  label={t.menuCapabilities}
                  onSelect={() => router.push("/capabilities/")}
                />
                <GlassPopoverSeparator />
                <GlassPopoverItem
                  icon={<Settings />}
                  label={t.menuSettings}
                  onSelect={() => router.push("/settings/")}
                />
              </GlassPopoverContent>
            </GlassPopover>
          </div>
        </nav>
      </GlassPanel>
    </div>
  );
}
