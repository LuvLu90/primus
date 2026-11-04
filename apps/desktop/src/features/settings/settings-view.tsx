"use client";

import { ChevronLeft } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useId, useState } from "react";
import { GlassPanel } from "@/components/layout/glass-panel";
import {
  centerSeamStyle,
  OUTER_RADIUS,
  SEAM_BLEED,
  seamBleedStyle,
  sidePanelSeamStyle,
  sideShellClass,
} from "@/components/layout/seam";
import { WindowTitleBar } from "@/components/layout/window-controls";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/glass-tabs";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { strings } from "@/lib/strings";
import { cn } from "@/lib/utils";
import { type ThemeMode, useAppearanceStore } from "@/stores/appearance-store";
import { AccountSettings, ModelSettings } from "./account-models";
import { Row, Section } from "./settings-section";

const t = strings.settings;
export type SettingsGroup = keyof typeof t.groups;
const GROUPS = Object.keys(t.groups) as SettingsGroup[];

/** 启动与通知开关的默认值（第 18 章），settings.toml 接入前只读 */
const PENDING_DEFAULTS = { reopen: true, tray: false, notify: true } as const;

function GeneralSettings() {
  const theme = useAppearanceStore((s) => s.theme);
  const setTheme = useAppearanceStore((s) => s.setTheme);
  const glassTint = useAppearanceStore((s) => s.glassTint);
  const setGlassTint = useAppearanceStore((s) => s.setGlassTint);
  // 启动与通知开关要写入 settings.toml（薄壳 settings_get/settings_set），接入前显示默认值并禁用
  const pending = PENDING_DEFAULTS;
  const themeLabel = useId();

  return (
    <div className="flex flex-col gap-6">
      <Section title={t.appearance}>
        <Row label={t.theme} labelId={themeLabel}>
          <Tabs value={theme} onValueChange={(v) => setTheme(v as ThemeMode)}>
            <TabsList aria-labelledby={themeLabel}>
              {(["system", "light", "dark"] as const).map((m) => (
                <TabsTrigger key={m} value={m}>
                  {t.themes[m]}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </Row>
        <Row label={t.glass} hint={t.glassHint}>
          <div className="flex items-center gap-3 text-xs text-muted">
            <span>{t.glassClear}</span>
            <Slider
              ariaLabel={t.glass}
              min={0}
              max={100}
              value={Math.round(glassTint * 100)}
              onValueChange={(v) => setGlassTint(v / 100)}
            />
            <span>{t.glassTinted}</span>
          </div>
        </Row>
        <Row label={t.language}>
          <span className="text-sm text-muted">{t.languageValue}</span>
        </Row>
      </Section>
      <Section title={t.startup}>
        <Row label={t.reopenWorkspace} hint={t.pendingSettingsHint}>
          <Switch ariaLabel={t.reopenWorkspace} checked={pending.reopen} disabled />
        </Row>
        <Row label={t.minimizeToTray} hint={t.pendingSettingsHint}>
          <Switch ariaLabel={t.minimizeToTray} checked={pending.tray} disabled />
        </Row>
      </Section>
      <Section title={t.notifications}>
        <Row label={t.notifyEnabled} hint={t.pendingSettingsHint}>
          <Switch ariaLabel={t.notifyEnabled} checked={pending.notify} disabled />
        </Row>
      </Section>
    </div>
  );
}

function Placeholder({ group }: { group: Exclude<SettingsGroup, "general" | "account"> }) {
  return (
    <Section title={t.groups[group]}>
      <div className="px-4 py-4 text-sm">
        <p className="text-muted">{t.comingSoon}</p>
        <p className="mt-1">{t.groupItems[group]}</p>
      </div>
    </Section>
  );
}

const NAV_WIDTH = 232;

// 设置（第 18 章）：与主界面同样的吸附样式——左侧导航与右侧内容是贴合的两块液态玻璃，
// 接缝处直角 + 平滑凹口、无缝隙。已实现"通用"中的外观、启动与通知，"账号"（内置账号）与"模型"（默认模型），
// 其余分组列出将提供的设置项。
/** 地址中的 `?group=<分组>`（如侧栏菜单的“用量”打开 `/settings/?group=usage`）；无效值返回 null */
export function groupFromSearch(search: string): SettingsGroup | null {
  const g = new URLSearchParams(search).get("group");
  return g && (GROUPS as string[]).includes(g) ? (g as SettingsGroup) : null;
}

export function SettingsView() {
  const router = useRouter();
  const [group, setGroup] = useState<SettingsGroup>("general");
  // 静态导出没有服务端：在客户端读查询参数选中分组（不用 useSearchParams，免去 Suspense 边界）
  useEffect(() => {
    const g = groupFromSearch(window.location.search);
    if (g) setGroup(g);
  }, []);

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden px-2 pb-2 text-fg">
      {/* 主窗口没有系统标题栏：顶部细条可拖动窗口，窗口按钮贴在右上角（浏览器预览中只留上边距） */}
      <WindowTitleBar className="-mx-2 mb-1" />
      <div className="flex min-h-0 flex-1">
        <div className={sideShellClass} style={{ width: NAV_WIDTH, ...sidePanelSeamStyle("left") }}>
          <GlassPanel className="shrink-0 shadow-none" style={seamBleedStyle("left", NAV_WIDTH)}>
            <nav aria-label={t.title} className="flex h-full flex-col gap-3 p-3">
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  aria-label={t.back}
                  onClick={() => router.push("/")}
                  className="inline-flex size-8 items-center justify-center rounded-full text-muted transition-colors hover:bg-hover hover:text-fg"
                >
                  <ChevronLeft aria-hidden size={18} />
                </button>
                <h1 className="text-sm font-semibold">{t.title}</h1>
              </div>
              <ul className="scroll-thin flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto">
                {GROUPS.map((g) => (
                  <li key={g}>
                    <button
                      type="button"
                      aria-current={g === group ? "page" : undefined}
                      onClick={() => setGroup(g)}
                      className={cn(
                        "w-full rounded-xl px-3 py-[7px] text-left text-sm transition-colors hover:bg-hover",
                        g === group &&
                          "bg-white/75 font-medium shadow-[0_0.5px_1px_rgb(0_0_0/0.06)] ring-1 ring-black/[0.04] hover:bg-white/75 dark:bg-white/[0.1] dark:ring-white/[0.06] dark:hover:bg-white/[0.1]",
                      )}
                    >
                      {t.groups[g]}
                    </button>
                  </li>
                ))}
              </ul>
            </nav>
          </GlassPanel>
        </div>
        <main
          aria-label={t.groups[group]}
          className="seam-mask relative isolate flex min-w-0 flex-1 flex-col overflow-hidden"
          style={centerSeamStyle(true, false)}
        >
          {/* 与导航同款液态玻璃；接缝一侧外扩 SEAM_BLEED 由外层裁掉，接缝不露高光线 */}
          <GlassPanel
            aria-hidden
            radius={OUTER_RADIUS}
            className="-z-10 pointer-events-none absolute inset-y-0 shadow-none"
            style={{ position: "absolute", left: -SEAM_BLEED, right: 0 }}
          />
          <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto flex max-w-2xl flex-col gap-6 px-8 py-8">
              <h2 className="font-serif text-2xl font-medium tracking-tight">{t.groups[group]}</h2>
              {group === "general" ? (
                <GeneralSettings />
              ) : group === "account" ? (
                <AccountSettings />
              ) : group === "models" ? (
                <>
                  <ModelSettings />
                  <Placeholder group="models" />
                </>
              ) : (
                <Placeholder group={group} />
              )}
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
