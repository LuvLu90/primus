"use client";

// 输入框右下角的模型按钮：纯文字“<模型短名> · <档位>”（不带图标与“思考”二字；档位未知或只有一档时只显示模型名），
// 点开可切换（第 9.5 节）。
// 模型列表来自设置中的模型渠道（models_get / models_watch）；思考强度按模型支持的档位（get_available_thinking_levels）。
// 弹层：“模型”分组，按渠道分小节（小节标题为渠道名），每行模型名 + 右侧单选圆点（选中为橙色圆环白芯，
// 选中行的浅色底在行间滑动）；分隔线下是“思考程度”滑杆（两端“更快 / 更聪明”，拇指弹到档位上）。
// 还没有任何模型时弹层只有一句说明和“去设置添加渠道”。
import type { ThinkingLevel } from "@primus/protocol";
import { ChevronDown } from "lucide-react";
import { DropdownMenu as Menu } from "radix-ui";
import {
  type KeyboardEvent,
  type PointerEvent,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
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

/** 思考滑杆拇指宽度（px）；刻度与填充都按“拇指中心可达范围”排布 */
const THUMB_W = 32;

const rowClass =
  "relative z-[1] mx-1.5 flex cursor-default select-none items-center gap-2.5 rounded-[10px] px-2.5 py-[9px] text-[14px] text-fg outline-none " +
  "transition-colors data-[highlighted]:bg-black/[0.035] data-[disabled]:opacity-45 dark:data-[highlighted]:bg-white/[0.06]";

export function thinkingLabel(level: string | undefined): string {
  return (level && (t.levels as Record<string, string>)[level]) || level || t.levelDefault;
}

/** 按钮上的短名：去掉括号里的档位说明（如“Claude Opus 5.5（High）”显示为“Claude Opus 5.5”） */
export function shortModelName(name: string): string {
  return name.replace(/\s*[（(][^）)]*[）)]\s*$/, "") || name;
}

/** 按渠道分组（保持模型列表中的先后顺序） */
export function groupByProvider(
  models: ModelSummary[],
  providerNames: Record<string, string> = {},
): { provider: string; name: string; models: ModelSummary[] }[] {
  const groups = new Map<string, ModelSummary[]>();
  for (const m of models) {
    const list = groups.get(m.provider);
    if (list) list.push(m);
    else groups.set(m.provider, [m]);
  }
  return [...groups].map(([provider, list]) => ({
    provider,
    name: providerNames[provider] ?? provider,
    models: list,
  }));
}

export function ModelPicker({
  models,
  providerNames,
  current,
  thinkingLevel,
  thinkingLevels,
  disabled,
  onSelectModel,
  onSelectThinking,
  onOpenSettings,
}: {
  models: ModelSummary[];
  /** 渠道 ID → 渠道名称（分组标题）；缺少时显示渠道 ID */
  providerNames?: Record<string, string>;
  /** 当前模型（`provider/modelId`）；未知时为 null */
  current: string | null;
  thinkingLevel: string | undefined;
  /** 当前模型支持的思考强度；未知时按是否推理模型给出默认档位 */
  thinkingLevels: string[] | undefined;
  disabled?: boolean;
  onSelectModel: (key: string) => void;
  onSelectThinking: (level: ThinkingLevel) => void;
  /** 打开设置中的模型渠道（没有可用模型时的入口） */
  onOpenSettings?: () => void;
}) {
  const empty = models.length === 0;
  // 记住分组结果：选中行的高亮按分组变化重新量取位置
  const groups = useMemo(() => groupByProvider(models, providerNames), [models, providerNames]);
  const model = models.find((m) => m.key === current);
  const levels = thinkingLevels ?? (model?.reasoning === false ? ["off"] : DEFAULT_THINKING_LEVELS);
  const showThinking = !empty && levels.length > 1;
  const name = model
    ? shortModelName(model.name)
    : empty
      ? t.empty
      : current
        ? current.split("/").pop()
        : t.none;
  // 按钮上只显示已知的档位；未知（会话还没报告）时不显示“默认”
  const level =
    showThinking && thinkingLevel ? (t.levels as Record<string, string>)[thinkingLevel] : undefined;
  return (
    <GlassPopover>
      <GlassPopoverTrigger asChild disabled={disabled}>
        <button
          type="button"
          aria-label={`${t.label}：${model?.name ?? name}${level ? `，${t.thinkingDegree}${level}` : ""}`}
          title={model?.name ?? name}
          className="flex h-8 max-w-64 items-center gap-1.5 rounded-full px-2.5 text-[12px] text-muted outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:bg-hover disabled:opacity-40 data-[state=open]:bg-hover data-[state=open]:text-fg"
        >
          <span className="truncate">{name}</span>
          {level && <span className="shrink-0">· {level}</span>}
          <ChevronDown aria-hidden size={12} className="shrink-0 opacity-70" />
        </button>
      </GlassPopoverTrigger>
      <GlassPopoverContent side="top" align="end" sideOffset={10} tint={0.8} minWidth={300}>
        <Menu.Label className="px-4 pt-1 pb-1.5 text-[12px] text-muted">{t.models}</Menu.Label>
        {empty ? (
          <div className="px-4 pt-1 pb-2">
            <p className="text-[13px] text-muted">{t.empty}</p>
            <Menu.Item
              onSelect={onOpenSettings}
              className="mt-2.5 inline-flex cursor-default select-none items-center rounded-full bg-hover px-3 py-1.5 text-[13px] font-medium text-fg outline-none transition-colors data-[highlighted]:bg-black/[0.08] motion-reduce:transition-none dark:data-[highlighted]:bg-white/[0.12]"
            >
              {t.addProvider}
            </Menu.Item>
          </div>
        ) : (
          <ModelList groups={groups} current={current} onSelect={onSelectModel} />
        )}
        {showThinking && (
          <>
            <Menu.Separator className="mx-3 my-2 h-px bg-black/[0.07] dark:bg-white/[0.09]" />
            <ThinkingSlider
              levels={levels}
              value={thinkingLevel}
              onCommit={(level) => onSelectThinking(level as ThinkingLevel)}
            />
          </>
        )}
      </GlassPopoverContent>
    </GlassPopover>
  );
}

/** 模型单选列表（按渠道分小节）：选中行的浅色底是一块独立的高亮，切换时在行间滑动 */
function ModelList({
  groups,
  current,
  onSelect,
}: {
  groups: ReturnType<typeof groupByProvider>;
  current: string | null;
  onSelect: (key: string) => void;
}) {
  const groupRef = useRef<HTMLDivElement>(null);
  const labelBase = useId();
  const [box, setBox] = useState<{ top: number; height: number } | null>(null);
  // 首次定位不过渡（弹层刚打开），之后的切换才滑动
  const [animate, setAnimate] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: 选中项或列表变化时重新量取选中行的位置
  useLayoutEffect(() => {
    const row = groupRef.current?.querySelector<HTMLElement>('[data-state="checked"]');
    setBox(row ? { top: row.offsetTop, height: row.offsetHeight } : null);
  }, [current, groups]);
  useEffect(() => {
    const id = requestAnimationFrame(() => setAnimate(true));
    return () => cancelAnimationFrame(id);
  }, []);
  return (
    <Menu.RadioGroup value={current ?? ""} onValueChange={onSelect}>
      <div ref={groupRef} className="relative">
        <span
          aria-hidden
          className={cn(
            "pointer-events-none absolute inset-x-1.5 top-0 rounded-[10px] bg-black/[0.05] dark:bg-white/[0.08]",
            animate && "model-highlight",
          )}
          style={{
            translate: `0 ${box?.top ?? 0}px`,
            height: box?.height ?? 0,
            opacity: box ? 1 : 0,
          }}
        />
        {groups.map((group) => (
          <Menu.Group key={group.provider} aria-labelledby={`${labelBase}-${group.provider}`}>
            <Menu.Label
              id={`${labelBase}-${group.provider}`}
              className="truncate px-4 pt-1.5 pb-1 text-[11px] font-medium text-muted"
            >
              {group.name}
            </Menu.Label>
            {group.models.map((m) => (
              <Menu.RadioItem key={m.key} value={m.key} textValue={m.name} className={rowClass}>
                <span className="min-w-0 flex-1 truncate">{m.name}</span>
                <span
                  aria-hidden
                  className={cn(
                    "grid size-[18px] shrink-0 place-items-center rounded-full transition-[box-shadow,background-color] duration-200",
                    m.key === current
                      ? "bg-select"
                      : "shadow-[inset_0_0_0_1.5px_color-mix(in_srgb,var(--color-muted)_55%,transparent)]",
                  )}
                >
                  {m.key === current && (
                    <span className="radio-dot size-[7px] rounded-full bg-white" />
                  )}
                </span>
              </Menu.RadioItem>
            ))}
          </Menu.Group>
        ))}
      </div>
    </Menu.RadioGroup>
  );
}

/**
 * 思考程度滑杆（role="slider"）：浅灰轨道上每档一道刻度，白色凸起拇指；拇指左侧是深一些的填充。
 * 拖动时拇指跟手，松手弹到最近的档位；点轨道直接跳档；方向键 / Home / End 逐档移动。
 * 松手（或抬键）才提交，避免拖动途中逐档发请求。当前档位未知（默认）时停在中间档。
 */
function ThinkingSlider({
  levels,
  value,
  onCommit,
}: {
  levels: string[];
  value: string | undefined;
  onCommit: (level: string) => void;
}) {
  const known = value ? levels.indexOf(value) : -1;
  const index = known >= 0 ? known : Math.floor((levels.length - 1) / 2);
  const [draft, setDraft] = useState(index);
  const draftRef = useRef(index);
  useEffect(() => {
    setDraft(index);
    draftRef.current = index;
  }, [index]);
  const max = levels.length - 1;
  const trackRef = useRef<HTMLDivElement>(null);
  // 拖动中拇指跟手的位置（0–1）；null 表示停在档位上
  const [drag, setDrag] = useState<number | null>(null);

  const set = useCallback((i: number) => {
    draftRef.current = i;
    setDraft(i);
  }, []);
  const commit = useCallback(() => {
    const level = levels[draftRef.current];
    if (level && level !== value) onCommit(level);
  }, [levels, value, onCommit]);

  const ratioAt = (clientX: number) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= THUMB_W) return draftRef.current / Math.max(1, max);
    return Math.min(1, Math.max(0, (clientX - rect.left - THUMB_W / 2) / (rect.width - THUMB_W)));
  };
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.focus();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const r = ratioAt(e.clientX);
    setDrag(r);
    set(Math.round(r * max));
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (drag === null) return;
    const r = ratioAt(e.clientX);
    setDrag(r);
    set(Math.round(r * max));
  };
  const onPointerUp = () => {
    if (drag === null) return;
    setDrag(null);
    commit();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // Esc、Tab 交给菜单（关闭、移出焦点）；其余按键不让菜单拿去移动高亮或做首字母跳转
    if (e.key === "Escape" || e.key === "Tab") return;
    e.stopPropagation();
    const step: Record<string, number> = {
      ArrowRight: 1,
      ArrowUp: 1,
      ArrowLeft: -1,
      ArrowDown: -1,
      PageUp: 1,
      PageDown: -1,
    };
    let next = draftRef.current;
    if (e.key in step) next += step[e.key] ?? 0;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = max;
    else return;
    e.preventDefault();
    set(Math.min(max, Math.max(0, next)));
  };
  const onKeyUp = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape" || e.key === "Tab") return;
    e.stopPropagation();
    commit();
  };

  const ratio = drag ?? (max > 0 ? draft / max : 0);
  const thumbLeft = `calc(${ratio} * (100% - ${THUMB_W}px))`;
  const label = thinkingLabel(levels[draft]);
  return (
    <div className="px-4 pt-0.5 pb-2">
      <div className="flex items-baseline gap-1.5 text-[12px] text-muted">
        <span>{t.thinkingDegree}</span>
        <span key={label} aria-hidden className="value-in text-[13px] font-medium text-fg">
          {label}
        </span>
      </div>
      <div aria-hidden className="mt-2 mb-1.5 flex justify-between text-[12px] text-muted">
        <span>{t.faster}</span>
        <span>{t.smarter}</span>
      </div>
      <div
        ref={trackRef}
        role="slider"
        tabIndex={0}
        aria-label={t.thinkingDegree}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={draft}
        aria-valuetext={label}
        data-dragging={drag !== null || undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        className="think-track relative h-[34px] cursor-pointer touch-none select-none rounded-[10px] bg-black/[0.045] outline-none focus-visible:ring-2 focus-visible:ring-accent/35 dark:bg-white/[0.07]"
      >
        <span
          aria-hidden
          className="think-fill absolute inset-y-0 left-0 rounded-[10px] bg-black/[0.09] dark:bg-white/[0.12]"
          style={{ width: `calc(${ratio} * (100% - ${THUMB_W}px) + ${THUMB_W}px)` }}
        />
        {levels.map((level, i) => (
          <span
            key={level}
            aria-hidden
            className={cn(
              "absolute top-1/2 h-3 w-[2px] -translate-x-1/2 -translate-y-1/2 rounded-full transition-colors duration-200",
              i <= draft ? "bg-black/25 dark:bg-white/35" : "bg-black/15 dark:bg-white/20",
            )}
            style={{
              left: `calc(${max > 0 ? i / max : 0} * (100% - ${THUMB_W}px) + ${THUMB_W / 2}px)`,
            }}
          />
        ))}
        <span
          aria-hidden
          className="think-thumb glass-knob absolute top-[2px] bottom-[2px] rounded-[8px]"
          style={{ left: thumbLeft, width: THUMB_W }}
        />
      </div>
    </div>
  );
}
