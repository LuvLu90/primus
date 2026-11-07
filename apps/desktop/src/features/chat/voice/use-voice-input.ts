"use client";

// 语音输入：系统语音识别（薄壳 speech_*，不用任何第三方云服务，约束 C1）。
// 临时结果（interim）随时替换，定稿（final）交给 onFinal 插入到光标处；会话结束时还没定稿的临时文本也一并插入，
// 不丢用户说过的话。波形取 18 格音量历史：优先 WebView 麦克风实测音量，否则用平台推送的音量（mock）。
import { useCallback, useEffect, useRef, useState } from "react";
import { getPlatform, isTauriRuntime } from "@/lib/platform";
import type { SpeechEvent, SpeechSettingsPage } from "@/lib/platform/types";
import { strings } from "@/lib/strings";
import { useMicLevel } from "./use-mic-level";

export const WAVE_BARS = 18;
const WAVE_STEP_MS = 80;

/** 语音输入的错误；settings 为能解决它的系统设置页（界面上给出“打开设置”） */
export interface VoiceError {
  message: string;
  settings?: SpeechSettingsPage;
}

/** 系统设置页（open_external 只接受这两个） */
export const SETTINGS_URLS: Record<SpeechSettingsPage, string> = {
  microphone: "ms-settings:privacy-microphone",
  speech: "ms-settings:privacy-speech",
};

export interface VoiceInput {
  /** 平台支持语音输入（首帧为 false，不可用时隐藏按钮） */
  available: boolean;
  recording: boolean;
  /** 当前这一句的临时文本 */
  interim: string;
  /** 最近 18 格音量（0–1），最新的在最后 */
  levels: number[];
  /** 已录音秒数 */
  elapsed: number;
  error: VoiceError | null;
  start: () => void;
  stop: () => void;
}

export function useVoiceInput({
  onStart,
  onFinal,
  onEnd,
}: {
  /** 开始录音（记下光标位置） */
  onStart?: () => void;
  /** 定稿的一段文本 */
  onFinal: (text: string) => void;
  /** 录音结束 */
  onEnd?: () => void;
}): VoiceInput {
  const [available, setAvailable] = useState(false);
  const [recording, setRecording] = useState(false);
  const [interim, setInterim] = useState("");
  const [levels, setLevels] = useState<number[]>(() => Array(WAVE_BARS).fill(0));
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<VoiceError | null>(null);
  const callbacks = useRef({ onStart, onFinal, onEnd });
  callbacks.current = { onStart, onFinal, onEnd };
  const interimRef = useRef("");
  const pushedLevel = useRef(0);
  // 每次开始一个会话一个令牌：旧会话迟到的事件不影响新会话
  const session = useRef<symbol | null>(null);
  // 只在桌面端读麦克风（浏览器预览不调用 getUserMedia，不弹浏览器权限框）
  const readMic = useMicLevel(recording, isTauriRuntime(), () =>
    setError((prev) => prev ?? { message: strings.chat.voice.micDenied, settings: "microphone" }),
  );

  useEffect(() => {
    let cancelled = false;
    getPlatform()
      .then((p) => p.speechAvailable())
      .then((ok) => !cancelled && setAvailable(ok))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const finish = useCallback((token: symbol) => {
    if (session.current !== token) return;
    session.current = null;
    const pending = interimRef.current;
    interimRef.current = "";
    setInterim("");
    if (pending) callbacks.current.onFinal(pending);
    setRecording(false);
    callbacks.current.onEnd?.();
  }, []);

  const start = useCallback(() => {
    if (session.current) return;
    const token = Symbol("speech");
    session.current = token;
    setError(null);
    setElapsed(0);
    setLevels(Array(WAVE_BARS).fill(0));
    interimRef.current = "";
    pushedLevel.current = 0;
    callbacks.current.onStart?.();
    setRecording(true);
    const onEvent = (e: SpeechEvent) => {
      if (session.current !== token) return;
      if (e.type === "interim") {
        interimRef.current = e.text;
        setInterim(e.text);
      } else if (e.type === "final") {
        interimRef.current = "";
        setInterim("");
        callbacks.current.onFinal(e.text);
      } else if (e.type === "level") pushedLevel.current = e.level;
      else if (e.type === "error")
        setError({ message: `${strings.chat.voice.failed}：${e.message}`, settings: e.settings });
      else finish(token);
    };
    getPlatform()
      .then((p) => p.speechStart(onEvent))
      .catch((e: unknown) => {
        setError({
          message: `${strings.chat.voice.failed}：${e instanceof Error ? e.message : String(e)}`,
        });
        finish(token);
      });
  }, [finish]);

  const stop = useCallback(() => {
    const token = session.current;
    if (!token) return;
    getPlatform()
      .then((p) => p.speechStop())
      // 停止失败（或平台没有推送 end）也要结束界面上的录音状态
      .catch(() => finish(token));
  }, [finish]);

  // 录音中：波形与计时
  useEffect(() => {
    if (!recording) return;
    const started = Date.now();
    const wave = setInterval(() => {
      const level = readMic() ?? pushedLevel.current;
      setLevels((prev) => [...prev.slice(1), level]);
    }, WAVE_STEP_MS);
    const clock = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 250);
    return () => {
      clearInterval(wave);
      clearInterval(clock);
    };
  }, [recording, readMic]);

  // 卸载时结束仍在进行的识别
  useEffect(
    () => () => {
      if (!session.current) return;
      session.current = null;
      void getPlatform()
        .then((p) => p.speechStop())
        .catch(() => {});
    },
    [],
  );

  return { available, recording, interim, levels, elapsed, error, start, stop };
}
