"use client";

// 麦克风按钮 ↔ 录音胶囊：按下后按钮弹性展开成浅红胶囊（脉动红点、18 格实时波形、计时、停止键），
// 停止后内容先淡出、胶囊收回成按钮。动画在 globals.css 的 .voice-pill。
import { Icon } from "@/components/icons";
import { glassButtonClass, useGlassStyle } from "@/components/layout/glass-panel";
import { GlassButton } from "@/components/ui/glass-button";
import { Tooltip } from "@/components/ui/tooltip";
import { strings } from "@/lib/strings";

const t = strings.chat.voice;

function clock(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function VoiceButton({
  recording,
  levels,
  elapsed,
  disabled,
  onStart,
  onStop,
}: {
  recording: boolean;
  levels: number[];
  elapsed: number;
  disabled?: boolean;
  onStart: () => void;
  onStop: () => void;
}) {
  const glass = useGlassStyle();
  return (
    <div className="voice-pill" data-recording={recording || undefined}>
      <span className="voice-idle absolute inset-y-0 right-0 flex">
        <Tooltip content={t.start}>
          <GlassButton
            size={30}
            {...glass}
            aria-label={t.start}
            disabled={disabled || recording}
            tabIndex={recording ? -1 : undefined}
            aria-hidden={recording || undefined}
            onClick={onStart}
            className={glassButtonClass}
          >
            <Icon name="mic" size="sm" />
          </GlassButton>
        </Tooltip>
      </span>
      <span className="voice-live" aria-hidden={!recording || undefined}>
        <span className="voice-dot size-[7px] shrink-0 rounded-full bg-danger" />
        <span className="voice-wave flex h-5 shrink-0 items-center gap-[2px]">
          {levels.map((level, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: 固定 18 格
            <i key={i} style={{ height: `${3 + Math.min(1, level) * 14}px` }} />
          ))}
        </span>
        <span
          role="timer"
          aria-label={`${t.recording} ${clock(elapsed)}`}
          className="voice-time shrink-0 text-2xs tabular-nums"
        >
          {clock(elapsed)}
        </span>
        <Tooltip content={t.stop}>
          <button
            type="button"
            aria-label={t.stop}
            tabIndex={recording ? undefined : -1}
            onClick={onStop}
            className="ml-auto grid size-[22px] shrink-0 place-items-center rounded-full bg-danger text-on-danger outline-none transition-transform active:scale-90 focus-visible:ring-2 focus-visible:ring-danger/40"
          >
            <Icon name="stop" size="2xs" />
          </button>
        </Tooltip>
      </span>
    </div>
  );
}
