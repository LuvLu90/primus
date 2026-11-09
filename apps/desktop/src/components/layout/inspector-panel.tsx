"use client";

import { FilePreview } from "@/features/files/file-preview";
import { strings } from "@/lib/strings";
import { GlassPanel } from "./glass-panel";
import { seamBleedStyle, sidePanelSeamStyle, sideShellClass } from "./seam";

// 右栏（可拖动、可收起，第 16.2 节）：只有文件预览。点击回复里的文件、或一轮结束时 Agent 写出的文件在这里打开。
export function InspectorPanel({ width }: { width: number }) {
  return (
    <div className={sideShellClass} style={{ width, ...sidePanelSeamStyle("right") }}>
      <GlassPanel className="shrink-0 shadow-none" style={seamBleedStyle("right", width)}>
        <aside aria-label={strings.layout.inspector} className="flex h-full flex-col p-3">
          <FilePreview />
        </aside>
      </GlassPanel>
    </div>
  );
}
