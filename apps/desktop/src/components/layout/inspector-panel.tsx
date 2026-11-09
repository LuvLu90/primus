"use client";

import type { ReactNode } from "react";
import { Icon, type IconName } from "@/components/icons";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/glass-tabs";
import { strings } from "@/lib/strings";
import { GlassPanel } from "./glass-panel";
import { seamBleedStyle, sidePanelSeamStyle, sideShellClass } from "./seam";

const t = strings.inspectorTabs;

function Empty({ icon, children }: { icon: IconName; children: ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center text-sm text-muted">
      <Icon name={icon} size="xl" />
      <p>{children}</p>
    </div>
  );
}

// 右栏（可拖动、可收起，第 16.2 节）：变更 · 文件 · 计划。内容在第 14、15 章对应任务中实现。
export function InspectorPanel({ width }: { width: number }) {
  return (
    <div className={sideShellClass} style={{ width, ...sidePanelSeamStyle("right") }}>
      <GlassPanel className="shrink-0 shadow-none" style={seamBleedStyle("right", width)}>
        <aside aria-label={strings.layout.inspector} className="flex h-full flex-col p-3">
          <Tabs defaultValue="changes" className="flex h-full flex-col">
            <TabsList className="self-center">
              <TabsTrigger value="changes">{t.changes}</TabsTrigger>
              <TabsTrigger value="files">{t.files}</TabsTrigger>
              <TabsTrigger value="plan">{t.plan}</TabsTrigger>
            </TabsList>
            <TabsContent value="changes" className="flex flex-1 data-[state=inactive]:hidden">
              <Empty icon="diff">{t.changesEmpty}</Empty>
            </TabsContent>
            <TabsContent value="files" className="flex flex-1 data-[state=inactive]:hidden">
              <Empty icon="file-tree">{t.filesEmpty}</Empty>
            </TabsContent>
            <TabsContent value="plan" className="flex flex-1 data-[state=inactive]:hidden">
              <Empty icon="list-check">{t.planEmpty}</Empty>
            </TabsContent>
          </Tabs>
        </aside>
      </GlassPanel>
    </div>
  );
}
