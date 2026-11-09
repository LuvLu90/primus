"use client";

// 输入框右下角的模型按钮：纯文字“<模型短名> · <档位>”（不带图标与“思考”二字；档位未知或只有一档时只显示模型名），
// 点开可切换（第 9.5 节）。
// 模型列表来自设置中的模型渠道（models_get / models_watch），会话打开后能力（上下文长度、能否看图、是否支持思考）
// 以 Core 的 get_available_models 为准（chat-panel 合并后传入）；思考强度按模型支持的档位（get_available_thinking_levels）。
// 弹层：按渠道分小节（小号灰色小节标题），每个模型一行：名称、右侧灰色的上下文长度、当前模型打勾；
// 行的字号、行高与输入栏其他菜单一致（composer-menus 的 rowClass）。列表高度不超过窗口可用空间，
// 超出时在弹层内滚动（不显示滚动条；滚轮、触控与方向键照常可用），打开时当前模型滚到可见处；
// 分隔线下是固定在底部的“思考程度”滑杆（两端“更快 / 更聪明”，拇指弹到档位上）。
// 还没有任何模型时弹层只有一句说明和“去设置添加渠道”。
import type { ThinkingLevel } from "@primus/protocol";
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
import { Icon } from "@/components/icons";
import {
  GlassPopover,
  GlassPopoverContent,
  GlassPopoverTrigger,
} from "@/components/ui/glass-popover";
import { formatTokens } from "@/features/settings/account-models";
import type { ModelSummary } from "@/lib/platform/types";
import { strings } from "@/lib/strings";
import { cn } from "@/lib/utils";
import type { CoreModelCaps } from "@/stores/session-store";
import { composerGhostClass } from "./composer-ghost";
import { rowClass, separatorClass } from "./composer-menus";

const t = strings.chat.model;

/** 会话打开前（还不知道模型支持哪些档位）对推理模型显示的思考强度 */
export const DEFAULT_THINKING_LEVELS: ThinkingLevel[] = ["off", "low", "medium", "high", "xhigh"];

/** 思考滑杆拇指宽度（px）；刻度与填充都按“拇指中心可达范围”排布 */
const THUMB_W = 32;

/** 思考程度滑杆调整档位的按键：方向、Page Up/Down 为步进；Home / End 为 0（到两端单独处理） */
const ADJUST_KEYS: Record<string, number> = {
  ArrowRight: 1,
  ArrowUp: 1,
  ArrowLeft: -1,
  ArrowDown: -1,
  PageUp: 1,
  PageDown: -1,
  Home: 0,
  End: 0,
};

/**
 * 弹层内容的最大高度：不超过 Radix 给出的可用高度（触发按钮到窗口边缘，已扣除 collisionPadding），
 * 减去玻璃底板的上下内边距（py-2），且不超过 30rem
 */
const contentMaxHeight =
  "max-h-[min(30rem,calc(var(--radix-dropdown-menu-content-available-height,30rem)_-_1rem))]";

export function thinkingLabel(level: string | undefined): string {
  return (level && (t.levels as Record<string, string>)[level]) || level || t.levelDefault;
}

/** 按钮上的短名：去掉括号里的档位说明（如“Claude Opus 5.5（High）”显示为“Claude Opus 5.5”） */
export function shortModelName(name: string): string {
  return name.replace(/\s*[（(][^）)]*[）)]\s*$/, "") || name;
}

/** `provider/modelId` 的模型 ID 部分（模型 ID 本身可以含 `/`，只按第一个 `/` 拆分） */
export function modelIdOf(key: string): string {
  const i = key.indexOf("/");
  return i >= 0 ? key.slice(i + 1) : key;
}

/**
 * 用 Core 认得的能力（get_available_models / get_state）覆盖设置里的值：会话打开后，能否看图、是否支持思考、
 * 上下文长度与最大输出以 Core 实际请求用的为准；Core 没报告的模型保持设置里的值。列表与顺序不变
 */
export function withCoreCaps(
  models: ModelSummary[],
  caps: Record<string, CoreModelCaps> | undefined,
): ModelSummary[] {
  if (!caps) return models;
  return models.map((m) => {
    const c = caps[m.key];
    if (!c) return m;
    return {
      ...m,
      image: c.image,
      reasoning: c.reasoning,
      // 数值异常（缺失或非正数）时保留设置里的值
      contextWindow: c.contextWindow > 0 ? c.contextWindow : m.contextWindow,
      maxTokens: c.maxTokens > 0 ? c.maxTokens : m.maxTokens,
    };
  });
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
  onOpenChange,
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
  /** 弹层打开或关闭（打开时可刷新 Core 的模型能力） */
  onOpenChange?: (open: boolean) => void;
}) {
  const empty = models.length === 0;
  const groups = useMemo(() => groupByProvider(models, providerNames), [models, providerNames]);
  const model = models.find((m) => m.key === current);
  const levels = thinkingLevels ?? (model?.reasoning === false ? ["off"] : DEFAULT_THINKING_LEVELS);
  const showThinking = !empty && levels.length > 1;
  const name = model
    ? shortModelName(model.name)
    : empty
      ? t.empty
      : current
        ? modelIdOf(current)
        : t.none;
  // 按钮上只显示已知的档位；未知（会话还没报告）时不显示“默认”
  const level =
    showThinking && thinkingLevel ? (t.levels as Record<string, string>)[thinkingLevel] : undefined;
  return (
    <GlassPopover onOpenChange={onOpenChange}>
      <GlassPopoverTrigger asChild disabled={disabled}>
        <button
          type="button"
          aria-label={`${t.label}：${model?.name ?? name}${level ? `，${t.thinkingDegree}${level}` : ""}`}
          title={model?.name ?? name}
          className={composerGhostClass({ className: "max-w-64" })}
        >
          <span className="truncate">{name}</span>
          {level && <span className="shrink-0">· {level}</span>}
          <Icon name="chevron-down" size="xs" />
        </button>
      </GlassPopoverTrigger>
      <GlassPopoverContent
        side="top"
        align="end"
        sideOffset={10}
        collisionPadding={12}
        tint={0.8}
        minWidth={280}
        className="max-w-[360px]"
      >
        <div className={cn("flex flex-col", contentMaxHeight)}>
          {empty ? (
            <div className="px-4 pt-1 pb-2">
              <p className="text-sm text-muted">{t.empty}</p>
              <Menu.Item
                onSelect={onOpenSettings}
                className="mt-2.5 inline-flex cursor-default select-none items-center rounded-full bg-hover px-3 py-1.5 text-sm font-medium text-fg outline-none transition-colors data-[highlighted]:bg-black/[0.08] motion-reduce:transition-none dark:data-[highlighted]:bg-white/[0.12]"
              >
                {t.addProvider}
              </Menu.Item>
            </div>
          ) : (
            <ModelList groups={groups} current={current} onSelect={onSelectModel} />
          )}
          {showThinking && (
            <div className="shrink-0">
              <Menu.Separator className={separatorClass} />
              <ThinkingSlider
                levels={levels}
                value={thinkingLevel}
                onCommit={(level) => onSelectThinking(level as ThinkingLevel)}
              />
            </div>
          )}
        </div>
      </GlassPopoverContent>
    </GlassPopover>
  );
}

/**
 * 模型单选列表（按渠道分小节）：可滚动、不显示滚动条。每行：名称、灰色的上下文长度、当前模型打勾。
 * 打开时把当前模型滚到可见处（方向键移动高亮时浏览器会把聚焦的行滚进来）。
 */
function ModelList({
  groups,
  current,
  onSelect,
}: {
  groups: ReturnType<typeof groupByProvider>;
  current: string | null;
  onSelect: (key: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const labelBase = useId();
  // 只在打开（挂载）时定位一次：之后由用户滚动
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    const row = scroller?.querySelector<HTMLElement>('[data-state="checked"]');
    if (!scroller || !row) return;
    const bottom = row.offsetTop + row.offsetHeight;
    if (row.offsetTop < scroller.scrollTop || bottom > scroller.scrollTop + scroller.clientHeight)
      scroller.scrollTop = row.offsetTop - (scroller.clientHeight - row.offsetHeight) / 2;
  }, []);
  return (
    <div
      ref={scrollRef}
      data-testid="model-list"
      className="scroll-none relative min-h-0 flex-1 overflow-y-auto overscroll-contain"
    >
      <Menu.RadioGroup value={current ?? ""} onValueChange={onSelect}>
        {groups.map((group, i) => (
          <Menu.Group key={group.provider} aria-labelledby={`${labelBase}-${group.provider}`}>
            <Menu.Label
              id={`${labelBase}-${group.provider}`}
              className={cn(
                "truncate px-4 pb-1 text-2xs font-medium text-muted",
                i === 0 ? "pt-0.5" : "pt-2.5",
              )}
            >
              {group.name}
            </Menu.Label>
            {group.models.map((m) => (
              <Menu.RadioItem
                key={m.key}
                value={m.key}
                textValue={m.name}
                title={m.id === m.name ? undefined : m.id}
                className={rowClass}
              >
                <span className="min-w-0 flex-1 truncate">{m.name}</span>
                <span aria-hidden className="shrink-0 text-xs tabular-nums text-muted">
                  {formatTokens(m.contextWindow)}
                </span>
                <span aria-hidden className="flex w-3.5 shrink-0 justify-center">
                  <Menu.ItemIndicator>
                    <Icon name="check" size="sm" />
                  </Menu.ItemIndicator>
                </span>
              </Menu.RadioItem>
            ))}
          </Menu.Group>
        ))}
      </Menu.RadioGroup>
    </div>
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
    let next = draftRef.current;
    if (e.key === "Home") next = 0;
    else if (e.key === "End") next = max;
    else if (Object.hasOwn(ADJUST_KEYS, e.key)) next += ADJUST_KEYS[e.key] ?? 0;
    else return;
    e.preventDefault();
    set(Math.min(max, Math.max(0, next)));
  };
  const onKeyUp = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape" || e.key === "Tab") return;
    e.stopPropagation();
    // 只在调整档位的按键松开时提交（Shift 等修饰键松开不算选了档位）
    if (Object.hasOwn(ADJUST_KEYS, e.key)) commit();
  };

  const ratio = drag ?? (max > 0 ? draft / max : 0);
  const thumbLeft = `calc(${ratio} * (100% - ${THUMB_W}px))`;
  const label = thinkingLabel(levels[draft]);
  return (
    <div className="px-4 pt-0.5 pb-2">
      <div className="flex items-baseline gap-1.5 text-xs text-muted">
        <span>{t.thinkingDegree}</span>
        <span key={label} aria-hidden className="value-in text-sm font-medium text-fg">
          {label}
        </span>
      </div>
      <div aria-hidden className="mt-2 mb-1.5 flex justify-between text-xs text-muted">
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
