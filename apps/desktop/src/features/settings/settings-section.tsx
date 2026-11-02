import type { ReactNode } from "react";

/** 设置中的一组卡片（macOS 系统设置的分组样式） */
export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="px-1 text-xs font-medium text-muted">{title}</h3>
      <div className="divide-y divide-border rounded-2xl bg-white/70 shadow-[0_1px_2px_rgb(0_0_0/0.04)] ring-1 ring-black/[0.06] dark:bg-white/[0.06] dark:ring-white/[0.08]">
        {children}
      </div>
    </section>
  );
}

export function Row({
  label,
  hint,
  labelId,
  children,
}: {
  label: string;
  hint?: string;
  labelId?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center gap-4 px-4 py-3">
      <div className="min-w-0 flex-1">
        <p id={labelId} className="text-sm">
          {label}
        </p>
        {hint && <p className="mt-0.5 text-xs text-muted">{hint}</p>}
      </div>
      {children}
    </div>
  );
}
