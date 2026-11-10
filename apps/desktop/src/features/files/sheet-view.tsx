"use client";

// 右栏表格预览：像在 Excel 中打开一样显示工作表——顶部列字母（A、B、C…）、左侧行号、网格线、合并单元格、
// 文件里的字色 / 填充 / 字形，底部工作表标签切换工作表。数据由 sheet-model 整理（xlsx / xlsm / csv / tsv）。
// 网格放在白色纸面上（与 Word、网页预览一致，深色外观下也不变），按行虚拟滚动；行号列与列字母行固定。
import { useVirtualizer } from "@tanstack/react-virtual";
import { useMemo, useRef, useState } from "react";
import { strings } from "@/lib/strings";
import { cn } from "@/lib/utils";
import { columnName, type Merge, offsetsOf, type Sheet, type SheetCell } from "./sheet-model";

const t = strings.preview;

/** 列字母行高度、行号列宽度（px） */
const HEADER_HEIGHT = 20;
const ROW_HEADER_WIDTH = 40;

const JUSTIFY = { top: "justify-start", middle: "justify-center", bottom: "justify-end" } as const;
const TEXT_ALIGN = { left: "text-left", center: "text-center", right: "text-right" } as const;

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * 一个单元格。有填充色的格子盖住网格线（与 Excel 一致）；合并区域与溢出到右侧的文本铺纸面色盖住内部网格线，
 * 但让出右边与下边 1px，外框的网格线仍可见。
 */
function CellBox({ cell, box, cover }: { cell?: SheetCell; box: Box; cover: boolean }) {
  const inset = cover && !cell?.filled ? 1 : 0;
  return (
    <div
      data-cell
      className={cn(
        "absolute flex flex-col overflow-hidden px-1 text-xs",
        JUSTIFY[cell?.valign ?? "bottom"],
        inset > 0 && "bg-page",
      )}
      style={{
        left: box.left,
        top: box.top,
        width: Math.max(0, box.width - inset),
        height: Math.max(0, box.height - inset),
        ...cell?.style,
      }}
    >
      {cell && (
        <span
          className={cn(
            "block w-full overflow-hidden",
            TEXT_ALIGN[cell.align],
            cell.wrap ? "whitespace-pre-wrap break-words" : "whitespace-pre",
          )}
        >
          {cell.text}
        </span>
      )}
    </div>
  );
}

function boxOf(range: Merge, rowTops: number[], colLefts: number[]): Box {
  const left = colLefts[range.left] ?? 0;
  const top = rowTops[range.top] ?? 0;
  return {
    left,
    top,
    width: (colLefts[range.right + 1] ?? left) - left,
    height: (rowTops[range.bottom + 1] ?? top) - top,
  };
}

/** 一张工作表的网格 */
export function SheetGrid({ sheet }: { sheet: Sheet }) {
  const scroller = useRef<HTMLElement>(null);
  const rowTops = useMemo(() => offsetsOf(sheet.rowHeights), [sheet]);
  const colLefts = useMemo(() => offsetsOf(sheet.colWidths), [sheet]);
  const virtualizer = useVirtualizer({
    count: sheet.rows,
    getScrollElement: () => scroller.current,
    estimateSize: (i) => sheet.rowHeights[i] ?? 0,
    overscan: 10,
    // 测量前（含测试环境）按一屏估算，首帧就能渲染出可见行
    initialRect: { width: 0, height: 640 },
  });
  const items = virtualizer.getVirtualItems();
  const first = items[0]?.index ?? 0;
  const last = items.at(-1)?.index ?? -1;
  const gridWidth = colLefts[sheet.cols] ?? 0;
  const gridHeight = rowTops[sheet.rows] ?? 0;
  const merges = sheet.merges.filter((m) => m.range.top <= last && m.range.bottom >= first);
  const headerCell =
    "absolute flex items-center justify-center overflow-hidden border-page-line border-r border-b bg-page-header text-2xs text-page-muted tabular-nums";
  return (
    <section
      ref={scroller}
      aria-label={t.spreadsheet}
      className="scroll-thin min-h-0 flex-1 overflow-auto bg-page text-on-page scheme-light"
    >
      <div
        className="relative"
        style={{ width: ROW_HEADER_WIDTH + gridWidth, height: HEADER_HEIGHT + gridHeight }}
      >
        {/* 列字母：滚动时固定在顶部；左上角的空格同时固定在左侧 */}
        <div
          className="sticky top-0 z-20 flex"
          style={{ height: HEADER_HEIGHT, width: ROW_HEADER_WIDTH + gridWidth }}
        >
          <div
            className="sticky left-0 z-10 shrink-0 border-page-line border-r border-b bg-page-header"
            style={{ width: ROW_HEADER_WIDTH }}
          />
          <div className="relative shrink-0" style={{ width: gridWidth }}>
            {sheet.colWidths.map((width, c) =>
              width > 0 ? (
                <div
                  // biome-ignore lint/suspicious/noArrayIndexKey: 列号即身份
                  key={c}
                  className={cn(headerCell, "top-0 h-full")}
                  style={{ left: colLefts[c], width }}
                >
                  {columnName(c)}
                </div>
              ) : null,
            )}
          </div>
        </div>
        {/* 行号：滚动时固定在左侧 */}
        <div className="sticky left-0 z-10" style={{ width: ROW_HEADER_WIDTH, height: gridHeight }}>
          {items.map((item) => {
            const height = sheet.rowHeights[item.index] ?? 0;
            if (height === 0) return null;
            return (
              <div
                key={item.key}
                className={cn(headerCell, "left-0 w-full")}
                style={{ top: rowTops[item.index], height }}
              >
                {item.index + 1}
              </div>
            );
          })}
        </div>
        <div
          className="absolute"
          style={{
            left: ROW_HEADER_WIDTH,
            top: HEADER_HEIGHT,
            width: gridWidth,
            height: gridHeight,
          }}
        >
          {/* 网格线：每列一条竖线、每个可见行一条横线 */}
          {sheet.colWidths.map((width, c) =>
            width > 0 ? (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: 列号即身份
                key={c}
                aria-hidden
                className="absolute top-0 h-full border-page-line border-r"
                style={{ left: colLefts[c], width }}
              />
            ) : null,
          )}
          {items.map((item) => (
            <div
              key={`line-${item.key}`}
              aria-hidden
              className="absolute left-0 w-full border-page-line border-b"
              style={{ top: rowTops[item.index], height: sheet.rowHeights[item.index] }}
            />
          ))}
          {items.map((item) => {
            const r = item.index;
            const height = sheet.rowHeights[r] ?? 0;
            if (height === 0) return null;
            return sheet.cells.get(r)?.map((cell, c) => {
              const width = sheet.colWidths[c] ?? 0;
              if (!cell || width === 0) return null;
              return (
                <CellBox
                  // biome-ignore lint/suspicious/noArrayIndexKey: 行号与列号即单元格身份
                  key={`${r}:${c}`}
                  cell={cell}
                  cover={cell.spill !== undefined}
                  box={{
                    left: colLefts[c] ?? 0,
                    top: rowTops[r] ?? 0,
                    width: cell.spill ?? width,
                    height,
                  }}
                />
              );
            });
          })}
          {merges.map(({ range, cell }) => (
            <CellBox
              key={`merge-${range.top}:${range.left}`}
              cell={cell}
              cover
              box={boxOf(range, rowTops, colLefts)}
            />
          ))}
        </div>
      </div>
    </section>
  );
}

/** 一个或多个工作表：网格 + 超限提示 + 底部工作表标签（`tabs` 为 false 时不显示标签，如 CSV） */
export function SheetBook({ sheets, tabs = true }: { sheets: Sheet[]; tabs?: boolean }) {
  const [active, setActive] = useState(0);
  const sheet = sheets[Math.min(active, sheets.length - 1)];
  return (
    <div className="flex size-full min-h-0 flex-col">
      {!sheet ? (
        <p className="px-4 py-3 text-sm text-muted">{t.noSheets}</p>
      ) : sheet.rows === 0 || sheet.cols === 0 ? (
        <p className="min-h-0 flex-1 px-4 py-3 text-sm text-muted">{t.sheetEmpty}</p>
      ) : (
        // 换表时重建网格：滚动位置与虚拟列表从头开始
        <SheetGrid key={active} sheet={sheet} />
      )}
      {sheet?.clipped && (
        <p className="shrink-0 border-border border-t px-3 py-1 text-2xs text-muted">
          {t.sheetClipped}
        </p>
      )}
      {tabs && sheets.length > 0 && (
        <div
          role="tablist"
          aria-label={t.sheets}
          className="scroll-thin flex shrink-0 gap-0.5 overflow-x-auto border-border border-t px-1.5 py-1"
        >
          {sheets.map((s, i) => (
            <button
              // 工作簿内工作表名唯一
              key={s.name}
              type="button"
              role="tab"
              aria-selected={i === active}
              onClick={() => setActive(i)}
              className={cn(
                "shrink-0 whitespace-pre rounded-md px-2.5 py-0.5 text-xs outline-none transition-colors",
                i === active
                  ? "bg-hover font-medium text-fg"
                  : "text-muted hover:bg-hover hover:text-fg focus-visible:bg-hover",
              )}
            >
              {s.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
