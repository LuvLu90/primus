// 图块外圈的进度环：圆角矩形路径从顶部中点顺时针绘制（pathLength=100），dashoffset 随真实阶段推进。
// 不显示数字百分比；颜色、透明度与过渡由 globals.css 的 .att-ring 按图块状态控制。

/** 62×62 盒子里、比 56px 图块大一圈的圆角矩形（圆角 16），起点在上边中点 */
export const RING_PATH =
  "M31 1H45A16 16 0 0 1 61 17V45A16 16 0 0 1 45 61H17A16 16 0 0 1 1 45V17A16 16 0 0 1 17 1Z";

export function ProgressRing({ progress }: { progress: number }) {
  const p = Math.min(100, Math.max(0, progress));
  return (
    <svg aria-hidden className="att-ring" viewBox="0 0 62 62">
      <path className="att-ring-track" d={RING_PATH} />
      <path
        className="att-ring-bar"
        d={RING_PATH}
        pathLength={100}
        strokeDasharray={100}
        strokeDashoffset={100 - p}
      />
    </svg>
  );
}
