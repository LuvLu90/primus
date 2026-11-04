"use client";

// 输入框右下角、上下文圆环左侧的模型按钮：显示当前模型与思考强度，点开可切换（第 9.5 节）。
// 模型列表来自账号下发的配置（models_get）；思考强度按模型支持的档位（get_available_thinking_levels）。
import type { ThinkingLevel } from "@primus/protocol";
import { Check, ChevronDown, Sparkles } from "lucide-react";
import { DropdownMenu as Menu } from "radix-ui";
import {
  GlassPopover,
  GlassPopoverContent,
  GlassPopoverTrigger,
} from "@/components/ui/glass-popover";
import type { ModelSummary } from "@/lib/platform/types";
import { strings } from "@/lib/strings";
import { cn } from "@/lib/utils";

const t = strings.chat.model;

/** 会话打开前（还不知道模型支持哪些档位）对推理模型显示的思考强度 */
export const DEFAULT_THINKING_LEVELS: ThinkingLevel[] = ["off", "low", "medium", "high", "xhigh"];

const rowClass =
  "mx-1.5 flex cursor-default select-none items-center gap-2.5 rounded-[10px] px-2.5 py-[7px] text-[13px] text-fg outline-none " +
  "data-[highlighted]:bg-black/[0.06] data-[disabled]:opacity-45 dark:data-[highlighted]:bg-white/[0.1]";

export function thinkingLabel(level: string | undefined): string {
  return (level && (t.levels as Record<string, string>)[level]) || level || t.levelDefault;
}

/** 按钮上的短名：去掉括号里的档位说明（如“Claude Opus 5.5（High）”显示为“Claude Opus 5.5”） */
export function shortModelName(name: string): string {
  return name.replace(/\s*[（(][^）)]*[）)]\s*$/, "") || name;
}

export function ModelPicker({
  models,
  current,
  thinkingLevel,
  thinkingLevels,
  disabled,
  onSelectModel,
  onSelectThinking,
}: {
  models: ModelSummary[];
  /** 当前模型（`provider/modelId`）；未知时为 null */
  current: string | null;
  thinkingLevel: string | undefined;
  /** 当前模型支持的思考强度；未知时按是否推理模型给出默认档位 */
  thinkingLevels: string[] | undefined;
  disabled?: boolean;
  onSelectModel: (key: string) => void;
  onSelectThinking: (level: ThinkingLevel) => void;
}) {
  const model = models.find((m) => m.key === current);
  const levels = thinkingLevels ?? (model?.reasoning === false ? ["off"] : DEFAULT_THINKING_LEVELS);
  const showThinking = levels.length > 1;
  const name = model ? shortModelName(model.name) : current ? current.split("/").pop() : t.none;
  return (
    <GlassPopover>
      <GlassPopoverTrigger asChild disabled={disabled || models.length === 0}>
        <button
          type="button"
          aria-label={`${t.label}：${model?.name ?? name}${showThinking ? `，${t.thinking}${thinkingLabel(thinkingLevel)}` : ""}`}
          title={model?.name ?? name}
          className="flex h-8 max-w-56 items-center gap-1.5 rounded-full px-2.5 text-[12px] text-muted outline-none transition-colors hover:bg-hover hover:text-fg disabled:opacity-40 data-[state=open]:bg-hover data-[state=open]:text-fg"
        >
          <Sparkles aria-hidden size={13} className="shrink-0" />
          <span className="truncate">{name}</span>
          {showThinking && (
            <span className="shrink-0 text-muted/80">· {thinkingLabel(thinkingLevel)}</span>
          )}
          <ChevronDown aria-hidden size={12} className="shrink-0 opacity-70" />
        </button>
      </GlassPopoverTrigger>
      <GlassPopoverContent side="top" align="end" sideOffset={10} tint={0.8} minWidth={260}>
        <Menu.Label className="px-4 pt-1 pb-1.5 text-[11px] font-medium text-muted">
          {t.models}
        </Menu.Label>
        <Menu.RadioGroup value={current ?? ""} onValueChange={onSelectModel}>
          {models.map((m) => (
            <Menu.RadioItem key={m.key} value={m.key} textValue={m.name} className={rowClass}>
              <span className="min-w-0 flex-1 truncate">{m.name}</span>
              <Menu.ItemIndicator className="shrink-0">
                <Check aria-hidden size={14} />
              </Menu.ItemIndicator>
            </Menu.RadioItem>
          ))}
        </Menu.RadioGroup>
        {showThinking && (
          <>
            <Menu.Separator className="mx-3 my-1.5 h-px bg-black/[0.07] dark:bg-white/[0.09]" />
            <Menu.Label className="px-4 pt-1 pb-1.5 text-[11px] font-medium text-muted">
              {t.thinking}
            </Menu.Label>
            <Menu.RadioGroup
              value={thinkingLevel ?? ""}
              onValueChange={(v) => onSelectThinking(v as ThinkingLevel)}
            >
              {levels.map((level) => (
                <Menu.RadioItem
                  key={level}
                  value={level}
                  textValue={thinkingLabel(level)}
                  className={cn(rowClass)}
                >
                  <span className="min-w-0 flex-1">{thinkingLabel(level)}</span>
                  <Menu.ItemIndicator className="shrink-0">
                    <Check aria-hidden size={14} />
                  </Menu.ItemIndicator>
                </Menu.RadioItem>
              ))}
            </Menu.RadioGroup>
          </>
        )}
      </GlassPopoverContent>
    </GlassPopover>
  );
}
