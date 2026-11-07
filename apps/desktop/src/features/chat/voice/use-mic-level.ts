"use client";

// 麦克风音量（波形用）：WebView 里 getUserMedia + AnalyserNode 算 RMS，只在录音时打开麦克风，停止即释放。
// 拿不到麦克风（无权限、浏览器预览）时返回的读取函数恒为 null，调用方改用薄壳 / mock 推送的音量。
import { useCallback, useEffect, useRef } from "react";

/** 返回一个读取当前音量（0–1）的函数；未开始或不可用时为 null */
export function useMicLevel(active: boolean, enabled: boolean): () => number | null {
  const reader = useRef<(() => number) | null>(null);
  useEffect(() => {
    if (!active || !enabled || !navigator.mediaDevices?.getUserMedia) return;
    let cancelled = false;
    let stream: MediaStream | undefined;
    let ctx: AudioContext | undefined;
    navigator.mediaDevices
      .getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
      .then((s) => {
        if (cancelled) {
          // 清理已经执行过（很快停止或卸载）：立即释放迟到的麦克风
          for (const track of s.getTracks()) track.stop();
          return;
        }
        stream = s;
        ctx = new AudioContext();
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        ctx.createMediaStreamSource(s).connect(analyser);
        const buf = new Float32Array(analyser.fftSize);
        reader.current = () => {
          analyser.getFloatTimeDomainData(buf);
          let sum = 0;
          for (const v of buf) sum += v * v;
          const rms = Math.sqrt(sum / buf.length);
          // 说话时 RMS 大约 0.02–0.3：取平方根拉开小音量的层次
          return Math.min(1, Math.sqrt(rms * 4));
        };
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      reader.current = null;
      for (const track of stream?.getTracks() ?? []) track.stop();
      void ctx?.close().catch(() => {});
    };
  }, [active, enabled]);
  // 稳定的读取函数：调用方放进依赖也不会反复重建定时器
  return useCallback(() => reader.current?.() ?? null, []);
}
