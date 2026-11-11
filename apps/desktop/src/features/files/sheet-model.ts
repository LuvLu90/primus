// 右栏表格预览的数据模型：把 Excel 工作簿（@cj-tech-master/excelts 解析）或 CSV 文本整理成只读网格。
// 只取显示需要的部分：显示文本（按数字格式格式化后的值）、合并单元格、行高列宽、隐藏行列与基础样式
// （粗体、斜体、下划线、删除线、字色、纯色填充、水平 / 垂直对齐、自动换行）。
// 每张表最多显示 MAX_ROWS 行 × MAX_COLS 列，超出部分不显示（大表只读取开头），界面给出提示。

import type { Cell, Workbook, Worksheet } from "@cj-tech-master/excelts";
import type { CSSProperties } from "react";

/** 每张表最多显示的行数 */
export const MAX_ROWS = 1000;
/** 每张表最多显示的列数 */
export const MAX_COLS = 100;

/** Excel 默认行高 15pt = 20px；默认列宽 8.43 字符 ≈ 64px */
const DEFAULT_ROW_HEIGHT_PT = 15;
const DEFAULT_COL_WIDTH_CHARS = 8.43;
const MIN_ROW_PX = 16;
const MAX_ROW_PX = 400;
const MIN_COL_PX = 24;
const MAX_COL_PX = 480;
/** 文本溢出到右侧空单元格时最多跨过的格数 */
const MAX_SPILL = 20;
/** 内容较少的表格补齐空行、空列到至少这么多（与 Excel 打开后铺满网格一致） */
const MIN_ROWS = 30;
const MIN_COLS = 10;
/** 显示的行列数：按上限裁剪；有内容时补齐到 MIN_ROWS × MIN_COLS */
const displayCount = (count: number, max: number, min: number) =>
  count > 0 ? Math.max(Math.min(count, max), min) : 0;

export type HAlign = "left" | "center" | "right";
export type VAlign = "top" | "middle" | "bottom";

export interface SheetCell {
  text: string;
  align: HAlign;
  valign: VAlign;
  wrap: boolean;
  /** 来自文件的字色、填充与字形（只接受 #RRGGBB，不经过设计令牌：它们是文件内容） */
  style?: CSSProperties;
  /** 有填充色（不溢出到相邻格） */
  filled: boolean;
  /** 左对齐、不换行的文本可溢出到右侧连续的空单元格：溢出后的总宽度（px） */
  spill?: number;
}

/** 合并区域（0 起、含两端），已裁剪到显示范围 */
export interface Merge {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

export interface Sheet {
  name: string;
  /** 显示的行列数（已按上限裁剪，内容少时补齐了空行空列） */
  rows: number;
  cols: number;
  /** 原表超出了显示上限 */
  clipped: boolean;
  /** 每行高度 / 每列宽度（px；隐藏的为 0） */
  rowHeights: number[];
  colWidths: number[];
  /** 行号（0 起）→ 稀疏的单元格数组（列号 0 起）；合并区域里的格子不在这里，左上角的放在 merges */
  cells: Map<number, (SheetCell | undefined)[]>;
  merges: { range: Merge; cell?: SheetCell }[];
}

/** 列号（0 起）→ 列字母：0 → A，25 → Z，26 → AA */
export function columnName(index: number): string {
  let n = index + 1;
  let name = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

/** 前缀和：offsets[i] 为第 i 项的起点，offsets[n] 为总长 */
export function offsetsOf(sizes: number[]): number[] {
  const offsets = [0];
  for (const size of sizes) offsets.push((offsets.at(-1) ?? 0) + size);
  return offsets;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const rowPx = (pt: number) => clamp(Math.round((pt * 4) / 3), MIN_ROW_PX, MAX_ROW_PX);
/** 列宽（字符数）→ px：Excel 的换算，默认字体最大数字宽 7px，外加 5px 边距 */
const colPx = (chars: number) => clamp(Math.round(chars * 7 + 5), MIN_COL_PX, MAX_COL_PX);

const ARGB = /^[0-9a-f]{8}$/i;
/** ARGB（如 FFFFE699）→ #RRGGBB；主题色、索引色等取不到具体值的返回 undefined */
function argbColor(color: unknown): string | undefined {
  const argb = (color as { argb?: unknown } | undefined)?.argb;
  return typeof argb === "string" && ARGB.test(argb) ? `#${argb.slice(2)}` : undefined;
}

const H_ALIGN: Record<string, HAlign> = {
  left: "left",
  center: "center",
  centerContinuous: "center",
  right: "right",
};
const V_ALIGN: Record<string, VAlign> = { top: "top", middle: "middle", bottom: "bottom" };

/** 单元格的值（公式取缓存结果）：数字、日期右对齐，布尔居中，其余左对齐（Excel “常规”对齐） */
function defaultAlign(value: unknown): HAlign {
  const v =
    value && typeof value === "object" && "result" in value
      ? (value as { result: unknown }).result
      : value;
  if (typeof v === "number" || v instanceof Date) return "right";
  if (typeof v === "boolean") return "center";
  if (v && typeof v === "object" && "error" in v) return "center";
  return "left";
}

type DisplayText = (cell: Cell) => string;

function toCell(cell: Cell, displayText: DisplayText): SheetCell | undefined {
  let text: string;
  try {
    text = displayText(cell);
  } catch {
    text = cell.text ?? "";
  }
  const font = cell.font;
  const fill = cell.fill;
  const fillColor =
    fill?.type === "pattern" && fill.pattern === "solid" ? argbColor(fill.fgColor) : undefined;
  const style: CSSProperties = {};
  if (font?.bold) style.fontWeight = 600;
  if (font?.italic) style.fontStyle = "italic";
  const lines = [font?.underline ? "underline" : "", font?.strike ? "line-through" : ""]
    .filter(Boolean)
    .join(" ");
  if (lines) style.textDecoration = lines;
  const color = argbColor(font?.color);
  if (color) style.color = color;
  if (fillColor) style.backgroundColor = fillColor;
  if (!text && !fillColor) return undefined;
  const alignment = cell.alignment;
  return {
    text,
    align: H_ALIGN[alignment?.horizontal ?? ""] ?? defaultAlign(cell.value),
    valign: V_ALIGN[alignment?.vertical ?? ""] ?? "bottom",
    wrap: alignment?.wrapText === true,
    filled: fillColor !== undefined,
    ...(Object.keys(style).length > 0 && { style }),
  };
}

/** 估算文本宽度（px）：ASCII 约 7px，其余（中文等）约 12px */
const textWidth = (s: string) => {
  let w = 0;
  for (const ch of s) w += (ch.codePointAt(0) ?? 0) < 0x80 ? 7 : 12;
  return w;
};

/** 左对齐、不换行的文本溢出到右侧连续的空单元格（与 Excel 一致；数字不溢出） */
function computeSpill(sheet: Sheet, covered: Set<string>) {
  for (const [r, row] of sheet.cells) {
    row.forEach((cell, c) => {
      if (!cell?.text || cell.align !== "left" || cell.wrap || cell.filled) return;
      let width = sheet.colWidths[c] ?? 0;
      // 只溢出到放得下文本为止（按估算宽度，含左右内边距）
      const needed = textWidth(cell.text) + 8;
      let next = c + 1;
      while (
        width < needed &&
        next < sheet.cols &&
        next - c <= MAX_SPILL &&
        !row[next] &&
        !covered.has(`${r}:${next}`)
      ) {
        width += sheet.colWidths[next] ?? 0;
        next += 1;
      }
      if (next > c + 1) cell.spill = width;
    });
  }
}

/** 把合并区域里的格子挪出 cells：左上角放进 merges，其余丢掉 */
function applyMerges(sheet: Sheet, ranges: Merge[]): Set<string> {
  const covered = new Set<string>();
  for (const range of ranges) {
    const top = range.top;
    const left = range.left;
    if (top >= sheet.rows || left >= sheet.cols) continue;
    const clipped = {
      top,
      left,
      bottom: Math.min(range.bottom, sheet.rows - 1),
      right: Math.min(range.right, sheet.cols - 1),
    };
    if (clipped.bottom === top && clipped.right === left) continue;
    const row = sheet.cells.get(top);
    sheet.merges.push({ range: clipped, cell: row?.[left] });
    for (let r = clipped.top; r <= clipped.bottom; r++) {
      const cells = sheet.cells.get(r);
      for (let c = clipped.left; c <= clipped.right; c++) {
        covered.add(`${r}:${c}`);
        if (cells) cells[c] = undefined;
      }
    }
  }
  return covered;
}

/** 一行的最小形状（完整加载的 Row 与流式读取的 Row 都满足） */
interface RowLike {
  number: number;
  height?: number;
  hidden?: boolean;
  eachCell(callback: (cell: Cell, colNumber: number) => void): void;
}

interface SheetSource {
  name: string;
  /** 行号（1 起）不超过 MAX_ROWS 的行 */
  rows: RowLike[];
  /** 列定义（下标 0 为 A 列） */
  columns: ({ width?: number; hidden?: boolean } | undefined)[];
  /** 合并区域（1 起，含两端） */
  merges: { top: number; left: number; bottom: number; right: number }[];
  /** 原表的行数 / 列数（可能超过上限） */
  rowCount: number;
  columnCount: number;
  defaultRowHeight?: number;
  defaultColWidth?: number;
  /** 读取时已知超出了上限 */
  clipped?: boolean;
}

function buildSheet(src: SheetSource, displayText: DisplayText): Sheet {
  const hasContent = src.rowCount > 0 && src.columnCount > 0;
  const rows = hasContent ? displayCount(src.rowCount, MAX_ROWS, MIN_ROWS) : 0;
  const cols = hasContent ? displayCount(src.columnCount, MAX_COLS, MIN_COLS) : 0;
  const defaultRow = src.defaultRowHeight || DEFAULT_ROW_HEIGHT_PT;
  const defaultCol = src.defaultColWidth || DEFAULT_COL_WIDTH_CHARS;
  const rowHeights = new Array<number>(rows).fill(rowPx(defaultRow));
  const cells = new Map<number, (SheetCell | undefined)[]>();
  for (const row of src.rows) {
    const r = row.number - 1;
    if (r < 0 || r >= rows) continue;
    if (row.hidden) rowHeights[r] = 0;
    else if (row.height) rowHeights[r] = rowPx(row.height);
    const out: (SheetCell | undefined)[] = [];
    row.eachCell((cell, colNumber) => {
      if (colNumber > cols) return;
      const value = toCell(cell, displayText);
      if (value) out[colNumber - 1] = value;
    });
    if (out.length > 0) cells.set(r, out);
  }
  const colWidths: number[] = [];
  for (let c = 0; c < cols; c++) {
    // 列定义里的列宽（字符数）；没有定义的列用默认列宽
    const col = src.columns[c];
    colWidths.push(col?.hidden ? 0 : colPx(col?.width || defaultCol));
  }
  const sheet: Sheet = {
    name: src.name,
    rows,
    cols,
    clipped: src.clipped === true || src.rowCount > MAX_ROWS || src.columnCount > MAX_COLS,
    rowHeights,
    colWidths,
    cells,
    merges: [],
  };
  const covered = applyMerges(
    sheet,
    src.merges.map((m) => ({
      top: m.top - 1,
      left: m.left - 1,
      bottom: m.bottom - 1,
      right: m.right - 1,
    })),
  );
  computeSpill(sheet, covered);
  return sheet;
}

/** 完整加载的工作表 → 网格 */
function sheetFromWorksheet(ws: Worksheet, displayText: DisplayText): Sheet {
  const rows: RowLike[] = [];
  const last = Math.min(ws.rowCount, MAX_ROWS);
  for (let r = 1; r <= last; r++) {
    const row = ws.findRow(r);
    if (row) rows.push(row);
  }
  return buildSheet(
    {
      name: ws.name,
      rows,
      columns: ws.columns ?? [],
      merges: [...ws.mergedRegions],
      rowCount: ws.rowCount,
      columnCount: ws.columnCount,
      defaultRowHeight: ws.properties?.defaultRowHeight,
      defaultColWidth: ws.properties?.defaultColWidth,
    },
    displayText,
  );
}

const isHidden = (state: unknown) => state === "hidden" || state === "veryHidden";

/**
 * 解析 .xlsx / .xlsm 字节为可显示的工作表（隐藏的工作表不显示）；解析库按需加载。
 * 先完整加载（限制每张表最多 MAX_ROWS 行、每行最多 MAX_COLS 格，得到合并单元格、隐藏行列等全部信息）；
 * 超出限制时解析库直接报错（不会截断），改用流式读取：每张表读到第 MAX_ROWS 行就停，后面的数据只读完、不再解析，
 * 这条路径拿不到合并单元格与隐藏行列（大表的预览只求快速显示开头）。
 */
export async function readWorkbook(data: ArrayBuffer): Promise<Sheet[]> {
  const lib = await import("@cj-tech-master/excelts");
  const displayText: DisplayText = (cell) => lib.getCellDisplayText(cell);
  const wb: Workbook = new lib.Workbook();
  try {
    await wb.xlsx.load(data, { maxRows: MAX_ROWS, maxCols: MAX_COLS });
  } catch (e) {
    if (!(e instanceof lib.MaxItemsExceededError)) throw e;
    return readWorkbookStreaming(lib, data, displayText);
  }
  return wb.worksheets
    .filter((ws) => !isHidden(ws.state))
    .map((ws) => sheetFromWorksheet(ws, displayText));
}

type Lib = typeof import("@cj-tech-master/excelts");

/** 读完一项的原始数据并丢弃 */
async function drain(chunks: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of chunks) {
    // 只消费
  }
}

async function readWorkbookStreaming(
  lib: Lib,
  data: ArrayBuffer,
  displayText: DisplayText,
): Promise<Sheet[]> {
  const reader = new lib.WorkbookReader(new Uint8Array(data), {
    worksheets: "emit",
    sharedStrings: "cache",
    styles: "cache",
    hyperlinks: "ignore",
    entries: "ignore",
  });
  const sheets: Sheet[] = [];
  for await (const ws of reader) {
    const rows: RowLike[] = [];
    let rowCount = 0;
    let columnCount = 0;
    let clipped = false;
    // 隐藏的工作表也要读（流式读取按顺序消费压缩包），只是不显示
    for await (const row of ws) {
      if (row.number > MAX_ROWS) {
        clipped = true;
        // 余下的数据不解析，但要读完（只解压不解析 XML）：直接跳出会让压缩包里这一项停在暂停状态，
        // 背压使读取器无法前进到后面的工作表，整个预览一直停在加载中
        await drain(ws.iterator);
        break;
      }
      rows.push(row);
      rowCount = row.number;
      row.eachCell((_cell, col) => {
        if (col > MAX_COLS) {
          clipped = true;
          columnCount = MAX_COLS;
        } else columnCount = Math.max(columnCount, col);
      });
    }
    if (isHidden(ws.state)) continue;
    sheets.push(
      buildSheet(
        {
          name: ws.name,
          rows,
          columns: ws.columns ?? [],
          merges: [],
          rowCount,
          columnCount,
          clipped,
        },
        displayText,
      ),
    );
  }
  return sheets;
}

// —— CSV ——

/** 统计第一条记录里（引号外）各分隔符出现的次数，取最多的；都没有时用逗号 */
function guessDelimiter(text: string): string {
  const counts: Record<string, number> = { ",": 0, ";": 0, "\t": 0 };
  let quoted = false;
  for (const ch of text.slice(0, 64 * 1024)) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === "\n" || ch === "\r")) break;
    else if (!quoted && ch in counts) counts[ch] = (counts[ch] ?? 0) + 1;
  }
  let best = ",";
  for (const d of [";", "\t"]) if ((counts[d] ?? 0) > (counts[best] ?? 0)) best = d;
  return best;
}

/**
 * RFC 4180 CSV → 行（字段可带引号，引号内可含分隔符与换行，"" 表示一个引号）。
 * 最多返回 maxRows 行；`complete` 为 false 表示还有更多行。
 */
export function parseCsv(
  text: string,
  delimiter: string,
  maxRows: number,
): { rows: string[][]; complete: boolean } {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;
  const n = text.length;
  const endRow = () => {
    row.push(field);
    rows.push(row);
    row = [];
    field = "";
  };
  while (i < n) {
    const ch = text[i] as string;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
      } else field += ch;
      i += 1;
      continue;
    }
    if (ch === '"' && field === "") quoted = true;
    else if (ch === delimiter) {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      endRow();
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      if (rows.length >= maxRows) return { rows, complete: i + 1 >= n };
    } else field += ch;
    i += 1;
  }
  if (field !== "" || row.length > 0) endRow();
  return { rows, complete: true };
}

const NUMBER_LIKE = /^[-+]?(\d{1,3}(,\d{3})+|\d+)?(\.\d+)?([eE][-+]?\d+)?%?$/;

/**
 * CSV / TSV 文本 → 一张表。`truncated` 表示文本只是文件开头（预览最多读 1 MiB）：最后一行可能不完整，丢掉。
 * 列宽按前 200 行的内容估算。
 */
export function sheetFromCsv(
  text: string,
  name: string,
  options: { tsv?: boolean; truncated?: boolean } = {},
): Sheet {
  const delimiter = options.tsv ? "\t" : guessDelimiter(text);
  const parsed = parseCsv(text, delimiter, MAX_ROWS + 1);
  const records = parsed.rows;
  if (options.truncated && parsed.complete && records.length > 0) records.pop();
  const totalCols = records.reduce((m, r) => Math.max(m, r.length), 0);
  const hasContent = records.length > 0 && totalCols > 0;
  const rows = hasContent ? displayCount(records.length, MAX_ROWS, MIN_ROWS) : 0;
  const cols = hasContent ? displayCount(totalCols, MAX_COLS, MIN_COLS) : 0;
  const cells = new Map<number, (SheetCell | undefined)[]>();
  const widths = new Array<number>(cols).fill(0);
  for (let r = 0; r < rows; r++) {
    const record = records[r] ?? [];
    const out: (SheetCell | undefined)[] = [];
    for (let c = 0; c < Math.min(record.length, cols); c++) {
      const text = record[c] ?? "";
      if (!text) continue;
      const trimmed = text.trim();
      out[c] = {
        text,
        align: trimmed && NUMBER_LIKE.test(trimmed) ? "right" : "left",
        valign: "bottom",
        wrap: false,
        filled: false,
      };
      if (r < 200) widths[c] = Math.max(widths[c] ?? 0, textWidth(text) + 10);
    }
    if (out.length > 0) cells.set(r, out);
  }
  const sheet: Sheet = {
    name,
    rows,
    cols,
    clipped: records.length > MAX_ROWS || !parsed.complete || totalCols > MAX_COLS,
    rowHeights: new Array<number>(rows).fill(rowPx(DEFAULT_ROW_HEIGHT_PT)),
    colWidths: widths.map((w) => clamp(w, colPx(DEFAULT_COL_WIDTH_CHARS), 320)),
    cells,
    merges: [],
  };
  computeSpill(sheet, new Set());
  return sheet;
}
